import type {
	CaseStudyResearchResult,
	FetchText,
} from "../case-study-research.ts";

export const harnessAgentModes = ["simple", "react", "codeact"] as const;

export type HarnessAgentMode = (typeof harnessAgentModes)[number];

export interface HarnessDemoOptions {
	agent?: HarnessAgentMode | "all";
	runId?: string;
	outputDir?: string;
	onStream?: (event: HarnessStreamEvent) => void;
	researchFetchText?: FetchText;
	researchTargetCount?: number;
	reactPageBudget?: number;
	codeActPageBudget?: number;
	codeActConcurrency?: number;
	llmGenerate?: HarnessLlmGenerate;
	enableCodeActTemporalCloud?: boolean;
}

export interface HarnessLlmRequest {
	purpose: string;
	prompt: string;
	timeoutMs?: number;
}

export type HarnessLlmGenerate = (
	request: HarnessLlmRequest,
) => Promise<string>;

export interface TemporalPrimitive {
	id: string;
	label: string;
	whyItMatters: string;
	codeSignal: string;
}

export interface HarnessEvent {
	at: string;
	agent: HarnessAgentMode;
	kind:
		| "prompt"
		| "reason"
		| "act"
		| "tool"
		| "observation"
		| "artifact"
		| "result";
	message: string;
	artifactPath?: string;
}

export interface HarnessToolCall {
	agent: HarnessAgentMode;
	tool: string;
	input: string;
	output: string;
}

export interface HarnessWorkerEvent {
	at: string;
	agent: HarnessAgentMode;
	workerId: string;
	phase:
		| "planned"
		| "assigned"
		| "retrying"
		| "record"
		| "failure"
		| "complete"
		| "aggregate";
	message: string;
	url?: string;
	records?: number;
	failures?: number;
}

export interface GeneratedFile {
	path: string;
	relativePath: string;
	purpose: string;
}

export interface CodeActTemporalCloudRun {
	workflowId: string;
	workflowType: string;
	taskQueue: string;
	activities: string[];
	status: "completed" | "failed" | "skipped";
	message: string;
	records?: number;
	failures?: number;
	attempted?: number;
}

export interface HarnessAgentResult {
	mode: HarnessAgentMode;
	title: string;
	summary: string;
	events: HarnessEvent[];
	toolCalls: HarnessToolCall[];
	workerEvents: HarnessWorkerEvent[];
	artifacts: GeneratedFile[];
	temporalPrimitives: string[];
	transcript: string[];
	caseStudyResearch?: CaseStudyResearchResult;
	codeActTemporalCloud?: CodeActTemporalCloudRun;
}

export interface HarnessDemoResult {
	runId: string;
	outputDir: string;
	reportPath: string;
	comparisonPath?: string;
	results: HarnessAgentResult[];
}

export type HarnessStreamEvent =
	| { type: "run-start"; runId: string; agent: HarnessAgentMode | "all" }
	| { type: "agent-start"; runId: string; agent: HarnessAgentMode }
	| { type: "event"; runId: string; event: HarnessEvent }
	| { type: "tool"; runId: string; toolCall: HarnessToolCall }
	| { type: "worker"; runId: string; worker: HarnessWorkerEvent }
	| { type: "artifact"; runId: string; artifact: GeneratedFile }
	| { type: "agent-complete"; runId: string; result: HarnessAgentResult }
	| { type: "run-complete"; runId: string; result: HarnessDemoResult };

export type HarnessRuntimeStreamEvent =
	| { type: "event"; event: HarnessEvent }
	| { type: "tool"; toolCall: HarnessToolCall }
	| { type: "worker"; worker: HarnessWorkerEvent }
	| { type: "artifact"; artifact: GeneratedFile };
