import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTemporalPiHarnessDemo } from "../src/harness/demo.ts";
import {
	createTemporalScaffoldSpec,
	renderTemporalScaffoldBashScript,
} from "../src/harness/temporal-scaffold.ts";
import {
	makeTemporalMockFetch,
	mockHarnessLlmGenerate,
} from "./mock-temporal.ts";

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
		assert.equal(react.caseStudyResearch?.targetCount, 2);
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
					call.output.includes('"targetCount": 2') &&
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
			codeAct.workerEvents.some((event) => event.phase === "aggregate"),
		);
		assert.ok(codeAct.toolCalls.some((call) => call.tool === "bash"));
		assert.ok(
			codeAct.toolCalls.some(
				(call) => call.tool === "temporal_skill_context_loaded",
			),
		);
		assert.ok(
			codeAct.toolCalls.some((call) =>
				call.output.includes("Temporal Python skill context loaded"),
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
				(call) => call.input === "codeact-temporal-bash-scaffold",
			),
		);
		const scaffoldPrompt =
			codeAct.toolCalls.find(
				(call) => call.input === "codeact-temporal-bash-scaffold",
			)?.output ?? "";
		assert.match(scaffoldPrompt, /Strict validation contract:/);
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
				if (request.purpose === "codeact-temporal-bash-scaffold") {
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
				if (request.purpose === "codeact-temporal-bash-scaffold") {
					return "this is malformed CodeAct output, not a bash heredoc scaffold";
				}
				if (request.purpose === "codeact-temporal-bash-scaffold-repair-1") {
					return mockHarnessLlmGenerate({
						...request,
						purpose: "codeact-temporal-bash-scaffold",
					});
				}
				return mockHarnessLlmGenerate(request);
			},
		});

		const codeAct = result.results[0];
		assert.equal(codeAct?.mode, "codeact");
		assert.ok(
			codeAct.toolCalls.some(
				(call) => call.input === "codeact-temporal-bash-scaffold-repair-1",
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
		const placeholderScaffold = renderTemporalScaffoldBashScript(
			createTemporalScaffoldSpec(),
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
				if (request.purpose === "codeact-temporal-bash-scaffold") {
					return placeholderScaffold;
				}
				if (request.purpose === "codeact-temporal-bash-scaffold-repair-1") {
					return mockHarnessLlmGenerate({
						...request,
						purpose: "codeact-temporal-bash-scaffold",
					});
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
		const unsafeScaffold = renderTemporalScaffoldBashScript(
			createTemporalScaffoldSpec(),
		).replace(
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
				if (request.purpose === "codeact-temporal-bash-scaffold") {
					return unsafeScaffold;
				}
				if (request.purpose === "codeact-temporal-bash-scaffold-repair-1") {
					return mockHarnessLlmGenerate({
						...request,
						purpose: "codeact-temporal-bash-scaffold",
					});
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
		const unsafeScaffold = renderTemporalScaffoldBashScript(
			createTemporalScaffoldSpec(),
		).replace(
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
				if (request.purpose === "codeact-temporal-bash-scaffold") {
					return unsafeScaffold;
				}
				if (request.purpose === "codeact-temporal-bash-scaffold-repair-1") {
					return mockHarnessLlmGenerate({
						...request,
						purpose: "codeact-temporal-bash-scaffold",
					});
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
