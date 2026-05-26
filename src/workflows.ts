import {
	ChildWorkflowCancellationType,
	condition,
	defineQuery,
	defineSignal,
	executeChild,
	ParentClosePolicy,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type * as activities from "./activities.ts";
import type {
	TemporalScaffoldGeneratedFile,
	TemporalScaffoldPlan,
} from "./harness/temporal-scaffold.ts";
import type {
	CodeActScaffoldFileActivityResult,
	CodeActScaffoldWorkflowAttempt,
	CodeActScaffoldWorkflowInput,
	CodeActScaffoldWorkflowResult,
} from "./harness/types.ts";
import { buildAgentHandshake, buildPolicyInspection } from "./policy.ts";
import { getScenarioDefinition } from "./scenario-definitions.ts";
import type {
	AgentHandshakeInput,
	ApprovalDecision,
	DemoWorkflowInput,
	DemoWorkflowState,
	PiOutput,
	PolicyInspectionInput,
	RecoveryEvent,
} from "./types.ts";

const activity = proxyActivities<typeof activities>({
	startToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "2 seconds",
		maximumAttempts: 3,
	},
});

const scaffoldActivity = proxyActivities<typeof activities>({
	startToCloseTimeout: "5 minutes",
	retry: {
		maximumAttempts: 1,
	},
});

const scaffoldPaths = [
	"requirements.txt",
	"src/models.py",
	"src/activities.py",
	"src/workflows.py",
	"src/worker.py",
	"src/client.py",
	"src/extractor.py",
	"README.md",
] as const;

export const submitPiOutputSignal = defineSignal<[PiOutput]>("submitPiOutput");
export const submitApprovalSignal =
	defineSignal<[ApprovalDecision]>("submitApproval");
export const inspectPolicySignal =
	defineSignal<[PolicyInspectionInput]>("inspectPolicy");
export const agentHandshakeSignal =
	defineSignal<[AgentHandshakeInput]>("agentHandshake");
export const demoStateQuery = defineQuery<DemoWorkflowState>("demoState");

export async function gtmDemoWorkflow(
	input: DemoWorkflowInput,
): Promise<DemoWorkflowState> {
	const definition = getScenarioDefinition(input.scenarioId);
	const state: DemoWorkflowState = {
		runId: input.runId || `${input.scenarioId}-${Date.now()}`,
		scenarioId: input.scenarioId,
		title: definition.title,
		reliabilityMode: input.reliabilityMode ?? "clean-run",
		phase: "preparing",
		timeline: [],
	};
	const addEvent = (message: string) => {
		state.timeline = [
			...state.timeline,
			{ at: new Date(Date.now()).toISOString(), message },
		];
	};
	const addRecoveryEvents = (events: RecoveryEvent[] | undefined) => {
		for (const event of events ?? []) {
			state.recoveryEvents = [...(state.recoveryEvents ?? []), event];
			addEvent(
				`Recovered ${event.step}: ${event.failure} after attempt ${event.failedAttempt}; succeeded on attempt ${event.recoveredOnAttempt}`,
			);
		}
	};

	setHandler(demoStateQuery, () => state);
	setHandler(submitPiOutputSignal, (output) => {
		state.piOutput = output;
		addEvent(`Received ${output.source} Pi output`);
	});
	setHandler(submitApprovalSignal, (decision) => {
		state.approval = {
			...decision,
			decidedAt: decision.decidedAt || new Date(Date.now()).toISOString(),
		};
		addEvent(`Approval decision: ${decision.decision}`);
	});
	setHandler(inspectPolicySignal, (input) => {
		const inspection = buildPolicyInspection(
			state,
			input,
			input.requestedAt || new Date(Date.now()).toISOString(),
		);
		state.policyInspections = [...(state.policyInspections ?? []), inspection];
		addEvent(
			`Policy inspection ${inspection.id}: ${inspection.status} for ${inspection.policyId}`,
		);
	});
	setHandler(agentHandshakeSignal, (input) => {
		const handshake = buildAgentHandshake(
			state,
			input,
			input.createdAt || new Date(Date.now()).toISOString(),
		);
		state.agentHandshakes = [...(state.agentHandshakes ?? []), handshake];
		addEvent(
			`Agent handshake ${handshake.id}: ${handshake.fromAgent} to ${handshake.toAgent} is ${handshake.status}`,
		);
	});

	addEvent("Workflow started");
	try {
		state.promptPack = await activity.prepareScenarioActivity(input);
		addRecoveryEvents(state.promptPack.recoveryEvents);
	} catch (error) {
		state.phase = "failed";
		state.failure = errorMessage(error);
		addEvent(`Workflow failed while preparing context: ${state.failure}`);
		return state;
	}
	state.phase = "waiting_for_pi";
	addEvent("Prepared prompt pack and waiting for Pi generation");

	await condition(() => state.piOutput !== undefined);
	state.phase = "waiting_for_approval";
	addEvent("Waiting for human approval");

	await condition(() => state.approval !== undefined);
	if (state.approval?.decision === "rejected") {
		state.phase = "rejected";
		addEvent("Run rejected; no final artifact exported");
		return state;
	}

	state.phase = "exporting";
	addEvent("Exporting approved artifact");
	try {
		state.artifact = await activity.exportArtifactActivity({
			...state,
			phase: "completed",
		});
		addRecoveryEvents(state.artifact.recoveryEvents);
	} catch (error) {
		state.phase = "failed";
		state.failure = errorMessage(error);
		addEvent(`Workflow failed while exporting artifact: ${state.failure}`);
		return state;
	}
	state.phase = "completed";
	addEvent(`Completed with artifact ${state.artifact.relativePath}`);
	return state;
}

export async function codeActScaffoldParentWorkflow(
	input: CodeActScaffoldWorkflowInput,
): Promise<CodeActScaffoldWorkflowResult> {
	const childWorkflowId =
		input.childWorkflowId || `${input.runId}-codeact-scaffold-child`;
	const result = await executeChild(codeActScaffoldChildWorkflow, {
		workflowId: childWorkflowId,
		args: [{ ...input, childWorkflowId }],
		parentClosePolicy: ParentClosePolicy.TERMINATE,
		cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
	});
	return { ...result, childWorkflowId };
}

export async function codeActScaffoldChildWorkflow(
	input: CodeActScaffoldWorkflowInput,
): Promise<CodeActScaffoldWorkflowResult> {
	const repairAttempts = normalizeRepairAttempts(input.repairAttempts);
	const attempts: CodeActScaffoldWorkflowAttempt[] = [];
	const filesByPath: Record<string, TemporalScaffoldGeneratedFile> = {};

	const planResult = await scaffoldActivity.codeActScaffoldPlanActivity({
		timeoutMs: input.timeoutMs,
	});
	attempts.push({
		attempt: 1,
		purpose: planResult.purpose,
		status: planResult.status,
		errorMessage: planResult.errorMessage,
	});
	if (planResult.status !== "validated" || !planResult.plan) {
		return fallbackScaffold(input, attempts);
	}

	let previousError = "";
	let repairPaths: string[] = [];
	const initialFiles = await generateScaffoldFiles({
		paths: [...scaffoldPaths],
		plan: planResult.plan,
		filesByPath,
		timeoutMs: input.timeoutMs,
		attempts,
		attemptNumber: 1,
	});
	previousError = initialFiles.errorMessage;
	repairPaths = initialFiles.repairPaths;
	if (!previousError) {
		const validation = await validateScaffoldFiles({
			scaffoldDir: input.scaffoldDir,
			plan: planResult.plan,
			filesByPath,
			attempts,
			attemptNumber: 1,
		});
		if (validation.status === "validated") {
			return {
				childWorkflowId: input.childWorkflowId,
				spec: validation.spec,
				generated: validation.generated,
				validation: validation.validation,
				usedFallback: false,
				acceptedAttempt: 1,
				attempts,
			};
		}
		previousError =
			validation.errorMessage || "Generated scaffold failed validation.";
		repairPaths = validation.repairPaths ?? [...scaffoldPaths];
	}

	for (
		let repairAttempt = 1;
		repairAttempt <= repairAttempts;
		repairAttempt += 1
	) {
		const repaired = await generateScaffoldFiles({
			paths: repairPaths,
			plan: planResult.plan,
			filesByPath,
			timeoutMs: input.timeoutMs,
			attempts,
			attemptNumber: repairAttempt + 1,
			repairError: previousError,
			repairAttempt,
			repairPaths,
		});
		previousError = repaired.errorMessage;
		repairPaths = repaired.repairPaths;
		if (previousError) continue;
		const validation = await validateScaffoldFiles({
			scaffoldDir: input.scaffoldDir,
			plan: planResult.plan,
			filesByPath,
			attempts,
			attemptNumber: repairAttempt + 1,
		});
		if (validation.status === "validated") {
			return {
				childWorkflowId: input.childWorkflowId,
				spec: validation.spec,
				generated: validation.generated,
				validation: validation.validation,
				usedFallback: false,
				acceptedAttempt: repairAttempt + 1,
				attempts,
			};
		}
		previousError =
			validation.errorMessage || "Generated scaffold failed validation.";
		repairPaths = validation.repairPaths ?? [...scaffoldPaths];
	}

	const fallback = await scaffoldActivity.codeActScaffoldFallbackActivity({
		scaffoldDir: input.scaffoldDir,
	});
	if (!fallback.spec || !fallback.generated || !fallback.validation) {
		throw new Error(
			"Validated fallback scaffold activity returned no scaffold.",
		);
	}
	return {
		childWorkflowId: input.childWorkflowId,
		spec: fallback.spec,
		generated: fallback.generated,
		validation: fallback.validation,
		usedFallback: true,
		attempts,
	};
}

async function fallbackScaffold(
	input: CodeActScaffoldWorkflowInput,
	attempts: CodeActScaffoldWorkflowAttempt[],
): Promise<CodeActScaffoldWorkflowResult> {
	const fallback = await scaffoldActivity.codeActScaffoldFallbackActivity({
		scaffoldDir: input.scaffoldDir,
	});
	if (!fallback.spec || !fallback.generated || !fallback.validation) {
		throw new Error(
			"Validated fallback scaffold activity returned no scaffold.",
		);
	}
	return {
		childWorkflowId: input.childWorkflowId,
		spec: fallback.spec,
		generated: fallback.generated,
		validation: fallback.validation,
		usedFallback: true,
		attempts,
	};
}

async function generateScaffoldFiles(input: {
	paths: string[];
	plan: TemporalScaffoldPlan;
	filesByPath: Record<string, TemporalScaffoldGeneratedFile>;
	timeoutMs?: number;
	attempts: CodeActScaffoldWorkflowAttempt[];
	attemptNumber: number;
	repairError?: string;
	repairAttempt?: number;
	repairPaths?: string[];
}): Promise<{ errorMessage: string; repairPaths: string[] }> {
	const currentFiles = () =>
		Object.fromEntries(
			Object.entries(input.filesByPath).map(([path, file]) => [
				path,
				file.contents,
			]),
		);
	const results = await Promise.all(
		input.paths.map((path) =>
			scaffoldActivity.codeActScaffoldFileActivity({
				path,
				plan: input.plan,
				timeoutMs: input.timeoutMs,
				currentFiles: currentFiles(),
				repairError: input.repairError,
				repairAttempt: input.repairAttempt,
				repairPaths: input.repairPaths,
				previousContents: input.filesByPath[path]?.contents,
			}),
		),
	);
	const failed: CodeActScaffoldFileActivityResult[] = [];
	for (const result of results) {
		input.attempts.push({
			attempt: input.attemptNumber,
			purpose: result.purpose,
			status: result.status,
			errorMessage: result.errorMessage,
			repairPaths: result.repairPaths,
		});
		if (result.status === "validated" && result.file) {
			input.filesByPath[result.file.path] = result.file;
		} else {
			failed.push(result);
		}
	}
	if (failed.length === 0) return { errorMessage: "", repairPaths: [] };
	const repairPaths = failed
		.flatMap((result) => result.repairPaths ?? [])
		.filter(Boolean);
	return {
		errorMessage: failed
			.map(
				(result) =>
					`${result.repairPaths?.[0] ?? result.purpose}: ${result.errorMessage ?? "file generation failed"}`,
			)
			.join("\n"),
		repairPaths: repairPaths.length > 0 ? repairPaths : [...scaffoldPaths],
	};
}

async function validateScaffoldFiles(input: {
	scaffoldDir: string;
	plan: TemporalScaffoldPlan;
	filesByPath: Record<string, TemporalScaffoldGeneratedFile>;
	attempts: CodeActScaffoldWorkflowAttempt[];
	attemptNumber: number;
}) {
	const result = await scaffoldActivity.codeActScaffoldValidateActivity({
		scaffoldDir: input.scaffoldDir,
		plan: input.plan,
		files: Object.values(input.filesByPath),
	});
	input.attempts.push({
		attempt: input.attemptNumber,
		purpose: result.purpose,
		status: result.status,
		errorMessage: result.errorMessage,
		repairPaths: result.repairPaths,
		validation: result.validation,
	});
	if (
		result.status === "validated" &&
		result.spec &&
		result.generated &&
		result.validation
	) {
		return {
			status: "validated" as const,
			spec: result.spec,
			generated: result.generated,
			validation: result.validation,
		};
	}
	return {
		status: "rejected" as const,
		errorMessage: result.errorMessage,
		repairPaths: result.repairPaths,
	};
}

function normalizeRepairAttempts(value: number | undefined): number {
	if (!value || value < 0) return 0;
	return Math.floor(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
