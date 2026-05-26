import {
	type FetchText,
	TEMPORAL_CUSTOMER_STORIES_URL,
	TEMPORAL_SITEMAP_URL,
} from "../src/case-study-research.ts";
import {
	createTemporalScaffoldPlan,
	createTemporalScaffoldSpec,
	renderTemporalScaffoldBashScript,
} from "../src/harness/temporal-scaffold.ts";
import type { HarnessLlmGenerate } from "../src/harness/types.ts";

export const mockCaseStudyUrls = [
	"https://temporal.io/resources/case-studies/anz-story",
	"https://temporal.io/resources/case-studies/checkr",
	"https://temporal.io/resources/case-studies/coinbase",
	"https://temporal.io/resources/case-studies/how-retool-built-robust-workflow-agents-products",
	"https://temporal.io/resources/case-studies/how-vodafone-aims-to-orchestrate-value-added-services-across-devices",
	"https://temporal.io/resources/case-studies/instacart-simplifies-complex-workflows",
];

const pages = new Map(
	mockCaseStudyUrls.map((url) => {
		const company = companyFromUrl(url);
		return [
			url,
			`<!doctype html>
<html>
<head><title>${company} uses Temporal for durable execution</title></head>
<body>
  <h1>${headlineFor(company, url)}</h1>
  <p>${company} uses Temporal to orchestrate critical business workflows with durable execution, retries, and visibility across distributed systems.</p>
  <p>This customer story explains how ${company} reduced operational risk by keeping workflow state durable while services, APIs, or workers may fail.</p>
  <section><div>Industry</div><div>${industryFor(company)}</div><div>Use Case</div><div>Reliable workflow orchestration</div><div>SDK</div><div>Python</div></section>
</body>
</html>`,
		];
	}),
);

export function makeTemporalMockFetch(
	options: { failFirstFor?: string } = {},
): FetchText {
	const attempts = new Map<string, number>();
	return async (url: string) => {
		const normalized = url.replace(/\/$/, "");
		const attempt = (attempts.get(normalized) ?? 0) + 1;
		attempts.set(normalized, attempt);
		if (options.failFirstFor === normalized && attempt === 1) {
			throw new Error("mock transient 503");
		}
		if (normalized === TEMPORAL_CUSTOMER_STORIES_URL) {
			return `<a href="/resources/case-studies/anz-story">ANZ</a>
<a href="/resources/case-studies/checkr">Checkr</a>
<a href="/blog/not-a-case-study">Blog</a>`;
		}
		if (normalized === TEMPORAL_SITEMAP_URL) {
			return `<?xml version="1.0" ?><urlset>${mockCaseStudyUrls
				.map((caseStudyUrl) => `<url><loc>${caseStudyUrl}</loc></url>`)
				.join(
					"",
				)}<url><loc>https://temporal.io/blog/not-a-case-study</loc></url></urlset>`;
		}
		const page = pages.get(normalized);
		if (page) return page;
		return "<html><body><h1>Not a customer story</h1></body></html>";
	};
}

export const mockHarnessLlmGenerate: HarnessLlmGenerate = async ({
	purpose,
	prompt,
}) => {
	if (purpose.endsWith("live-temporal-website-search")) {
		return JSON.stringify(
			{
				discoveredUrls: mockCaseStudyUrls,
				executionStrategy: {
					targetCount: 2,
					pageBudget: 2,
					concurrency: 2,
					parallelPlan: [
						"branch 1: fetch AI-agent customer stories",
						"branch 2: fetch platform reliability customer stories",
					],
					rationale:
						"Mock Pi chose a small concurrent ReAct strategy for the test run.",
				},
				observations: [
					"Mock Pi used bash to search Temporal-owned case-study URLs.",
				],
			},
			null,
			2,
		);
	}
	if (
		purpose === "codeact-temporal-bash-scaffold" ||
		purpose === "codeact-temporal-python-scaffold"
	) {
		return renderTemporalScaffoldBashScript(createTemporalScaffoldSpec());
	}
	if (purpose === "codeact-temporal-scaffold-plan") {
		return JSON.stringify(createTemporalScaffoldPlan(), null, 2);
	}
	if (purpose.startsWith("codeact-temporal-scaffold-file-")) {
		const path = scaffoldPathFromPurpose(
			purpose,
			"codeact-temporal-scaffold-file-",
		);
		return scaffoldFileContents(path);
	}
	if (purpose.startsWith("codeact-temporal-scaffold-repair-")) {
		const path = scaffoldPathFromPurpose(
			purpose.replace(/^codeact-temporal-scaffold-repair-\d+-/, ""),
			"",
		);
		return scaffoldFileContents(path);
	}
	if (purpose.endsWith("case-study-record-extraction")) {
		const url =
			/Source URL:\s*(https:\/\/temporal\.io\/resources\/case-studies\/[^\s]+)/.exec(
				prompt,
			)?.[1] ?? mockCaseStudyUrls[0];
		const company = companyFromUrl(url);
		return JSON.stringify(
			{
				valid: true,
				url,
				company,
				headline: headlineFor(company, url),
				summary: `${company} uses Temporal to orchestrate critical business workflows with durable execution, retries, and visibility across distributed systems.`,
				evidenceQuote: `This customer story explains how ${company} reduced operational risk by keeping workflow state durable while services, APIs, or workers may fail.`,
				temporalValue: `${company} uses Temporal to orchestrate critical business workflows with durable execution, retries, and visibility across distributed systems.`,
				industry: industryFor(company),
				useCase: "Reliable workflow orchestration",
				sdk: "Python",
			},
			null,
			2,
		);
	}
	if (purpose.endsWith("case-study-artifact-bundle")) {
		const mode = purpose.startsWith("react") ? "ReAct" : "CodeAct";
		return JSON.stringify(
			{
				html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${mode} Case Study Page</title></head><body><h1>${mode} Temporal Customer Proof</h1><p>LLM-generated artifact with Temporal customer-story citations.</p><a href="https://temporal.io/resources/case-studies/anz-story">Source</a></body></html>`,
				citationsMarkdown: `# ${mode} Citations\n\n- https://temporal.io/resources/case-studies/anz-story\n`,
				narrativeMarkdown: `# ${mode} Agent Execution\n\nLLM-generated ${mode} narrative with an explicit exit condition.\n`,
			},
			null,
			2,
		);
	}
	if (purpose === "react-vs-codeact-comparison-report") {
		return [
			"# LLM ReAct vs CodeAct Comparison",
			"",
			"- ReAct artifact: react/react-case-study-page.html",
			"- CodeAct artifact: codeact/codeact-case-study-page.html",
			"- CodeAct produced broader coverage with generated Temporal primitives.",
		].join("\n");
	}
	return `# LLM ${purpose}\n\nThis artifact was generated by the mock LLM for tests.`;
};

function scaffoldPathFromPurpose(purpose: string, prefix: string): string {
	const slug = prefix ? purpose.slice(prefix.length) : purpose;
	const spec = createTemporalScaffoldSpec();
	const file = spec.files.find(
		(candidate) =>
			candidate.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") ===
			slug,
	);
	if (!file) throw new Error(`Unknown scaffold file purpose: ${purpose}`);
	return file.path;
}

function scaffoldFileContents(path: string): string {
	const file = createTemporalScaffoldSpec().files.find(
		(candidate) => candidate.path === path,
	);
	if (!file) throw new Error(`Unknown scaffold path: ${path}`);
	return file.contents;
}

function companyFromUrl(url: string): string {
	if (url.includes("anz")) return "ANZ";
	if (url.includes("checkr")) return "Checkr";
	if (url.includes("coinbase")) return "Coinbase";
	if (url.includes("retool")) return "Retool";
	if (url.includes("vodafone")) return "Vodafone";
	if (url.includes("instacart")) return "Instacart";
	return "Customer";
}

function headlineFor(company: string, url: string): string {
	if (url.includes("retool"))
		return "How Retool built robust workflow agents products";
	if (url.includes("vodafone"))
		return "How Vodafone aims to orchestrate value-added services across devices";
	return `${company} uses Temporal to run resilient customer workflows`;
}

function industryFor(company: string): string {
	if (company === "ANZ" || company === "Coinbase") return "Financial Services";
	if (company === "Vodafone") return "Telecommunications";
	return "Software";
}
