import {
	condition,
	defineQuery,
	defineSignal,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type * as activities from "./activities.ts";
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
