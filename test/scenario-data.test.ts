import assert from "node:assert/strict";
import { test } from "node:test";
import {
	extractHtmlSignals,
	parseCsv,
	parseSimpleYaml,
} from "../src/parsers.ts";
import { buildFixturePiOutput, buildPromptPack } from "../src/scenario-data.ts";
import { scenarioIds } from "../src/types.ts";
import { makeTemporalMockFetch } from "./mock-temporal.ts";

test("parseCsv handles quoted values and headers", () => {
	const rows = parseCsv('name,note\n"Acme, Inc.","hello ""world"""');
	assert.deepEqual(rows, [{ name: "Acme, Inc.", note: 'hello "world"' }]);
});

test("extractHtmlSignals returns core page structure", () => {
	const signals = extractHtmlSignals(
		"<title>T</title><h1>Hero</h1><h2>Proof</h2><a href='/x'>CTA</a><form></form>",
	);
	assert.equal(signals.title, "T");
	assert.equal(signals.h1, "Hero");
	assert.deepEqual(signals.headings, ["Proof"]);
	assert.deepEqual(signals.ctas, ["CTA"]);
	assert.equal(signals.formCount, 1);
});

test("parseSimpleYaml reads flat fixture metrics", () => {
	assert.deepEqual(parseSimpleYaml('a: one\nb: "two"'), { a: "one", b: "two" });
});

for (const scenarioId of scenarioIds) {
	test(`builds prompt pack without preloading discovered URLs for ${scenarioId}`, async () => {
		const pack = await buildPromptPack(scenarioId, {
			fetchText: makeTemporalMockFetch(),
			targetCount: 4,
		});
		assert.equal(pack.scenarioId, scenarioId);
		assert.ok(pack.prompt.includes(pack.title));
		assert.ok(pack.fixturePaths.length > 0);
		assert.ok(Object.keys(pack.preparedData).length > 0);
		assert.equal(pack.preparedData.preloadedDiscoveredUrls, 0);
		assert.equal(pack.preparedData.researchResult, undefined);
		assert.doesNotMatch(pack.prompt, /"discoveredUrls"/);
		assert.doesNotMatch(pack.prompt, /"records"/);
		assert.doesNotMatch(pack.prompt, /Prepared live research result/);
		assert.doesNotMatch(pack.prompt, /Developer demo contrast/);
		assert.doesNotMatch(pack.prompt, /ReAct is sequential/);
		assert.doesNotMatch(pack.prompt, /CodeAct uses Pi/);
		assert.doesNotMatch(pack.prompt, /Temporal is the durable state layer/);
		assert.doesNotMatch(pack.prompt, /\$JSON\.stringify/);
		assert.match(pack.prompt, /preloadedDiscoveredUrls/);
	});

	test(`builds explicit fixture output for ${scenarioId}`, async () => {
		const pack = await buildPromptPack(scenarioId, {
			fetchText: makeTemporalMockFetch(),
			targetCount: 4,
			includePreparedResearch: true,
		});
		const output = buildFixturePiOutput(pack);
		assert.ok(output.includes(pack.title));
		assert.ok(output.includes("Approval Gate"));
		assert.ok(output.includes("Marketing HTML Draft"));
	});
}
