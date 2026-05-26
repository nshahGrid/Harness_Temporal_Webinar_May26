import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApplicationFailure, Context } from "@temporalio/activity";
import {
	buildTemporalScaffoldLlmPrompt,
	buildTemporalScaffoldRepairPrompt,
} from "./harness/pi-harness.ts";
import {
	createTemporalScaffoldSpec,
	parseTemporalScaffoldSpecFromBash,
	parseTemporalScaffoldSpecFromLlm,
	temporalDeveloperSkillName,
	validateTemporalScaffold,
	writeTemporalScaffold,
} from "./harness/temporal-scaffold.ts";
import type {
	CodeActScaffoldAttemptActivityInput,
	CodeActScaffoldAttemptActivityResult,
	CodeActScaffoldWorkflowInput,
} from "./harness/types.ts";
import { artifactsDir, packageRelative } from "./paths.ts";
import { generateTextWithPi } from "./pi-runner.ts";
import { redactedErrorMessage } from "./redact.ts";
import { buildFixturePiOutput, buildPromptPack } from "./scenario-data.ts";
import { getScenarioDefinition } from "./scenario-definitions.ts";
import type {
	DemoWorkflowInput,
	DemoWorkflowState,
	ExportedArtifact,
	PiOutput,
	PromptPack,
	ReliabilityMode,
	ScenarioId,
} from "./types.ts";

interface FailureIncident {
	step: string;
	system: string;
	failure: string;
	type: string;
	temporalHelp: string;
}

export async function prepareScenarioActivity(
	input: DemoWorkflowInput,
): Promise<PromptPack> {
	const incident = prepareIncident(input.scenarioId);
	await maybeFailForReliabilityDrill(input.reliabilityMode, incident);
	const pack = await buildPromptPack(input.scenarioId);
	return attachRecoveryEvent(pack, input.reliabilityMode, incident);
}

export async function fixturePiOutputActivity(
	pack: PromptPack,
): Promise<PiOutput> {
	const fixturePack = pack.preparedData.researchResult
		? pack
		: await buildPromptPack(pack.scenarioId, { includePreparedResearch: true });
	return {
		source: "fixture",
		generatedAt: new Date().toISOString(),
		markdown: buildFixturePiOutput(fixturePack),
	};
}

export async function exportArtifactActivity(
	state: DemoWorkflowState,
): Promise<ExportedArtifact> {
	const incident = exportIncident(state.scenarioId);
	await maybeFailForReliabilityDrill(state.reliabilityMode, incident);
	await mkdir(artifactsDir, { recursive: true });
	const definition = getScenarioDefinition(state.scenarioId);
	const extension = definition.artifactName.endsWith(".html") ? ".html" : ".md";
	const path = join(
		artifactsDir,
		`${state.runId}-${state.scenarioId}${extension}`,
	);
	const body =
		extension === ".html"
			? buildHtmlArtifact(state)
			: buildMarkdownArtifact(state);
	await writeFile(path, body, "utf8");
	return attachRecoveryEvent(
		{ path, relativePath: packageRelative(path) },
		state.reliabilityMode,
		incident,
	);
}

export async function codeActScaffoldAttemptActivity(
	input: CodeActScaffoldAttemptActivityInput,
): Promise<CodeActScaffoldAttemptActivityResult> {
	const basePrompt = buildTemporalScaffoldLlmPrompt();
	const purpose =
		input.attempt === 1
			? "codeact-temporal-bash-scaffold"
			: `codeact-temporal-bash-scaffold-repair-${input.attempt - 1}`;
	const prompt =
		input.attempt === 1
			? basePrompt
			: buildTemporalScaffoldRepairPrompt(
					basePrompt,
					input.previousError || "Previous scaffold attempt failed.",
					input.previousOutput || "",
					input.attempt - 1,
				);
	let output = "";
	try {
		output = await generateTextWithPi({
			prompt,
			skillName: temporalDeveloperSkillName,
			timeoutMs: input.timeoutMs ?? 150_000,
		});
		const spec = parseTemporalScaffoldOutput(output);
		const generated = await writeTemporalScaffold(input.scaffoldDir, spec);
		const validation = await validateTemporalScaffold(input.scaffoldDir);
		return {
			attempt: input.attempt,
			purpose,
			status: "validated",
			output,
			spec,
			generated,
			validation,
		};
	} catch (error) {
		return {
			attempt: input.attempt,
			purpose,
			status: "rejected",
			output: output || undefined,
			errorMessage: redactedErrorMessage(error),
		};
	}
}

export async function codeActScaffoldFallbackActivity(
	input: Pick<CodeActScaffoldWorkflowInput, "scaffoldDir">,
): Promise<
	Pick<
		CodeActScaffoldAttemptActivityResult,
		"spec" | "generated" | "validation"
	>
> {
	const spec = createTemporalScaffoldSpec();
	const generated = await writeTemporalScaffold(input.scaffoldDir, spec);
	const validation = await validateTemporalScaffold(input.scaffoldDir);
	return { spec, generated, validation };
}

function buildMarkdownArtifact(state: DemoWorkflowState): string {
	return [
		`# ${state.title}`,
		"",
		`Workflow: ${state.runId}`,
		`Scenario: ${state.scenarioId}`,
		`Phase: ${state.phase}`,
		"",
		"## Temporal Timeline",
		...state.timeline.map((event) => `- ${event.at}: ${event.message}`),
		"",
		"## Prompt Pack",
		"```json",
		JSON.stringify(state.promptPack, null, 2),
		"```",
		"",
		"## Pi Output",
		state.piOutput?.markdown ?? "(missing)",
		"",
		"## Approval",
		"```json",
		JSON.stringify(state.approval, null, 2),
		"```",
		"",
	].join("\n");
}

function buildHtmlArtifact(state: DemoWorkflowState): string {
	const markdown = state.piOutput?.markdown ?? "";
	const htmlBlock = /```html\s*([\s\S]*?)```/i.exec(markdown)?.[1]?.trim();
	if (htmlBlock?.startsWith("<!doctype html")) return htmlBlock;
	const timeline = state.timeline
		.map(
			(event) =>
				`<li><strong>${escapeHtml(event.message)}</strong><span>${escapeHtml(event.at)}</span></li>`,
		)
		.join("");
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(state.title)}</title>
  <style>
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f8fafc; color: #111827; }
    header { background: #0b1020; color: white; padding: 56px 40px; }
    main { max-width: 1080px; margin: 0 auto; padding: 32px 40px; }
    h1 { font-size: 42px; line-height: 1; margin: 0 0 12px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #111827; color: #e5e7eb; border-radius: 8px; padding: 18px; }
    li { margin-bottom: 10px; }
    li span { display: block; color: #64748b; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(state.title)}</h1>
    <p>Generated by Pi and exported after Temporal approval.</p>
  </header>
  <main>
    <h2>Pi Draft</h2>
    <pre>${escapeHtml(markdown || "(missing draft)")}</pre>
    <h2>Temporal Timeline</h2>
    <ul>${timeline}</ul>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => {
		const entities: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		};
		return entities[char] ?? char;
	});
}

function parseTemporalScaffoldOutput(output: string) {
	try {
		return parseTemporalScaffoldSpecFromBash(output);
	} catch (bashError) {
		const bashMessage =
			bashError instanceof Error ? bashError.message : String(bashError);
		try {
			return parseTemporalScaffoldSpecFromLlm(output);
		} catch {
			throw new Error(
				`Pi output did not contain a complete scaffold. Last bash parser error: ${bashMessage}`,
			);
		}
	}
}

async function maybeFailForReliabilityDrill(
	mode: ReliabilityMode | undefined,
	incident: FailureIncident,
): Promise<void> {
	const attempt = currentAttempt();
	if (!mode || mode === "clean-run") return;

	if (mode === "permanent-failure") {
		throw ApplicationFailure.nonRetryable(
			`${incident.system} permanent failure: ${incident.failure}`,
			`${incident.type}_PERMANENT`,
			{ incident, attempt },
		);
	}

	if (mode === "recoverable-failures" && attempt === 1) {
		throw ApplicationFailure.retryable(
			`${incident.system} transient failure: ${incident.failure}`,
			incident.type,
			{
				incident,
				attempt,
			},
		);
	}

	if (mode === "random-chaos" && attempt < 3 && Math.random() < 0.55) {
		throw ApplicationFailure.retryable(
			`${incident.system} intermittent failure: ${incident.failure}`,
			incident.type,
			{ incident, attempt },
		);
	}
}

function attachRecoveryEvent<T extends object>(
	value: T,
	mode: ReliabilityMode | undefined,
	incident: FailureIncident,
): T {
	const attempt = currentAttempt();
	if (!mode || mode === "clean-run" || attempt <= 1) return value;
	const existing =
		"recoveryEvents" in value && Array.isArray(value.recoveryEvents)
			? value.recoveryEvents
			: [];
	return {
		...value,
		recoveryEvents: [
			...existing,
			{
				step: incident.step,
				system: incident.system,
				failure: incident.failure,
				failedAttempt: attempt - 1,
				recoveredOnAttempt: attempt,
				temporalHelp: incident.temporalHelp,
			},
		],
	} as T;
}

function currentAttempt(): number {
	try {
		return Context.current().info.attempt;
	} catch {
		return 1;
	}
}

function prepareIncident(scenarioId: ScenarioId): FailureIncident {
	const incidents: Record<ScenarioId, FailureIncident> = {
		"temporal-case-study-marketing-page": {
			step: "discover and fetch Temporal customer stories",
			system: "Temporal website page-fetch activity",
			failure: "transient 429 while collecting Temporal case-study pages",
			type: "TEMPORAL_CASE_STUDY_FETCH_RATE_LIMIT",
			temporalHelp:
				"Temporal retried the fetch activity without losing already discovered URLs, extracted records, policy state, or future approval state.",
		},
	};
	return incidents[scenarioId];
}

function exportIncident(scenarioId: ScenarioId): FailureIncident {
	return {
		step: "export approved artifact",
		system: "Artifact storage",
		failure: `write conflict while exporting ${scenarioId} approval artifact`,
		type: "ARTIFACT_WRITE_CONFLICT",
		temporalHelp:
			"Temporal retried the export activity after approval, so the human signal was preserved.",
	};
}
