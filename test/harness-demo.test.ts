import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codeActTaskQueueForRun } from "../src/harness/codeact-temporal-cloud.ts";
import { runTemporalPiHarnessDemo } from "../src/harness/demo.ts";
import { shouldRunCodeActScaffoldChildWorkflow } from "../src/harness/scaffold-child-workflow.ts";
import { createTemporalScaffoldSpec } from "../src/harness/temporal-scaffold.ts";
import {
	makeTemporalMockFetch,
	mockCaseStudyUrls,
	mockHarnessLlmGenerate,
} from "./mock-temporal.ts";

process.env.CODEACT_TEMPORAL_CLOUD = "0";

test("CodeAct scaffold child workflow is opt-in and disabled for mock LLM runs", () => {
	const previous = {
		address: process.env.TEMPORAL_ADDRESS,
		namespace: process.env.TEMPORAL_NAMESPACE,
		apiKey: process.env.TEMPORAL_API_KEY,
		childWorkflow: process.env.CODEACT_SCAFFOLD_CHILD_WORKFLOW,
	};
	try {
		process.env.TEMPORAL_ADDRESS = "localhost:7233";
		process.env.TEMPORAL_NAMESPACE = "default";
		delete process.env.TEMPORAL_API_KEY;
		delete process.env.CODEACT_SCAFFOLD_CHILD_WORKFLOW;
		assert.equal(shouldRunCodeActScaffoldChildWorkflow(false), false);

		process.env.CODEACT_SCAFFOLD_CHILD_WORKFLOW = "1";
		assert.equal(shouldRunCodeActScaffoldChildWorkflow(false), true);
		assert.equal(shouldRunCodeActScaffoldChildWorkflow(true), false);

		process.env.CODEACT_SCAFFOLD_CHILD_WORKFLOW = "0";
		assert.equal(shouldRunCodeActScaffoldChildWorkflow(false), false);
	} finally {
		restoreEnv("TEMPORAL_ADDRESS", previous.address);
		restoreEnv("TEMPORAL_NAMESPACE", previous.namespace);
		restoreEnv("TEMPORAL_API_KEY", previous.apiKey);
		restoreEnv("CODEACT_SCAFFOLD_CHILD_WORKFLOW", previous.childWorkflow);
	}
});

test("CodeAct Cloud task queues are isolated per run by default", () => {
	const previous = {
		taskQueue: process.env.TEMPORAL_TASK_QUEUE,
		codeactTaskQueue: process.env.TEMPORAL_CODEACT_TASK_QUEUE,
		sharedTaskQueue: process.env.CODEACT_TEMPORAL_SHARED_TASK_QUEUE,
	};
	try {
		process.env.TEMPORAL_TASK_QUEUE = "demo-task-queue";
		delete process.env.TEMPORAL_CODEACT_TASK_QUEUE;

		assert.notEqual(
			codeActTaskQueueForRun("run-one"),
			codeActTaskQueueForRun("run-two"),
		);
		assert.equal(
			codeActTaskQueueForRun("Run One!"),
			"demo-task-queue-codeact-run-one",
		);

		process.env.TEMPORAL_CODEACT_TASK_QUEUE = "shared-codeact";
		assert.equal(codeActTaskQueueForRun("run-one"), "shared-codeact-run-one");

		process.env.CODEACT_TEMPORAL_SHARED_TASK_QUEUE = "1";
		assert.equal(codeActTaskQueueForRun("run-one"), "shared-codeact");
	} finally {
		restoreEnv("TEMPORAL_TASK_QUEUE", previous.taskQueue);
		restoreEnv("TEMPORAL_CODEACT_TASK_QUEUE", previous.codeactTaskQueue);
		restoreEnv("CODEACT_TEMPORAL_SHARED_TASK_QUEUE", previous.sharedTaskQueue);
	}
});

test("harness demo shows business-aligned simple, ReAct, and CodeAct agents", async () => {
	const outputDir = await mkdtemp(join(tmpdir(), "pi-temporal-harness-"));
	try {
		const result = await runTemporalPiHarnessDemo({
			agent: "all",
			runId: "test-harness",
			outputDir,
			researchFetchText: makeTemporalMockFetch(),
			researchTargetCount: 4,
			reactPageBudget: 2,
			codeActPageBudget: 6,
			codeActConcurrency: 3,
			llmGenerate: mockHarnessLlmGenerate,
		});

		assert.equal(result.results.length, 3);
		assert.deepEqual(
			result.results.map((agentResult) => agentResult.mode),
			["simple", "react", "codeact"],
		);

		const react = result.results.find(
			(agentResult) => agentResult.mode === "react",
		);
		assert.ok(react);
		assert.equal(react.caseStudyResearch?.records.length, 2);
		assert.equal(react.caseStudyResearch?.targetCount, 4);
		assert.ok(
			react.toolCalls.some((call) => call.tool === "pi_live_search_cli"),
		);
		assert.ok(
			react.toolCalls.some(
				(call) => call.input === "react-live-temporal-website-search",
			),
		);
		const reactSearchPrompt =
			react.toolCalls.find((call) => call.tool === "pi_live_search_prompt")
				?.output ?? "";
		assert.doesNotMatch(reactSearchPrompt, /Mode: ReAct/);
		assert.doesNotMatch(
			reactSearchPrompt,
			/Keep the discovery narrow and sequential/,
		);
		assert.doesNotMatch(reactSearchPrompt, /Mode: CodeAct/);
		assert.ok(
			react.toolCalls.some((call) => call.tool === "discover_case_study_links"),
		);
		assert.ok(
			react.toolCalls.some((call) => call.tool === "react_execution_strategy"),
		);
		assert.ok(
			react.toolCalls.some(
				(call) =>
					call.tool === "react_execution_strategy" &&
					call.output.includes('"targetCount": 4') &&
					call.output.includes('"concurrency": 2') &&
					call.output.includes('"parallelPlan"'),
			),
		);
		assert.ok(
			react.toolCalls.some((call) => call.tool === "react_parallel_plan"),
		);
		assert.ok(
			react.toolCalls.some(
				(call) => call.tool === "fetch_extract_react_action",
			),
		);
		assert.ok(
			react.toolCalls.some(
				(call) => call.tool === "pi_runtime_extract_case_study",
			),
		);
		assert.ok(react.toolCalls.some((call) => call.tool === "llm_output"));
		const reactArtifactPrompt =
			react.toolCalls.find(
				(call) => call.input === "react-case-study-artifact-bundle",
			)?.output ?? "";
		assert.match(reactArtifactPrompt, /Marketing evidence brief:/);
		assert.doesNotMatch(reactArtifactPrompt, /Research state:/);
		assert.doesNotMatch(reactArtifactPrompt, /"discoveredUrls"/);
		assert.doesNotMatch(reactArtifactPrompt, /"attemptedUrls"/);
		assert.doesNotMatch(reactArtifactPrompt, /"records"/);
		assert.doesNotMatch(reactArtifactPrompt, /Mode: react/);
		assert.doesNotMatch(reactArtifactPrompt, /ReAct is sequential/);
		assert.doesNotMatch(reactArtifactPrompt, /Business use cases:/);
		assert.doesNotMatch(reactArtifactPrompt, /Temporal primitive catalog/);
		assert.doesNotMatch(reactArtifactPrompt, /CodeAct bash path/);
		assert.ok(
			react.artifacts.some((artifact) =>
				artifact.relativePath.endsWith("react-case-study-page.html"),
			),
		);

		const codeAct = result.results.find(
			(agentResult) => agentResult.mode === "codeact",
		);
		assert.ok(codeAct);
		assert.equal(codeAct.caseStudyResearch?.records.length, 4);
		assert.ok(
			!codeAct.toolCalls.some(
				(call) => call.input === "codeact-live-temporal-website-search",
			),
		);
		assert.ok(
			codeAct.workerEvents.some(
				(event) => event.workerId === "discovery-subagent-1",
			),
		);
		assert.ok(
			codeAct.workerEvents.some(
				(event) => event.workerId === "discovery-subagent-2",
			),
		);
		assert.ok(
			codeAct.workerEvents.some(
				(event) => event.workerId === "extract-subagent-1",
			),
		);
		assert.ok(
			codeAct.toolCalls.some(
				(call) => call.tool === "pi_runtime_extract_case_study",
			),
		);
		assert.ok(
			codeAct.workerEvents.some((event) => event.phase === "aggregate"),
		);
		assert.ok(codeAct.toolCalls.some((call) => call.tool === "bash"));
		assert.ok(
			codeAct.toolCalls.some(
				(call) => call.tool === "temporal_agent_skill_loaded",
			),
		);
		assert.ok(
			codeAct.toolCalls.some((call) =>
				call.output.includes(
					"Temporal Agent Skill configured for CodeAct scaffold generation",
				),
			),
		);
		assert.ok(
			codeAct.toolCalls.some(
				(call) =>
					call.tool === "pi_agent_skill" &&
					call.input === "codeact-temporal-scaffold-plan" &&
					call.output.includes("skills/temporal-developer/SKILL.md"),
			),
		);
		assert.ok(
			codeAct.toolCalls.some(
				(call) => call.tool === "temporal_validation_references",
			),
		);
		assert.ok(
			codeAct.toolCalls.some((call) =>
				call.output.includes(
					"Temporal Python reference checks used during and after CodeAct generation",
				),
			),
		);
		assert.ok(
			codeAct.toolCalls.some((call) => call.output.includes("RetryPolicy")),
		);
		assert.ok(
			codeAct.toolCalls.some((call) => call.output.includes("asyncio.gather")),
		);
		assert.ok(
			codeAct.toolCalls.some((call) =>
				call.output.includes("generated-code lint: passed"),
			),
		);
		assert.ok(
			codeAct.toolCalls.some(
				(call) => call.input === "codeact-temporal-scaffold-plan",
			),
		);
		const scaffoldPrompt =
			codeAct.toolCalls.find(
				(call) => call.input === "codeact-temporal-scaffold-plan",
			)?.output ?? "";
		assert.match(scaffoldPrompt, /Use the loaded temporal-developer/);
		assert.match(scaffoldPrompt, /Cross-file contract:/);
		assert.match(scaffoldPrompt, /activity_executor/);
		assert.match(scaffoldPrompt, /ThreadPoolExecutor/);
		assert.ok(
			codeAct.artifacts.some((artifact) =>
				artifact.relativePath.endsWith("codeact-case-study-page.html"),
			),
		);
		const codeActArtifactPrompt =
			codeAct.toolCalls.find(
				(call) => call.input === "codeact-case-study-artifact-bundle",
			)?.output ?? "";
		assert.match(codeActArtifactPrompt, /---HTML---/);
		assert.doesNotMatch(codeActArtifactPrompt, /Return ONLY JSON/);

		const scaffoldDir = join(outputDir, "codeact", "runtime-temporal-scaffold");
		await readFile(join(scaffoldDir, "requirements.txt"), "utf8");
		const workflowSource = await readFile(
			join(scaffoldDir, "src", "workflows.py"),
			"utf8",
		);
		const activitiesSource = await readFile(
			join(scaffoldDir, "src", "activities.py"),
			"utf8",
		);
		await readFile(join(scaffoldDir, "src", "worker.py"), "utf8");
		await readFile(join(scaffoldDir, "src", "client.py"), "utf8");
		await readFile(join(scaffoldDir, "src", "extractor.py"), "utf8");

		assert.match(workflowSource, /@workflow\.defn/);
		assert.match(workflowSource, /@workflow\.signal/);
		assert.match(workflowSource, /@workflow\.query/);
		assert.match(workflowSource, /RetryPolicy/);
		assert.match(workflowSource, /asyncio\.gather/);
		assert.match(activitiesSource, /@activity\.defn/);
		assert.match(activitiesSource, /ApplicationError/);

		assert.ok(result.comparisonPath);
		const comparison = await readFile(result.comparisonPath, "utf8");
		assert.match(comparison, /LLM ReAct vs CodeAct Comparison/);
		assert.match(comparison, /react-case-study-page\.html/);
		assert.match(comparison, /codeact-case-study-page\.html/);

		const report = await readFile(result.reportPath, "utf8");
		assert.match(
			report,
			/marketing HTML, citations, agent narratives, CodeAct Python scaffold/,
		);
		assert.match(report, /CodeAct agent/);
		assert.match(report, /react LLM-generated agent narrative/);
		assert.match(report, /temporal-case-study-marketing-page/);
		assert.match(report, /bash: temporal scaffold write/);
		assert.match(report, /generated-code lint: passed/);
		assert.match(report, /bounded_parallel_subagent_extract/);
		assert.match(report, /Parallel Worker Events/);
	} finally {
		await rm(outputDir, { recursive: true, force: true });
	}
});

test("Pi record extraction accepts labeled fields without exact JSON", async () => {
	const outputDir = await mkdtemp(join(tmpdir(), "pi-temporal-harness-"));
	try {
		const result = await runTemporalPiHarnessDemo({
			agent: "react",
			runId: "test-labeled-record-extraction",
			outputDir,
			researchFetchText: makeTemporalMockFetch(),
			researchTargetCount: 1,
			reactPageBudget: 1,
			llmGenerate: async (request) => {
				if (request.purpose === "react-live-temporal-website-search") {
					return JSON.stringify({
						discoveredUrls: [mockCaseStudyUrls[0]],
						executionStrategy: {
							targetCount: 1,
							pageBudget: 1,
							concurrency: 1,
							parallelPlan: ["single branch: fetch one case study"],
							rationale: "test labeled extraction",
						},
						observations: [],
					});
				}
				if (request.purpose === "react-case-study-record-extraction") {
					return [
						"Company: ANZ Bank",
						"Headline: ANZ accelerates home loan origination with Temporal",
						"Summary: ANZ uses Temporal to coordinate durable home-loan workflows across distributed services.",
						"Evidence quote: Temporal helped ANZ keep long-running application state durable while services changed.",
						"Temporal value: Durable execution, retries, and visibility helped ANZ reduce orchestration risk.",
						"Industry: Financial Services",
						"Use case: Loan origination",
					].join("\n");
				}
				return mockHarnessLlmGenerate(request);
			},
		});

		const react = result.results[0];
		assert.equal(react?.mode, "react");
		assert.equal(react.caseStudyResearch?.records.length, 1);
		assert.equal(react.caseStudyResearch?.records[0]?.company, "ANZ Bank");
	} finally {
		await rm(outputDir, { recursive: true, force: true });
	}
});

test("Pi record extraction cache reuses parsed records across runs", async () => {
	const outputDir = await mkdtemp(join(tmpdir(), "pi-temporal-harness-cache-"));
	const cachePath = join(outputDir, "pi-extractions.json");
	let extractionCalls = 0;
	const runWithCache = async (runId: string) =>
		runTemporalPiHarnessDemo({
			agent: "react",
			runId,
			outputDir: join(outputDir, runId),
			researchFetchText: makeTemporalMockFetch(),
			researchTargetCount: 1,
			reactPageBudget: 1,
			enablePiExtractionCache: true,
			piExtractionCachePath: cachePath,
			llmGenerate: async (request) => {
				if (request.purpose === "react-live-temporal-website-search") {
					return JSON.stringify({
						discoveredUrls: [mockCaseStudyUrls[0]],
						executionStrategy: {
							targetCount: 1,
							pageBudget: 1,
							concurrency: 1,
							parallelPlan: ["single branch: fetch one case study"],
							rationale: "test cached extraction",
						},
						observations: [],
					});
				}
				if (request.purpose === "react-case-study-record-extraction") {
					extractionCalls += 1;
					return [
						"Company: ANZ Bank",
						"Headline: ANZ accelerates home loan origination with Temporal",
						"Summary: ANZ uses Temporal to coordinate durable home-loan workflows across distributed services.",
						"Evidence quote: Temporal helped ANZ keep long-running application state durable while services changed.",
						"Temporal value: Durable execution, retries, and visibility helped ANZ reduce orchestration risk.",
						"Industry: Financial Services",
						"Use case: Loan origination",
					].join("\n");
				}
				return mockHarnessLlmGenerate(request);
			},
		});
	try {
		const first = await runWithCache("first");
		assert.equal(
			first.results[0]?.caseStudyResearch?.records[0]?.company,
			"ANZ Bank",
		);
		assert.equal(extractionCalls, 1);

		const second = await runWithCache("second");
		assert.equal(
			second.results[0]?.caseStudyResearch?.records[0]?.company,
			"ANZ Bank",
		);
		assert.equal(extractionCalls, 1);
		assert.ok(
			second.results[0]?.toolCalls.some(
				(call) =>
					call.tool === "pi_runtime_extract_case_study_cache" &&
					call.output.includes('"status": "hit"'),
			),
		);
		const cache = await readFile(cachePath, "utf8");
		assert.match(cache, /ANZ Bank/);
	} finally {
		await rm(outputDir, { recursive: true, force: true });
	}
});

test("CodeAct scaffold generation falls back instead of hanging the demo", async () => {
	const outputDir = await mkdtemp(join(tmpdir(), "pi-temporal-harness-"));
	try {
		const result = await runTemporalPiHarnessDemo({
			agent: "codeact",
			runId: "test-codeact-fallback",
			outputDir,
			researchFetchText: makeTemporalMockFetch(),
			researchTargetCount: 4,
			codeActPageBudget: 6,
			codeActConcurrency: 3,
			llmGenerate: async (request) => {
				if (
					request.purpose === "codeact-temporal-scaffold-file-src-models-py" ||
					request.purpose.startsWith("codeact-temporal-scaffold-repair-")
				) {
					throw new Error("mock scaffold timeout");
				}
				return mockHarnessLlmGenerate(request);
			},
		});

		const codeAct = result.results[0];
		assert.equal(codeAct?.mode, "codeact");
		assert.equal(codeAct.caseStudyResearch?.records.length, 4);
		assert.ok(
			codeAct.toolCalls.some(
				(call) => call.tool === "scaffold_repair_feedback",
			),
		);
		assert.ok(
			codeAct.toolCalls.some(
				(call) => call.tool === "scaffold_generation_fallback",
			),
		);
		assert.ok(
			codeAct.toolCalls.some((call) =>
				call.output.includes("generated-code lint: passed"),
			),
		);
		assert.ok(
			codeAct.artifacts.some((artifact) =>
				artifact.relativePath.endsWith("codeact-case-study-page.html"),
			),
		);
	} finally {
		await rm(outputDir, { recursive: true, force: true });
	}
});

test("CodeAct feeds malformed scaffold output back to Pi for repair", async () => {
	const outputDir = await mkdtemp(join(tmpdir(), "pi-temporal-harness-"));
	try {
		const result = await runTemporalPiHarnessDemo({
			agent: "codeact",
			runId: "test-codeact-repair",
			outputDir,
			researchFetchText: makeTemporalMockFetch(),
			researchTargetCount: 4,
			codeActPageBudget: 6,
			codeActConcurrency: 3,
			llmGenerate: async (request) => {
				if (
					request.purpose === "codeact-temporal-scaffold-file-src-workflows-py"
				) {
					return "this is malformed CodeAct output, not a workflow file";
				}
				if (
					request.purpose ===
					"codeact-temporal-scaffold-repair-1-src-workflows-py"
				) {
					return scaffoldFileContents("src/workflows.py");
				}
				return mockHarnessLlmGenerate(request);
			},
		});

		const codeAct = result.results[0];
		assert.equal(codeAct?.mode, "codeact");
		assert.ok(
			codeAct.toolCalls.some(
				(call) =>
					call.input === "codeact-temporal-scaffold-repair-1-src-workflows-py",
			),
		);
		assert.ok(
			codeAct.toolCalls.some(
				(call) => call.tool === "scaffold_repair_feedback",
			),
		);
		assert.ok(
			codeAct.toolCalls.some((call) => call.tool === "scaffold_repair_success"),
		);
		assert.ok(
			!codeAct.toolCalls.some(
				(call) => call.tool === "scaffold_generation_fallback",
			),
		);
		assert.ok(
			codeAct.toolCalls.some((call) =>
				call.output.includes("generated-code lint: passed"),
			),
		);
		assert.ok(
			codeAct.artifacts.some((artifact) =>
				artifact.relativePath.endsWith("codeact-case-study-page.html"),
			),
		);
	} finally {
		await rm(outputDir, { recursive: true, force: true });
	}
});

test("CodeAct rejects placeholder case-study URLs without displaying them as generated code", async () => {
	const outputDir = await mkdtemp(join(tmpdir(), "pi-temporal-harness-"));
	try {
		const placeholderActivities = scaffoldFileContents(
			"src/activities.py",
		).replace(
			"https://temporal.io/in-use",
			"https://temporal.io/case-studies/example-1",
		);
		const result = await runTemporalPiHarnessDemo({
			agent: "codeact",
			runId: "test-codeact-placeholder-repair",
			outputDir,
			researchFetchText: makeTemporalMockFetch(),
			researchTargetCount: 4,
			codeActPageBudget: 6,
			codeActConcurrency: 3,
			llmGenerate: async (request) => {
				if (
					request.purpose === "codeact-temporal-scaffold-file-src-activities-py"
				) {
					return placeholderActivities;
				}
				if (
					request.purpose ===
					"codeact-temporal-scaffold-repair-1-src-activities-py"
				) {
					return scaffoldFileContents("src/activities.py");
				}
				return mockHarnessLlmGenerate(request);
			},
		});

		const codeAct = result.results[0];
		assert.equal(codeAct?.mode, "codeact");
		assert.ok(
			codeAct.toolCalls.some((call) => call.tool === "llm_output_rejected"),
		);
		assert.ok(
			codeAct.toolCalls.some((call) => call.tool === "scaffold_repair_success"),
		);
		assert.ok(
			!codeAct.toolCalls.some(
				(call) => call.tool === "llm_output" && call.input.includes("scaffold"),
			),
		);
		assert.ok(
			!codeAct.toolCalls.some((call) =>
				call.output.includes("https://temporal.io/case-studies/example-1"),
			),
		);
	} finally {
		await rm(outputDir, { recursive: true, force: true });
	}
});

test("CodeAct rejects mutable discovered URL indexing before Cloud execution", async () => {
	const outputDir = await mkdtemp(join(tmpdir(), "pi-temporal-harness-"));
	try {
		const unsafeWorkflow = scaffoldFileContents("src/workflows.py").replace(
			"for url, result in zip(batch, results):",
			"for i, result in enumerate(results):\n                url = self._state.discovered_urls[len(self._state.attempted_urls) + i]",
		);
		const result = await runTemporalPiHarnessDemo({
			agent: "codeact",
			runId: "test-codeact-index-repair",
			outputDir,
			researchFetchText: makeTemporalMockFetch(),
			researchTargetCount: 4,
			codeActPageBudget: 6,
			codeActConcurrency: 3,
			llmGenerate: async (request) => {
				if (
					request.purpose === "codeact-temporal-scaffold-file-src-workflows-py"
				) {
					return unsafeWorkflow;
				}
				if (
					request.purpose ===
					"codeact-temporal-scaffold-repair-1-src-workflows-py"
				) {
					return scaffoldFileContents("src/workflows.py");
				}
				return mockHarnessLlmGenerate(request);
			},
		});

		const codeAct = result.results[0];
		assert.equal(codeAct?.mode, "codeact");
		assert.ok(
			codeAct.toolCalls.some((call) => call.tool === "llm_output_rejected"),
		);
		assert.ok(
			codeAct.toolCalls.some((call) => call.tool === "scaffold_repair_success"),
		);
		const workflowSource = await readFile(
			join(
				outputDir,
				"codeact",
				"runtime-temporal-scaffold",
				"src",
				"workflows.py",
			),
			"utf8",
		);
		assert.doesNotMatch(
			workflowSource,
			/len\(self\._state\.attempted_urls\) \+ i/,
		);
		assert.match(workflowSource, /zip\(batch, results\)/);
	} finally {
		await rm(outputDir, { recursive: true, force: true });
	}
});

test("CodeAct rejects workflow result type filters that drop Temporal payload records", async () => {
	const outputDir = await mkdtemp(join(tmpdir(), "pi-temporal-harness-"));
	try {
		const unsafeWorkflow = scaffoldFileContents("src/workflows.py").replace(
			"                else:\n                    self._state.records.append(result)",
			"                elif isinstance(result, CaseStudyRecord):\n                    self._state.records.append(result)",
		);
		const result = await runTemporalPiHarnessDemo({
			agent: "codeact",
			runId: "test-codeact-payload-filter-repair",
			outputDir,
			researchFetchText: makeTemporalMockFetch(),
			researchTargetCount: 4,
			codeActPageBudget: 6,
			codeActConcurrency: 3,
			llmGenerate: async (request) => {
				if (
					request.purpose === "codeact-temporal-scaffold-file-src-workflows-py"
				) {
					return unsafeWorkflow;
				}
				if (
					request.purpose ===
					"codeact-temporal-scaffold-repair-1-src-workflows-py"
				) {
					return scaffoldFileContents("src/workflows.py");
				}
				return mockHarnessLlmGenerate(request);
			},
		});

		const codeAct = result.results[0];
		assert.equal(codeAct?.mode, "codeact");
		assert.ok(
			codeAct.toolCalls.some((call) => call.tool === "llm_output_rejected"),
		);
		assert.ok(
			codeAct.toolCalls.some((call) => call.tool === "scaffold_repair_success"),
		);
		const workflowSource = await readFile(
			join(
				outputDir,
				"codeact",
				"runtime-temporal-scaffold",
				"src",
				"workflows.py",
			),
			"utf8",
		);
		assert.doesNotMatch(
			workflowSource,
			/isinstance\(result, CaseStudyRecord\)/,
		);
		assert.match(workflowSource, /self\._state\.records\.append\(result\)/);
	} finally {
		await rm(outputDir, { recursive: true, force: true });
	}
});

test("malformed LLM artifact JSON falls back to deterministic artifacts", async () => {
	const outputDir = await mkdtemp(join(tmpdir(), "pi-temporal-harness-"));
	try {
		const result = await runTemporalPiHarnessDemo({
			agent: "codeact",
			runId: "test-artifact-fallback",
			outputDir,
			researchFetchText: makeTemporalMockFetch(),
			researchTargetCount: 4,
			codeActPageBudget: 6,
			codeActConcurrency: 3,
			llmGenerate: async (request) => {
				if (request.purpose === "codeact-case-study-artifact-bundle") {
					return '{"html":"<!doctype html><html></html>","citationsMarkdown":["bad"]';
				}
				return mockHarnessLlmGenerate(request);
			},
		});

		const codeAct = result.results[0];
		assert.equal(codeAct?.mode, "codeact");
		assert.ok(
			codeAct.toolCalls.some(
				(call) => call.tool === "artifact_bundle_fallback",
			),
		);
		const htmlArtifact = codeAct.artifacts.find((artifact) =>
			artifact.relativePath.endsWith("codeact-case-study-page.html"),
		);
		assert.ok(htmlArtifact);
		const html = await readFile(htmlArtifact.path, "utf8");
		assert.match(html, /CodeAct Case Study Page/);
	} finally {
		await rm(outputDir, { recursive: true, force: true });
	}
});

test("failed LLM artifact generation falls back to deterministic artifacts", async () => {
	const outputDir = await mkdtemp(join(tmpdir(), "pi-temporal-harness-"));
	try {
		const result = await runTemporalPiHarnessDemo({
			agent: "codeact",
			runId: "test-artifact-generation-fallback",
			outputDir,
			researchFetchText: makeTemporalMockFetch(),
			researchTargetCount: 4,
			codeActPageBudget: 6,
			codeActConcurrency: 3,
			llmGenerate: async (request) => {
				if (request.purpose === "codeact-case-study-artifact-bundle") {
					throw new Error("mock Pi artifact timeout");
				}
				return mockHarnessLlmGenerate(request);
			},
		});

		const codeAct = result.results[0];
		assert.equal(codeAct?.mode, "codeact");
		assert.ok(
			codeAct.toolCalls.some(
				(call) => call.tool === "artifact_bundle_fallback",
			),
		);
		assert.ok(
			codeAct.artifacts.some((artifact) =>
				artifact.relativePath.endsWith("codeact-case-study-page.html"),
			),
		);
	} finally {
		await rm(outputDir, { recursive: true, force: true });
	}
});

test("tagged LLM artifact bundle avoids HTML-in-JSON escaping", async () => {
	const outputDir = await mkdtemp(join(tmpdir(), "pi-temporal-harness-"));
	try {
		const result = await runTemporalPiHarnessDemo({
			agent: "codeact",
			runId: "test-tagged-artifact-bundle",
			outputDir,
			researchFetchText: makeTemporalMockFetch(),
			researchTargetCount: 4,
			codeActPageBudget: 6,
			codeActConcurrency: 3,
			llmGenerate: async (request) => {
				if (request.purpose === "codeact-case-study-artifact-bundle") {
					return [
						"---HTML---",
						'<!doctype html><html lang="en"><body><h1>Tagged CodeAct Page</h1></body></html>',
						"---CITATIONS---",
						"# Tagged Citations",
						"",
						"- https://temporal.io/resources/case-studies/anz-story",
						"---NARRATIVE---",
						"# Tagged Narrative",
						"",
						"CodeAct artifact returned without JSON escaping.",
						"---END---",
					].join("\n");
				}
				return mockHarnessLlmGenerate(request);
			},
		});

		const codeAct = result.results[0];
		assert.equal(codeAct?.mode, "codeact");
		assert.ok(
			!codeAct.toolCalls.some(
				(call) => call.tool === "artifact_bundle_fallback",
			),
		);
		const htmlArtifact = codeAct.artifacts.find((artifact) =>
			artifact.relativePath.endsWith("codeact-case-study-page.html"),
		);
		assert.ok(htmlArtifact);
		const html = await readFile(htmlArtifact.path, "utf8");
		assert.match(html, /Tagged CodeAct Page/);
	} finally {
		await rm(outputDir, { recursive: true, force: true });
	}
});

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = value;
}

function scaffoldFileContents(path: string): string {
	const file = createTemporalScaffoldSpec().files.find(
		(candidate) => candidate.path === path,
	);
	if (!file) throw new Error(`Unknown scaffold path: ${path}`);
	return file.contents;
}
