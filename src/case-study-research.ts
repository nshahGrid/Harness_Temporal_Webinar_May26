export const TEMPORAL_CUSTOMER_STORIES_URL = "https://temporal.io/in-use";
export const TEMPORAL_SITEMAP_URL = "https://temporal.io/sitemap.xml";
export const CASE_STUDY_TARGET_COUNT = 20;
export const REACT_DEFAULT_PAGE_BUDGET = 6;
export const CODEACT_PAGE_BUDGET = 40;
export const CODEACT_CONCURRENCY = 8;

export type CaseStudyResearchMode = "react" | "codeact" | "workflow";
export type FetchText = (url: string) => Promise<string>;

export interface CaseStudyRecord {
	url: string;
	slug: string;
	company: string;
	headline: string;
	summary: string;
	evidenceQuote: string;
	temporalValue: string;
	industry?: string;
	useCase?: string;
	companySize?: string;
	sdk?: string;
	deployment?: string;
	sourceType: "Temporal case study";
}

export interface FailedPage {
	url: string;
	step: "discover" | "fetch" | "extract";
	reason: string;
	attempts: number;
	retryable: boolean;
}

export interface CaseStudyResearchResult {
	mode: CaseStudyResearchMode;
	targetCount: number;
	pageBudget: number;
	concurrency: number;
	sourceRoots: string[];
	discoveredUrls: string[];
	attemptedUrls: string[];
	records: CaseStudyRecord[];
	failures: FailedPage[];
	retries: number;
	startedAt: string;
	completedAt: string;
	elapsedMs: number;
	status: "complete" | "needs_review";
	exitCondition: string;
}

interface CollectOptions {
	mode: CaseStudyResearchMode;
	targetCount?: number;
	pageBudget?: number;
	concurrency?: number;
	fetchText?: FetchText;
	discoveredUrls?: string[];
	sourceRoots?: string[];
}

export async function defaultFetchText(url: string): Promise<string> {
	const response = await fetch(url, {
		headers: {
			accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"user-agent": "pi-temporal-case-study-demo/0.1",
		},
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
	}
	return response.text();
}

export async function collectTemporalCaseStudies(
	options: CollectOptions,
): Promise<CaseStudyResearchResult> {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const fetchText = options.fetchText ?? defaultFetchText;
	const targetCount = options.targetCount ?? CASE_STUDY_TARGET_COUNT;
	const pageBudget =
		options.pageBudget ??
		(options.mode === "react"
			? REACT_DEFAULT_PAGE_BUDGET
			: Math.max(CODEACT_PAGE_BUDGET, targetCount));
	const concurrency = Math.max(
		1,
		options.concurrency ??
			(options.mode === "codeact" ? CODEACT_CONCURRENCY : 1),
	);
	const failures: FailedPage[] = [];
	const discoveredUrls = options.discoveredUrls?.length
		? uniqueUrls(options.discoveredUrls.filter(isTemporalCaseStudyUrl))
		: await discoverTemporalCaseStudyUrls(fetchText, failures);
	const attemptedUrls = discoveredUrls.slice(0, pageBudget);
	const records: CaseStudyRecord[] = [];
	let retries = 0;
	const maxAttempts = options.mode === "react" ? 1 : 2;

	if (concurrency === 1) {
		for (const url of attemptedUrls) {
			if (records.length >= targetCount) break;
			const result = await fetchExtractWithRetry(url, fetchText, maxAttempts);
			if (result.record) records.push(result.record);
			if (result.failure) failures.push(result.failure);
			retries += result.retries;
		}
	} else {
		const results = await mapLimit(attemptedUrls, concurrency, (url) =>
			fetchExtractWithRetry(url, fetchText, maxAttempts),
		);
		for (const result of results) {
			if (result.record && records.length < targetCount)
				records.push(result.record);
			if (result.failure) failures.push(result.failure);
			retries += result.retries;
		}
	}

	const completedAtMs = Date.now();
	const status = records.length >= targetCount ? "complete" : "needs_review";
	return {
		mode: options.mode,
		targetCount,
		pageBudget,
		concurrency,
		sourceRoots: options.sourceRoots ?? [
			TEMPORAL_CUSTOMER_STORIES_URL,
			TEMPORAL_SITEMAP_URL,
		],
		discoveredUrls,
		attemptedUrls,
		records,
		failures,
		retries,
		startedAt,
		completedAt: new Date(completedAtMs).toISOString(),
		elapsedMs: completedAtMs - startedAtMs,
		status,
		exitCondition: exitCondition(
			options.mode,
			status,
			records.length,
			targetCount,
			attemptedUrls.length,
			pageBudget,
			concurrency,
		),
	};
}

export async function discoverTemporalCaseStudyUrls(
	fetchText: FetchText = defaultFetchText,
	failures: FailedPage[] = [],
): Promise<string[]> {
	const urls: string[] = [];
	try {
		urls.push(
			...discoverCaseStudyLinksFromHtml(
				await fetchText(TEMPORAL_CUSTOMER_STORIES_URL),
			),
		);
	} catch (error) {
		failures.push(discoveryFailure(TEMPORAL_CUSTOMER_STORIES_URL, error));
	}
	try {
		urls.push(
			...discoverCaseStudyLinksFromSitemap(
				await fetchText(TEMPORAL_SITEMAP_URL),
			),
		);
	} catch (error) {
		failures.push(discoveryFailure(TEMPORAL_SITEMAP_URL, error));
	}
	return uniqueUrls(urls.filter(isTemporalCaseStudyUrl));
}

export function discoverCaseStudyLinksFromHtml(
	html: string,
	baseUrl = TEMPORAL_CUSTOMER_STORIES_URL,
): string[] {
	const urls: string[] = [];
	for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
		const href = match[1];
		try {
			urls.push(new URL(href, baseUrl).toString());
		} catch {
			// Ignore invalid authoring fragments from the source page.
		}
	}
	for (const match of html.matchAll(
		/https:\/\/temporal\.io\/resources\/case-studies\/[a-z0-9-/%]+/gi,
	)) {
		urls.push(match[0]);
	}
	return uniqueUrls(urls.filter(isTemporalCaseStudyUrl));
}

export function discoverCaseStudyLinksFromSitemap(xml: string): string[] {
	const urls: string[] = [];
	for (const match of xml.matchAll(
		/<loc>\s*([^<]+?\/resources\/case-studies\/[^<]+?)\s*<\/loc>/gi,
	)) {
		urls.push(decodeHtml(match[1].trim()));
	}
	for (const match of xml.matchAll(
		/https:\/\/temporal\.io\/resources\/case-studies\/[a-z0-9-/%]+/gi,
	)) {
		urls.push(match[0]);
	}
	return uniqueUrls(urls.filter(isTemporalCaseStudyUrl));
}

export function extractCaseStudyRecordFromHtml(
	url: string,
	html: string,
): CaseStudyRecord | undefined {
	if (!isTemporalCaseStudyUrl(url)) return undefined;
	const slug = slugFromUrl(url);
	const title =
		firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ??
		firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
	const headline = cleanText(title ?? titleFromSlug(slug));
	if (
		!headline ||
		/^temporal\b/i.test(headline) ||
		/404|not found/i.test(headline)
	)
		return undefined;
	const text = htmlToReadableText(html);
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const company = extractCompany(headline, slug);
	const usefulLines = lines.filter(
		(line) => !boilerplateLine(line) && !titleLikeLine(line, headline, company),
	);
	const evidenceLines = usefulLines.filter((line) =>
		evidenceLikeLine(line, company),
	);
	const metadata = {
		...extractMetadata(usefulLines),
		...extractMetadataFromHtml(html),
	};
	const evidenceQuote =
		evidenceLines.find((line) => line.length >= 80 && line.length <= 260) ??
		evidenceLines.find((line) => line.length >= 45) ??
		`${company} is cited in this Temporal customer story.`;
	const temporalValue =
		evidenceLines.find(
			(line) => /\bTemporal\b/.test(line) && line.length >= 45,
		) ?? `${company} uses Temporal to orchestrate reliable, durable workflows.`;
	const summary =
		evidenceLines.find((line) => line !== evidenceQuote && line.length >= 80) ??
		evidenceQuote;
	return {
		url: normalizeUrl(url),
		slug,
		company,
		headline,
		summary: sentence(summary),
		evidenceQuote: sentence(evidenceQuote),
		temporalValue: sentence(temporalValue),
		industry: metadata.Industry,
		useCase: metadata["Use Case"] ?? metadata["Use Cases"],
		companySize: metadata["Company Size"],
		sdk: metadata.SDK,
		deployment: metadata.Deployment,
		sourceType: "Temporal case study",
	};
}

export function renderCaseStudyMarketingPage(
	mode: CaseStudyResearchMode,
	result: CaseStudyResearchResult,
): string {
	const title =
		mode === "react" ? "ReAct Case Study Page" : "CodeAct Case Study Page";
	const eyebrow =
		mode === "react"
			? "LLM-selected ReAct research"
			: "CodeAct bounded parallel research";
	const cards = result.records
		.map(
			(record) => `<article class="card">
  <a href="${escapeHtml(record.url)}">${escapeHtml(record.company)}</a>
  <h3>${escapeHtml(record.headline)}</h3>
  <p>${escapeHtml(record.temporalValue)}</p>
  <dl>
    <div><dt>Use case</dt><dd>${escapeHtml(record.useCase ?? "Extracted from story copy")}</dd></div>
    <div><dt>Industry</dt><dd>${escapeHtml(record.industry ?? "Not labeled")}</dd></div>
  </dl>
</article>`,
		)
		.join("\n");
	const sources = result.records
		.map(
			(record) =>
				`<li><a href="${escapeHtml(record.url)}">${escapeHtml(record.url)}</a></li>`,
		)
		.join("\n");
	const statusText =
		result.status === "complete"
			? `Target met: ${result.records.length} valid Temporal case studies.`
			: `Needs review: ${result.records.length}/${result.targetCount} valid Temporal case studies found.`;
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; --ink: #111827; --muted: #667085; --line: #d0d5dd; --green: #0f766e; --coral: #c2410c; --navy: #111827; --paper: #fbfcfe; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--paper); }
    header { padding: 56px clamp(20px, 5vw, 64px); background: #ffffff; border-bottom: 1px solid var(--line); }
    .eyebrow { color: var(--coral); text-transform: uppercase; letter-spacing: .08em; font-weight: 800; font-size: 12px; }
    h1 { max-width: 900px; margin: 10px 0 12px; font-size: clamp(34px, 5vw, 64px); line-height: 1; letter-spacing: 0; }
    header p { max-width: 820px; color: var(--muted); font-size: 18px; }
    .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 22px; }
    .stat { border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 10px 12px; min-width: 150px; }
    .stat strong { display: block; font-size: 22px; }
    main { padding: 28px clamp(20px, 5vw, 64px) 56px; }
    .notice { border-left: 4px solid var(--green); background: #ecfdf3; padding: 12px 14px; margin-bottom: 22px; color: #134e4a; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
    .card { border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 18px; }
    .card a { color: var(--green); font-weight: 800; text-decoration: none; }
    .card h3 { margin: 10px 0; font-size: 18px; line-height: 1.2; }
    .card p { color: var(--muted); }
    dl { display: grid; gap: 8px; margin: 14px 0 0; }
    dt { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
    dd { margin: 2px 0 0; }
    .sources { margin-top: 30px; }
    .sources a { color: var(--navy); overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <header>
    <div class="eyebrow">${escapeHtml(eyebrow)}</div>
    <h1>Temporal customer proof for production AI and durable execution.</h1>
    <p>${escapeHtml(statusText)} This page is draft-only collateral generated from Temporal-owned customer-story pages.</p>
    <div class="stats">
      <div class="stat"><strong>${escapeHtml(result.records.length)}</strong>valid records</div>
      <div class="stat"><strong>${escapeHtml(result.attemptedUrls.length)}</strong>pages attempted</div>
      <div class="stat"><strong>${escapeHtml(result.failures.length)}</strong>failed pages</div>
      <div class="stat"><strong>${escapeHtml(result.retries)}</strong>retries</div>
    </div>
  </header>
  <main>
    <div class="notice">${escapeHtml(result.exitCondition)}</div>
    <section class="grid">${cards || "<p>No valid case-study records were extracted.</p>"}</section>
    <section class="sources">
      <h2>Sources</h2>
      <ol>${sources}</ol>
    </section>
  </main>
</body>
</html>`;
}

export function renderComparisonMarkdown(
	react: CaseStudyResearchResult,
	codeact: CaseStudyResearchResult,
): string {
	const qualityGap = codeact.records.length - react.records.length;
	return [
		"# ReAct vs CodeAct Temporal Case-Study Research",
		"",
		"| Measure | ReAct strategy | CodeAct + Temporal scaffold |",
		"| --- | ---: | ---: |",
		`| Valid records | ${react.records.length} | ${codeact.records.length} |`,
		`| Pages attempted | ${react.attemptedUrls.length} | ${codeact.attemptedUrls.length} |`,
		`| Failed pages | ${react.failures.length} | ${codeact.failures.length} |`,
		`| Retries | ${react.retries} | ${codeact.retries} |`,
		`| Elapsed ms | ${react.elapsedMs} | ${codeact.elapsedMs} |`,
		`| Status | ${react.status} | ${codeact.status} |`,
		"",
		"## Output Quality",
		"",
		`CodeAct produced ${qualityGap >= 0 ? "+" : ""}${qualityGap} more valid records than the LLM-selected ReAct path in this run.`,
		"",
		"ReAct exit condition:",
		`> ${react.exitCondition}`,
		"",
		"CodeAct exit condition:",
		`> ${codeact.exitCondition}`,
		"",
		"## Generated Files",
		"",
		"- `react/react-case-study-page.html`",
		"- `codeact/codeact-case-study-page.html`",
		"- `codeact/runtime-temporal-scaffold/src/workflows.py`",
		"- `codeact/runtime-temporal-scaffold/src/activities.py`",
		"",
		"## Source URLs",
		"",
		...codeact.records.map((record) => `- ${record.company}: ${record.url}`),
		"",
	].join("\n");
}

export function renderCaseStudySourceCitations(
	result: CaseStudyResearchResult,
): string {
	return [
		"# Temporal Case-Study Source Citations",
		"",
		`Mode: ${result.mode}`,
		`Status: ${result.status}`,
		`Exit condition: ${result.exitCondition}`,
		"",
		"## Discovery Roots",
		"",
		...result.sourceRoots.map((url) => `- ${url}`),
		"",
		"## Extracted Customer Stories",
		"",
		...result.records.map((record) => `- ${record.company}: ${record.url}`),
		"",
	].join("\n");
}

export function isTemporalCaseStudyUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.hostname === "temporal.io" &&
			url.pathname.startsWith("/resources/case-studies/")
		);
	} catch {
		return false;
	}
}

async function fetchExtractWithRetry(
	url: string,
	fetchText: FetchText,
	maxAttempts: number,
): Promise<{
	record?: CaseStudyRecord;
	failure?: FailedPage;
	retries: number;
}> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			const html = await fetchText(url);
			const record = extractCaseStudyRecordFromHtml(url, html);
			if (!record) {
				return {
					failure: {
						url,
						step: "extract",
						reason: "Page did not contain a valid Temporal case-study record.",
						attempts: attempt,
						retryable: false,
					},
					retries: attempt - 1,
				};
			}
			return { record, retries: attempt - 1 };
		} catch (error) {
			lastError = error;
		}
	}
	return {
		failure: {
			url,
			step: "fetch",
			reason: errorMessage(lastError),
			attempts: maxAttempts,
			retryable: true,
		},
		retries: Math.max(0, maxAttempts - 1),
	};
}

async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = [];
	let index = 0;
	async function worker(): Promise<void> {
		for (;;) {
			const current = index;
			index += 1;
			if (current >= items.length) return;
			results[current] = await fn(items[current]);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () => worker()),
	);
	return results;
}

function discoveryFailure(url: string, error: unknown): FailedPage {
	return {
		url,
		step: "discover",
		reason: errorMessage(error),
		attempts: 1,
		retryable: true,
	};
}

function exitCondition(
	mode: CaseStudyResearchMode,
	status: CaseStudyResearchResult["status"],
	recordCount: number,
	targetCount: number,
	attemptedCount: number,
	pageBudget: number,
	concurrency: number,
): string {
	if (status === "complete")
		return `${targetCount} valid Temporal case-study records found.`;
	if (mode === "react") {
		if (attemptedCount < pageBudget) {
			return `LLM-selected ReAct discovery returned ${attemptedCount}/${pageBudget} candidate pages; ${recordCount}/${targetCount} records were found, so the run needs review instead of inventing missing stories.`;
		}
		return `LLM-selected ReAct strategy exhausted its page budget: ${attemptedCount}/${pageBudget} pages attempted at concurrency ${concurrency}, with ${recordCount}/${targetCount} records found.`;
	}
	return `Bounded parallel crawl completed with ${recordCount}/${targetCount} valid records; workflow should pause for review instead of fabricating missing case studies.`;
}

function extractMetadata(lines: string[]): Record<string, string> {
	const labels = [
		"Industry",
		"Use Case",
		"Use Cases",
		"Company Size",
		"SDK",
		"Deployment",
	];
	const values: Record<string, string> = {};
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].replace(/:$/, "");
		for (const label of labels) {
			if (line === label && lines[index + 1]) values[label] = lines[index + 1];
			const inline = new RegExp(
				`^${escapeRegExp(label)}\\s*:\\s*(.+)$`,
				"i",
			).exec(line);
			if (inline) values[label] = inline[1].trim();
		}
	}
	return values;
}

function extractMetadataFromHtml(html: string): Record<string, string> {
	const labels = [
		"Industry",
		"Use Case",
		"Use Cases",
		"Company Size",
		"SDK",
		"Deployment",
	];
	const values: Record<string, string> = {};
	for (const label of labels) {
		const pattern = new RegExp(
			`<[^>]+>\\s*${escapeRegExp(label)}\\s*<\\/[^>]+>\\s*<[^>]+>\\s*([\\s\\S]*?)\\s*<\\/[^>]+>`,
			"i",
		);
		const match = pattern.exec(html);
		if (match?.[1]) values[label] = cleanText(match[1]);
	}
	return values;
}

function htmlToReadableText(html: string): string {
	return decodeHtml(
		html
			.replace(/<script[\s\S]*?<\/script>/gi, "\n")
			.replace(/<style[\s\S]*?<\/style>/gi, "\n")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|section|article|li|h1|h2|h3|dt|dd)>/gi, "\n")
			.replace(/<[^>]+>/g, " ")
			.replace(/[ \t]+/g, " ")
			.replace(/\n\s+/g, "\n"),
	);
}

function cleanText(value: string): string {
	return decodeHtml(
		value
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim(),
	).replace(/\s+\|\s+Temporal.*$/i, "");
}

function decodeHtml(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function extractCompany(headline: string, slug: string): string {
	const patterns = [
		/^(.+?)\s+(?:uses|use|migrates|builds|runs|orchestrates|saves|improves|scales)\b/i,
		/^How\s+(.+?)\s+(?:uses|use|built|builds|ensures|simplifies|aims|delivers|migrated)\b/i,
		/^Building .* at\s+(.+)$/i,
		/^(.+?):\s+/,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(headline);
		if (match?.[1]) return titleCaseCompany(match[1]);
	}
	return titleCaseCompany(
		slug
			.replace(/-story$/, "")
			.split("-")
			.slice(0, 2)
			.join(" "),
	);
}

function titleCaseCompany(value: string): string {
	return value
		.replace(/^how\s+/i, "")
		.replace(/\s+with\s+Temporal.*$/i, "")
		.replace(/\s+using\s+Temporal.*$/i, "")
		.trim()
		.split(/\s+/)
		.map((part) => {
			if (/^[A-Z0-9]{2,}$/.test(part)) return part;
			if (/^(AI|ANZ|REA|KFC)$/i.test(part)) return part.toUpperCase();
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join(" ");
}

function slugFromUrl(value: string): string {
	const pathname = new URL(normalizeUrl(value)).pathname;
	return pathname.split("/").filter(Boolean).at(-1) ?? "case-study";
}

function titleFromSlug(slug: string): string {
	return titleCaseCompany(slug.replace(/-/g, " "));
}

function normalizeUrl(value: string): string {
	const url = new URL(value);
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString();
}

function uniqueUrls(values: string[]): string[] {
	return [...new Set(values.map(normalizeUrl))].sort((a, b) =>
		a.localeCompare(b),
	);
}

function firstMatch(value: string, pattern: RegExp): string | undefined {
	const match = pattern.exec(value);
	return match?.[1];
}

function sentence(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function boilerplateLine(line: string): boolean {
	return (
		line.length < 25 ||
		/^(platform|resources|developers|company|sign up|all systems operational|privacy policy|terms of service)$/i.test(
			line,
		) ||
		/announcing product updates|read announcement|all rights reserved|cookie|subscribe|contact sales|start building|request demo/i.test(
			line,
		) ||
		/^image:/i.test(line)
	);
}

function titleLikeLine(
	line: string,
	headline: string,
	company: string,
): boolean {
	const compactLine = normalizeComparable(line);
	return (
		compactLine === normalizeComparable(headline) ||
		compactLine === normalizeComparable(`${headline} Temporal`) ||
		compactLine === normalizeComparable(`${headline} | Temporal`) ||
		(compactLine.includes(normalizeComparable(headline)) &&
			line.length < headline.length + 30) ||
		(compactLine.includes(normalizeComparable(company)) &&
			/\|\s*Temporal$/i.test(line) &&
			line.length < 180)
	);
}

function evidenceLikeLine(line: string, company: string): boolean {
	if (!/[.!?"]$/.test(line) && !/%|\d/.test(line)) return false;
	if (/^\w[\w\s-]+ \| Temporal$/i.test(line)) return false;
	return (
		/\b(Temporal|workflow|workflows|durable|reliability|reliable|scale|AI|agent|agents|production|developer|engineer|percent|%|\d)\b/i.test(
			line,
		) || line.includes(company)
	);
}

function normalizeComparable(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function escapeHtml(value: string | number): string {
	return String(value).replace(/[&<>"']/g, (char) => {
		const entities: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		};
		return entities[char] ?? char;
	});
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
