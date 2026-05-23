export const scenarioIds = ["temporal-case-study-marketing-page"] as const;

export type ScenarioId = (typeof scenarioIds)[number];

export const reliabilityModes = [
	"clean-run",
	"recoverable-failures",
	"random-chaos",
	"permanent-failure",
] as const;

export type ReliabilityMode = (typeof reliabilityModes)[number];

export type WorkflowPhase =
	| "preparing"
	| "waiting_for_pi"
	| "waiting_for_approval"
	| "exporting"
	| "completed"
	| "rejected"
	| "failed";

export type ApprovalStatus = "approved" | "rejected";

export type PolicyInspectionStatus = "pending" | "passed" | "blocked";

export type AgentHandshakeStatus =
	| "needs_context"
	| "needs_policy"
	| "ready_for_review"
	| "blocked";

export interface DemoWorkflowInput {
	scenarioId: ScenarioId;
	runId?: string;
	requestedBy?: string;
	reliabilityMode?: ReliabilityMode;
}

export interface ScenarioDefinition {
	id: ScenarioId;
	title: string;
	shortDescription: string;
	skillName: string;
	temporalStory: string[];
	artifactName: string;
}

export interface TimelineEvent {
	at: string;
	message: string;
}

export interface RecoveryEvent {
	step: string;
	system: string;
	failure: string;
	failedAttempt: number;
	recoveredOnAttempt: number;
	temporalHelp: string;
}

export interface PolicyInspectionInput {
	requestedBy?: string;
	policyId?: string;
	question?: string;
	requestedAt?: string;
}

export interface PolicyInspection {
	id: string;
	requestedBy: string;
	policyId: string;
	question: string;
	phaseAtInspection: WorkflowPhase;
	status: PolicyInspectionStatus;
	findings: string[];
	recommendation: string;
	requestedAt: string;
}

export interface AgentHandshakeInput {
	fromAgent?: string;
	toAgent?: string;
	intent?: string;
	createdAt?: string;
}

export interface AgentHandshake {
	id: string;
	fromAgent: string;
	toAgent: string;
	intent: string;
	phaseAtHandshake: WorkflowPhase;
	status: AgentHandshakeStatus;
	policyStatus?: PolicyInspectionStatus;
	summary: string;
	createdAt: string;
}

export interface PromptPack {
	scenarioId: ScenarioId;
	title: string;
	summary: string;
	prompt: string;
	temporalStory: string[];
	fixturePaths: string[];
	preparedData: Record<string, unknown>;
	recoveryEvents?: RecoveryEvent[];
}

export interface PiOutput {
	source: "pi" | "fixture";
	generatedAt: string;
	markdown: string;
}

export interface ApprovalDecision {
	decision: ApprovalStatus;
	reviewer?: string;
	notes?: string;
	decidedAt?: string;
}

export interface ExportedArtifact {
	path: string;
	relativePath: string;
	recoveryEvents?: RecoveryEvent[];
}

export interface DemoWorkflowState {
	runId: string;
	scenarioId: ScenarioId;
	title: string;
	reliabilityMode?: ReliabilityMode;
	phase: WorkflowPhase;
	promptPack?: PromptPack;
	piOutput?: PiOutput;
	approval?: ApprovalDecision;
	artifact?: ExportedArtifact;
	recoveryEvents?: RecoveryEvent[];
	policyInspections?: PolicyInspection[];
	agentHandshakes?: AgentHandshake[];
	failure?: string;
	timeline: TimelineEvent[];
}
