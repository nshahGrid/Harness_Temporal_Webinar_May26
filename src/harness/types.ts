import type {
	CaseStudyResearchResult,
	FetchText,
} from "../case-study-research.ts";
import type {
	TemporalScaffoldGeneratedFile,
	TemporalScaffoldPlan,
	TemporalScaffoldSpec,
} from "./temporal-scaffold.ts";

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
	enableCodeActScaffoldChildWorkflow?: boolean;
	enablePiExtractionCache?: boolean;
	piExtractionCachePath?: string;
}

export interface HarnessLlmRequest {
	purpose: string;
	prompt: string;
	skillName?: string | null;
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

export interface CodeActScaffoldWorkflowInput {
	runId: string;
	scaffoldDir: string;
	repairAttempts?: number;
	timeoutMs?: number;
	childWorkflowId?: string;
}

export interface CodeActScaffoldAttemptActivityInput {
	scaffoldDir: string;
	attempt: number;
	timeoutMs?: number;
	previousError?: string;
	previousOutput?: string;
}

export interface CodeActScaffoldAttemptActivityResult {
	attempt: number;
	purpose: string;
	status: "validated" | "rejected";
	output?: string;
	errorMessage?: string;
	spec?: TemporalScaffoldSpec;
	generated?: GeneratedFile[];
	validation?: string[];
}

export interface CodeActScaffoldPlanActivityInput {
	timeoutMs?: number;
}

export interface CodeActScaffoldPlanActivityResult {
	purpose: string;
	status: "validated" | "rejected";
	output?: string;
	errorMessage?: string;
	plan?: TemporalScaffoldPlan;
}

export interface CodeActScaffoldFileActivityInput {
	path: string;
	plan: TemporalScaffoldPlan;
	timeoutMs?: number;
	currentFiles?: Record<string, string>;
	repairError?: string;
	repairAttempt?: number;
	repairPaths?: string[];
	previousContents?: string;
}

export interface CodeActScaffoldFileActivityResult {
	purpose: string;
	status: "validated" | "rejected";
	output?: string;
	errorMessage?: string;
	repairPaths?: string[];
	file?: TemporalScaffoldGeneratedFile;
}

export interface CodeActScaffoldValidateActivityInput {
	scaffoldDir: string;
	plan: TemporalScaffoldPlan;
	files: TemporalScaffoldGeneratedFile[];
}

export interface CodeActScaffoldValidateActivityResult {
	purpose: string;
	status: "validated" | "rejected";
	errorMessage?: string;
	repairPaths?: string[];
	spec?: TemporalScaffoldSpec;
	generated?: GeneratedFile[];
	validation?: string[];
}

export interface CodeActScaffoldWorkflowAttempt {
	attempt: number;
	purpose: string;
	status: "validated" | "rejected";
	errorMessage?: string;
	validation?: string[];
	repairPaths?: string[];
}

export interface CodeActScaffoldWorkflowResult {
	parentWorkflowId?: string;
	childWorkflowId?: string;
	spec: TemporalScaffoldSpec;
	generated: GeneratedFile[];
	validation: string[];
	usedFallback: boolean;
	acceptedAttempt?: number;
	acceptedOutput?: string;
	attempts: CodeActScaffoldWorkflowAttempt[];
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
