import {
	type ChildProcessWithoutNullStreams,
	execFile,
	spawn,
} from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
	CaseStudyRecord,
	CaseStudyResearchResult,
	FailedPage,
} from "../case-study-research.ts";
import {
	TEMPORAL_CUSTOMER_STORIES_URL,
	TEMPORAL_SITEMAP_URL,
} from "../case-study-research.ts";
import { hasTemporalEnv } from "../env.ts";
import { artifactsDir } from "../paths.ts";
import { redactSecrets } from "../redact.ts";
import type { CodeActTemporalCloudRun } from "./types.ts";

const execFileAsync = promisify(execFile);

export const codeActTemporalWorkflowType = "TemporalCaseStudyResearchWorkflow";
export const codeActTemporalActivityTypes = [
	"discover_case_study_urls",
	"fetch_and_extract_case_study",
	"export_marketing_html",
];

export interface GeneratedTemporalCloudExecution {
	cloudRun: CodeActTemporalCloudRun;
	research?: CaseStudyResearchResult;
	clientEvents: PythonClientEvent[];
}

export interface GeneratedTemporalCloudOptions {
	scaffoldDir: string;
	runId: string;
	targetCount: number;
	pageBudget: number;
	concurrency: number;
	timeoutMs?: number;
	onStatus?: (message: string) => void;
	onWorkerOutput?: (message: string) => void;
}

interface PythonClientEvent {
	event?: string;
	workflow_id?: string;
	task_queue?: string;
	workflow_type?: string;
	activities?: string[];
	state?: PythonResearchState;
	status?: string;
	records?: number;
	failures?: number;
	attempted?: number;
	message?: string;
}

interface PythonResearchState {
	target_count?: number;
	status?: string;
	discovered_urls?: string[];
	attempted_urls?: string[];
	records?: PythonCaseStudyRecord[];
	failed_pages?: PythonFailedPage[];
	reviewer_notes?: string[];
	approved?: boolean;
}

interface PythonCaseStudyRecord {
	url?: string;
	company?: string;
	headline?: string;
	summary?: string;
	evidence_quote?: string;
	temporal_value?: string;
	industry?: string | null;
	use_case?: string | null;
}

interface PythonFailedPage {
	url?: string;
	step?: string;
	reason?: string;
	attempts?: number;
	retryable?: boolean;
}

export function shouldRunCodeActTemporalCloud(
	llmGenerateConfigured: boolean,
): boolean {
	if (process.env.CODEACT_TEMPORAL_CLOUD === "0") return false;
	if (process.env.CODEACT_TEMPORAL_CLOUD === "1") return hasTemporalEnv();
	return hasTemporalEnv() && !llmGenerateConfigured;
}

export function codeActTaskQueue(): string {
	return codeActTaskQueueForRun();
}

export function codeActTaskQueueForRun(runId?: string): string {
	const configured = process.env.TEMPORAL_CODEACT_TASK_QUEUE;
	const base =
		configured ??
		[process.env.TEMPORAL_TASK_QUEUE, "codeact"].filter(Boolean).join("-");
	if (!runId || process.env.CODEACT_TEMPORAL_SHARED_TASK_QUEUE === "1")
		return base;
	return `${base}-${sanitizeTaskQueueSuffix(runId)}`;
}

function sanitizeTaskQueueSuffix(runId: string): string {
	const suffix = runId
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return suffix || "run";
}

export async function runGeneratedTemporalCloudScaffold(
	options: GeneratedTemporalCloudOptions,
): Promise<GeneratedTemporalCloudExecution> {
	if (!hasTemporalEnv()) {
		return {
			cloudRun: {
				workflowId: "",
				workflowType: codeActTemporalWorkflowType,
				taskQueue: codeActTaskQueueForRun(options.runId),
				activities: codeActTemporalActivityTypes,
				status: "skipped",
				message:
					"Temporal Cloud env is not configured; generated Python workflow was not started.",
			},
			clientEvents: [],
		};
	}

	const workflowId = codeActWorkflowId(options.runId);
	const taskQueue = codeActTaskQueueForRun(options.runId);
	const python = await resolvePythonRuntime(
		options.scaffoldDir,
		options.onStatus,
	);
	const piExtractionCachePath = codeActPiExtractionCachePath();
	const env = {
		...process.env,
		PYTHONUNBUFFERED: "1",
		PYTHONPATH: [
			options.scaffoldDir,
			join(options.scaffoldDir, "src"),
			process.env.PYTHONPATH,
		]
			.filter(Boolean)
			.join(process.platform === "win32" ? ";" : ":"),
		TEMPORAL_TASK_QUEUE: taskQueue,
		CODEACT_WORKFLOW_ID: workflowId,
		CODEACT_TARGET_COUNT: String(options.targetCount),
		CODEACT_PAGE_BUDGET: String(options.pageBudget),
		CODEACT_BATCH_SIZE: String(Math.max(1, options.concurrency)),
		CODEACT_AUTO_APPROVE: "1",
		...(piExtractionCachePath
			? { PI_EXTRACTION_CACHE_PATH: piExtractionCachePath }
			: {}),
	};

	let worker: ChildProcessWithoutNullStreams | undefined;
	const workerOutput: string[] = [];
	try {
		const startedAt = new Date().toISOString();
		options.onStatus?.(
			`Starting generated Python Temporal worker on task queue ${taskQueue}.`,
		);
		worker = spawn(python, ["src/worker.py"], {
			cwd: options.scaffoldDir,
			env,
			stdio: "pipe",
		});
		const runningWorker = worker;
		runningWorker.stdin.end();
		const workerExit = new Promise<never>((_, reject) => {
			runningWorker.once("exit", (code, signal) => {
				reject(
					new Error(
						`Generated Python worker exited early with code ${code ?? "none"} signal ${signal ?? "none"}.`,
					),
				);
			});
			runningWorker.once("error", reject);
		});
		pipeWorkerOutput(runningWorker, (message) => {
			workerOutput.push(message);
			if (workerOutput.length > 10) workerOutput.shift();
			options.onWorkerOutput?.(message);
		});
		await Promise.race([delay(2500), workerExit]);

		options.onStatus?.(
			`Launching generated Python workflow ${workflowId} in Temporal Cloud.`,
		);
		const { stdout, stderr } = await execFileAsync(python, ["src/client.py"], {
			cwd: options.scaffoldDir,
			env,
			timeout: options.timeoutMs ?? 180_000,
			maxBuffer: 1024 * 1024 * 8,
		});
		if (stderr.trim()) options.onWorkerOutput?.(redactSecrets(stderr.trim()));
		const clientEvents = parsePythonClientEvents(stdout);
		const completed = [...clientEvents]
			.reverse()
			.find((event) => event.event === "workflow_completed");
		const state = completed?.state;
		const research = state
			? pythonStateToResearch({
					state,
					targetCount: options.targetCount,
					pageBudget: options.pageBudget,
					concurrency: options.concurrency,
					startedAt,
				})
			: undefined;
		const records =
			research?.records.length ?? completed?.records ?? state?.records?.length;
		const failures =
			state?.failed_pages?.length ??
			completed?.failures ??
			research?.failures.length;
		const attempted =
			state?.attempted_urls?.length ??
			completed?.attempted ??
			research?.attemptedUrls.length;
		return {
			cloudRun: {
				workflowId,
				workflowType: codeActTemporalWorkflowType,
				taskQueue,
				activities: codeActTemporalActivityTypes,
				status: "completed",
				message:
					"Generated Python Temporal workflow completed in Temporal Cloud.",
				records,
				failures,
				attempted,
			},
			research,
			clientEvents,
		};
	} catch (error) {
		return {
			cloudRun: {
				workflowId,
				workflowType: codeActTemporalWorkflowType,
				taskQueue,
				activities: codeActTemporalActivityTypes,
				status: "failed",
				message: redactSecrets(
					[
						error instanceof Error ? error.message : String(error),
						workerOutput.length
							? `Worker output:\n${workerOutput.join("\n")}`
							: "",
					]
						.filter(Boolean)
						.join("\n"),
				),
			},
			clientEvents: [],
		};
	} finally {
		if (worker && !worker.killed) {
			worker.kill("SIGTERM");
			await Promise.race([onceExit(worker), delay(1500)]).catch(
				() => undefined,
			);
			if (!worker.killed) worker.kill("SIGKILL");
		}
	}
}

function codeActPiExtractionCachePath(): string | undefined {
	if (
		process.env.PI_EXTRACTION_CACHE !== undefined &&
		/^(0|false|off|no)$/i.test(process.env.PI_EXTRACTION_CACHE.trim())
	) {
		return undefined;
	}
	return (
		process.env.CODEACT_PI_EXTRACTION_CACHE_PATH ??
		join(artifactsDir, "cache", "codeact-pi-extractions.json")
	);
}

function pipeWorkerOutput(
	worker: ChildProcessWithoutNullStreams,
	onWorkerOutput: ((message: string) => void) | undefined,
): void {
	const emit = (chunk: Buffer) => {
		const text = redactSecrets(chunk.toString("utf8").trim());
		if (text) onWorkerOutput?.(text);
	};
	worker.stdout.on("data", emit);
	worker.stderr.on("data", emit);
}

async function resolvePythonRuntime(
	scaffoldDir: string,
	onStatus: ((message: string) => void) | undefined,
): Promise<string> {
	const basePython = process.env.PYTHON || "python3";
	if (await pythonCanImportTemporal(basePython, scaffoldDir)) {
		onStatus?.("Using existing Python runtime with temporalio installed.");
		return basePython;
	}

	const venvDir = join(scaffoldDir, ".venv");
	const venvPython =
		process.platform === "win32"
			? join(venvDir, "Scripts", "python.exe")
			: join(venvDir, "bin", "python");
	onStatus?.(
		"Creating an isolated Python runtime for the generated Temporal scaffold.",
	);
	await mkdir(scaffoldDir, { recursive: true });
	await execFileAsync(basePython, ["-m", "venv", ".venv"], {
		cwd: scaffoldDir,
		timeout: 120_000,
		maxBuffer: 1024 * 1024,
	});
	onStatus?.("Installing generated scaffold Python dependencies.");
	await execFileAsync(
		venvPython,
		[
			"-m",
			"pip",
			"install",
			"-q",
			"--disable-pip-version-check",
			"-r",
			"requirements.txt",
		],
		{
			cwd: scaffoldDir,
			timeout: 180_000,
			maxBuffer: 1024 * 1024 * 4,
		},
	);
	return venvPython;
}

async function pythonCanImportTemporal(
	python: string,
	cwd: string,
): Promise<boolean> {
	try {
		await execFileAsync(python, ["-c", "import temporalio"], {
			cwd,
			timeout: 10_000,
			maxBuffer: 1024 * 128,
		});
		return true;
	} catch {
		return false;
	}
}

function parsePythonClientEvents(stdout: string): PythonClientEvent[] {
	const events: PythonClientEvent[] = [];
	for (const rawLine of stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const jsonText = line.startsWith("CODEACT_TEMPORAL_EVENT ")
			? line.slice("CODEACT_TEMPORAL_EVENT ".length)
			: line.startsWith("{")
				? line
				: "";
		if (!jsonText) continue;
		try {
			events.push(JSON.parse(jsonText) as PythonClientEvent);
		} catch {
			// Ignore non-JSON stdout from generated client code.
		}
	}
	return events;
}

function pythonStateToResearch(input: {
	state: PythonResearchState;
	targetCount: number;
	pageBudget: number;
	concurrency: number;
	startedAt: string;
}): CaseStudyResearchResult {
	const completedAt = new Date().toISOString();
	const targetCount = input.state.target_count ?? input.targetCount;
	const records = (
		(input.state.records ?? [])
			.map(mapPythonRecord)
			.filter(Boolean) as CaseStudyRecord[]
	).slice(0, targetCount);
	const status = records.length >= targetCount ? "complete" : "needs_review";
	return {
		mode: "codeact",
		targetCount,
		pageBudget: input.pageBudget,
		concurrency: input.concurrency,
		sourceRoots: [TEMPORAL_CUSTOMER_STORIES_URL, TEMPORAL_SITEMAP_URL],
		discoveredUrls: input.state.discovered_urls ?? [],
		attemptedUrls: input.state.attempted_urls ?? [],
		records,
		failures: (input.state.failed_pages ?? []).map(mapPythonFailure),
		retries: 0,
		startedAt: input.startedAt,
		completedAt,
		elapsedMs: Math.max(
			0,
			Date.parse(completedAt) - Date.parse(input.startedAt),
		),
		status,
		exitCondition:
			status === "complete"
				? `${targetCount} valid Temporal case-study records found by the generated Python Temporal workflow.`
				: `Generated Python Temporal workflow completed with ${records.length}/${targetCount} valid records; keep the output in review instead of fabricating missing stories.`,
	};
}

function mapPythonRecord(
	record: PythonCaseStudyRecord,
): CaseStudyRecord | undefined {
	if (!record.url || !record.company || !record.headline) return undefined;
	return {
		url: record.url,
		slug: slugFromUrl(record.url),
		company: record.company,
		headline: record.headline,
		summary: record.summary ?? record.evidence_quote ?? "",
		evidenceQuote: record.evidence_quote ?? record.summary ?? "",
		temporalValue: record.temporal_value ?? record.evidence_quote ?? "",
		industry: record.industry ?? undefined,
		useCase: record.use_case ?? undefined,
		sourceType: "Temporal case study",
	};
}

function mapPythonFailure(failure: PythonFailedPage): FailedPage {
	const step =
		failure.step === "discover" || failure.step === "extract"
			? failure.step
			: "fetch";
	return {
		url: failure.url ?? "unknown",
		step,
		reason: failure.reason ?? "Generated workflow activity failed.",
		attempts: failure.attempts ?? 1,
		retryable: failure.retryable ?? true,
	};
}

function slugFromUrl(url: string): string {
	try {
		return (
			new URL(url).pathname.replace(/\/$/, "").split("/").pop() || "case-study"
		);
	} catch {
		return "case-study";
	}
}

function codeActWorkflowId(runId: string): string {
	const safe = runId
		.replace(/[^a-zA-Z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 160);
	return `${safe || "pi-temporal"}-codeact-python`;
}

function onceExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	return new Promise((resolve) => {
		child.once("exit", () => resolve());
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
