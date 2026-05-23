import type {
	AgentHandshake,
	AgentHandshakeInput,
	DemoWorkflowState,
	PolicyInspection,
	PolicyInspectionInput,
	PolicyInspectionStatus,
} from "./types.ts";

export function buildPolicyInspection(
	state: DemoWorkflowState,
	input: PolicyInspectionInput,
	requestedAt: string,
): PolicyInspection {
	const policyId = input.policyId || "draft-only-human-approval";
	const question =
		input.question ||
		"Can this agent output proceed to human review or export?";
	const requestedBy = input.requestedBy || "pi-agent";
	const findings = [
		state.promptPack
			? "Prompt pack exists in durable workflow state."
			: "Prompt pack is not prepared yet.",
		state.piOutput
			? "Agent draft output exists in workflow state."
			: "Agent draft output has not been submitted.",
		state.approval
			? `Human approval signal is ${state.approval.decision}.`
			: "Human approval signal has not been received.",
		"The demo is draft-only and does not send email, post externally, or update CRM.",
	];
	const status = policyStatusForState(state);
	return {
		id: `policy-${(state.policyInspections?.length ?? 0) + 1}`,
		requestedBy,
		policyId,
		question,
		phaseAtInspection: state.phase,
		status,
		findings,
		recommendation: policyRecommendation(status),
		requestedAt,
	};
}

export function buildAgentHandshake(
	state: DemoWorkflowState,
	input: AgentHandshakeInput,
	createdAt: string,
): AgentHandshake {
	const latestPolicy = state.policyInspections?.at(-1);
	const fromAgent = input.fromAgent || "case-study-research-agent";
	const toAgent = input.toAgent || "policy-review-agent";
	const intent =
		input.intent ||
		"Hand off generated Temporal case-study marketing page for policy review before approval/export.";
	const status = handshakeStatusForState(state, latestPolicy?.status);
	return {
		id: `handshake-${(state.agentHandshakes?.length ?? 0) + 1}`,
		fromAgent,
		toAgent,
		intent,
		phaseAtHandshake: state.phase,
		status,
		policyStatus: latestPolicy?.status,
		summary: handshakeSummary(status, latestPolicy?.status),
		createdAt,
	};
}

function policyStatusForState(
	state: DemoWorkflowState,
): PolicyInspectionStatus {
	if (!state.promptPack || !state.piOutput) return "pending";
	if (containsExternalActionClaim(state.piOutput.markdown)) return "blocked";
	return "passed";
}

function containsExternalActionClaim(markdown: string): boolean {
	return markdown.split(/\r?\n/).some((line) => {
		if (/\b(no|not|never|nothing)\b/i.test(line)) return false;
		return /\b(sent|emailed|posted|published|updated crm|synced to crm|launched campaign)\b/i.test(
			line,
		);
	});
}

function policyRecommendation(status: PolicyInspectionStatus): string {
	if (status === "pending") {
		return "Keep workflow waiting. Policy can inspect durable state, but the agent draft is not ready yet.";
	}
	if (status === "blocked") {
		return "Block approval/export until the draft is rewritten as draft-only collateral.";
	}
	return "Policy passed for human review. Continue to approval signal before export.";
}

function handshakeStatusForState(
	state: DemoWorkflowState,
	policyStatus: PolicyInspectionStatus | undefined,
): AgentHandshake["status"] {
	if (!state.promptPack || !state.piOutput) return "needs_context";
	if (!policyStatus) return "needs_policy";
	if (policyStatus === "blocked") return "blocked";
	return "ready_for_review";
}

function handshakeSummary(
	status: AgentHandshake["status"],
	policyStatus: PolicyInspectionStatus | undefined,
): string {
	if (status === "needs_context") {
		return "Receiving agent needs the prompt pack and draft output before it can proceed.";
	}
	if (status === "needs_policy") {
		return "Draft exists, but a policy inspection signal has not been recorded yet.";
	}
	if (status === "blocked") {
		return `Policy state is ${policyStatus}; receiving agent should request a safer rewrite.`;
	}
	return `Policy state is ${policyStatus}; receiving agent can continue to human approval handoff.`;
}
