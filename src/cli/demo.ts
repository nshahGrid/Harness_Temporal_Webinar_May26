import { createTemporalClient } from "../env.ts";
import { generateWithPi } from "../pi-runner.ts";
import { redactedErrorMessage, redactSecrets } from "../redact.ts";
import { buildFixturePiOutput, buildPromptPack } from "../scenario-data.ts";
import type { DemoWorkflowState, PiOutput, ReliabilityMode } from "../types.ts";
import {
	demoStateQuery,
	gtmDemoWorkflow,
	submitApprovalSignal,
	submitPiOutputSignal,
} from "../workflows.ts";
import { hasFlag, readArg, readScenario } from "./args.ts";

async function main() {
	const scenarioId = readScenario();
	if (hasFlag("--dry-run")) {
		const { dryRunScenario } = await import("./dry-run.ts");
		await dryRunScenario(scenarioId);
		return;
	}

	const { client, taskQueue } = await createTemporalClient();
	const workflowId = readArg("--workflow") || `${scenarioId}-${Date.now()}`;
	const reliabilityMode = (readArg("--reliability") ||
		"clean-run") as ReliabilityMode;
	const handle = await client.workflow.start(gtmDemoWorkflow, {
		taskQueue,
		workflowId,
		args: [
			{ scenarioId, runId: workflowId, requestedBy: "cli", reliabilityMode },
		],
	});
	console.log(`Started Temporal workflow ${workflowId}`);

	if (!hasFlag("--no-generate")) {
		const state = await waitForPrompt(handle);
		const output: PiOutput = hasFlag("--fixture")
			? {
					source: "fixture",
					generatedAt: new Date().toISOString(),
					markdown: buildFixturePiOutput(
						await buildPromptPack(scenarioId, {
							includePreparedResearch: true,
						}),
					),
				}
			: await generateWithPi(
					state.promptPack ?? (await buildPromptPack(scenarioId)),
				);
		await handle.signal(submitPiOutputSignal, output);
		console.log(`Submitted ${output.source} output to ${workflowId}`);
	}

	if (hasFlag("--auto-approve")) {
		await handle.signal(submitApprovalSignal, {
			decision: "approved",
			reviewer: "demo-cli",
			notes: "Auto-approved for demo run.",
			decidedAt: new Date().toISOString(),
		});
		console.log(`Approved ${workflowId}`);
	}

	const finalState = await handle.query(demoStateQuery);
	console.log(redactSecrets(JSON.stringify(finalState, null, 2)));
}

async function waitForPrompt(handle: {
	query: (query: typeof demoStateQuery) => Promise<DemoWorkflowState>;
}) {
	for (let attempt = 0; attempt < 30; attempt++) {
		const state = await handle.query(demoStateQuery);
		if (state.promptPack) return state;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error(
		"Timed out waiting for Temporal workflow to prepare prompt pack.",
	);
}

main().catch((error) => {
	console.error(redactedErrorMessage(error));
	process.exitCode = 1;
});
