import { createTemporalScaffoldSpec } from "../harness/temporal-scaffold.ts";

export interface AgentCodeSnippet {
	title: string;
	language: "ts" | "py" | "bash";
	code: string;
}

export interface AgentLadderStep {
	id: "simple" | "react" | "codeact";
	title: string;
	shortName: string;
	definition: string;
	audienceTakeaway: string;
	snippets: AgentCodeSnippet[];
}

export interface DemoMode {
	id: "codeact" | "harness-codeact";
	title: string;
	shortName: string;
	definition: string;
	whenToShow: string;
	outputs: string[];
	snippets: AgentCodeSnippet[];
}

export function buildDemoModes(): DemoMode[] {
	return [
		{
			id: "codeact",
			title: "CodeAct",
			shortName: "Direct",
			definition:
				"The agent uses code execution as its action. In this demo Pi/LLM loads the Temporal Agent Skill, emits Python Temporal scaffold code through a bash escape hatch, and the harness writes, lints, validates, and runs it before asking Pi/LLM for the marketing HTML output.",
			whenToShow:
				"Use this when the audience wants to understand the primitive: an AI agent can produce code, execute commands, inspect results, and iterate.",
			outputs: [
				"Python Temporal scaffold files",
				"Temporal Agent Skill-backed generation plus generated-code lint output",
				"Pi/LLM-generated workflow, activities, signals, queries, retry policy, worker, client, and HTML artifact",
			],
			snippets: [
				{
					title: "Direct CodeAct loop",
					language: "ts",
					code: `reason("Write the Temporal case-study research scaffold through the bash escape hatch.");

const skill = await bash("temporal agent skill load");
const files = await bash("temporal scaffold write");
const referenceChecks = await bash("temporal scaffold validation-references");
const validation = await bash("temporal scaffold validate");
const extraction = await bash("temporal case-study extract --mode codeact");

return { skill, files, referenceChecks, validation, extraction };`,
				},
				{
					title: "Generated files",
					language: "bash",
					code: `runtime-temporal-scaffold/
  requirements.txt
  src/models.py
  src/activities.py
  src/workflows.py
  src/worker.py
  src/client.py
  src/extractor.py`,
				},
			],
		},
		{
			id: "harness-codeact",
			title: "Harness with CodeAct",
			shortName: "Harness",
			definition:
				"The Pi harness runs CodeAct inside a controlled demo surface. It records LLM prompts/outputs, reasoning, tool calls, generated files, validation, and a final report.",
			whenToShow:
				"Use this for a developer demo because it makes the invisible agent loop auditable and compares CodeAct against Simple and ReAct behavior.",
			outputs: [
				"Agent ladder report",
				"Timeline of prompt, reason, act, tool, artifact, result events",
				"Temporal Agent Skill-generated CodeAct scaffold plus validation transcript",
				"Parallel CodeAct worker-lane telemetry for discovery, extraction, retries, and aggregation",
			],
			snippets: [
				{
					title: "Harness wrapper",
					language: "ts",
					code: `const harness = new PiTemporalHarness("codeact", outputDir);
const result = await runCodeActAgent(harness);

await writeFile(
  "pi-temporal-harness-report.md",
  renderReport(runId, [result]),
);

// The harness captures:
// - transcript
// - tool calls
// - parallel worker events
// - generated artifacts
// - Temporal primitives validated`,
				},
				{
					title: "Presentation command",
					language: "bash",
					code: `npm run harness-demo -- --agent all --run-id live-demo
open artifacts/harness-runs/live-demo/pi-temporal-harness-report.md`,
				},
			],
		},
	];
}

export function buildAgentLadder(): AgentLadderStep[] {
	const scaffold = createTemporalScaffoldSpec();
	const workflowSource =
		scaffold.files.find((file) => file.path === "src/workflows.py")?.contents ??
		"";
	const activitiesSource =
		scaffold.files.find((file) => file.path === "src/activities.py")
			?.contents ?? "";
	const extractorSource =
		scaffold.files.find((file) => file.path === "src/extractor.py")?.contents ??
		"";

	return [
		{
			id: "simple",
			title: "Simple Agent",
			shortName: "Simple",
			definition:
				"A prompt goes in and an answer comes out. No tools, no inspection, no file writes.",
			audienceTakeaway:
				"Useful for orientation, but it cannot verify state or create runnable artifacts.",
			snippets: [
				{
					title: "Prompt-only shape",
					language: "ts",
					code: `const prompt = buildPromptPack("temporal-case-study-marketing-page");
const answer = await pi.respond(prompt);

// Result: useful guidance, but no Temporal files or workflow state.
return answer;`,
				},
			],
		},
		{
			id: "react",
			title: "ReAct Agent",
			shortName: "ReAct",
			definition:
				"ReAct means Reason + Act. The agent reasons about the next step, calls a tool, then uses the result to continue.",
			audienceTakeaway:
				"Good for developer demos because the audience can see the model choose a parallel-minded bounded strategy, call tools, observe results, and exit explicitly.",
			snippets: [
				{
					title: "Reason + tool calls",
					language: "ts",
					code: `harness.reason(
  "Let Pi create a concise parallel branch plan and choose concurrency, then use the same target/page budget as CodeAct while fetching and extracting Temporal case studies until the exit condition is hit.",
);

const useCases = await harness.inspectBusinessUseCases();
const primitives = await harness.inspectTemporalCatalog();
const urls = await harness.discoverTemporalUrlsWithPi("react");
const research = await harness.runReactResearch();

const bundle = await harness.generateCaseStudyArtifactBundleWithLlm(
  "react",
  research,
  "Write this as a ReAct execution trace with citations.",
);

await harness.writeCaseStudyArtifactBundle("react", bundle);`,
				},
				{
					title: "LLM artifact prompt",
					language: "ts",
					code: `await harness.generateWithLlm({
  purpose: "react-case-study-artifact-bundle",
  prompt: [
    "Return ONLY JSON with html, citationsMarkdown, narrativeMarkdown.",
    "Use only supplied Temporal case-study records.",
    JSON.stringify(research, null, 2),
  ].join("\\n"),
});`,
				},
			],
		},
		{
			id: "codeact",
			title: "CodeAct Agent",
			shortName: "CodeAct",
			definition:
				"CodeAct keeps the reasoning loop, but the action is code execution. In this demo, Pi/LLM uses the Temporal Agent Skill and a bash escape hatch to emit Python Temporal code, then the harness validates that generated code and runs bounded parallel research at runtime.",
			audienceTakeaway:
				"This is the developer hook: the agent does not just describe Temporal primitives, it generates a scaffold with workflow state, retryable activities, signals, queries, bounded parallelism, worker, and client code.",
			snippets: [
				{
					title: "Escape hatch",
					language: "ts",
					code: `await harness.bash("temporal scaffold business-use-cases");
await harness.bash("temporal agent skill load");
await harness.bash("temporal scaffold primitives");
await harness.bash("temporal scaffold write");
await harness.bash("temporal scaffold validation-references");
await harness.bash("temporal scaffold validate");
await harness.bash("temporal case-study extract --mode codeact");`,
				},
				{
					title: "Expected workflow shape",
					language: "py",
					code: workflowSource,
				},
				{
					title: "Expected activities shape",
					language: "py",
					code: activitiesSource,
				},
				{
					title: "Bounded local extractor",
					language: "py",
					code: extractorSource,
				},
				{
					title: "CLI demo",
					language: "bash",
					code: `npm run harness-demo -- --agent codeact --run-id live-demo
python3 -m py_compile artifacts/harness-runs/live-demo/codeact/runtime-temporal-scaffold/src/*.py`,
				},
			],
		},
	];
}
