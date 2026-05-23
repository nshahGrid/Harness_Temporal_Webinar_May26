import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.ts";
import { getTemporalEnv } from "./env.ts";
import { redactedErrorMessage } from "./redact.ts";

async function main() {
	const env = getTemporalEnv();
	const connection = await NativeConnection.connect({
		address: env.address,
		apiKey: env.apiKey,
		tls: env.apiKey ? true : undefined,
	});
	const worker = await Worker.create({
		connection,
		namespace: env.namespace,
		taskQueue: env.taskQueue,
		workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
		activities,
	});
	console.log("Temporal case-study demo worker listening.");
	await worker.run();
}

main().catch((error) => {
	console.error(redactedErrorMessage(error));
	process.exitCode = 1;
});
