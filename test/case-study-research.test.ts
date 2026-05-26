import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
	collectTemporalCaseStudies,
	discoverCaseStudyLinksFromHtml,
	discoverCaseStudyLinksFromSitemap,
	extractCaseStudyRecordFromHtml,
	renderCaseStudyMarketingPage,
	renderComparisonMarkdown,
} from "../src/case-study-research.ts";
import { packageRoot } from "../src/paths.ts";
import { makeTemporalMockFetch, mockCaseStudyUrls } from "./mock-temporal.ts";

test("discovers case-study links from a customer-story hub page", () => {
	const links = discoverCaseStudyLinksFromHtml(`
    <a href="/resources/case-studies/anz-story">ANZ</a>
    <a href="https://temporal.io/resources/case-studies/checkr">Checkr</a>
    <a href="https://temporal.io/blog/not-a-case-study">Blog</a>
  `);
	assert.deepEqual(links, [
		"https://temporal.io/resources/case-studies/anz-story",
		"https://temporal.io/resources/case-studies/checkr",
	]);
});

test("discovers case-study links from sitemap XML and rejects non-customer-story pages", () => {
	const links = discoverCaseStudyLinksFromSitemap(`
    <url><loc>https://temporal.io/resources/case-studies/coinbase</loc></url>
    <url><loc>https://temporal.io/blog/not-a-case-study</loc></url>
  `);
	assert.deepEqual(links, [
		"https://temporal.io/resources/case-studies/coinbase",
	]);
});

test("extracts structured CaseStudyRecord fields from a case-study page", async () => {
	const fetchText = makeTemporalMockFetch();
	const html = await fetchText(mockCaseStudyUrls[0]);
	const record = extractCaseStudyRecordFromHtml(mockCaseStudyUrls[0], html);
	assert.ok(record);
	assert.equal(record.company, "ANZ");
	assert.equal(record.industry, "Financial Services");
	assert.equal(record.useCase, "Reliable workflow orchestration");
	assert.match(record.temporalValue, /Temporal/);
	assert.equal(
		extractCaseStudyRecordFromHtml(
			"https://temporal.io/blog/not-a-case-study",
			html,
		),
		undefined,
	);
});

test("partial extraction state survives failed fetch attempts and fewer-than-target pauses for review", async () => {
	const result = await collectTemporalCaseStudies({
		mode: "codeact",
		targetCount: 20,
		pageBudget: 6,
		concurrency: 3,
		fetchText: makeTemporalMockFetch({ failFirstFor: mockCaseStudyUrls[2] }),
	});
	assert.equal(result.records.length, 6);
	assert.equal(result.status, "needs_review");
	assert.equal(result.retries, 1);
	assert.match(
		result.exitCondition,
		/needs review|pause for review|valid records/i,
	);
});

test("collectTemporalCaseStudies can use Pi-discovered URLs instead of local discovery", async () => {
	const result = await collectTemporalCaseStudies({
		mode: "react",
		targetCount: 2,
		pageBudget: 2,
		discoveredUrls: [
			mockCaseStudyUrls[1],
			"https://temporal.io/blog/not-a-case-study",
			mockCaseStudyUrls[0],
		],
		fetchText: makeTemporalMockFetch(),
	});
	assert.deepEqual(result.discoveredUrls, [
		mockCaseStudyUrls[0],
		mockCaseStudyUrls[1],
	]);
	assert.equal(result.attemptedUrls.length, 2);
	assert.equal(result.records.length, 2);
});

test("collection can delegate record extraction instead of using HTML heuristics", async () => {
	let extractionCalls = 0;
	const result = await collectTemporalCaseStudies({
		mode: "react",
		targetCount: 1,
		pageBudget: 1,
		discoveredUrls: [mockCaseStudyUrls[0]],
		fetchText: async () =>
			"<html><body><main>semantic page payload</main></body></html>",
		extractRecord: async (url, html) => {
			extractionCalls += 1;
			assert.match(html, /semantic page payload/);
			return {
				url,
				slug: "anz-story",
				company: "ANZ",
				headline: "ANZ uses Temporal to run resilient customer workflows",
				summary:
					"ANZ uses Temporal to orchestrate critical business workflows with durable execution.",
				evidenceQuote:
					"ANZ reduced operational risk by keeping workflow state durable while workers may fail.",
				temporalValue:
					"ANZ uses Temporal to orchestrate critical business workflows with durable execution.",
				sourceType: "Temporal case study",
			};
		},
	});

	assert.equal(extractionCalls, 1);
	assert.equal(result.records[0]?.company, "ANZ");
});

test("ReAct collection honors model-selected concurrency instead of forcing one lane", async () => {
	const baseFetch = makeTemporalMockFetch();
	let active = 0;
	let maxActive = 0;
	const result = await collectTemporalCaseStudies({
		mode: "react",
		targetCount: 4,
		pageBudget: 4,
		concurrency: 3,
		discoveredUrls: mockCaseStudyUrls.slice(0, 4),
		fetchText: async (url) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			try {
				return await baseFetch(url);
			} finally {
				active -= 1;
			}
		},
	});

	assert.equal(result.concurrency, 3);
	assert.equal(result.records.length, 4);
	assert.ok(maxActive > 1);
});

test("renders separate HTML pages and comparison report", async () => {
	const react = await collectTemporalCaseStudies({
		mode: "react",
		targetCount: 4,
		pageBudget: 2,
		fetchText: makeTemporalMockFetch(),
	});
	const codeact = await collectTemporalCaseStudies({
		mode: "codeact",
		targetCount: 4,
		pageBudget: 6,
		concurrency: 3,
		fetchText: makeTemporalMockFetch(),
	});
	assert.match(
		renderCaseStudyMarketingPage("react", react),
		/ReAct Case Study Page/,
	);
	assert.match(
		renderCaseStudyMarketingPage("codeact", codeact),
		/CodeAct Case Study Page/,
	);
	const comparison = renderComparisonMarkdown(react, codeact);
	assert.match(comparison, /react-case-study-page\.html/);
	assert.match(comparison, /codeact-case-study-page\.html/);
});

test("citation file includes Temporal Python references and customer-story source URLs", async () => {
	const citations = await readFile(
		join(packageRoot, "TEMPORAL_SKILL_CITATIONS.md"),
		"utf8",
	);
	assert.match(citations, /references\/python\/python\.md/);
	assert.match(citations, /references\/python\/determinism\.md/);
	assert.match(citations, /temporal\.io\/resources\/case-studies/);
});
