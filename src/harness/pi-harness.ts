import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
	type ExtractCaseStudyRecord,
	type FailedPage,
	type FetchText,
	isTemporalCaseStudyUrl,
	renderCaseStudyMarketingPage,
	renderCaseStudySourceCitations,
	TEMPORAL_CUSTOMER_STORIES_URL,
	TEMPORAL_SITEMAP_URL,
} from "../case-study-research.ts";
import { artifactsDir } from "../paths.ts";
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
	runCodeActScaffoldChildWorkflow,
	shouldRunCodeActScaffoldChildWorkflow,
} from "./scaffold-child-workflow.ts";
import {
	buildTemporalAgentSkillGenerationSummary,
	buildTemporalValidationReferenceSummary,
	createTemporalScaffoldSpec,
	parseTemporalScaffoldSpecFromBash,
	parseTemporalScaffoldSpecFromLlm,
	type TemporalScaffoldSpec,
	temporalDeveloperSkillName,
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

interface PiExtractionCacheKey {
	key: string;
	promptHash: string;
	url: string;
}

interface PiExtractionCacheEntry {
	version: string;
	key: string;
	url: string;
	promptHash: string;
	storedAt: string;
	valid: boolean;
	record?: CaseStudyRecord;
}

interface PiExtractionCacheFile {
	version: number;
	entries: Record<string, PiExtractionCacheEntry>;
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
	private readonly piExtractionCache?: PiExtractionCacheStore;

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
			| "enableCodeActScaffoldChildWorkflow"
			| "enablePiExtractionCache"
			| "piExtractionCachePath"
		> = {},
	) {
		this.piExtractionCache = createPiExtractionCacheStore(researchOptions);
	}

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
			defaultPageBudget:
				this.researchOptions.codeActPageBudget ?? CODEACT_PAGE_BUDGET,
			targetCountCap:
				this.researchOptions.researchTargetCount ?? CASE_STUDY_TARGET_COUNT,
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
			extractRecord: this.createPiRuntimeExtractor("react"),
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
		const extractRecord = this.createPiRuntimeExtractor("codeact");
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
						extractRecord,
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
		extractRecord: ExtractCaseStudyRecord,
		maxAttempts: number,
	): Promise<{
		record?: CaseStudyRecord;
		failure?: FailedPage;
		retries: number;
	}> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			let html: string;
			try {
				html = await fetchText(url);
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
				continue;
			}
			try {
				const record = await extractRecord(url, html);
				if (record) return { record, retries: attempt - 1 };
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
			} catch (error) {
				return {
					failure: this.failedPage(url, "extract", error, attempt, false),
					retries: attempt - 1,
				};
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

	private createPiRuntimeExtractor(
		mode: "react" | "codeact",
	): ExtractCaseStudyRecord {
		return async (url, html) =>
			this.extractCaseStudyRecordWithPi(mode, url, html);
	}

	private async extractCaseStudyRecordWithPi(
		mode: "react" | "codeact",
		url: string,
		html: string,
	): Promise<CaseStudyRecord | undefined> {
		const purpose = `${mode}-case-study-record-extraction`;
		const prompt = buildPiCaseStudyExtractionPrompt(url, html);
		const cacheKey = buildPiExtractionCacheKey(url, prompt);
		this.recordTool(
			"pi_runtime_extract_case_study",
			url,
			[
				`purpose=${purpose}`,
				`htmlCharacters=${html.length}`,
				`promptCharacters=${prompt.length}`,
				this.piExtractionCache
					? `cacheKey=${cacheKey.key.slice(0, 16)}`
					: "cache=disabled",
				"Semantic extraction is delegated to Pi runtime; local regex is used only for URL filtering and response validation.",
			].join("\n"),
		);
		const cached = await this.readPiExtractionCache(url, cacheKey);
		if (cached) {
			this.recordPiExtractionOutput(url, cached.record);
			return cached.record;
		}
		const markdown = await this.generateWithLlm(
			{
				purpose,
				prompt,
				skillName: "temporal-case-study-marketing-page",
				timeoutMs: 180_000,
			},
			{ recordPrompt: false },
		);
		const record = parsePiCaseStudyExtraction(markdown, url);
		await this.writePiExtractionCache(url, cacheKey, record);
		this.recordPiExtractionOutput(url, record);
		return record;
	}

	private async readPiExtractionCache(
		url: string,
		cacheKey: PiExtractionCacheKey,
	): Promise<{ record?: CaseStudyRecord } | undefined> {
		if (!this.piExtractionCache) return undefined;
		try {
			const cached = await this.piExtractionCache.get(cacheKey.key);
			this.recordTool(
				"pi_runtime_extract_case_study_cache",
				url,
				JSON.stringify(
					{
						status: cached ? "hit" : "miss",
						key: cacheKey.key.slice(0, 16),
						valid: cached?.valid,
					},
					null,
					2,
				),
			);
			if (!cached) return undefined;
			return {
				record: cached.record ? cloneCaseStudyRecord(cached.record) : undefined,
			};
		} catch (error) {
			this.recordTool(
				"pi_runtime_extract_case_study_cache",
				url,
				`cache read failed; continuing without cache. ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	}

	private async writePiExtractionCache(
		url: string,
		cacheKey: PiExtractionCacheKey,
		record: CaseStudyRecord | undefined,
	): Promise<void> {
		if (!this.piExtractionCache) return;
		try {
			await this.piExtractionCache.set({
				version: PI_EXTRACTION_CACHE_VERSION,
				key: cacheKey.key,
				url: cacheKey.url,
				promptHash: cacheKey.promptHash,
				storedAt: new Date().toISOString(),
				valid: Boolean(record),
				record: record ? cloneCaseStudyRecord(record) : undefined,
			});
			this.recordTool(
				"pi_runtime_extract_case_study_cache",
				url,
				JSON.stringify(
					{
						status: "stored",
						key: cacheKey.key.slice(0, 16),
						valid: Boolean(record),
					},
					null,
					2,
				),
			);
		} catch (error) {
			this.recordTool(
				"pi_runtime_extract_case_study_cache",
				url,
				`cache write failed; extraction result still used. ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private recordPiExtractionOutput(
		url: string,
		record: CaseStudyRecord | undefined,
	): void {
		this.recordTool(
			"pi_runtime_extract_case_study_output",
			url,
			record
				? JSON.stringify(
						{
							company: record.company,
							headline: record.headline,
							useCase: record.useCase,
						},
						null,
						2,
					)
				: "Pi marked this page as not a valid Temporal case-study record.",
		);
	}

	async generateWithLlm(
		request: HarnessLlmRequest,
		options: { recordOutput?: boolean; recordPrompt?: boolean } = {},
	): Promise<string> {
		this.record("act", `llm ${request.purpose}`);
		this.recordTool(
			"llm_prompt",
			request.purpose,
			options.recordPrompt === false
				? `<prompt omitted from transcript; ${request.prompt.length} characters>`
				: request.prompt,
		);
		const effectiveSkillName =
			request.skillName === null
				? undefined
				: (request.skillName ?? "temporal-codeact-builder");
		if (effectiveSkillName) {
			this.recordTool(
				"pi_agent_skill",
				request.purpose,
				`--skill skills/${effectiveSkillName}/SKILL.md`,
			);
		}
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
					skillName: effectiveSkillName,
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
		const purpose = `${mode}-case-study-artifact-bundle`;
		const fallback = (reason: string): CaseStudyArtifactBundle => {
			this.record(
				"observation",
				`Pi artifact bundle response was unavailable or invalid; continuing with fallback artifact rendering. ${truncateForRepairPrompt(reason, 1000)}`,
			);
			this.recordTool(
				"artifact_bundle_fallback",
				purpose,
				[
					"Pi did not return a usable HTML/citations/narrative bundle.",
					"The harness rendered deterministic fallback artifacts from the extracted research state.",
					"Source URLs and extracted facts are still preserved; no customer stories are invented.",
				].join("\n"),
			);
			return {
				html: renderCaseStudyMarketingPage(mode, result),
				citationsMarkdown: renderCaseStudySourceCitations(result),
				narrativeMarkdown: renderFallbackNarrative(mode, result, reason),
			};
		};
		let response: string;
		try {
			response = await this.generateWithLlm({
				purpose,
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
		} catch (error) {
			return fallback(error instanceof Error ? error.message : String(error));
		}
		try {
			return parseArtifactBundleFromLlm(response);
		} catch (error) {
			return fallback(error instanceof Error ? error.message : String(error));
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

		if (command === "temporal agent skill load") {
			const output = buildTemporalAgentSkillGenerationSummary();
			this.recordTool(
				"temporal_agent_skill_loaded",
				"Temporal Agent Skill -> CodeAct scaffold generation",
				output,
			);
			return output;
		}

		if (command === "temporal scaffold validation-references") {
			const output = buildTemporalValidationReferenceSummary();
			this.recordTool(
				"temporal_validation_references",
				"Temporal Python references -> generation and validation checks",
				output,
			);
			return output;
		}

		throw new Error(`Unsupported harness bash command: ${command}`);
	}

	private async generateWriteAndValidateTemporalScaffold(
		scaffoldDir: string,
	): Promise<ScaffoldAttemptResult> {
		if (this.shouldStartScaffoldChildWorkflow()) {
			try {
				return await this.generateWriteAndValidateTemporalScaffoldAsChildWorkflow(
					scaffoldDir,
				);
			} catch (error) {
				this.recordTool(
					"temporal_child_workflow_fallback",
					"codeact-scaffold-child-workflow",
					[
						"Temporal child workflow orchestration failed before returning a scaffold.",
						redactSecrets(
							error instanceof Error ? error.message : String(error),
						),
						"Falling back to the local harness validate/repair loop.",
					].join("\n"),
				);
			}
		}
		return this.generateWriteAndValidateTemporalScaffoldLocally(scaffoldDir);
	}

	private shouldStartScaffoldChildWorkflow(): boolean {
		if (this.researchOptions.enableCodeActScaffoldChildWorkflow !== undefined) {
			return (
				this.researchOptions.enableCodeActScaffoldChildWorkflow &&
				!this.researchOptions.llmGenerate
			);
		}
		return shouldRunCodeActScaffoldChildWorkflow(
			Boolean(this.researchOptions.llmGenerate),
		);
	}

	private async generateWriteAndValidateTemporalScaffoldAsChildWorkflow(
		scaffoldDir: string,
	): Promise<ScaffoldAttemptResult> {
		const timeoutMs = Number(
			process.env.CODEACT_SCAFFOLD_TIMEOUT_MS || 150_000,
		);
		const configuredRepairAttempts = Number(
			process.env.CODEACT_SCAFFOLD_REPAIR_ATTEMPTS || 3,
		);
		const repairAttempts = Number.isFinite(configuredRepairAttempts)
			? Math.max(3, Math.floor(configuredRepairAttempts))
			: 3;
		const runId = this.runDir.split("/").pop() || `codeact-${Date.now()}`;
		this.recordWorker({
			workerId: "codeact-scaffold-child-workflow",
			phase: "planned",
			message:
				"Temporal parent workflow will run scaffold validation and repair as a child workflow.",
		});
		const result = await runCodeActScaffoldChildWorkflow({
			runId,
			scaffoldDir,
			repairAttempts,
			timeoutMs,
		});
		this.recordWorker({
			workerId: "codeact-scaffold-child-workflow",
			phase: "complete",
			message: `Child workflow ${result.childWorkflowId || "unknown"} returned ${
				result.usedFallback
					? "the validated fallback scaffold"
					: `a validated scaffold on attempt ${
							result.acceptedAttempt ?? "unknown"
						}`
			}.`,
		});
		this.recordTool(
			"temporal_child_workflow",
			result.parentWorkflowId || "codeActScaffoldParentWorkflow",
			JSON.stringify(
				{
					parentWorkflowId: result.parentWorkflowId,
					childWorkflowId: result.childWorkflowId,
					attempts: result.attempts,
					usedFallback: result.usedFallback,
					acceptedAttempt: result.acceptedAttempt,
				},
				null,
				2,
			),
		);
		for (const attempt of result.attempts) {
			if (attempt.attempt > 1) {
				this.recordTool(
					"scaffold_repair_feedback",
					attempt.purpose,
					[
						"The Temporal child workflow fed the previous generated scaffold failure back to Pi.",
						attempt.errorMessage || "Previous scaffold attempt failed.",
						"Pi had to return a complete corrected bash-heredoc scaffold.",
					].join("\n"),
				);
			}
			if (attempt.status === "rejected") {
				this.recordTool(
					"llm_output_rejected",
					attempt.purpose,
					[
						"Rejected Pi scaffold candidate inside the Temporal child workflow.",
						`Reason: ${attempt.errorMessage || "Unknown validation failure"}`,
						"Invalid candidate code is intentionally not displayed as generated code because it may contain fabricated placeholder URLs or broken Temporal wiring.",
					].join("\n"),
				);
			}
		}
		if (result.usedFallback) {
			this.recordTool(
				"scaffold_generation_fallback",
				"codeact-temporal-bash-scaffold",
				[
					"The Temporal child workflow exhausted Pi scaffold repair attempts.",
					"The workflow continued with the validated Temporal scaffold so the demo does not hang.",
					"Generated-code lint and py_compile still ran before extraction.",
				].join("\n"),
			);
		} else {
			this.recordTool(
				"llm_output_validated",
				result.attempts.find((attempt) => attempt.status === "validated")
					?.purpose ?? "codeact-temporal-bash-scaffold",
				[
					"Temporal child workflow accepted the scaffold after parsing, py_compile, generated-code lint, and Temporal primitive validation.",
					"",
					result.acceptedOutput ?? "(accepted scaffold output omitted)",
				].join("\n"),
			);
			if ((result.acceptedAttempt ?? 1) > 1) {
				this.recordTool(
					"scaffold_repair_success",
					`codeact-temporal-bash-scaffold-repair-${(result.acceptedAttempt ?? 1) - 1}`,
					[
						`Temporal child workflow repair attempt ${(result.acceptedAttempt ?? 1) - 1} produced a valid scaffold.`,
						...result.validation,
					].join("\n"),
				);
			}
		}
		return {
			spec: result.spec,
			generated: result.generated,
			validation: result.validation,
			usedFallback: result.usedFallback,
		};
	}

	private async generateWriteAndValidateTemporalScaffoldLocally(
		scaffoldDir: string,
	): Promise<ScaffoldAttemptResult> {
		const timeoutMs = Number(
			process.env.CODEACT_SCAFFOLD_TIMEOUT_MS || 150_000,
		);
		const configuredRepairAttempts = Number(
			process.env.CODEACT_SCAFFOLD_REPAIR_ATTEMPTS || 3,
		);
		const repairAttempts = Number.isFinite(configuredRepairAttempts)
			? Math.max(3, Math.floor(configuredRepairAttempts))
			: 3;
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
						skillName: temporalDeveloperSkillName,
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

const PI_EXTRACTION_CACHE_VERSION = "pi-case-study-extraction-v1";
const PI_EXTRACTION_CACHE_FILE_VERSION = 1;

type PiExtractionCacheOptions = Pick<
	HarnessDemoOptions,
	"llmGenerate" | "enablePiExtractionCache" | "piExtractionCachePath"
>;

class PiExtractionCacheStore {
	private readonly loadPromise: Promise<Map<string, PiExtractionCacheEntry>>;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(private readonly path: string) {
		this.loadPromise = this.load();
	}

	async get(key: string): Promise<PiExtractionCacheEntry | undefined> {
		const entries = await this.loadPromise;
		const entry = entries.get(key);
		if (!entry || entry.version !== PI_EXTRACTION_CACHE_VERSION)
			return undefined;
		if (entry.valid && !isCaseStudyRecord(entry.record)) return undefined;
		return clonePiExtractionCacheEntry(entry);
	}

	async set(entry: PiExtractionCacheEntry): Promise<void> {
		const entries = await this.loadPromise;
		entries.set(entry.key, clonePiExtractionCacheEntry(entry));
		const snapshot = [...entries.values()].map(clonePiExtractionCacheEntry);
		this.writeQueue = this.writeQueue.then(async () => {
			await mkdir(dirname(this.path), { recursive: true });
			const file: PiExtractionCacheFile = {
				version: PI_EXTRACTION_CACHE_FILE_VERSION,
				entries: Object.fromEntries(snapshot.map((item) => [item.key, item])),
			};
			await writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
		});
		return this.writeQueue;
	}

	private async load(): Promise<Map<string, PiExtractionCacheEntry>> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch (error) {
			if (isNodeErrorWithCode(error, "ENOENT")) return new Map();
			throw error;
		}
		const parsed = JSON.parse(raw) as Partial<PiExtractionCacheFile>;
		const entries = new Map<string, PiExtractionCacheEntry>();
		if (parsed.version !== PI_EXTRACTION_CACHE_FILE_VERSION) return entries;
		if (!parsed.entries || typeof parsed.entries !== "object") return entries;
		for (const [key, value] of Object.entries(parsed.entries)) {
			if (!isPiExtractionCacheEntry(value)) continue;
			entries.set(key, clonePiExtractionCacheEntry(value));
		}
		return entries;
	}
}

function createPiExtractionCacheStore(
	options: PiExtractionCacheOptions,
): PiExtractionCacheStore | undefined {
	if (!shouldUsePiExtractionCache(options)) return undefined;
	return new PiExtractionCacheStore(
		options.piExtractionCachePath ??
			process.env.PI_EXTRACTION_CACHE_PATH ??
			join(artifactsDir, "cache", "pi-case-study-extractions.json"),
	);
}

function shouldUsePiExtractionCache(
	options: PiExtractionCacheOptions,
): boolean {
	if (options.enablePiExtractionCache !== undefined) {
		return options.enablePiExtractionCache;
	}
	if (process.env.PI_EXTRACTION_CACHE !== undefined) {
		return !/^(0|false|off|no)$/i.test(process.env.PI_EXTRACTION_CACHE.trim());
	}
	if (process.env.PI_EXTRACTION_CACHE_PATH) return true;
	return !options.llmGenerate;
}

function buildPiExtractionCacheKey(
	url: string,
	prompt: string,
): PiExtractionCacheKey {
	const normalizedUrl = normalizeCaseStudyUrl(url);
	const promptHash = hashText(`${PI_EXTRACTION_CACHE_VERSION}\n${prompt}`);
	const key = hashText(
		`${PI_EXTRACTION_CACHE_VERSION}\n${normalizedUrl}\n${promptHash}`,
	);
	return { key, promptHash, url: normalizedUrl };
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isPiExtractionCacheEntry(
	value: unknown,
): value is PiExtractionCacheEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<PiExtractionCacheEntry>;
	if (
		entry.version !== PI_EXTRACTION_CACHE_VERSION ||
		typeof entry.key !== "string" ||
		typeof entry.url !== "string" ||
		typeof entry.promptHash !== "string" ||
		typeof entry.storedAt !== "string" ||
		typeof entry.valid !== "boolean"
	) {
		return false;
	}
	return !entry.valid || isCaseStudyRecord(entry.record);
}

function isCaseStudyRecord(value: unknown): value is CaseStudyRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<CaseStudyRecord>;
	return (
		typeof record.url === "string" &&
		typeof record.slug === "string" &&
		typeof record.company === "string" &&
		typeof record.headline === "string" &&
		typeof record.summary === "string" &&
		typeof record.evidenceQuote === "string" &&
		typeof record.temporalValue === "string" &&
		record.sourceType === "Temporal case study"
	);
}

function clonePiExtractionCacheEntry(
	entry: PiExtractionCacheEntry,
): PiExtractionCacheEntry {
	return {
		...entry,
		record: entry.record ? cloneCaseStudyRecord(entry.record) : undefined,
	};
}

function cloneCaseStudyRecord(record: CaseStudyRecord): CaseStudyRecord {
	return { ...record };
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === code
	);
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

export function buildTemporalScaffoldLlmPrompt(): string {
	const scaffold = createTemporalScaffoldSpec();
	return [
		"You are Pi running CodeAct for a developer demo.",
		`Use the loaded ${temporalDeveloperSkillName} Temporal Agent Skill for Temporal Python SDK structure, determinism, activities, workers, clients, signals, queries, retries, and durable AI-agent patterns.`,
		"The prompt below supplies the demo-specific output contract and validation requirements.",
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
		"Required files:",
		...scaffold.files.map((file) => `- ${file.path}: ${file.purpose}`),
		"Required Temporal primitives and code signals:",
		...temporalPrimitiveCatalog.map(
			(primitive) => `- ${primitive.label}: ${primitive.codeSignal}`,
		),
		"Strict validation contract:",
		"- requirements.txt must include every third-party package imported by generated Python, such as requests, beautifulsoup4, or lxml. Prefer stdlib urllib.request for fetching. Do not use regex or HTML heuristics as the semantic case-study extractor.",
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
		"- src/workflows.py must map parallel results with zip(batch, results); do not look URLs back up with len(attempted_urls) + i while mutating attempted_urls.",
		"- src/workflows.py must not require isinstance(result, CaseStudyRecord) before appending activity output; Temporal payload conversion may return dict-shaped records, so append valid non-exception results or normalize dicts before appending.",
		"- src/workflows.py must not call workflow.info().workflow_execution_timeout; the Python SDK Info object does not expose that attribute. Use explicit timedelta(seconds=...) activity start_to_close_timeout values.",
		"- src/activities.py must contain @activity.defn def fetch_and_extract_case_study and ApplicationError.",
		"- src/activities.py activity functions must be synchronous def functions, not async def, because they use blocking urllib and subprocess.run and must execute on the worker ThreadPoolExecutor.",
		"- src/activities.py must crawl live Temporal-owned sources: https://temporal.io/in-use and https://temporal.io/sitemap.xml.",
		"- src/activities.py must only count URLs under /resources/case-studies/ as valid case studies.",
		'- src/activities.py must discover case-study URLs with a bounded slug regex such as CASE_STUDY_PATTERN = re.compile(r"https://temporal\\.io/resources/case-studies/[a-z0-9\\-/]+", re.I); do not use broad [^\\s"<>]+ URL matching that captures trailing punctuation.',
		"- src/activities.py must catch urllib.error.HTTPError separately and treat err.code == 404 as a non-retryable missing case-study page.",
		"- src/activities.py must call the Pi runtime from the fetch/extract Activity to extract company, headline, summary, evidence_quote, and temporal_value from page text.",
		'- src/activities.py must read the Pi command with: command = shlex.split(os.getenv("PI_COMMAND", "pi")).',
		'- src/activities.py must invoke Pi with subprocess.run([*command, "--mode", "json", "--no-session", "--no-tools", "-p", prompt], text=True, capture_output=True, timeout=180, check=False).',
		"- src/activities.py must parse Pi --mode json stdout as newline-delimited JSON events: iterate completed.stdout.splitlines(), json.loads each line, read assistant text from message_end.message.content or from the last assistant message in agent_end.messages, then parse structured extraction fields from that assistant text.",
		"- src/activities.py should prefer JSON when present, but it must not require the whole assistant answer to be exactly JSON. It should extract the first balanced JSON object or fall back to labeled fields such as Company:, Headline:, Summary:, Evidence quote:, and Temporal value:.",
		"- src/activities.py must cache parsed Pi extraction payloads when PI_EXTRACTION_CACHE_PATH is set: hash the extraction prompt, call read_extraction_cache(cache_key) before subprocess.run, and call write_extraction_cache(cache_key, parsed) after successful parsing.",
		"- src/activities.py must not call json.loads(completed.stdout), json.loads(completed.stdout.strip()), or json.loads(output) where output came from completed.stdout; Pi JSON-mode stdout is an event stream, not one JSON document.",
		'- src/activities.py must treat unparseable Pi extraction responses and missing required extraction fields as non-retryable ApplicationError failures, for example ApplicationError("Pi extraction response could not be parsed into fields", type="ValidationError", non_retryable=True).',
		"- src/activities.py export_marketing_html must handle dict-shaped record payloads as well as CaseStudyRecord objects before reading fields, because Temporal may decode records nested inside a list as dictionaries.",
		'- Do not hardcode ["pi", "ask", prompt] or any other fixed Pi command; use the PI_COMMAND environment variable with the "pi" fallback above.',
		"- Regex is acceptable for URL discovery and JSON response boundary parsing only; semantic case-study record extraction must be delegated to Pi runtime.",
		"- src/activities.py must not fabricate example URLs, fake companies, fixture records, or preloaded case-study data.",
		'- src/workflows.py must not stringify activity exception objects in workflow logs or state updates with patterns such as f"...{result}"; log only the URL or a short static failure reason before storing bounded failure metadata.',
		"- src/worker.py must contain Worker(client, task_queue=TASK_QUEUE and the literal activity_executor.",
		'- src/worker.py and src/client.py must set TASK_QUEUE from required_env("TEMPORAL_TASK_QUEUE"); do not hardcode or default to any fixed task queue.',
		"- src/workflows.py must not hardcode a task_queue for execute_activity calls; omit task_queue so activities run on the current workflow task queue.",
		"- src/worker.py must connect with TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_API_KEY, and tls=True when an API key is present.",
		"- src/client.py must read CODEACT_WORKFLOW_ID, CODEACT_TARGET_COUNT, CODEACT_BATCH_SIZE, and CODEACT_PAGE_BUDGET.",
		"- src/client.py must connect with TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_API_KEY, and tls=True when an API key is present.",
		"- src/client.py must pass the API key with Client.connect(..., api_key=api_key, tls=True if api_key else False); do not use rpc_metadata for authentication.",
		"- src/worker.py must pass the API key with Client.connect(..., api_key=api_key, tls=True if api_key else False); do not use rpc_metadata for authentication.",
		"- src/client.py must print JSON lines prefixed with CODEACT_TEMPORAL_EVENT so the UI can show the generated workflow ID, activity names, and final state.",
		"- src/client.py must import asdict and is_dataclass from dataclasses, define to_jsonable(...), and pass every event payload through to_jsonable before json.dumps.",
		"- src/client.py must wrap handle.query(TemporalCaseStudyResearchWorkflow.current_state) in try/except, emit workflow_query_failed with the exception type if the query times out, and continue to signal approve_export and await handle.result().",
		"- The workflow_completed event must include state=result so the TypeScript harness can build the marketing artifact from the generated workflow output.",
		'- src/client.py must normalize the workflow result before computing counts: result = await handle.result(); result_state = to_jsonable(result); then emit("workflow_completed", workflow_id=workflow_id, state=result, records=state_list_count(result_state, "records"), failures=state_list_count(result_state, "failed_pages"), attempted=state_list_count(result_state, "attempted_urls")).',
		"- src/client.py must define state_list_count(state, key) so workflow result counts work whether Temporal decodes WorkflowState as a dataclass-like object or as a dict.",
		"- The workflow_completed event must be JSON serializable even when result is a dataclass such as WorkflowState or a dict decoded by Temporal Cloud.",
		"- Do not use TEMPORAL_HOST; this demo's Cloud contract is TEMPORAL_ADDRESS.",
		"- src/extractor.py must import ThreadPoolExecutor and define bounded_parallel_extract.",
		"Required worker.py shape:",
		"from concurrent.futures import ThreadPoolExecutor",
		"def required_env(name: str) -> str:",
		'TASK_QUEUE = required_env("TEMPORAL_TASK_QUEUE")',
		"activity_executor = ThreadPoolExecutor(max_workers=8)",
		"worker = Worker(client, task_queue=TASK_QUEUE, workflows=[TemporalCaseStudyResearchWorkflow], activities=[discover_case_study_urls, fetch_and_extract_case_study, export_marketing_html], activity_executor=activity_executor)",
		"Required extractor.py shape:",
		"from concurrent.futures import ThreadPoolExecutor",
		"def bounded_parallel_extract(urls: list[str], limit: int = 8) -> dict:",
		"Required activities.py Pi runtime invocation shape:",
		"import os",
		"import shlex",
		"import subprocess",
		'command = shlex.split(os.getenv("PI_COMMAND", "pi"))',
		'completed = subprocess.run([*command, "--mode", "json", "--no-session", "--no-tools", "-p", prompt], text=True, capture_output=True, timeout=180, check=False)',
		"assistant_text = extract_assistant_text(completed.stdout)",
		"parsed = parse_extraction_response(assistant_text or completed.stdout)",
		"def extract_assistant_text(stdout: str) -> str:",
		'last_assistant = ""',
		"for line in stdout.splitlines():",
		'messages = event.get("messages") or []',
		'last_assistant = text_from_content(message.get("content"))',
		"def text_from_content(content: object) -> str:",
		"def parse_extraction_response(text: str) -> dict[str, object]:",
		"def parse_json_object(text: str) -> object:",
		"def parse_labeled_fields(text: str) -> dict[str, object]:",
		'PI_EXTRACTION_CACHE_PATH = os.getenv("PI_EXTRACTION_CACHE_PATH")',
		"def read_extraction_cache(cache_key: str) ->",
		"def write_extraction_cache(cache_key: str, payload: dict[str, object]) -> None:",
		"Required client.py runtime behavior:",
		'TASK_QUEUE = required_env("TEMPORAL_TASK_QUEUE")',
		'workflow_id = os.getenv("CODEACT_WORKFLOW_ID") or f"temporal-case-study-research-{uuid.uuid4()}"',
		"handle = await client.start_workflow(TemporalCaseStudyResearchWorkflow.run, args=[target_count, batch_size, page_budget], id=workflow_id, task_queue=TASK_QUEUE)",
		"try:",
		"state = await handle.query(TemporalCaseStudyResearchWorkflow.current_state)",
		'emit("workflow_query_failed", workflow_id=workflow_id, error=type(err).__name__)',
		'await handle.signal(TemporalCaseStudyResearchWorkflow.approve_export, "approved from generated client")',
		"result = await handle.result()",
		"result_state = to_jsonable(result)",
		"def state_list_count(state: object, key: str) -> int:",
		'print("CODEACT_TEMPORAL_EVENT " + json.dumps({"event": event, **to_jsonable(payload)}), flush=True)',
		'emit("workflow_completed", workflow_id=workflow_id, state=result, records=state_list_count(result_state, "records"), failures=state_list_count(result_state, "failed_pages"), attempted=state_list_count(result_state, "attempted_urls"))',
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

export function buildTemporalScaffoldRepairPrompt(
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
		'If the failure mentions TEMPORAL_TASK_QUEUE, hardcoding, or a stale task queue literal, update both src/worker.py and src/client.py to set TASK_QUEUE = required_env("TEMPORAL_TASK_QUEUE") and use TASK_QUEUE everywhere. Do not hardcode or default to any fixed task queue.',
		"If the failure mentions TEMPORAL_HOST, replace it with TEMPORAL_ADDRESS and include TEMPORAL_API_KEY plus tls=True when present.",
		"If the failure mentions rpc_metadata or Jwt is missing, pass api_key=api_key into Client.connect and do not use rpc_metadata for Temporal Cloud auth.",
		"If the failure mentions src/client.py, include CODEACT_WORKFLOW_ID, current_state, approve_export, and CODEACT_TEMPORAL_EVENT JSON-line output.",
		'If the failure mentions state=result, result.records, AttributeError, dict object has no attribute, or workflow_completed, make src/client.py use result = await handle.result(), result_state = to_jsonable(result), and then emit("workflow_completed", workflow_id=workflow_id, state=result, records=state_list_count(result_state, "records"), failures=state_list_count(result_state, "failed_pages"), attempted=state_list_count(result_state, "attempted_urls")).',
		"If the failure mentions to_jsonable, JSON serializable, WorkflowState, asdict, is_dataclass, or state_list_count, convert dataclasses with asdict/is_dataclass before calling json.dumps and count records from the normalized result_state dict/list shape.",
		"If the failure mentions page_budget, update src/workflows.py so run accepts page_budget and slices discovered URLs before extraction.",
		"If the failure says pass page_budget, not batch_size, call discover_case_study_urls with page_budget from the workflow run arguments.",
		"If the failure mentions zip(batch, results), len(attempted_urls) + i, or indexing discovered URLs while mutating attempted_urls, rewrite result handling to iterate for url, result in zip(batch, results) before mutating attempted_urls.",
		"If the failure mentions isinstance(result, CaseStudyRecord), rewrite src/workflows.py so non-exception activity results are appended or normalized from dicts; do not drop records just because Temporal decoded them as dictionaries.",
		"If the failure mentions workflow_execution_timeout, rewrite src/workflows.py to remove workflow.info().workflow_execution_timeout and use explicit timedelta(seconds=...) values for each activity start_to_close_timeout.",
		"If the failure mentions activity exception objects, stringify, workflow logs, or {result}, update src/workflows.py so workflow.logger calls do not interpolate activity exception objects; log only the URL or a short static reason and keep workflow tasks quick.",
		"If the failure mentions async def, synchronous def, activity_executor, blocking urllib, subprocess.run, or worker event loop, rewrite src/activities.py so every @activity.defn function is a synchronous def function, not async def.",
		"If the failure mentions live Temporal case-study pages or examples, replace fake example URLs with live crawling of https://temporal.io/in-use and https://temporal.io/sitemap.xml, and accept only /resources/case-studies/ URLs.",
		'If the failure mentions case-study URL regex, broad URL matching, captured punctuation, [^\\s, CASE_STUDY_PATTERN, or [a-z0-9\\-/]+, update src/activities.py discovery to use a bounded Temporal case-study regex like CASE_STUDY_PATTERN = re.compile(r"https://temporal\\\\.io/resources/case-studies/[a-z0-9\\\\-/]+", re.I), normalize matched URLs, and reject punctuation outside the slug.',
		"If the failure mentions HTTPError, err.code == 404, 404, or non-retryable missing case-study page, update src/activities.py so fetch_and_extract_case_study catches urllib.error.HTTPError as err and raises ApplicationError for err.code == 404 with non_retryable=True.",
		"If the failure mentions evidence_quote or temporal_value, update src/activities.py so fetch_and_extract_case_study returns those fields from extracted page text.",
		'If the failure mentions PI_COMMAND, update src/activities.py so it imports os, shlex, and subprocess; reads command = shlex.split(os.getenv("PI_COMMAND", "pi")); and calls subprocess.run([*command, "--mode", "json", "--no-session", "--no-tools", "-p", prompt], text=True, capture_output=True, timeout=180, check=False). Do not use ["pi", "ask", prompt].',
		"If the failure mentions PI_EXTRACTION_CACHE_PATH, read_extraction_cache, write_extraction_cache, extraction cache, or cache_key, update src/activities.py so run_pi_extraction hashes the extraction prompt, reads a parsed payload from PI_EXTRACTION_CACHE_PATH before subprocess.run, and writes the parsed payload back after successful parsing.",
		'If the failure mentions JSONDecodeError, Extra data, parse Pi output, completed.stdout, json.loads(output), json.loads(completed.stdout), extract_assistant_text, text_from_content, agent_end, event.get("messages"), parse_json_object, parse_labeled_fields, or parse_extraction_response, update src/activities.py so it treats Pi --mode json stdout as newline-delimited JSON events: define extract_assistant_text(stdout: str) to keep last_assistant, iterate stdout.splitlines(), json.loads each event line, read message_end.message.content for assistant messages, read the last assistant message from agent_end messages = event.get("messages") or [], extract text through text_from_content(message.get("content")), then call parse_extraction_response(assistant_text or completed.stdout). parse_extraction_response should first parse the first balanced JSON object if present, then fall back to labeled fields like Company:, Headline:, Summary:, Evidence quote:, and Temporal value:. Do not json.loads the entire completed.stdout or an output variable assigned from it, do not require the whole assistant answer to be exactly JSON, and do not read agent_end text from top-level event.get("content").',
		'If the failure mentions invalid Pi JSON, unparseable response, non_retryable=True, or extraction responses, update src/activities.py so invalid JSON, missing parseable fields, and missing required extraction fields raise ApplicationError with type="ValidationError" and non_retryable=True.',
		"If the failure mentions export_marketing_html, dict-shaped CaseStudyRecord payloads, list items as dictionaries, record.headline, or AttributeError: 'dict' object has no attribute, update src/activities.py so export_marketing_html normalizes each record from dict to CaseStudyRecord or reads fields through a helper before accessing record fields.",
		"If the failure mentions workflow_query_failed, handle.query, current_state query, or Timeout expired, update src/client.py so the current_state query is wrapped in try/except, emits workflow_query_failed with error=type(err).__name__ on failure, and still sends approve_export and awaits handle.result().",
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
		"Use the same fair comparison budget as CodeAct: targetCount must be 20 and pageBudget must be 40.",
		"If fewer than 20 live URLs are actually discovered, do not invent URLs; return the real list and the harness will mark partial coverage for review.",
		"Choose whether page processing should be single-lane or concurrent. Keep concurrency bounded from 1-8.",
		"Return only the discoveredUrls you actually found. Do not pad the URL list to a fixed count.",
		"Return ONLY JSON with this shape:",
		'{"discoveredUrls":["https://temporal.io/resources/case-studies/..."],"executionStrategy":{"targetCount":20,"pageBudget":40,"concurrency":2,"parallelPlan":["branch 1: fetch AI-agent case studies","branch 2: fetch platform reliability case studies"],"rationale":"short reason"},"observations":["short note"]}',
		"Do not include raw environment variables, API keys, Temporal namespace, PI_COMMAND, or secrets.",
		"Do not invent URLs. If the live fetch fails, return JSON with discoveredUrls as an empty array and observations explaining the failure.",
	].join("\n");
}

const PI_EXTRACTION_HTML_LIMIT = 45_000;

function buildPiCaseStudyExtractionPrompt(url: string, html: string): string {
	const page = truncateForPiExtraction(html);
	return [
		"You are Pi extracting one structured customer-proof record from a Temporal-owned case-study page.",
		"Use semantic reading of the supplied page content. Do not rely on local regex rules, saved artifacts, repo fixtures, or memory.",
		"Use only facts present in the supplied page content. Do not invent customers, metrics, quotes, use cases, or claims.",
		'If the page is not a valid Temporal customer case study or there is not enough evidence, return {"valid":false,"reason":"short reason"} or a short labeled invalid response.',
		"Prefer one JSON object with this shape when valid:",
		'{"valid":true,"url":"https://temporal.io/resources/case-studies/...","company":"...","headline":"...","summary":"...","evidenceQuote":"...","temporalValue":"...","industry":"...","useCase":"...","companySize":"...","sdk":"...","deployment":"..."}',
		"JSON does not have to be the only text in the response; the harness can extract the first balanced JSON object.",
		"If JSON is inconvenient, return labeled fields instead: Company:, Headline:, Summary:, Evidence quote:, Temporal value:, Industry:, Use case:, Company size:, SDK:, Deployment:.",
		"Required valid fields are company, headline, summary, evidenceQuote, and temporalValue.",
		"Optional fields may be omitted or null when the page does not state them.",
		"Do not expose environment variables, API keys, Temporal namespace, PI_COMMAND, or secrets.",
		`Source URL: ${url}`,
		`Supplied page HTML (${html.length} characters, ${page.length} included):`,
		page,
	].join("\n\n");
}

function truncateForPiExtraction(html: string): string {
	if (html.length <= PI_EXTRACTION_HTML_LIMIT) return html;
	const headLength = Math.floor(PI_EXTRACTION_HTML_LIMIT * 0.72);
	const tailLength = PI_EXTRACTION_HTML_LIMIT - headLength;
	return [
		html.slice(0, headLength),
		`<!-- omitted ${html.length - PI_EXTRACTION_HTML_LIMIT} middle characters -->`,
		html.slice(-tailLength),
	].join("\n");
}

function parsePiCaseStudyExtraction(
	markdown: string,
	expectedUrl: string,
): CaseStudyRecord | undefined {
	const parsed = parseExtractionFieldsFromLlm(markdown);
	if (parsed.valid === false) return undefined;
	if (
		typeof parsed.valid === "string" &&
		/^(false|no|invalid)$/i.test(parsed.valid.trim())
	) {
		return undefined;
	}
	const returnedUrl = stringField(parsed, "url") ?? expectedUrl;
	const normalizedExpectedUrl = normalizeCaseStudyUrl(expectedUrl);
	const normalizedReturnedUrl = isTemporalCaseStudyUrl(returnedUrl)
		? normalizeCaseStudyUrl(returnedUrl)
		: normalizedExpectedUrl;
	const url =
		normalizedReturnedUrl === normalizedExpectedUrl
			? normalizedReturnedUrl
			: normalizedExpectedUrl;
	const company = stringField(parsed, "company");
	const headline = stringField(parsed, "headline");
	const summary = stringField(parsed, "summary");
	const evidenceQuote = stringField(parsed, "evidenceQuote", "evidence_quote");
	const temporalValue = stringField(parsed, "temporalValue", "temporal_value");
	if (!company || !headline || !summary || !evidenceQuote || !temporalValue) {
		const missing = [
			["company", company],
			["headline", headline],
			["summary", summary],
			["evidenceQuote", evidenceQuote],
			["temporalValue", temporalValue],
		]
			.filter(([, value]) => !value)
			.map(([field]) => field);
		throw new Error(
			`Pi extraction response missing required field(s): ${missing.join(", ")}`,
		);
	}
	return {
		url,
		slug: slugFromCaseStudyUrl(url),
		company,
		headline,
		summary,
		evidenceQuote,
		temporalValue,
		industry: stringField(parsed, "industry"),
		useCase: stringField(parsed, "useCase", "use_case"),
		companySize: stringField(parsed, "companySize", "company_size"),
		sdk: stringField(parsed, "sdk", "SDK"),
		deployment: stringField(parsed, "deployment"),
		sourceType: "Temporal case study",
	};
}

function stringField(
	source: Record<string, unknown>,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const value = source[key];
		if (typeof value !== "string") continue;
		const trimmed = value.replace(/\s+/g, " ").trim();
		if (trimmed && !/^n\/?a$/i.test(trimmed) && !/^unknown$/i.test(trimmed)) {
			return trimmed;
		}
	}
	return undefined;
}

function parseExtractionFieldsFromLlm(
	markdown: string,
): Record<string, unknown> {
	try {
		return parseJsonFromLlm(markdown) as Record<string, unknown>;
	} catch (error) {
		const labeled = parseLabeledExtractionFields(markdown);
		if (labeled) return labeled;
		throw error;
	}
}

const labeledExtractionAliases: Record<string, string> = {
	valid: "valid",
	sourceurl: "url",
	url: "url",
	company: "company",
	customer: "company",
	headline: "headline",
	title: "headline",
	summary: "summary",
	evidencequote: "evidenceQuote",
	quote: "evidenceQuote",
	temporalvalue: "temporalValue",
	value: "temporalValue",
	industry: "industry",
	usecase: "useCase",
	companysize: "companySize",
	size: "companySize",
	sdk: "sdk",
	deployment: "deployment",
};

function parseLabeledExtractionFields(
	markdown: string,
): Record<string, unknown> | undefined {
	const fields: Record<string, string> = {};
	let currentKey: string | undefined;
	for (const rawLine of markdown.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const match =
			/^(?:[-*]\s*)?(?:\*\*)?([A-Za-z][A-Za-z _/-]{1,40})(?:\*\*)?\s*:\s*(.*)$/.exec(
				line,
			);
		if (match) {
			const key = labeledExtractionAliases[normalizeLabel(match[1])];
			if (key) {
				fields[key] = cleanLabeledFieldValue(match[2]);
				currentKey = key;
				continue;
			}
		}
		if (currentKey) {
			fields[currentKey] = [fields[currentKey], line]
				.filter(Boolean)
				.join(" ")
				.trim();
		}
	}
	if (Object.keys(fields).length === 0) return undefined;
	return fields;
}

function normalizeLabel(label: string): string {
	return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cleanLabeledFieldValue(value: string): string {
	return value
		.trim()
		.replace(/^["']|["']$/g, "")
		.replace(/\s+/g, " ");
}

function normalizeCaseStudyUrl(value: string): string {
	const url = new URL(value);
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString();
}

function slugFromCaseStudyUrl(value: string): string {
	const pathname = new URL(normalizeCaseStudyUrl(value)).pathname;
	return pathname.split("/").filter(Boolean).at(-1) ?? "case-study";
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
		defaultPageBudget: number;
		targetCountCap: number;
	},
): ReactExecutionStrategy {
	const targetCount = clampInteger(
		options.targetCountCap,
		1,
		options.targetCountCap,
	);
	const pageBudget = clampInteger(
		options.pageBudgetOverride ?? options.defaultPageBudget,
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
	const object = extractFirstBalancedJsonObject(raw);
	if (!object) {
		throw new Error("LLM response did not contain a JSON object.");
	}
	return JSON.parse(object);
}

function extractFirstBalancedJsonObject(raw: string): string | undefined {
	const start = raw.indexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < raw.length; index += 1) {
		const character = raw[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (character === "{") {
			depth += 1;
			continue;
		}
		if (character === "}") {
			depth -= 1;
			if (depth === 0) return raw.slice(start, index + 1);
		}
	}
	return undefined;
}
