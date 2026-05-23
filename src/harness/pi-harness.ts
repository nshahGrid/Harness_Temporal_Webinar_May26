import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
	CASE_STUDY_TARGET_COUNT,
	type CaseStudyRecord,
	type CaseStudyResearchResult,
	CODEACT_CONCURRENCY,
	CODEACT_PAGE_BUDGET,
	collectTemporalCaseStudies,
	defaultFetchText,
	discoverCaseStudyLinksFromHtml,
	discoverCaseStudyLinksFromSitemap,
	extractCaseStudyRecordFromHtml,
	type FailedPage,
	type FetchText,
	isTemporalCaseStudyUrl,
	REACT_DEFAULT_PAGE_BUDGET,
	renderCaseStudyMarketingPage,
	renderCaseStudySourceCitations,
	TEMPORAL_CUSTOMER_STORIES_URL,
	TEMPORAL_SITEMAP_URL,
} from "../case-study-research.ts";
import {
	generateTextWithPi,
	generateTextWithPiDetailed,
} from "../pi-runner.ts";
import { redactSecrets } from "../redact.ts";
import { buildPromptPack } from "../scenario-data.ts";
import { scenarioDefinitions } from "../scenario-definitions.ts";
import type { PromptPack, ScenarioId } from "../types.ts";
import {
	codeActTemporalWorkflowType,
	runGeneratedTemporalCloudScaffold,
	shouldRunCodeActTemporalCloud,
} from "./codeact-temporal-cloud.ts";
import {
	buildTemporalSkillContextWindow,
	createTemporalScaffoldSpec,
	parseTemporalScaffoldSpecFromBash,
	parseTemporalScaffoldSpecFromLlm,
	type TemporalScaffoldSpec,
	temporalPrimitiveCatalog,
	validateTemporalScaffold,
	writeTemporalScaffold,
} from "./temporal-scaffold.ts";
import type {
	CodeActTemporalCloudRun,
	GeneratedFile,
	HarnessAgentMode,
	HarnessDemoOptions,
	HarnessEvent,
	HarnessLlmRequest,
	HarnessRuntimeStreamEvent,
	HarnessToolCall,
	HarnessWorkerEvent,
	TemporalPrimitive,
} from "./types.ts";

interface CaseStudyArtifactBundle {
	html: string;
	citationsMarkdown: string;
	narrativeMarkdown: string;
}

interface ScaffoldAttemptResult {
	spec: TemporalScaffoldSpec;
	generated: GeneratedFile[];
	validation: string[];
	usedFallback: boolean;
}

interface ReactExecutionStrategy {
	targetCount: number;
	pageBudget: number;
	concurrency: number;
	parallelPlan: string[];
	rationale: string;
}

interface PiLiveSearchResult {
	urls: string[];
	strategy?: Partial<ReactExecutionStrategy>;
}

export class PiTemporalHarness {
	private readonly events: HarnessEvent[] = [];
	private readonly toolCalls: HarnessToolCall[] = [];
	private readonly workerEvents: HarnessWorkerEvent[] = [];
	private readonly artifacts: GeneratedFile[] = [];
	private readonly transcript: string[] = [];
	private latestCodeActResearch?: CaseStudyResearchResult;
	private latestCodeActScaffoldUsedFallback = false;
	private latestCodeActTemporalCloudRun?: CodeActTemporalCloudRun;
	private readonly piLiveSearchByMode = new Map<
		"react" | "codeact",
		PiLiveSearchResult
	>();

	constructor(
		private readonly agent: HarnessAgentMode,
		private readonly runDir: string,
		private readonly onStream?: (event: HarnessRuntimeStreamEvent) => void,
		private readonly researchOptions: Pick<
			HarnessDemoOptions,
			| "researchFetchText"
			| "researchTargetCount"
			| "reactPageBudget"
			| "codeActPageBudget"
			| "codeActConcurrency"
			| "llmGenerate"
			| "enableCodeActTemporalCloud"
		> = {},
	) {}

	get agentMode(): HarnessAgentMode {
		return this.agent;
	}

	getRunDir(): string {
		return this.runDir;
	}

	getEvents(): HarnessEvent[] {
		return [...this.events];
	}

	getToolCalls(): HarnessToolCall[] {
		return [...this.toolCalls];
	}

	getWorkerEvents(): HarnessWorkerEvent[] {
		return [...this.workerEvents];
	}

	getArtifacts(): GeneratedFile[] {
		return [...this.artifacts];
	}

	getTranscript(): string[] {
		return [...this.transcript];
	}

	prompt(message: string): void {
		this.record("prompt", message);
		this.transcript.push(`user: ${message}`);
	}

	reason(message: string): void {
		this.record("reason", message);
		this.transcript.push(`assistant.reason: ${message}`);
	}

	observe(message: string): void {
		this.record("observation", message);
		this.transcript.push(`observation: ${message}`);
	}

	result(message: string): void {
		this.record("result", message);
		this.transcript.push(`assistant: ${message}`);
	}

	async inspectTemporalCatalog(): Promise<TemporalPrimitive[]> {
		const output = temporalPrimitiveCatalog
			.map((primitive) => `${primitive.id}: ${primitive.whyItMatters}`)
			.join("\n");
		this.recordTool("inspect_temporal_catalog", "list primitives", output);
		return temporalPrimitiveCatalog;
	}

	async inspectBusinessUseCases(): Promise<typeof scenarioDefinitions> {
		const output = scenarioDefinitions
			.map(
				(scenario) =>
					`${scenario.id}: ${scenario.title} - ${scenario.shortDescription}`,
			)
			.join("\n");
		this.recordTool("inspect_business_scenarios", "list scenarios", output);
		return scenarioDefinitions;
	}

	async preparePromptPack(scenarioId: ScenarioId): Promise<PromptPack> {
		const pack = await buildPromptPack(scenarioId, {
			fetchText: this.researchOptions.researchFetchText,
			targetCount: this.researchOptions.researchTargetCount,
		});
		const output = JSON.stringify(
			{
				scenarioId: pack.scenarioId,
				title: pack.title,
				fixturePaths: pack.fixturePaths,
				preparedDataKeys: Object.keys(pack.preparedData),
				promptCharacters: pack.prompt.length,
			},
			null,
			2,
		);
		this.recordTool("prepare_prompt_pack", scenarioId, output);
		return pack;
	}

	async runReactResearch(): Promise<CaseStudyResearchResult> {
		const liveSearch = await this.discoverTemporalSearchWithPi("react");
		const strategy = normalizeReactExecutionStrategy(liveSearch.strategy, {
			pageBudgetOverride: this.researchOptions.reactPageBudget,
			targetCountCap:
				this.researchOptions.researchTargetCount ?? CASE_STUDY_TARGET_COUNT,
			discoveredCount: liveSearch.urls.length,
		});
		this.recordTool(
			"react_execution_strategy",
			"Pi-selected ReAct strategy",
			JSON.stringify(strategy, null, 2),
		);
		this.recordTool(
			"react_parallel_plan",
			"Pi concise parallel ReAct plan",
			strategy.parallelPlan.length > 0
				? strategy.parallelPlan
						.map((branch, index) => `${index + 1}. ${branch}`)
						.join("\n")
				: "Pi did not provide a parallel branch plan.",
		);
		const result = await collectTemporalCaseStudies({
			mode: "react",
			fetchText: this.researchOptions.researchFetchText,
			targetCount: strategy.targetCount,
			pageBudget: strategy.pageBudget,
			concurrency: strategy.concurrency,
			discoveredUrls: liveSearch.urls,
			sourceRoots: [TEMPORAL_CUSTOMER_STORIES_URL, TEMPORAL_SITEMAP_URL],
		});
		this.recordTool(
			"discover_case_study_links",
			"Pi live bash search of https://temporal.io/in-use and https://temporal.io/sitemap.xml",
			`${result.discoveredUrls.length} Temporal-owned case-study URLs discovered by Pi and accepted by the harness; ReAct targetCount=${result.targetCount}, pageBudget=${result.pageBudget}, concurrency=${result.concurrency}`,
		);
		for (const url of result.attemptedUrls) {
			const record = result.records.find((candidate) => candidate.url === url);
			const failure = result.failures.find(
				(candidate) => candidate.url === url,
			);
			this.recordTool(
				"fetch_extract_react_action",
				url,
				record
					? `${record.company}: ${record.headline}`
					: `no record extracted${failure ? `: ${failure.reason}` : ""}`,
			);
		}
		return result;
	}

	async runParallelCodeActResearch(): Promise<CaseStudyResearchResult> {
		if (this.shouldStartGeneratedTemporalCloudWorkflow()) {
			const cloudResult = await this.runGeneratedTemporalCloudWorkflow();
			this.latestCodeActTemporalCloudRun = cloudResult.cloudRun;
			if (cloudResult.research) {
				this.latestCodeActResearch = cloudResult.research;
				this.recordTool(
					"temporal_cloud_generated_workflow_result",
					cloudResult.cloudRun.workflowId,
					JSON.stringify(cloudResult.cloudRun, null, 2),
				);
				this.recordTool(
					"bounded_parallel_subagent_extract",
					"generated Python Temporal workflow result",
					JSON.stringify(
						{
							records: cloudResult.research.records.length,
							failures: cloudResult.research.failures.length,
							retries: cloudResult.research.retries,
							status: cloudResult.research.status,
							exitCondition: cloudResult.research.exitCondition,
						},
						null,
						2,
					),
				);
				return cloudResult.research;
			}
			this.recordTool(
				"temporal_cloud_generated_workflow_result",
				cloudResult.cloudRun.workflowId || codeActTemporalWorkflowType,
				JSON.stringify(cloudResult.cloudRun, null, 2),
			);
			this.observe(
				`${cloudResult.cloudRun.message} Falling back to local bounded extraction so artifacts still export.`,
			);
		}

		const result = await this.runGeneratedCodeActWorkerResearch();
		this.recordTool(
			"bounded_parallel_subagent_extract",
			JSON.stringify(
				{
					targetCount: result.targetCount,
					pageBudget: result.pageBudget,
					concurrency: result.concurrency,
				},
				null,
				2,
			),
			JSON.stringify(
				{
					records: result.records.length,
					failures: result.failures.length,
					retries: result.retries,
					status: result.status,
					exitCondition: result.exitCondition,
				},
				null,
				2,
			),
		);
		this.latestCodeActResearch = result;
		return result;
	}

	private shouldStartGeneratedTemporalCloudWorkflow(): boolean {
		if (this.researchOptions.enableCodeActTemporalCloud !== undefined) {
			return this.researchOptions.enableCodeActTemporalCloud;
		}
		return shouldRunCodeActTemporalCloud(
			Boolean(this.researchOptions.llmGenerate),
		);
	}

	private async runGeneratedTemporalCloudWorkflow(): Promise<
		Awaited<ReturnType<typeof runGeneratedTemporalCloudScaffold>>
	> {
		const scaffoldDir = join(
			this.runDir,
			this.agent,
			"runtime-temporal-scaffold",
		);
		const targetCount =
			this.researchOptions.researchTargetCount ?? CASE_STUDY_TARGET_COUNT;
		const pageBudget =
			this.researchOptions.codeActPageBudget ?? CODEACT_PAGE_BUDGET;
		const concurrency = Math.max(
			1,
			this.researchOptions.codeActConcurrency ?? CODEACT_CONCURRENCY,
		);
		this.recordWorker({
			workerId: "temporal-cloud-python-worker",
			phase: "planned",
			message:
				"Generated Python worker will poll Temporal Cloud for the CodeAct workflow type.",
		});
		const cloudResult = await runGeneratedTemporalCloudScaffold({
			scaffoldDir,
			runId: this.runDir.split("/").pop() || `codeact-${Date.now()}`,
			targetCount,
			pageBudget,
			concurrency,
			onStatus: (message) => {
				this.recordWorker({
					workerId: "temporal-cloud-python-worker",
					phase: "assigned",
					message,
				});
			},
			onWorkerOutput: (message) => {
				this.recordWorker({
					workerId: "temporal-cloud-python-worker",
					phase: "assigned",
					message,
				});
			},
		});
		this.recordTool(
			"temporal_cloud_generated_workflow_start",
			cloudResult.cloudRun.workflowId || codeActTemporalWorkflowType,
			JSON.stringify(
				{
					workflowId: cloudResult.cloudRun.workflowId,
					workflowType: cloudResult.cloudRun.workflowType,
					taskQueue: cloudResult.cloudRun.taskQueue,
					activities: cloudResult.cloudRun.activities,
				},
				null,
				2,
			),
		);
		this.recordWorker({
			workerId: "temporal-cloud-python-worker",
			phase:
				cloudResult.cloudRun.status === "completed" ? "complete" : "failure",
			records: cloudResult.cloudRun.records,
			failures: cloudResult.cloudRun.failures,
			message: cloudResult.cloudRun.message,
		});
		return cloudResult;
	}

	private async runGeneratedCodeActWorkerResearch(): Promise<CaseStudyResearchResult> {
		const startedAtMs = Date.now();
		const startedAt = new Date(startedAtMs).toISOString();
		const fetchText =
			this.researchOptions.researchFetchText ?? defaultFetchText;
		const targetCount =
			this.researchOptions.researchTargetCount ?? CASE_STUDY_TARGET_COUNT;
		const pageBudget =
			this.researchOptions.codeActPageBudget ?? CODEACT_PAGE_BUDGET;
		const concurrency = Math.max(
			1,
			this.researchOptions.codeActConcurrency ?? CODEACT_CONCURRENCY,
		);
		const sourceRoots = [TEMPORAL_CUSTOMER_STORIES_URL, TEMPORAL_SITEMAP_URL];
		const failures: FailedPage[] = [];
		let retries = 0;

		this.recordWorker({
			workerId: "codeact-planner",
			phase: "planned",
			message:
				"Generated scaffold scheduled live discovery as parallel root workers, then page extraction as bounded sub-agent workers.",
		});

		const discoveredUrls = await this.discoverWithCodeActWorkers(
			fetchText,
			failures,
		);
		const attemptedUrls = discoveredUrls.slice(0, pageBudget);
		const indexedResults: Array<{
			record?: CaseStudyRecord;
			failure?: FailedPage;
			retries: number;
		}> = [];
		let nextIndex = 0;

		this.recordWorker({
			workerId: "subagent-pool",
			phase: "planned",
			message: `${concurrency} parallel extraction sub-agents will process ${attemptedUrls.length} candidate pages.`,
		});

		const workers = Array.from(
			{ length: Math.min(concurrency, attemptedUrls.length) },
			async (_, index) => {
				const workerId = `extract-subagent-${index + 1}`;
				this.recordWorker({
					workerId,
					phase: "planned",
					message: "Ready for bounded parallel page extraction.",
				});
				for (;;) {
					const current = nextIndex;
					nextIndex += 1;
					if (current >= attemptedUrls.length) break;
					const url = attemptedUrls[current];
					this.recordWorker({
						workerId,
						phase: "assigned",
						url,
						message: `Fetching and extracting page ${current + 1}/${attemptedUrls.length}.`,
					});
					const result = await this.fetchExtractWithWorkerRetry(
						workerId,
						url,
						fetchText,
						2,
					);
					indexedResults[current] = result;
					retries += result.retries;
					if (result.record) {
						this.recordWorker({
							workerId,
							phase: "record",
							url,
							records: 1,
							message: `${result.record.company}: ${result.record.headline}`,
						});
					}
					if (result.failure) {
						failures.push(result.failure);
						this.recordWorker({
							workerId,
							phase: "failure",
							url,
							failures: 1,
							message: result.failure.reason,
						});
					}
				}
				this.recordWorker({
					workerId,
					phase: "complete",
					message: "No more candidate pages in the bounded queue.",
				});
			},
		);
		await Promise.all(workers);

		const records = indexedResults
			.flatMap((result) => (result?.record ? [result.record] : []))
			.slice(0, targetCount);
		const completedAtMs = Date.now();
		const status = records.length >= targetCount ? "complete" : "needs_review";
		const result: CaseStudyResearchResult = {
			mode: "codeact",
			targetCount,
			pageBudget,
			concurrency,
			sourceRoots,
			discoveredUrls,
			attemptedUrls,
			records,
			failures,
			retries,
			startedAt,
			completedAt: new Date(completedAtMs).toISOString(),
			elapsedMs: completedAtMs - startedAtMs,
			status,
			exitCondition:
				status === "complete"
					? `${targetCount} valid Temporal case-study records found.`
					: `Bounded parallel crawl completed with ${records.length}/${targetCount} valid records; workflow should pause for review instead of fabricating missing case studies.`,
		};
		this.recordWorker({
			workerId: "synthesis-agent",
			phase: "aggregate",
			records: result.records.length,
			failures: result.failures.length,
			message: result.exitCondition,
		});
		return result;
	}

	private async discoverWithCodeActWorkers(
		fetchText: FetchText,
		failures: FailedPage[],
	): Promise<string[]> {
		const discoveryTasks = [
			{
				workerId: "discovery-subagent-1",
				url: TEMPORAL_CUSTOMER_STORIES_URL,
				parse: (body: string) => discoverCaseStudyLinksFromHtml(body),
			},
			{
				workerId: "discovery-subagent-2",
				url: TEMPORAL_SITEMAP_URL,
				parse: (body: string) => discoverCaseStudyLinksFromSitemap(body),
			},
		];
		const results = await Promise.all(
			discoveryTasks.map(async (task) => {
				this.recordWorker({
					workerId: task.workerId,
					phase: "assigned",
					url: task.url,
					message: "Fetching discovery root in parallel.",
				});
				try {
					const urls = task
						.parse(await fetchText(task.url))
						.filter(isTemporalCaseStudyUrl);
					this.recordWorker({
						workerId: task.workerId,
						phase: "record",
						url: task.url,
						records: urls.length,
						message: `${urls.length} candidate Temporal case-study URLs discovered.`,
					});
					return urls;
				} catch (error) {
					const failure = this.failedPage(task.url, "discover", error, 1, true);
					failures.push(failure);
					this.recordWorker({
						workerId: task.workerId,
						phase: "failure",
						url: task.url,
						failures: 1,
						message: failure.reason,
					});
					return [];
				}
			}),
		);
		const urls = uniqueUrls(results.flat()).filter(isTemporalCaseStudyUrl);
		this.recordWorker({
			workerId: "discovery-aggregator",
			phase: "aggregate",
			records: urls.length,
			message: `${urls.length} unique case-study candidates merged from parallel discovery workers.`,
		});
		return urls;
	}

	private async fetchExtractWithWorkerRetry(
		workerId: string,
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
						failure: this.failedPage(
							url,
							"extract",
							new Error(
								"Page did not contain a valid Temporal case-study record.",
							),
							attempt,
							false,
						),
						retries: attempt - 1,
					};
				}
				return { record, retries: attempt - 1 };
			} catch (error) {
				lastError = error;
				if (attempt < maxAttempts) {
					this.recordWorker({
						workerId,
						phase: "retrying",
						url,
						message: `Fetch failed on attempt ${attempt}; Temporal RetryPolicy schedules another activity attempt.`,
					});
				}
			}
		}
		return {
			failure: this.failedPage(url, "fetch", lastError, maxAttempts, true),
			retries: Math.max(0, maxAttempts - 1),
		};
	}

	private failedPage(
		url: string,
		step: FailedPage["step"],
		error: unknown,
		attempts: number,
		retryable: boolean,
	): FailedPage {
		return {
			url,
			step,
			reason: error instanceof Error ? error.message : String(error),
			attempts,
			retryable,
		};
	}

	getLatestCodeActResearch(): CaseStudyResearchResult | undefined {
		return this.latestCodeActResearch;
	}

	getLatestCodeActTemporalCloudRun(): CodeActTemporalCloudRun | undefined {
		return this.latestCodeActTemporalCloudRun;
	}

	didUseCodeActScaffoldFallback(): boolean {
		return this.latestCodeActScaffoldUsedFallback;
	}

	async discoverTemporalUrlsWithPi(
		mode: "react" | "codeact",
	): Promise<string[]> {
		return (await this.discoverTemporalSearchWithPi(mode)).urls;
	}

	private async discoverTemporalSearchWithPi(
		mode: "react" | "codeact",
	): Promise<PiLiveSearchResult> {
		const cached = this.piLiveSearchByMode.get(mode);
		if (cached) return cached;
		const purpose = `${mode}-live-temporal-website-search`;
		const prompt = buildPiLiveTemporalSearchPrompt();
		this.record("act", `Pi live website search for ${mode}`);
		this.recordTool(
			"pi_live_search_cli",
			purpose,
			[
				"pi --mode json --no-session --tools free_web_search,free_fetch_content --skill skills/temporal-case-study-marketing-page/SKILL.md -p <live Temporal website search prompt>",
				"Secrets and configured PI_COMMAND values are intentionally not displayed.",
			].join("\n"),
		);
		this.recordTool("pi_live_search_prompt", purpose, prompt);

		let markdown: string;
		if (this.researchOptions.llmGenerate) {
			markdown = await this.researchOptions.llmGenerate({ purpose, prompt });
			this.recordTool(
				"pi_live_search_tool_calls",
				purpose,
				"mock LLM search used by tests",
			);
		} else {
			const result = await generateTextWithPiDetailed({
				prompt,
				skillName: "temporal-case-study-marketing-page",
				tools: ["free_web_search", "free_fetch_content"],
				timeoutMs: 240_000,
			});
			markdown = result.markdown;
			this.recordTool(
				"pi_live_search_tool_calls",
				purpose,
				JSON.stringify(result.toolCalls, null, 2),
			);
			if (result.toolCalls.length === 0) {
				throw new Error(
					"Pi live search did not call the bash tool, so the demo cannot claim Pi searched Temporal.",
				);
			}
		}

		this.recordTool("pi_live_search_output", purpose, markdown);
		const result = parsePiLiveSearchResult(markdown);
		this.piLiveSearchByMode.set(mode, result);
		return result;
	}

	async generateWithLlm(
		request: HarnessLlmRequest,
		options: { recordOutput?: boolean } = {},
	): Promise<string> {
		this.record("act", `llm ${request.purpose}`);
		this.recordTool("llm_prompt", request.purpose, request.prompt);
		this.record(
			"observation",
			`Waiting for Pi/LLM output for ${request.purpose}${
				request.timeoutMs
					? `; timeout ${Math.round(request.timeoutMs / 1000)}s`
					: ""
			}.`,
		);
		const output = this.researchOptions.llmGenerate
			? await this.researchOptions.llmGenerate(request)
			: await generateTextWithPi({
					prompt: request.prompt,
					skillName: "temporal-codeact-builder",
					timeoutMs: request.timeoutMs ?? 180_000,
				});
		if (options.recordOutput !== false) {
			this.recordTool("llm_output", request.purpose, output);
		}
		return output;
	}

	async generateSimpleBriefWithLlm(): Promise<string> {
		return this.generateWithLlm({
			purpose: "simple-agent-brief",
			prompt: [
				"You are Pi running in a Temporal demo harness.",
				"Generate a concise Simple Agent brief in Markdown.",
				"The business scenario is Temporal customer-proof research from Temporal-owned case-study pages.",
				"Explain that this mode is prompt-only and does not use tools or write Temporal code.",
				"Do not expose environment variables, API keys, namespaces, or raw commands.",
			].join("\n"),
		});
	}

	async generateCaseStudyArtifactBundleWithLlm(
		mode: "react" | "codeact",
		result: CaseStudyResearchResult,
		extraContext = "",
	): Promise<CaseStudyArtifactBundle> {
		const response = await this.generateWithLlm({
			purpose: `${mode}-case-study-artifact-bundle`,
			prompt: [
				"You are Pi generating a cited customer-proof marketing page from verified Temporal case-study evidence.",
				"Return ONLY the three tagged sections below. Do not return JSON; HTML inside JSON is too brittle.",
				"---HTML---",
				"<!doctype html>...",
				"---CITATIONS---",
				"# ...",
				"---NARRATIVE---",
				"# ...",
				"---END---",
				"Use only the supplied marketing evidence rows and source URLs. Do not invent missing customers or metrics.",
				"Do not expose environment variables, API keys, namespaces, or raw commands.",
				"Include source links in both HTML and citations markdown.",
				extraContext,
				"Marketing evidence brief:",
				buildMarketingEvidenceBrief(result),
			].join("\n"),
		});
		try {
			return parseArtifactBundleFromLlm(response);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.record(
				"observation",
				`Pi artifact bundle response was invalid; continuing with fallback artifact rendering. ${message}`,
			);
			this.recordTool(
				"artifact_bundle_fallback",
				`${mode}-case-study-artifact-bundle`,
				[
					"Pi returned a malformed HTML/citations/narrative bundle.",
					"The harness rendered deterministic fallback artifacts from the extracted research state.",
					"Source URLs and extracted facts are still preserved; no customer stories are invented.",
				].join("\n"),
			);
			return {
				html: renderCaseStudyMarketingPage(mode, result),
				citationsMarkdown: renderCaseStudySourceCitations(result),
				narrativeMarkdown: renderFallbackNarrative(mode, result, message),
			};
		}
	}

	async generateComparisonReportWithLlm(
		react: CaseStudyResearchResult,
		codeact: CaseStudyResearchResult,
	): Promise<string> {
		return this.generateWithLlm({
			purpose: "react-vs-codeact-comparison-report",
			prompt: [
				"You are Pi generating a Markdown comparison report for a developer demo.",
				"Compare the LLM-selected ReAct research strategy with CodeAct generated-code research.",
				"Include coverage, elapsed time, failed fetches, retries, extracted records, generated files, final output quality, and exit conditions.",
				"Reference both artifacts: react/react-case-study-page.html and codeact/codeact-case-study-page.html.",
				"Do not expose environment variables, API keys, namespaces, or raw commands.",
				"ReAct state:",
				JSON.stringify(react, null, 2),
				"CodeAct state:",
				JSON.stringify(codeact, null, 2),
			].join("\n"),
		});
	}

	async submitApprovalSignal(
		scenarioId: ScenarioId,
		decision: "approved" | "rejected",
	): Promise<string> {
		const output = JSON.stringify(
			{
				signal: "submitApprovalSignal",
				scenarioId,
				decision,
				nextPhase: decision === "approved" ? "exporting" : "rejected",
			},
			null,
			2,
		);
		this.recordTool("approval_signal", scenarioId, output);
		return output;
	}

	async exportApprovedDraft(
		scenarioId: ScenarioId,
		markdown: string,
	): Promise<GeneratedFile> {
		const artifact = await this.writeArtifact(
			`react-execution/${scenarioId}-approved-draft.md`,
			markdown,
			"ReAct executed approved draft",
		);
		this.recordTool(
			"export_artifact",
			artifact.relativePath,
			`wrote ${artifact.relativePath}`,
		);
		return artifact;
	}

	async writeCaseStudyArtifactBundle(
		mode: "react" | "codeact",
		bundle: CaseStudyArtifactBundle,
	): Promise<GeneratedFile[]> {
		return [
			await this.writeArtifact(
				`${mode}-case-study-page.html`,
				extractHtmlDocument(bundle.html),
				`${mode} LLM-generated HTML case-study page`,
			),
			await this.writeArtifact(
				`${mode}-case-study-citations.md`,
				bundle.citationsMarkdown,
				`${mode} LLM-generated source citations`,
			),
			await this.writeArtifact(
				mode === "react"
					? "react-agent-execution.md"
					: "codeact-agent-walkthrough.md",
				bundle.narrativeMarkdown,
				`${mode} LLM-generated agent narrative`,
			),
		];
	}

	async writeArtifact(
		relativePath: string,
		contents: string,
		purpose: string,
	): Promise<GeneratedFile> {
		const path = join(this.runDir, this.agent, relativePath);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${contents.trimEnd()}\n`, "utf8");
		const artifact = {
			path,
			relativePath: relative(this.runDir, path),
			purpose,
		};
		this.artifacts.push(artifact);
		this.onStream?.({ type: "artifact", artifact });
		this.record("artifact", purpose, artifact.relativePath);
		return artifact;
	}

	async bash(command: string): Promise<string> {
		this.record("act", `bash ${command}`);
		if (command === "temporal scaffold write") {
			const scaffoldDir = join(
				this.runDir,
				this.agent,
				"runtime-temporal-scaffold",
			);
			const {
				spec: scaffold,
				generated,
				usedFallback,
			} = await this.generateWriteAndValidateTemporalScaffold(scaffoldDir);
			this.latestCodeActScaffoldUsedFallback = usedFallback;
			this.artifacts.push(
				...generated.map((file) => ({
					...file,
					relativePath: relative(this.runDir, file.path),
				})),
			);
			for (const file of this.artifacts.filter((artifact) =>
				artifact.relativePath.includes("runtime-temporal-scaffold"),
			)) {
				this.onStream?.({ type: "artifact", artifact: file });
			}
			for (const file of scaffold.files.filter((candidate) =>
				candidate.path.startsWith("src/"),
			)) {
				this.recordTool("write_file", file.path, file.contents);
			}
			const output = generated.map((file) => file.relativePath).join("\n");
			const source = usedFallback
				? "scaffold_source=fallback_validated_template"
				: "scaffold_source=pi_generated";
			this.recordTool("bash", command, `${source}\n${output}`);
			return `${source}\n${output}`;
		}

		if (command === "temporal scaffold validate") {
			const scaffoldDir = join(
				this.runDir,
				this.agent,
				"runtime-temporal-scaffold",
			);
			const passed = await validateTemporalScaffold(scaffoldDir);
			const output = passed.join("\n");
			this.recordTool("bash", command, output);
			return output;
		}

		if (command === "temporal case-study extract --mode codeact") {
			const result = await this.runParallelCodeActResearch();
			const cloudRun = this.latestCodeActTemporalCloudRun;
			const output = [
				cloudRun
					? `temporalWorkflowId=${cloudRun.workflowId || "not-started"}`
					: undefined,
				cloudRun ? `temporalWorkflowStatus=${cloudRun.status}` : undefined,
				cloudRun ? `temporalWorkflowType=${cloudRun.workflowType}` : undefined,
				cloudRun
					? `temporalActivities=${cloudRun.activities.join(",")}`
					: undefined,
				`records=${result.records.length}/${result.targetCount}`,
				`attempted=${result.attemptedUrls.length}`,
				`failures=${result.failures.length}`,
				`retries=${result.retries}`,
				`status=${result.status}`,
				`exit=${result.exitCondition}`,
			]
				.filter((line): line is string => Boolean(line))
				.join("\n");
			this.recordTool("bash", command, output);
			return output;
		}

		if (command === "temporal scaffold primitives") {
			const output = temporalPrimitiveCatalog
				.map((primitive) => `${primitive.label}: ${primitive.codeSignal}`)
				.join("\n");
			this.recordTool("bash", command, output);
			return output;
		}

		if (command === "temporal scaffold business-use-cases") {
			const output = scenarioDefinitions
				.map(
					(scenario) =>
						`${scenario.id}: ${scenario.title} (${scenario.skillName})`,
				)
				.join("\n");
			this.recordTool("bash", command, output);
			return output;
		}

		if (command === "temporal skill context load") {
			const output = buildTemporalSkillContextWindow();
			this.recordTool(
				"temporal_skill_context_loaded",
				"Temporal Python references -> CodeAct prompt context",
				output,
			);
			return output;
		}

		throw new Error(`Unsupported harness bash command: ${command}`);
	}

	private async generateWriteAndValidateTemporalScaffold(
		scaffoldDir: string,
	): Promise<ScaffoldAttemptResult> {
		const timeoutMs = Number(
			process.env.CODEACT_SCAFFOLD_TIMEOUT_MS || 150_000,
		);
		const configuredRepairAttempts = Number(
			process.env.CODEACT_SCAFFOLD_REPAIR_ATTEMPTS || 1,
		);
		const repairAttempts = Number.isFinite(configuredRepairAttempts)
			? Math.max(0, Math.floor(configuredRepairAttempts))
			: 1;
		const maxAttempts = 1 + repairAttempts;
		const basePrompt = buildTemporalScaffoldLlmPrompt();
		let prompt = basePrompt;
		let previousOutput = "";
		let previousError = "";

		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			const purpose =
				attempt === 1
					? "codeact-temporal-bash-scaffold"
					: `codeact-temporal-bash-scaffold-repair-${attempt - 1}`;
			if (attempt > 1) {
				this.recordWorker({
					workerId: "codeact-scaffold-agent",
					phase: "retrying",
					message: `Repair attempt ${attempt - 1}: Pi is correcting the generated Temporal scaffold.`,
				});
				this.recordTool(
					"scaffold_repair_feedback",
					purpose,
					[
						"The harness fed the previous generated scaffold failure back to Pi.",
						previousError,
						"Pi must return a complete corrected bash-heredoc scaffold.",
					].join("\n"),
				);
			}

			try {
				const output = await this.generateWithLlm(
					{
						purpose,
						prompt,
						timeoutMs,
					},
					{ recordOutput: false },
				);
				previousOutput = output;
				const spec = this.parseTemporalScaffoldOutput(output);
				const generated = await writeTemporalScaffold(scaffoldDir, spec);
				const validation = await validateTemporalScaffold(scaffoldDir);
				this.recordTool(
					"llm_output_validated",
					purpose,
					[
						"Pi returned a scaffold candidate and the harness accepted it after parsing, py_compile, generated-code lint, and Temporal primitive validation.",
						"",
						output,
					].join("\n"),
				);
				if (attempt > 1) {
					this.recordTool(
						"scaffold_repair_success",
						purpose,
						[
							`Pi repair attempt ${attempt - 1} produced a valid scaffold.`,
							...validation,
						].join("\n"),
					);
				}
				return { spec, generated, validation, usedFallback: false };
			} catch (error) {
				previousError = error instanceof Error ? error.message : String(error);
				this.recordTool(
					"llm_output_rejected",
					purpose,
					[
						"Rejected Pi scaffold candidate before execution.",
						`Reason: ${previousError}`,
						"Invalid candidate code is intentionally not displayed as generated code because it may contain fabricated placeholder URLs or broken Temporal wiring.",
					].join("\n"),
				);
				this.record(
					"observation",
					`Pi scaffold attempt ${attempt}/${maxAttempts} failed validation. ${previousError}`,
				);
				if (attempt < maxAttempts) {
					prompt = buildTemporalScaffoldRepairPrompt(
						basePrompt,
						previousError,
						previousOutput,
						attempt,
					);
				}
			}
		}

		this.record(
			"observation",
			`Pi scaffold repair attempts were exhausted; continuing with the demo-safe fallback scaffold. ${previousError}`,
		);
		this.recordTool(
			"scaffold_generation_fallback",
			"codeact-temporal-bash-scaffold",
			[
				"Pi did not return a complete valid bash-heredoc scaffold after repair feedback.",
				"The harness is continuing with its validated Temporal scaffold so the demo does not hang.",
				"Generated-code lint and py_compile still run before extraction.",
			].join("\n"),
		);
		const spec = createTemporalScaffoldSpec();
		const generated = await writeTemporalScaffold(scaffoldDir, spec);
		const validation = await validateTemporalScaffold(scaffoldDir);
		return { spec, generated, validation, usedFallback: true };
	}

	private parseTemporalScaffoldOutput(output: string): TemporalScaffoldSpec {
		try {
			return parseTemporalScaffoldSpecFromBash(output);
		} catch (bashError) {
			const bashMessage =
				bashError instanceof Error ? bashError.message : String(bashError);
			this.record(
				"observation",
				`Pi bash scaffold was incomplete or used an unsupported file-write shape; trying legacy file-bundle parser. ${bashMessage}`,
			);
			try {
				return parseTemporalScaffoldSpecFromLlm(output);
			} catch {
				throw new Error(
					`Pi output did not contain a complete scaffold. Last bash parser error: ${bashMessage}`,
				);
			}
		}
	}

	private record(
		kind: HarnessEvent["kind"],
		message: string,
		artifactPath?: string,
	): void {
		const event: HarnessEvent = {
			at: new Date().toISOString(),
			agent: this.agent,
			kind,
			message,
			artifactPath,
		};
		this.events.push(event);
		this.onStream?.({ type: "event", event });
	}

	private recordTool(tool: string, input: string, output: string): void {
		const toolCall = { agent: this.agent, tool, input, output };
		this.toolCalls.push(toolCall);
		this.record("tool", `${tool}: ${input}`);
		this.onStream?.({ type: "tool", toolCall });
		this.transcript.push(`tool.${tool}(${JSON.stringify(input)}):\n${output}`);
	}

	private recordWorker(event: Omit<HarnessWorkerEvent, "agent" | "at">): void {
		const worker = {
			...event,
			at: new Date().toISOString(),
			agent: this.agent,
		};
		this.workerEvents.push(worker);
		this.onStream?.({ type: "worker", worker });
		this.transcript.push(
			`worker.${worker.workerId}.${worker.phase}: ${worker.message}`,
		);
	}
}

function buildMarketingEvidenceBrief(result: CaseStudyResearchResult): string {
	const proofRows = result.records
		.map((record, index) =>
			[
				`Proof ${index + 1}: ${record.company}`,
				`Headline: ${record.headline}`,
				`Use case: ${record.useCase ?? "Extracted from Temporal customer-story copy"}`,
				`Evidence quote: ${record.evidenceQuote}`,
				`Temporal value: ${record.temporalValue}`,
				`Source: ${record.url}`,
			].join("\n"),
		)
		.join("\n\n");
	const failures =
		result.failures.length > 0
			? result.failures
					.map(
						(failure) =>
							`- ${failure.url}: ${failure.step} failed after ${failure.attempts} attempt(s)`,
					)
					.join("\n")
			: "- none";
	return [
		`Goal: Generate a cited customer-proof marketing page from Temporal-owned case-study facts.`,
		`Coverage: ${result.records.length}/${result.targetCount} valid customer stories.`,
		`Pages attempted: ${result.attemptedUrls.length}.`,
		`Failed pages: ${result.failures.length}.`,
		`Retries: ${result.retries}.`,
		`Status: ${result.status}.`,
		`Exit condition: ${result.exitCondition}`,
		"",
		"Customer proof rows:",
		proofRows || "No valid customer proof rows were extracted.",
		"",
		"Coverage gaps:",
		result.records.length < result.targetCount
			? `Need review: only ${result.records.length}/${result.targetCount} records were found. Do not invent missing stories.`
			: "Target met. Still cite every claim.",
		"",
		"Failed or rejected pages:",
		failures,
	].join("\n");
}

function uniqueUrls(urls: string[]): string[] {
	return [...new Set(urls.map((url) => url.replace(/\/$/, "")))];
}

function buildTemporalScaffoldLlmPrompt(): string {
	const scaffold = createTemporalScaffoldSpec();
	return [
		"You are Pi running CodeAct for a developer demo.",
		"Generate a bash script that writes a Python Temporal scaffold for Temporal customer case-study research.",
		"Return ONLY bash text. Do not return JSON. Do not wrap the answer in Markdown fences.",
		"Use single-quoted heredocs so Python code is written exactly as text.",
		"Use this write pattern for every file:",
		"cat > 'src/workflows.py' <<'PI_TEMPORAL_WORKFLOWS_PY'",
		"...python code...",
		"PI_TEMPORAL_WORKFLOWS_PY",
		"Required script shape:",
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		"mkdir -p src",
		"cat > 'requirements.txt' <<'PI_TEMPORAL_REQUIREMENTS_TXT'",
		"temporalio>=1.8.0",
		"PI_TEMPORAL_REQUIREMENTS_TXT",
		"...write every required file listed below...",
		"python3 -m py_compile src/*.py",
		"",
		buildTemporalSkillContextWindow(),
		"",
		"Required files:",
		...scaffold.files.map((file) => `- ${file.path}: ${file.purpose}`),
		"Required Temporal primitives and code signals:",
		...temporalPrimitiveCatalog.map(
			(primitive) => `- ${primitive.label}: ${primitive.codeSignal}`,
		),
		"Strict validation contract:",
		"- requirements.txt must include every third-party package imported by generated Python, such as requests, beautifulsoup4, or lxml. Prefer stdlib urllib.request and html.parser/re when possible.",
		"- Do not rename TemporalCaseStudyResearchWorkflow.",
		"- src/models.py must define CaseStudyRecord fields url, company, headline, summary, evidence_quote, and temporal_value.",
		"- src/models.py must define workflow state with records, attempted_urls, discovered_urls, and failed_pages.",
		"- src/workflows.py must contain exactly: @workflow.defn class TemporalCaseStudyResearchWorkflow",
		"- src/workflows.py must contain @workflow.signal async def approve_export and @workflow.query def current_state.",
		"- src/workflows.py must import activity functions inside with workflow.unsafe.imports_passed_through(): so network libraries used by Activities are not imported through the workflow sandbox.",
		"- src/workflows.py must contain RetryPolicy(maximum_attempts=3).",
		"- src/workflows.py must contain asyncio.gather(*tasks, return_exceptions=True).",
		"- src/workflows.py must accept page_budget and use it to bound discovered URLs before extraction.",
		"- src/workflows.py must pass page_budget, not batch_size, to discover_case_study_urls so discovery can find enough URLs for 20 records.",
		"- src/workflows.py must map parallel results with zip(batch, results); do not index discovered_urls using len(attempted_urls) + i while mutating attempted_urls.",
		"- src/workflows.py must not require isinstance(result, CaseStudyRecord) before appending activity output; Temporal payload conversion may return dict-shaped records, so append valid non-exception results or normalize dicts before appending.",
		"- src/activities.py must contain @activity.defn def fetch_and_extract_case_study and ApplicationError.",
		"- src/activities.py must crawl live Temporal-owned sources: https://temporal.io/in-use and https://temporal.io/sitemap.xml.",
		"- src/activities.py must only count URLs under /resources/case-studies/ as valid case studies.",
		"- src/activities.py must return CaseStudyRecord values with company, headline, summary, evidence_quote, and temporal_value populated from page text.",
		"- src/activities.py must not fabricate example URLs, fake companies, fixture records, or preloaded case-study data.",
		"- src/worker.py must contain Worker(client, task_queue=TASK_QUEUE and the literal activity_executor.",
		"- src/worker.py must connect with TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_API_KEY, and tls=True when an API key is present.",
		"- src/client.py must read CODEACT_WORKFLOW_ID, CODEACT_TARGET_COUNT, CODEACT_BATCH_SIZE, and CODEACT_PAGE_BUDGET.",
		"- src/client.py must connect with TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_API_KEY, and tls=True when an API key is present.",
		"- src/client.py must pass the API key with Client.connect(..., api_key=api_key, tls=True if api_key else False); do not use rpc_metadata for authentication.",
		"- src/worker.py must pass the API key with Client.connect(..., api_key=api_key, tls=True if api_key else False); do not use rpc_metadata for authentication.",
		"- src/client.py must print JSON lines prefixed with CODEACT_TEMPORAL_EVENT so the UI can show the generated workflow ID, activity names, and final state.",
		"- src/client.py must import asdict and is_dataclass from dataclasses, define to_jsonable(...), and pass every event payload through to_jsonable before json.dumps.",
		"- The workflow_completed event must include state=result so the TypeScript harness can build the marketing artifact from the generated workflow output.",
		"- The workflow_completed event must be JSON serializable even when result is a dataclass such as WorkflowState.",
		"- Do not use TEMPORAL_HOST; this demo's Cloud contract is TEMPORAL_ADDRESS.",
		"- src/extractor.py must import ThreadPoolExecutor and define bounded_parallel_extract.",
		"Required worker.py shape:",
		"from concurrent.futures import ThreadPoolExecutor",
		"activity_executor = ThreadPoolExecutor(max_workers=8)",
		"worker = Worker(client, task_queue=TASK_QUEUE, workflows=[TemporalCaseStudyResearchWorkflow], activities=[discover_case_study_urls, fetch_and_extract_case_study, export_marketing_html], activity_executor=activity_executor)",
		"Required extractor.py shape:",
		"from concurrent.futures import ThreadPoolExecutor",
		"def bounded_parallel_extract(urls: list[str], limit: int = 8) -> dict:",
		"Required client.py runtime behavior:",
		'workflow_id = os.getenv("CODEACT_WORKFLOW_ID") or f"temporal-case-study-research-{uuid.uuid4()}"',
		"handle = await client.start_workflow(TemporalCaseStudyResearchWorkflow.run, args=[target_count, batch_size, page_budget], id=workflow_id, task_queue=TASK_QUEUE)",
		"state = await handle.query(TemporalCaseStudyResearchWorkflow.current_state)",
		'await handle.signal(TemporalCaseStudyResearchWorkflow.approve_export, "approved from generated client")',
		'print("CODEACT_TEMPORAL_EVENT " + json.dumps({"event": event, **to_jsonable(payload)}), flush=True)',
		'emit("workflow_completed", workflow_id=workflow_id, state=result, records=len(result.records), failures=len(result.failed_pages), attempted=len(result.attempted_urls))',
		"Implementation requirements:",
		"- Workflow code must be deterministic: no network, filesystem, or subprocess calls inside workflow methods.",
		"- Put live crawling/fetching/extraction/export in Activities.",
		"- Include Signals for pause/review and approval.",
		"- Include a Query for current state.",
		"- Include RetryPolicy with retryable and non-retryable activity failures.",
		"- Include bounded parallel activity execution with asyncio.gather(..., return_exceptions=True).",
		"- Include Worker and Client files using env vars for Temporal connection details.",
		"- Do not include real secrets, API keys, namespaces, or raw environment values.",
		"- Generated Python must pass py_compile and the demo lint: no tabs, no trailing whitespace, no bare except.",
	].join("\n");
}

function buildTemporalScaffoldRepairPrompt(
	basePrompt: string,
	error: string,
	previousOutput: string,
	attempt: number,
): string {
	return [
		"You are Pi repairing CodeAct-generated Temporal scaffold code after harness validation failed.",
		`Repair attempt: ${attempt}.`,
		"Return ONLY the complete corrected bash-heredoc script. Do not return JSON, Markdown fences, prose, diff, or patch.",
		"The corrected script must rewrite every required file, not only the broken file.",
		"The harness will parse the heredocs, write the files, run py_compile, lint, and validate Temporal primitives again.",
		"Repair rule: preserve working files from the prior attempt, but update every file needed to satisfy the missing literal below.",
		"If the failure mentions src/models.py, define CaseStudyRecord with url, company, headline, summary, evidence_quote, and temporal_value.",
		"If the failure mentions workflow.unsafe.imports_passed_through or workflow sandbox, import models and activities inside with workflow.unsafe.imports_passed_through(): in src/workflows.py.",
		"If the failure mentions requirements.txt, add every third-party package imported by generated code, for example requests, beautifulsoup4, or lxml.",
		"If the failure mentions src/worker.py, include activity_executor and Worker(client, task_queue=TASK_QUEUE in src/worker.py.",
		"If the failure mentions TEMPORAL_HOST, replace it with TEMPORAL_ADDRESS and include TEMPORAL_API_KEY plus tls=True when present.",
		"If the failure mentions rpc_metadata or Jwt is missing, pass api_key=api_key into Client.connect and do not use rpc_metadata for Temporal Cloud auth.",
		"If the failure mentions src/client.py, include CODEACT_WORKFLOW_ID, current_state, approve_export, and CODEACT_TEMPORAL_EVENT JSON-line output.",
		"If the failure mentions state=result, make the final CODEACT_TEMPORAL_EVENT workflow_completed payload include state=result.",
		"If the failure mentions to_jsonable, JSON serializable, WorkflowState, asdict, or is_dataclass, convert dataclasses with asdict/is_dataclass before calling json.dumps.",
		"If the failure mentions page_budget, update src/workflows.py so run accepts page_budget and slices discovered URLs before extraction.",
		"If the failure says pass page_budget, not batch_size, call discover_case_study_urls with page_budget from the workflow run arguments.",
		"If the failure mentions zip(batch, results), discovered_urls[len(...)] indexing, or len(attempted_urls) + i, rewrite result handling to iterate for url, result in zip(batch, results) before mutating attempted_urls.",
		"If the failure mentions isinstance(result, CaseStudyRecord), rewrite src/workflows.py so non-exception activity results are appended or normalized from dicts; do not drop records just because Temporal decoded them as dictionaries.",
		"If the failure mentions live Temporal case-study pages or examples, replace fake example URLs with live crawling of https://temporal.io/in-use and https://temporal.io/sitemap.xml, and accept only /resources/case-studies/ URLs.",
		"If the failure mentions evidence_quote or temporal_value, update src/activities.py so fetch_and_extract_case_study returns those fields from extracted page text.",
		"If the failure mentions src/extractor.py, import ThreadPoolExecutor and define bounded_parallel_extract in src/extractor.py.",
		"",
		"Validation or parser failure to fix:",
		truncateForRepairPrompt(error, 4000),
		"",
		"Previous Pi output, for context:",
		truncateForRepairPrompt(
			previousOutput || "<no prior output was captured>",
			20_000,
		),
		"",
		"Original scaffold requirements still apply:",
		basePrompt,
	].join("\n");
}

function truncateForRepairPrompt(value: string, maxLength: number): string {
	const redacted = redactRejectedScaffoldPlaceholders(redactSecrets(value));
	if (redacted.length <= maxLength) return redacted;
	return `${redacted.slice(0, maxLength)}\n...[truncated ${redacted.length - maxLength} characters]`;
}

function redactRejectedScaffoldPlaceholders(value: string): string {
	return value
		.replace(
			/https:\/\/temporal\.io\/(?:resources\/)?case-studies\/example-\d+/g,
			"[rejected-placeholder-url]",
		)
		.replace(/\bexample-\d+\b/g, "[rejected-example-id]")
		.replace(/\bCompany-\{?[^"'\s),]+/g, "[rejected-placeholder-company]");
}

function renderFallbackNarrative(
	mode: "react" | "codeact",
	result: CaseStudyResearchResult,
	reason: string,
): string {
	return [
		`# ${mode === "react" ? "ReAct" : "CodeAct"} Agent Execution`,
		"",
		"The LLM response for the final artifact bundle was not valid JSON, so the harness rendered this fallback narrative from the durable research state.",
		"",
		`Fallback reason: ${reason}`,
		"",
		`Records: ${result.records.length}/${result.targetCount}`,
		`Status: ${result.status}`,
		`Exit condition: ${result.exitCondition}`,
		"",
		"## Source Records",
		"",
		...result.records.map((record) => `- ${record.company}: ${record.url}`),
		"",
	].join("\n");
}

function buildPiLiveTemporalSearchPrompt(): string {
	return [
		"You are Pi acting as the live website research agent for a Temporal developer demo.",
		"You MUST use the free_web_search tool at least once, and use free_fetch_content for promising Temporal-owned results when needed.",
		"Do not use local files, repo fixtures, saved artifacts, or memory for discovery.",
		"Search only these Temporal-owned sources:",
		`- ${TEMPORAL_CUSTOMER_STORIES_URL}`,
		`- ${TEMPORAL_SITEMAP_URL}`,
		"Count only URLs under https://temporal.io/resources/case-studies/ as valid customer-story candidates.",
		"Recommended tool shapes:",
		'- free_web_search({ "query": "site:temporal.io/resources/case-studies Temporal customer case studies", "numResults": <your chosen bounded search result count>, "detail": "lean" })',
		'- free_fetch_content({ "url": "https://temporal.io/in-use", "detail": "summary" })',
		"Choose the ReAct execution strategy you would use for this business task.",
		"Plan in a parallel-minded ReAct style: identify independent research branches that could be fetched/extracted concurrently, then choose the bounded concurrency you would use.",
		"Return a concise parallelPlan list with branch-level actions only. Do not include private chain-of-thought.",
		"Choose how many valid case-study records to target, how many candidate pages to inspect, and whether page processing should be single-lane or concurrent.",
		"Keep it bounded for a live demo: targetCount must be 1-20, pageBudget must be 1-40, and concurrency must be 1-8.",
		"Return only the discoveredUrls you actually found. Do not pad the URL list to a fixed count.",
		"Return ONLY JSON with this shape:",
		'{"discoveredUrls":["https://temporal.io/resources/case-studies/..."],"executionStrategy":{"targetCount":6,"pageBudget":8,"concurrency":2,"parallelPlan":["branch 1: fetch AI-agent case studies","branch 2: fetch platform reliability case studies"],"rationale":"short reason"},"observations":["short note"]}',
		"Do not include raw environment variables, API keys, Temporal namespace, PI_COMMAND, or secrets.",
		"Do not invent URLs. If the live fetch fails, return JSON with discoveredUrls as an empty array and observations explaining the failure.",
	].join("\n");
}

function parsePiLiveSearchResult(markdown: string): PiLiveSearchResult {
	const parsed = parseJsonFromLlm(markdown) as {
		discoveredUrls?: unknown;
		executionStrategy?: unknown;
		strategy?: unknown;
		targetCount?: unknown;
		targetRecords?: unknown;
		caseStudyTarget?: unknown;
		pageBudget?: unknown;
		concurrency?: unknown;
		parallelPlan?: unknown;
		parallelBranches?: unknown;
		branches?: unknown;
		rationale?: unknown;
	};
	if (!Array.isArray(parsed.discoveredUrls)) {
		throw new Error("Pi live search response must include discoveredUrls.");
	}
	const urls = [
		...new Set(
			parsed.discoveredUrls.filter(
				(url): url is string => typeof url === "string",
			),
		),
	].filter(isTemporalCaseStudyUrl);
	if (urls.length === 0) {
		throw new Error(
			"Pi live search did not return any valid Temporal case-study URLs.",
		);
	}
	const strategySource =
		parsed.executionStrategy && typeof parsed.executionStrategy === "object"
			? (parsed.executionStrategy as Record<string, unknown>)
			: parsed.strategy && typeof parsed.strategy === "object"
				? (parsed.strategy as Record<string, unknown>)
				: parsed;
	return {
		urls,
		strategy: {
			targetCount:
				integerOrUndefined(strategySource.targetCount) ??
				integerOrUndefined(strategySource.targetRecords) ??
				integerOrUndefined(strategySource.caseStudyTarget),
			pageBudget: integerOrUndefined(strategySource.pageBudget),
			concurrency: integerOrUndefined(strategySource.concurrency),
			parallelPlan: stringListOrUndefined(
				strategySource.parallelPlan ??
					strategySource.parallelBranches ??
					strategySource.branches,
			),
			rationale:
				typeof strategySource.rationale === "string"
					? strategySource.rationale
					: undefined,
		},
	};
}

function normalizeReactExecutionStrategy(
	strategy: Partial<ReactExecutionStrategy> | undefined,
	options: {
		pageBudgetOverride?: number;
		targetCountCap: number;
		discoveredCount: number;
	},
): ReactExecutionStrategy {
	const targetCount = clampInteger(
		strategy?.targetCount ??
			Math.min(options.targetCountCap, Math.max(1, options.discoveredCount)),
		1,
		options.targetCountCap,
	);
	const pageBudget = clampInteger(
		options.pageBudgetOverride ??
			strategy?.pageBudget ??
			Math.min(REACT_DEFAULT_PAGE_BUDGET, targetCount),
		1,
		CODEACT_PAGE_BUDGET,
	);
	const concurrency = clampInteger(
		strategy?.concurrency ?? 1,
		1,
		Math.min(CODEACT_CONCURRENCY, pageBudget),
	);
	const parallelPlan =
		strategy?.parallelPlan
			?.filter((entry) => entry.trim().length > 0)
			.slice(0, concurrency) ?? defaultReactParallelPlan(concurrency);
	const rationale =
		strategy?.rationale?.trim() ||
		"Pi did not provide a usable execution strategy, so the harness used the bounded ReAct fallback.";
	return { targetCount, pageBudget, concurrency, parallelPlan, rationale };
}

function integerOrUndefined(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value))
		return Math.floor(value);
	if (
		typeof value === "string" &&
		value.trim() &&
		Number.isFinite(Number(value))
	)
		return Math.floor(Number(value));
	return undefined;
}

function stringListOrUndefined(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const strings = value.filter(
			(entry): entry is string => typeof entry === "string",
		);
		return strings.length > 0 ? strings : undefined;
	}
	if (typeof value === "string" && value.trim()) return [value.trim()];
	return undefined;
}

function defaultReactParallelPlan(concurrency: number): string[] {
	if (concurrency <= 1)
		return [
			"single branch: fetch and extract the most promising Temporal case-study candidates",
		];
	return Array.from(
		{ length: concurrency },
		(_, index) =>
			`branch ${index + 1}: fetch and extract an independent subset of Temporal case-study candidates`,
	);
}

function clampInteger(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function parseArtifactBundleFromLlm(markdown: string): CaseStudyArtifactBundle {
	const tagged = parseTaggedArtifactBundle(markdown);
	if (tagged) return tagged;
	const parsed = parseJsonFromLlm(markdown) as Partial<CaseStudyArtifactBundle>;
	if (
		typeof parsed.html !== "string" ||
		typeof parsed.citationsMarkdown !== "string" ||
		typeof parsed.narrativeMarkdown !== "string"
	) {
		throw new Error(
			"LLM artifact response must include html, citationsMarkdown, and narrativeMarkdown strings.",
		);
	}
	return {
		html: extractHtmlDocument(parsed.html),
		citationsMarkdown: parsed.citationsMarkdown,
		narrativeMarkdown: parsed.narrativeMarkdown,
	};
}

function parseTaggedArtifactBundle(
	markdown: string,
): CaseStudyArtifactBundle | undefined {
	const html = extractTaggedSection(markdown, "HTML", "CITATIONS");
	const citationsMarkdown = extractTaggedSection(
		markdown,
		"CITATIONS",
		"NARRATIVE",
	);
	const narrativeMarkdown = extractTaggedSection(markdown, "NARRATIVE", "END");
	if (!html && !citationsMarkdown && !narrativeMarkdown) return undefined;
	if (!html || !citationsMarkdown || !narrativeMarkdown) {
		throw new Error(
			"Tagged artifact response must include HTML, CITATIONS, NARRATIVE, and END sections.",
		);
	}
	return {
		html: extractHtmlDocument(html),
		citationsMarkdown,
		narrativeMarkdown,
	};
}

function extractTaggedSection(
	value: string,
	startLabel: string,
	endLabel: string,
): string | undefined {
	const pattern = new RegExp(
		`---${startLabel}---\\s*([\\s\\S]*?)\\s*---${endLabel}---`,
		"i",
	);
	return pattern.exec(value)?.[1]?.trim();
}

function extractHtmlDocument(markdown: string): string {
	const html =
		/```html\s*([\s\S]*?)```/i.exec(markdown)?.[1]?.trim() ?? markdown.trim();
	if (!/^<!doctype html>/i.test(html)) {
		throw new Error("LLM HTML artifact must start with <!doctype html>.");
	}
	return html;
}

function parseJsonFromLlm(markdown: string): unknown {
	const fenced = /```json\s*([\s\S]*?)```/i.exec(markdown)?.[1];
	const raw = (fenced ?? markdown).trim();
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end < start)
		throw new Error("LLM response did not contain a JSON object.");
	return JSON.parse(raw.slice(start, end + 1));
}
