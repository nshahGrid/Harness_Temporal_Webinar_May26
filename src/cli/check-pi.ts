import "../env.ts";
import { checkPiRuntime } from "../pi-runner.ts";
import { redactedErrorMessage } from "../redact.ts";

try {
	const status = await checkPiRuntime({ smoke: true });
	console.log(`Pi CLI: ${status.ok ? "ready" : "not ready"}`);
	console.log(`Resolution: ${status.commandLabel}`);
	if (status.provider || status.model) {
		console.log(
			`Model: ${[status.provider, status.model].filter(Boolean).join("/")}`,
		);
	}
	console.log(status.message);
	if (!status.ok) process.exitCode = 1;
} catch (error) {
	console.error(redactedErrorMessage(error));
	process.exitCode = 1;
}
