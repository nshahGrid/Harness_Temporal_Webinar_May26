import {
	CASE_STUDY_TARGET_COUNT,
	collectTemporalCaseStudies,
	type FetchText,
	renderCaseStudyMarketingPage,
	TEMPORAL_CUSTOMER_STORIES_URL,
	TEMPORAL_SITEMAP_URL,
} from "./case-study-research.ts";
import { getScenarioDefinition } from "./scenario-definitions.ts";
import type { PromptPack, ScenarioId } from "./types.ts";

export interface BuildPromptPackOptions {
	fetchText?: FetchText;
	targetCount?: number;
	includePreparedResearch?: boolean;
}

export async function buildPromptPack(
	scenarioId: ScenarioId,
	options: BuildPromptPackOptions = {},
): Promise<PromptPack> {
	switch (scenarioId) {
		case "temporal-case-study-marketing-page":
			return temporalCaseStudyMarketingPromptPack(options);
	}
}

export function buildFixturePiOutput(pack: PromptPack): string {
	const result = pack.preparedData.researchResult;
	if (!isResearchResult(result)) {
		throw new Error(
			"Prompt pack is missing Temporal case-study research data.",
		);
	}
	const rows = result.records
		.map(
			(record) =>
				`| ${record.company} | ${record.headline} | ${record.useCase ?? "Story copy"} | ${record.url} |`,
		)
		.join("\n");
	return `# ${pack.title}

## Live Customer-Proof Matrix
Target: ${result.targetCount} Temporal customer stories
Extracted: ${result.records.length}
Status: ${result.status}
Exit condition: ${result.exitCondition}

| Company | Headline | Use case | Source |
| --- | --- | --- | --- |
${rows || "| No valid records extracted | Needs review | Needs review | Source crawl incomplete |"}

## Coverage Notes
- ReAct should use the same target/page budget as CodeAct while letting Pi choose branch planning and bounded concurrency.
- CodeAct should write and validate Python Temporal scaffold code, then use bounded parallel extraction for broader coverage.
- If fewer than ${result.targetCount} valid records are found, keep the workflow in a needs-review state instead of inventing customer stories.

## Marketing HTML Draft
\`\`\`html
${renderCaseStudyMarketingPage("workflow", result)}
\`\`\`

## Approval Gate
Approve before exporting this draft-only marketing artifact. The demo does not publish pages, send emails, update CRM, expose env vars, or invent missing case studies.`;
}

async function temporalCaseStudyMarketingPromptPack(
	options: BuildPromptPackOptions,
): Promise<PromptPack> {
	const scenario = getScenarioDefinition("temporal-case-study-marketing-page");
	const targetCount = options.targetCount ?? CASE_STUDY_TARGET_COUNT;
	const researchResult = options.includePreparedResearch
		? await collectTemporalCaseStudies({
				mode: "workflow",
				targetCount,
				fetchText: options.fetchText,
			})
		: undefined;
	return {
		scenarioId: scenario.id,
		title: scenario.title,
		summary: scenario.shortDescription,
		temporalStory: scenario.temporalStory,
		fixturePaths: [TEMPORAL_CUSTOMER_STORIES_URL, TEMPORAL_SITEMAP_URL],
		preparedData: researchResult
			? { researchResult }
			: {
					sourceRoots: [TEMPORAL_CUSTOMER_STORIES_URL, TEMPORAL_SITEMAP_URL],
					targetCount,
					preloadedDiscoveredUrls: 0,
					preloadedExtractedRecords: 0,
				},
		prompt: `You are running the ${scenario.title} Temporal demo.

Business goal:
Search Temporal's live website for up to ${targetCount} valid customer case-study pages, extract customer-proof data, and generate a draft marketing HTML page with source citations.

Live search requirement:
- Use the installed free_web_search and free_fetch_content tools to search/fetch Temporal-owned pages. Do not rely on preloaded discovered URLs or saved local artifacts.
- Start from ${TEMPORAL_CUSTOMER_STORIES_URL}. You may use ${TEMPORAL_SITEMAP_URL} as a fallback discovery source.
- The Temporal preparation step intentionally did not include discovered case-study URLs or extracted customer records.
- If a fetched field looks like a page title, navigation label, product announcement banner, or extraction artifact, flag it in coverage notes instead of treating it as customer proof.

Produce:
1. A customer-proof matrix with company, headline, extracted use case, evidence quote, and source URL.
2. Coverage-gap notes when fewer than ${targetCount} case studies are found.
3. A complete HTML marketing page artifact using only extracted facts and citations.
4. A short explanation of how Temporal preserves state when search, fetch, extraction, LLM generation, or export fails.
5. An explicit exit condition and approval gate.

Constraints:
- Count only Temporal-owned customer story/case-study pages under /resources/case-studies/.
- Do not invent missing customer stories, customer metrics, or unobserved claims.
- Do not expose environment variables, API keys, Temporal namespace, PI_COMMAND, or raw secrets.
- The demo never sends messages externally and never publishes the generated HTML.

Temporal preparation state:
${JSON.stringify(
	{
		sourceRoots: [TEMPORAL_CUSTOMER_STORIES_URL, TEMPORAL_SITEMAP_URL],
		targetCount,
		preloadedDiscoveredUrls: 0,
		preloadedExtractedRecords: 0,
		exitCondition:
			"Pi must search/fetch live Temporal-owned pages, then stop when target records are found, the budget is exhausted, or a reviewer pauses.",
	},
	null,
	2,
)}`,
	};
}

function isResearchResult(
	value: unknown,
): value is Awaited<ReturnType<typeof collectTemporalCaseStudies>> {
	return Boolean(
		value &&
			typeof value === "object" &&
			"records" in value &&
			"targetCount" in value,
	);
}
