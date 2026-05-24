import type { CaseStudyResearchResult } from "../case-study-research.ts";
import type { PiTemporalHarness } from "./pi-harness.ts";
import { temporalPrimitiveCatalog } from "./temporal-scaffold.ts";
import type { HarnessAgentResult } from "./types.ts";

const DEMO_PROMPT =
	"Research Temporal's live website for customer case studies, extract up to 20 proof points, and generate marketing HTML with source citations.";

export async function runSimpleAgent(
	harness: PiTemporalHarness,
): Promise<HarnessAgentResult> {
	harness.prompt(DEMO_PROMPT);
	harness.reason(
		"I will ask the LLM for the prompt-only Simple Agent brief so this artifact is model-generated.",
	);
	const brief = await harness.generateSimpleBriefWithLlm();
	await harness.writeArtifact(
		"simple-agent-brief.md",
		brief,
		"LLM-generated Simple agent brief",
	);
	harness.result(
		"The LLM generated the Simple Agent brief. No tools or generated Temporal code were used in this mode.",
	);
	return buildResult(
		harness,
		"Simple agent",
		"Answers from the prompt directly. Useful for orientation, but it cannot fetch pages, inspect state, or create runnable Temporal code.",
		["workflow", "activity", "signal", "query"],
	);
}

export async function runReactAgent(
	harness: PiTemporalHarness,
): Promise<HarnessAgentResult> {
	harness.prompt(DEMO_PROMPT);
	harness.reason(
		"I will run the business scenario as a ReAct loop: discover Temporal-owned case-study links, ask Pi for a parallel-minded branch plan and bounded concurrency, use the same target/page budget as CodeAct, fetch/extract evidence, and stop at the explicit exit condition.",
	);
	const useCases = await harness.inspectBusinessUseCases();
	harness.observe(
		`Loaded ${useCases.length} business scenario from the demo catalog.`,
	);
	const primitives = await harness.inspectTemporalCatalog();
	harness.observe(
		`Loaded ${primitives.length} Temporal primitives for state, retries, signals, queries, and workers.`,
	);
	const scenarioId = "temporal-case-study-marketing-page";
	const promptPack = await harness.preparePromptPack(scenarioId);
	harness.observe(
		`Prepared prompt pack for ${promptPack.title}: ${promptPack.fixturePaths.length} Temporal-owned discovery roots and ${Object.keys(promptPack.preparedData).length} prepared data group.`,
	);
	harness.reason(
		"The next action is the ReAct loop itself. Pi plans independent research branches and chooses the execution strategy, while CodeAct remains distinct because it generates Temporal scaffold code before running extraction.",
	);
	const research = await harness.runReactResearch();
	harness.observe(
		`ReAct extracted ${research.records.length}/${research.targetCount} valid records after Pi discovered ${research.discoveredUrls.length} candidate URLs and the harness attempted ${research.attemptedUrls.length} pages at concurrency ${research.concurrency}.`,
	);
	const reactBundle = await harness.generateCaseStudyArtifactBundleWithLlm(
		"react",
		research,
		"Write the narrative for a marketing reviewer: summarize what proof was found, what coverage is missing, and why approval is paused.",
	);
	await harness.writeCaseStudyArtifactBundle("react", reactBundle);
	harness.result(
		`Executed the ReAct loop; the LLM generated the ReAct HTML, citations, and execution narrative from ${research.records.length}/${research.targetCount} records. ${research.exitCondition}`,
	);
	return buildResult(
		harness,
		"ReAct agent",
		"Uses a reason, act, observe loop to plan independent research branches, fetch and extract Temporal customer stories with the same target/page budget as CodeAct, then exits when the budget, target count, or review condition is reached.",
		primitives.map((primitive) => primitive.id),
		research,
	);
}

export async function runCodeActAgent(
	harness: PiTemporalHarness,
): Promise<HarnessAgentResult> {
	harness.prompt(DEMO_PROMPT);
	harness.reason(
		"The user needs runtime code, not just a plan. I will use the CodeAct bash escape hatch to write a Python Temporal scaffold with Workflow, Activities, Signals, Queries, RetryPolicy, and bounded parallel extraction.",
	);
	const useCaseOutput = await harness.bash(
		"temporal scaffold business-use-cases",
	);
	harness.reason(
		`The scaffold must cover this business scenario:\n${useCaseOutput}`,
	);
	const skillContext = await harness.bash("temporal skill context load");
	harness.reason(
		`Loaded the relevant Temporal Python skill references into the CodeAct prompt context:\n${skillContext}`,
	);
	const primitiveOutput = await harness.bash("temporal scaffold primitives");
	harness.reason(
		`The scaffold must include these code-level signals:\n${primitiveOutput}`,
	);
	const generatedFiles = await harness.bash("temporal scaffold write");
	harness.reason(`The bash path generated files:\n${generatedFiles}`);
	const scaffoldSource = harness.didUseCodeActScaffoldFallback()
		? "Pi attempted the scaffold but failed strict validation; the harness used the validated fallback scaffold so the demo could continue."
		: "Pi generated the scaffold and it passed strict validation.";
	harness.observe(scaffoldSource);
	const validation = await harness.bash("temporal scaffold validate");
	harness.observe(`Validation passed:\n${validation}`);
	const extraction = await harness.bash(
		"temporal case-study extract --mode codeact",
	);
	harness.observe(`CodeAct extraction completed:\n${extraction}`);
	const research = harness.getLatestCodeActResearch();
	if (!research)
		throw new Error("CodeAct extraction did not produce research state.");
	const cloudRun = harness.getLatestCodeActTemporalCloudRun();
	const codeActBundle = await harness.generateCaseStudyArtifactBundleWithLlm(
		"codeact",
		research,
		[
			"Write the narrative as a CodeAct walkthrough.",
			harness.didUseCodeActScaffoldFallback()
				? "Explain that Pi/LLM attempted the Python scaffold, failed strict harness validation, and the harness continued with the validated fallback scaffold before linting, validating, and running extraction."
				: "Explain that Pi/LLM generated the Python scaffold, then the harness wrote, linted, validated, and ran it.",
			"Business use case:",
			useCaseOutput,
			"Validation:",
			validation,
			"Extraction:",
			extraction,
			cloudRun
				? [
						"Temporal Cloud generated workflow:",
						`workflowId=${cloudRun.workflowId || "not-started"}`,
						`workflowType=${cloudRun.workflowType}`,
						`taskQueue=${cloudRun.taskQueue}`,
						`activities=${cloudRun.activities.join(", ")}`,
						`status=${cloudRun.status}`,
					].join("\n")
				: "",
			"Generated files:",
			generatedFiles,
		].join("\n"),
	);
	await harness.writeCaseStudyArtifactBundle("codeact", codeActBundle);
	harness.result(
		codeActResultMessage(
			harness,
			research.records.length,
			research.targetCount,
			cloudRun,
		),
	);
	return buildResult(
		harness,
		"CodeAct agent",
		"Writes Python Temporal code at runtime through the bash escape hatch, validates workflow/activity/signal/query/retry/parallel primitives, starts the generated Python worker/workflow in Temporal Cloud when configured, and exports the marketing HTML artifact.",
		temporalPrimitiveCatalog.map((primitive) => primitive.id),
		research,
	);
}

function buildResult(
	harness: PiTemporalHarness,
	title: string,
	summary: string,
	temporalPrimitives: string[],
	caseStudyResearch?: CaseStudyResearchResult,
): HarnessAgentResult {
	return {
		mode: harness.agentMode,
		title,
		summary,
		events: harness.getEvents(),
		toolCalls: harness.getToolCalls(),
		workerEvents: harness.getWorkerEvents(),
		artifacts: harness.getArtifacts(),
		temporalPrimitives,
		transcript: harness.getTranscript(),
		caseStudyResearch,
		codeActTemporalCloud: harness.getLatestCodeActTemporalCloudRun(),
	};
}

function codeActResultMessage(
	harness: PiTemporalHarness,
	recordCount: number,
	targetCount: number,
	cloudRun: ReturnType<PiTemporalHarness["getLatestCodeActTemporalCloudRun"]>,
): string {
	const scaffoldSource = harness.didUseCodeActScaffoldFallback()
		? "Pi's generated scaffold failed strict validation, so the harness used the validated fallback scaffold"
		: "The LLM generated Python Temporal code";
	if (cloudRun?.status === "completed") {
		return `${scaffoldSource}; the harness wrote it, linted it, started a generated Python worker, launched Temporal Cloud workflow ${cloudRun.workflowId}, observed activities ${cloudRun.activities.join(", ")}, and produced codeact-case-study-page.html with ${recordCount}/${targetCount} records.`;
	}
	if (cloudRun) {
		return `${scaffoldSource}; the generated Python Temporal Cloud run did not complete (${cloudRun.status}), so the harness fell back to local bounded extraction and produced codeact-case-study-page.html with ${recordCount}/${targetCount} records.`;
	}
	return `${scaffoldSource}; the harness wrote it, linted it, validated it, ran local bounded parallel extraction, and used LLM output for codeact-case-study-page.html with ${recordCount}/${targetCount} records.`;
}
