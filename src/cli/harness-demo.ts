import "../env.ts";
import {
	parseHarnessAgent,
	runTemporalPiHarnessDemo,
} from "../harness/demo.ts";
import { redactedErrorMessage, redactSecrets } from "../redact.ts";
import { hasFlag, readArg } from "./args.ts";

async function main(): Promise<void> {
	const result = await runTemporalPiHarnessDemo({
		agent: parseHarnessAgent(readArg("--agent")),
		runId: readArg("--run-id"),
		outputDir: readArg("--out"),
	});

	if (hasFlag("--json")) {
		console.log(redactSecrets(JSON.stringify(result, null, 2)));
		return;
	}

	console.log(`Pi + Temporal harness demo: ${result.runId}`);
	console.log(`Report: ${result.reportPath}`);
	for (const agentResult of result.results) {
		console.log(`- ${agentResult.title}: ${agentResult.summary}`);
		for (const artifact of agentResult.artifacts) {
			console.log(`  artifact: ${artifact.relativePath}`);
		}
	}
}

main().catch((error) => {
	console.error(redactedErrorMessage(error));
	process.exitCode = 1;
});
