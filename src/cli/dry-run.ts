import { exportArtifactActivity } from "../activities.ts";
import { redactedErrorMessage, redactSecrets } from "../redact.ts";
import { buildFixturePiOutput, buildPromptPack } from "../scenario-data.ts";
import { getScenarioDefinition } from "../scenario-definitions.ts";
import type { DemoWorkflowState, ScenarioId } from "../types.ts";
import { readScenario } from "./args.ts";

export async function dryRunScenario(
	scenarioId: ScenarioId,
): Promise<DemoWorkflowState> {
	const definition = getScenarioDefinition(scenarioId);
	const promptPack = await buildPromptPack(scenarioId, {
		includePreparedResearch: true,
	});
	const now = new Date().toISOString();
	const state: DemoWorkflowState = {
		runId: `${scenarioId}-dry-run-${Date.now()}`,
		scenarioId,
		title: definition.title,
		phase: "completed",
		promptPack,
		piOutput: {
			source: "fixture",
			generatedAt: now,
			markdown: buildFixturePiOutput(promptPack),
		},
		approval: {
			decision: "approved",
			reviewer: "fixture",
			notes: "Dry-run approval.",
			decidedAt: now,
		},
		timeline: [
			{ at: now, message: "Dry-run prepared prompt pack" },
			{ at: now, message: "Dry-run generated fixture Pi output" },
			{ at: now, message: "Dry-run approved artifact" },
		],
	};
	state.artifact = await exportArtifactActivity(state);
	console.log(redactSecrets(JSON.stringify(state, null, 2)));
	return state;
}

if (process.argv[1]?.endsWith("dry-run.ts")) {
	dryRunScenario(readScenario()).catch((error) => {
		console.error(redactedErrorMessage(error));
		process.exitCode = 1;
	});
}
