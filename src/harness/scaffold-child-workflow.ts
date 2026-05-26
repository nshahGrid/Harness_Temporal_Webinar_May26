import { createTemporalClient, hasTemporalEnv } from "../env.ts";
import type {
	CodeActScaffoldWorkflowInput,
	CodeActScaffoldWorkflowResult,
} from "./types.ts";

type CodeActScaffoldParentWorkflow = (
	input: CodeActScaffoldWorkflowInput,
) => Promise<CodeActScaffoldWorkflowResult>;

export const codeActScaffoldParentWorkflowType =
	"codeActScaffoldParentWorkflow";
export const codeActScaffoldChildWorkflowType = "codeActScaffoldChildWorkflow";

export function shouldRunCodeActScaffoldChildWorkflow(
	llmGenerateConfigured: boolean,
): boolean {
	if (process.env.CODEACT_SCAFFOLD_CHILD_WORKFLOW === "0") return false;
	if (process.env.CODEACT_SCAFFOLD_CHILD_WORKFLOW === "1") {
		return hasTemporalEnv() && !llmGenerateConfigured;
	}
	return false;
}

export async function runCodeActScaffoldChildWorkflow(
	input: CodeActScaffoldWorkflowInput,
): Promise<CodeActScaffoldWorkflowResult> {
	const { client, taskQueue } = await createTemporalClient();
	const workflowId = codeActScaffoldParentWorkflowId(input.runId);
	const childWorkflowId =
		input.childWorkflowId || codeActScaffoldChildWorkflowId(input.runId);
	const result = await client.workflow.execute<CodeActScaffoldParentWorkflow>(
		codeActScaffoldParentWorkflowType,
		{
			taskQueue,
			workflowId,
			args: [{ ...input, childWorkflowId }],
			workflowRunTimeout: "10 minutes",
		},
	);
	return { ...result, parentWorkflowId: workflowId, childWorkflowId };
}

export function codeActScaffoldParentWorkflowId(runId: string): string {
	return `${safeWorkflowId(runId)}-codeact-scaffold-parent`;
}

export function codeActScaffoldChildWorkflowId(runId: string): string {
	return `${safeWorkflowId(runId)}-codeact-scaffold-child`;
}

function safeWorkflowId(value: string): string {
	const trimmed = value.trim() || `codeact-${Date.now()}`;
	return trimmed.replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 180);
}
