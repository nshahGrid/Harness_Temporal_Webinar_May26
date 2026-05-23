import { createTemporalClient } from "../env.ts";
import { redactedErrorMessage, redactSecrets } from "../redact.ts";
import type { ApprovalStatus } from "../types.ts";
import { demoStateQuery, submitApprovalSignal } from "../workflows.ts";
import { readArg } from "./args.ts";

async function main() {
	const workflowId = readArg("--workflow");
	const decision = (readArg("--decision") || "approved") as ApprovalStatus;
	if (!workflowId) throw new Error("--workflow is required");
	if (decision !== "approved" && decision !== "rejected") {
		throw new Error('--decision must be "approved" or "rejected"');
	}
	const { client } = await createTemporalClient();
	const handle = client.workflow.getHandle(workflowId);
	await handle.signal(submitApprovalSignal, {
		decision,
		reviewer: readArg("--reviewer") || "demo-reviewer",
		notes: readArg("--notes"),
		decidedAt: new Date().toISOString(),
	});
	const state = await handle.query(demoStateQuery);
	console.log(redactSecrets(JSON.stringify(state, null, 2)));
}

main().catch((error) => {
	console.error(redactedErrorMessage(error));
	process.exitCode = 1;
});
