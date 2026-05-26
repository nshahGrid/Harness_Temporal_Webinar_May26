import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { packageRoot } from "../src/paths.ts";
import { buildAgentLadder, buildDemoModes } from "../src/web/agent-ladder.ts";

test("agent ladder explains ReAct and CodeAct with developer code", () => {
	const ladder = buildAgentLadder();
	assert.deepEqual(
		ladder.map((step) => step.id),
		["simple", "react", "codeact"],
	);

	const react = ladder.find((step) => step.id === "react");
	assert.ok(react);
	assert.match(react.definition, /Reason \+ Act/);
	assert.match(react.snippets[0]?.code ?? "", /inspectTemporalCatalog/);

	const codeact = ladder.find((step) => step.id === "codeact");
	assert.ok(codeact);
	assert.match(codeact.definition, /bash escape hatch/);
	assert.ok(
		codeact.snippets.some((snippet) =>
			snippet.code.includes("temporal agent skill load"),
		),
	);
	assert.ok(
		codeact.snippets.some((snippet) =>
			snippet.code.includes('bash("temporal scaffold write")'),
		),
	);
	assert.ok(
		codeact.snippets.some((snippet) =>
			snippet.code.includes("TemporalCaseStudyResearchWorkflow"),
		),
	);
	assert.ok(
		codeact.snippets.some((snippet) =>
			snippet.code.includes("fetch_and_extract_case_study"),
		),
	);
	assert.ok(
		codeact.snippets.some((snippet) =>
			snippet.code.includes("bounded_parallel_extract"),
		),
	);
});

test("demo modes distinguish direct CodeAct from Harness with CodeAct", () => {
	const modes = buildDemoModes();
	assert.deepEqual(
		modes.map((mode) => mode.id),
		["codeact", "harness-codeact"],
	);

	const codeact = modes.find((mode) => mode.id === "codeact");
	assert.ok(codeact);
	assert.match(codeact.definition, /code execution/);
	assert.ok(
		codeact.snippets.some((snippet) =>
			snippet.code.includes("temporal scaffold write"),
		),
	);
	assert.ok(
		codeact.snippets.some((snippet) =>
			snippet.code.includes("temporal case-study extract"),
		),
	);

	const harness = modes.find((mode) => mode.id === "harness-codeact");
	assert.ok(harness);
	assert.match(harness.definition, /controlled demo surface/);
	assert.ok(
		harness.snippets.some((snippet) =>
			snippet.code.includes("new PiTemporalHarness"),
		),
	);
	assert.ok(
		harness.outputs.some((output) => output.includes("Agent ladder report")),
	);
});

test("web UI highlights Temporal primitives in generated code blocks", async () => {
	const html = await readFile(
		join(packageRoot, "src", "web", "index.html"),
		"utf8",
	);
	assert.match(html, /temporal-primitive/);
	assert.match(html, /renderHighlightedCode/);
	assert.match(html, /syntax-keyword/);
	assert.match(html, /syntax-string/);
	assert.match(html, /code-line/);
	assert.match(html, /line-no/);
	assert.match(html, /formatCodeForDisplay/);
	assert.match(html, /@workflow\.defn/);
	assert.match(html, /workflow\.execute_activity/);
});

test("web UI separates ReAct and CodeAct harness runs", async () => {
	const html = await readFile(
		join(packageRoot, "src", "web", "index.html"),
		"utf8",
	);
	assert.match(html, /id="runReactHarness"/);
	assert.match(html, /2\. ReAct baseline/);
	assert.match(html, /id="runCodeActHarness"/);
	assert.match(html, /3\. CodeAct \+ Temporal/);
	assert.match(html, /4\. Compare marketing pages/);
	assert.match(html, /5\. Open artifacts/);
	assert.match(html, /Error-prone demo: retryable failures/);
	assert.doesNotMatch(html, />1\. Start Temporal</);
	assert.doesNotMatch(html, />2\. Stream Pi Generation</);
	assert.doesNotMatch(html, />3\. Signal Policy Inspect</);
	assert.match(html, /streamHarness\("react"\)/);
	assert.match(html, /streamHarness\("codeact"\)/);
	assert.match(html, /appendHarnessCompletionSummary/);
	assert.match(html, /Harness run complete/);
	assert.match(html, /No comparison report was generated/);
	assert.match(html, /Open harness report/);
});

test("web UI shows the exact compact Pi prompt sent during streaming", async () => {
	const html = await readFile(
		join(packageRoot, "src", "web", "index.html"),
		"utf8",
	);
	assert.match(html, /event\.type === "prompt_pack"/);
	assert.match(html, /Pi prompt actually sent/);
	assert.match(html, /preloaded URLs/);
	assert.match(html, /preloaded records/);
});
