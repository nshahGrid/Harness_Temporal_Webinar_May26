import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import type { GeneratedFile, TemporalPrimitive } from "./types.ts";

const execFileAsync = promisify(execFile);
const generatedPythonFiles = [
	"src/models.py",
	"src/activities.py",
	"src/workflows.py",
	"src/worker.py",
	"src/client.py",
	"src/extractor.py",
];

export const temporalPrimitiveCatalog: TemporalPrimitive[] = [
	{
		id: "workflow",
		label: "Workflow",
		whyItMatters:
			"Owns durable case-study research state and can recover after worker restarts.",
		codeSignal: "@workflow.defn class TemporalCaseStudyResearchWorkflow",
	},
	{
		id: "activity",
		label: "Activity",
		whyItMatters:
			"Wraps discovery, page fetch, extraction, and export so external failures are retryable.",
		codeSignal: "@activity.defn def fetch_and_extract_case_study",
	},
	{
		id: "signal",
		label: "Signal",
		whyItMatters:
			"Lets a reviewer pause, approve, or reject after inspecting partial research state.",
		codeSignal: "@workflow.signal async def approve_export",
	},
	{
		id: "query",
		label: "Query",
		whyItMatters:
			"Exposes current extracted records, failures, and status without mutating workflow state.",
		codeSignal: "@workflow.query def current_state",
	},
	{
		id: "retry-policy",
		label: "Retry policy",
		whyItMatters:
			"Retries transient fetch/extract failures while preserving progress already recorded in workflow history.",
		codeSignal: "RetryPolicy(maximum_attempts=3)",
	},
	{
		id: "bounded-parallelism",
		label: "Bounded parallelism",
		whyItMatters:
			"Lets CodeAct cover more case-study pages with generated worker code while controlling website pressure.",
		codeSignal: "asyncio.gather(*tasks, return_exceptions=True)",
	},
	{
		id: "task-queue",
		label: "Task queue",
		whyItMatters:
			"Connects workflow tasks to workers that run the case-study activities.",
		codeSignal: "TEMPORAL_TASK_QUEUE",
	},
	{
		id: "worker",
		label: "Worker",
		whyItMatters:
			"Hosts generated Python workflow and activity code for execution.",
		codeSignal: "Worker(client, task_queue=TASK_QUEUE",
	},
	{
		id: "client",
		label: "Client",
		whyItMatters:
			"Starts workflows and sends approval or pause signals from outside the workflow.",
		codeSignal: "client.start_workflow",
	},
];

export const temporalDeveloperSkillName = "temporal-developer";

const temporalDeveloperSkillPath = "skills/temporal-developer/SKILL.md";

const temporalSkillReferences = [
	{
		file: "python.md",
		url: "https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/python.md",
		generationUse:
			"workflow/activity/worker/client structure, file separation, decorators, and sync activity shape",
	},
	{
		file: "determinism.md",
		url: "https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/determinism.md",
		generationUse:
			"workflow determinism constraints; network, filesystem, and subprocess work belongs in Activities",
	},
	{
		file: "patterns.md",
		url: "https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/patterns.md",
		generationUse:
			"Signals, Queries, wait conditions, and bounded parallel activity execution",
	},
	{
		file: "error-handling.md",
		url: "https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/error-handling.md",
		generationUse:
			"ApplicationError, retryable/non-retryable failures, and RetryPolicy",
	},
	{
		file: "ai-patterns.md",
		url: "https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/ai-patterns.md",
		generationUse:
			"parallel research, partial failure handling, and letting Temporal own retries",
	},
	{
		file: "testing.md",
		url: "https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/testing.md",
		generationUse: "mocked activities plus workflow signal/query tests",
	},
];

export function buildTemporalAgentSkillGenerationSummary(): string {
	return [
		"Temporal Agent Skill configured for CodeAct scaffold generation:",
		`- Skill: ${temporalDeveloperSkillName}`,
		`- Pi scaffold-generation calls pass --skill ${temporalDeveloperSkillPath}.`,
		"- The task prompt supplies the demo-specific bash-heredoc output contract; the Temporal Agent Skill supplies Temporal SDK code-generation guidance.",
		"- The generated scaffold must still pass the harness parser, py_compile, generated-code lint, and Temporal primitive validation before it can run.",
		...temporalSkillReferences.map(
			(reference) =>
				`- ${reference.file}: ${reference.generationUse}\n  Source: ${reference.url}`,
		),
	].join("\n");
}

export function buildTemporalValidationReferenceSummary(): string {
	return [
		"Temporal Python reference checks used during and after CodeAct generation:",
		"The scaffold-generation Pi call loads the Temporal Agent Skill; these same Python references also back the harness validation gates.",
		...temporalSkillReferences.map(
			(reference) =>
				`- ${reference.file}: ${reference.generationUse}\n  Source: ${reference.url}`,
		),
	].join("\n");
}

interface ScaffoldFile {
	path: string;
	purpose: string;
	contents: string;
}

export interface TemporalScaffoldSpec {
	scenarioName: string;
	taskQueue: string;
	files: ScaffoldFile[];
}

const requiredScaffoldPaths = [
	"requirements.txt",
	"src/models.py",
	"src/activities.py",
	"src/workflows.py",
	"src/worker.py",
	"src/client.py",
	"src/extractor.py",
	"README.md",
] as const;

export function parseTemporalScaffoldSpecFromLlm(
	markdown: string,
): TemporalScaffoldSpec {
	const parsed = parseJsonFromLlm(markdown) as Partial<TemporalScaffoldSpec>;
	if (!parsed || !Array.isArray(parsed.files)) {
		throw new Error("Legacy scaffold response must include a files array.");
	}
	const files = parsed.files.map((file) => {
		if (
			!file ||
			typeof file.path !== "string" ||
			typeof file.contents !== "string"
		) {
			throw new Error(
				"Each LLM scaffold file must include string path and contents fields.",
			);
		}
		return {
			path: file.path,
			purpose:
				typeof file.purpose === "string"
					? file.purpose
					: "LLM-generated scaffold file",
			contents: file.contents,
		};
	});
	const required = new Set(requiredScaffoldPaths);
	const present = new Set(files.map((file) => file.path));
	for (const path of required) {
		if (!present.has(path))
			throw new Error(`LLM scaffold response is missing ${path}.`);
	}
	return {
		scenarioName:
			typeof parsed.scenarioName === "string"
				? parsed.scenarioName
				: "Temporal customer-proof case-study research",
		taskQueue:
			typeof parsed.taskQueue === "string" ? parsed.taskQueue : "pi-gtm-demo",
		files,
	};
}

export function renderTemporalScaffoldBashScript(
	spec = createTemporalScaffoldSpec(),
): string {
	const lines = [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		"mkdir -p src",
		"",
	];
	for (const file of spec.files) {
		const marker = heredocMarker(file.path);
		lines.push(
			`# ${file.path}`,
			`cat > ${shellQuote(file.path)} <<'${marker}'`,
			file.contents.trimEnd(),
			marker,
			"",
		);
	}
	lines.push("python3 -m py_compile src/*.py", "");
	return lines.join("\n");
}

export function parseTemporalScaffoldSpecFromBash(
	markdown: string,
): TemporalScaffoldSpec {
	const script = extractShellScript(markdown).replace(/\r\n?/g, "\n");
	const defaultSpec = createTemporalScaffoldSpec();
	const purposeByPath = new Map(
		defaultSpec.files.map((file) => [file.path, file.purpose]),
	);
	const filesByPath = new Map<string, ScaffoldFile>();
	for (const write of parseHeredocWrites(script)) {
		const path = normalizeScaffoldPath(write.path);
		if (
			!path ||
			!requiredScaffoldPaths.includes(
				path as (typeof requiredScaffoldPaths)[number],
			)
		)
			continue;
		filesByPath.set(path, {
			path,
			purpose:
				purposeByPath.get(path) ??
				"Pi-generated scaffold file from bash heredoc",
			contents: write.contents,
		});
	}
	for (const path of requiredScaffoldPaths) {
		if (!filesByPath.has(path))
			throw new Error(`Pi bash scaffold is missing ${path}.`);
	}
	return {
		scenarioName: "Temporal customer-proof case-study research",
		taskQueue: "pi-gtm-demo",
		files: requiredScaffoldPaths.map((path) => {
			const file = filesByPath.get(path);
			if (!file) throw new Error(`Pi bash scaffold is missing ${path}.`);
			return file;
		}),
	};
}

export function createTemporalScaffoldSpec(): TemporalScaffoldSpec {
	const taskQueue = "TEMPORAL_TASK_QUEUE";
	return {
		scenarioName: "Temporal customer-proof case-study research",
		taskQueue,
		files: [
			{
				path: "requirements.txt",
				purpose:
					"Python dependencies for the runtime-generated Temporal scaffold.",
				contents: "temporalio>=1.8.0\n",
			},
			{
				path: "src/models.py",
				purpose:
					"Shared case-study record and durable workflow state contracts.",
				contents: modelsSource(),
			},
			{
				path: "src/activities.py",
				purpose:
					"Retryable discovery, fetch, extraction, and export activities.",
				contents: activitiesSource(),
			},
			{
				path: "src/workflows.py",
				purpose:
					"Durable workflow with retry policy, bounded parallel activities, signals, and queries.",
				contents: workflowSource(),
			},
			{
				path: "src/worker.py",
				purpose: "Worker process bound to the generated task queue.",
				contents: workerSource(),
			},
			{
				path: "src/client.py",
				purpose:
					"Client starter that demonstrates workflow start, query, pause, and approval signal.",
				contents: clientSource(),
			},
			{
				path: "src/extractor.py",
				purpose:
					"Standalone bounded-parallel local extractor shape used by the demo harness.",
				contents: extractorSource(),
			},
			{
				path: "README.md",
				purpose: "Narrative explaining what the CodeAct agent generated.",
				contents: readmeSource(taskQueue),
			},
		],
	};
}

function extractShellScript(markdown: string): string {
	const fencedBlocks = Array.from(
		markdown.matchAll(/```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g),
	);
	const shellBlocks = fencedBlocks
		.filter((match) => {
			const language = match[1]?.toLowerCase() ?? "";
			const contents = match[2] ?? "";
			return (
				(!language || ["bash", "sh", "shell", "zsh"].includes(language)) &&
				looksLikeHeredocScript(contents)
			);
		})
		.map((match) => match[2] ?? "");
	if (shellBlocks.length > 0) return shellBlocks.join("\n").trim();
	return markdown.trim();
}

function parseHeredocWrites(
	script: string,
): Array<{ path: string; contents: string }> {
	const writes: Array<{ path: string; contents: string }> = [];
	const lines = script.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const start = parseHeredocStart(lines[index]);
		if (!start) continue;
		const contentLines: string[] = [];
		index += 1;
		let closed = false;
		for (; index < lines.length; index += 1) {
			if (lines[index].trim() === start.marker) {
				closed = true;
				break;
			}
			contentLines.push(lines[index]);
		}
		if (!closed)
			throw new Error(
				`Pi bash scaffold has an unterminated heredoc for ${start.path}.`,
			);
		writes.push({ path: start.path, contents: contentLines.join("\n") });
	}
	return writes;
}

function parseHeredocStart(
	line: string,
): { path: string; marker: string } | undefined {
	const pathThenMarker =
		/^\s*cat\s+>\s*(?:"([^"]+)"|'([^']+)'|([^ \t]+))\s+<<-?\s*(?:"([^"]+)"|'([^']+)'|([^ \t]+))/.exec(
			line,
		);
	if (pathThenMarker) {
		return {
			path: pathThenMarker[1] ?? pathThenMarker[2] ?? pathThenMarker[3] ?? "",
			marker: normalizeHeredocMarker(
				pathThenMarker[4] ?? pathThenMarker[5] ?? pathThenMarker[6] ?? "",
			),
		};
	}
	const markerThenPath =
		/^\s*cat\s+<<-?\s*(?:"([^"]+)"|'([^']+)'|([^ \t]+))\s+>\s*(?:"([^"]+)"|'([^']+)'|([^ \t]+))/.exec(
			line,
		);
	if (markerThenPath) {
		return {
			path: markerThenPath[4] ?? markerThenPath[5] ?? markerThenPath[6] ?? "",
			marker: normalizeHeredocMarker(
				markerThenPath[1] ?? markerThenPath[2] ?? markerThenPath[3] ?? "",
			),
		};
	}
	const teeThenMarker =
		/^\s*tee\s+(?:-[a-zA-Z]+\s+)*(?:"([^"]+)"|'([^']+)'|([^ \t]+))(?:\s+>\s*[^ \t]+)?\s+<<-?\s*(?:"([^"]+)"|'([^']+)'|([^ \t]+))/.exec(
			line,
		);
	if (teeThenMarker) {
		return {
			path: teeThenMarker[1] ?? teeThenMarker[2] ?? teeThenMarker[3] ?? "",
			marker: normalizeHeredocMarker(
				teeThenMarker[4] ?? teeThenMarker[5] ?? teeThenMarker[6] ?? "",
			),
		};
	}
	return undefined;
}

function looksLikeHeredocScript(value: string): boolean {
	return /^\s*(?:cat|tee)\b.*<<-?/m.test(value);
}

function normalizeHeredocMarker(value: string): string {
	return value.trim().replace(/[;|&].*$/, "");
}

function normalizeScaffoldPath(value: string): string {
	return value
		.trim()
		.replace(/^\.?\//, "")
		.replace(/^runtime-temporal-scaffold\//, "")
		.replace(/^codeact\/runtime-temporal-scaffold\//, "");
}

function heredocMarker(path: string): string {
	return `PI_TEMPORAL_${path
		.replace(/[^a-z0-9]+/gi, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase()}`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

export async function writeTemporalScaffold(
	targetDir: string,
	spec = createTemporalScaffoldSpec(),
): Promise<GeneratedFile[]> {
	const generated: GeneratedFile[] = [];
	for (const file of spec.files) {
		const absolutePath = join(targetDir, file.path);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, `${file.contents.trimEnd()}\n`, "utf8");
		generated.push({
			path: absolutePath,
			relativePath: relative(targetDir, absolutePath),
			purpose: file.purpose,
		});
	}
	return generated;
}

export async function validateTemporalScaffold(
	targetDir: string,
): Promise<string[]> {
	const checks = [
		{
			path: "src/models.py",
			includes: [
				"headline",
				"summary",
				"evidence_quote",
				"temporal_value",
				"failed_pages",
			],
		},
		{
			path: "src/workflows.py",
			includes: ["@workflow.defn", "@workflow.signal", "@workflow.query"],
		},
		{
			path: "src/workflows.py",
			includes: ["workflow.unsafe.imports_passed_through()"],
		},
		{
			path: "src/workflows.py",
			includes: ["workflow.wait_condition", "workflow.execute_activity"],
		},
		{
			path: "src/workflows.py",
			includes: [
				"RetryPolicy",
				"asyncio.gather",
				"return_exceptions=True",
				"page_budget",
			],
		},
		{
			path: "src/activities.py",
			includes: [
				"@activity.defn",
				"ApplicationError",
				"fetch_and_extract_case_study",
				"CASE_STUDY_PATTERN",
				"[a-z0-9\\-/]+",
				"urllib.error.HTTPError",
				"err.code == 404",
				"subprocess.run",
				"PI_COMMAND",
				"PI_EXTRACTION_CACHE_PATH",
				"build_extraction_prompt",
				"extract_assistant_text",
				"text_from_content",
				"parse_extraction_response",
				"parse_json_object",
				"parse_labeled_fields",
				"read_extraction_cache",
				"write_extraction_cache",
				"last_assistant",
				'event.get("messages")',
				"evidence_quote",
				"temporal_value",
			],
		},
		{
			path: "src/activities.py",
			includes: [
				"https://temporal.io/in-use",
				"https://temporal.io/sitemap.xml",
				"/resources/case-studies/",
			],
		},
		{
			path: "src/worker.py",
			includes: [
				"Worker(",
				"activity_executor",
				"required_env",
				"TEMPORAL_TASK_QUEUE",
				"TEMPORAL_ADDRESS",
				"TEMPORAL_API_KEY",
				"api_key",
				"tls",
			],
		},
		{
			path: "src/client.py",
			includes: [
				"asdict",
				"is_dataclass",
				"to_jsonable",
				"client.start_workflow",
				"args=[",
				"approve_export",
				"current_state",
				"workflow_query_failed",
				"CODEACT_WORKFLOW_ID",
				"CODEACT_TEMPORAL_EVENT",
				'"event"',
				"state=result",
				"result_state",
				"state_list_count",
				"TEMPORAL_TASK_QUEUE",
				"TEMPORAL_ADDRESS",
				"TEMPORAL_API_KEY",
				"api_key",
				"tls",
			],
		},
		{
			path: "src/extractor.py",
			includes: ["ThreadPoolExecutor", "bounded_parallel_extract"],
		},
	];
	const passed: string[] = [];
	for (const check of checks) {
		const contents = await readFile(join(targetDir, check.path), "utf8");
		for (const expected of check.includes) {
			if (!contents.includes(expected)) {
				throw new Error(
					`Generated scaffold ${check.path} is missing "${expected}"`,
				);
			}
		}
		passed.push(`${check.path}: ${check.includes.join(", ")}`);
	}
	await execFileAsync(
		"python3",
		["-m", "py_compile", ...generatedPythonFiles],
		{ cwd: targetDir },
	);
	passed.push(
		"python3 -m py_compile: generated Python scaffold is syntactically valid",
	);
	passed.push(await lintGeneratedPythonScaffold(targetDir));
	return passed;
}

function extractPythonCalls(contents: string, callee: string): string[] {
	const calls: string[] = [];
	const marker = `${callee}(`;
	let searchIndex = 0;
	while (searchIndex < contents.length) {
		const start = contents.indexOf(marker, searchIndex);
		if (start < 0) break;
		let depth = 0;
		let quote: string | undefined;
		let tripleQuote = false;
		let escaped = false;
		let foundEnd = false;
		for (
			let index = start + callee.length;
			index < contents.length;
			index += 1
		) {
			const character = contents[index];
			if (quote) {
				if (escaped) {
					escaped = false;
					continue;
				}
				if (!tripleQuote && character === "\\") {
					escaped = true;
					continue;
				}
				if (
					tripleQuote &&
					character === quote &&
					contents[index + 1] === quote &&
					contents[index + 2] === quote
				) {
					index += 2;
					quote = undefined;
					tripleQuote = false;
					continue;
				}
				if (!tripleQuote && character === quote) {
					quote = undefined;
					continue;
				}
				continue;
			}
			if (character === '"' || character === "'") {
				quote = character;
				tripleQuote =
					contents[index + 1] === character &&
					contents[index + 2] === character;
				if (tripleQuote) index += 2;
				continue;
			}
			if (character === "(") {
				depth += 1;
				continue;
			}
			if (character === ")") {
				depth -= 1;
				if (depth === 0) {
					calls.push(contents.slice(start, index + 1));
					searchIndex = index + 1;
					foundEnd = true;
					break;
				}
			}
		}
		if (!foundEnd) searchIndex = start + marker.length;
	}
	return calls;
}

async function lintGeneratedPythonScaffold(targetDir: string): Promise<string> {
	const failures: string[] = [];
	const requirements = await readFile(
		join(targetDir, "requirements.txt"),
		"utf8",
	);
	for (const file of generatedPythonFiles) {
		const contents = await readFile(join(targetDir, file), "utf8");
		if (file === "src/activities.py") {
			if (/@activity\.defn\s+async\s+def\s+/.test(contents)) {
				failures.push(
					"src/activities.py activity functions must be synchronous def functions, not async def, so blocking urllib and subprocess.run work runs in the worker activity_executor",
				);
			}
			if (
				/\bimport\s+requests\b|\bfrom\s+requests\b/.test(contents) &&
				!/^requests\b/im.test(requirements)
			) {
				failures.push(
					"requirements.txt must include requests because src/activities.py imports requests",
				);
			}
			if (
				/\bfrom\s+bs4\b|\bimport\s+bs4\b|BeautifulSoup/.test(contents) &&
				!/^beautifulsoup4\b/im.test(requirements)
			) {
				failures.push(
					"requirements.txt must include beautifulsoup4 because src/activities.py uses BeautifulSoup",
				);
			}
			if (/\blxml\b/.test(contents) && !/^lxml\b/im.test(requirements)) {
				failures.push(
					"requirements.txt must include lxml because generated code references lxml",
				);
			}
			if (/resources\/case-studies\/\[\^\\s/.test(contents)) {
				failures.push(
					"src/activities.py must use a bounded Temporal case-study URL regex such as [a-z0-9\\-/]+, not a broad [^\\s...] pattern that captures punctuation",
				);
			}
			if (!/err\.code\s*==\s*404/.test(contents)) {
				failures.push(
					"src/activities.py must handle urllib.error.HTTPError 404 as a non-retryable missing case-study page",
				);
			}
			for (const applicationError of extractPythonCalls(
				contents,
				"ApplicationError",
			)) {
				if (
					/invalid JSON/i.test(applicationError) &&
					!/non_retryable\s*=\s*True/.test(applicationError)
				) {
					failures.push(
						"src/activities.py must mark invalid Pi JSON extraction responses as non_retryable=True",
					);
					break;
				}
			}
			if (
				/json\.loads\s*\(\s*completed\.stdout/.test(contents) ||
				/json\.loads\s*\(\s*output\s*\)/.test(contents)
			) {
				failures.push(
					"src/activities.py must parse Pi --mode json NDJSON with extract_assistant_text(completed.stdout) and parse_json_object(...), not json.loads(completed.stdout) or json.loads(output)",
				);
			}
			if (/return\s+json\.loads\(\s*text(?:\.strip\(\))?\s*\)/.test(contents)) {
				failures.push(
					"src/activities.py must not require the entire assistant answer to be JSON; parse the first balanced JSON object or fall back to labeled fields",
				);
			}
			if (
				/event\.get\(["']type["']\)\s*==\s*["']agent_end["'][\s\S]{0,500}event\.get\(["']content["']/.test(
					contents,
				)
			) {
				failures.push(
					'src/activities.py must read assistant text from agent_end messages via event.get("messages"), not top-level event.get("content")',
				);
			}
			if (
				/def\s+export_marketing_html[\s\S]*record\.(?:url|company|headline|summary|evidence_quote|temporal_value)/.test(
					contents,
				) &&
				!/def\s+coerce_case_study_record|isinstance\s*\(\s*record\s*,\s*dict\s*\)/.test(
					contents,
				)
			) {
				failures.push(
					"src/activities.py must normalize dict-shaped CaseStudyRecord payloads before export_marketing_html reads fields because Temporal may decode list items as dictionaries",
				);
			}
		}
		if (
			file === "src/client.py" &&
			/result\.(?:records|failed_pages|attempted_urls)/.test(contents)
		) {
			failures.push(
				"src/client.py must normalize handle.result() with to_jsonable/result_state before counting records, failed_pages, or attempted_urls because Temporal Cloud may decode WorkflowState as a dict",
			);
		}
		if (
			file === "src/workflows.py" &&
			/discover_case_study_urls,\s*batch_size/.test(contents)
		) {
			failures.push(
				"src/workflows.py must pass page_budget, not batch_size, to discover_case_study_urls",
			);
		}
		if (
			file === "src/workflows.py" &&
			/execute_activity\([\s\S]*task_queue\s*=/.test(contents)
		) {
			failures.push(
				"src/workflows.py must omit task_queue on execute_activity calls so generated activities use the workflow's runtime TEMPORAL_TASK_QUEUE",
			);
		}
		if (
			file === "src/workflows.py" &&
			/attempted_urls\)\s*\+\s*i/.test(contents)
		) {
			failures.push(
				"src/workflows.py must not index discovered URLs with len(attempted_urls) + i while mutating attempted_urls",
			);
		}
		if (
			file === "src/workflows.py" &&
			/isinstance\s*\(\s*result\s*,\s*CaseStudyRecord\s*\)/.test(contents)
		) {
			failures.push(
				"src/workflows.py must not drop activity results by requiring isinstance(result, CaseStudyRecord); Temporal payload conversion may return dict-shaped records, so append valid non-exception results or normalize dicts before appending",
			);
		}
		if (
			file === "src/workflows.py" &&
			/workflow\.info\(\)\.workflow_execution_timeout/.test(contents)
		) {
			failures.push(
				"src/workflows.py must not use workflow.info().workflow_execution_timeout; set explicit timedelta start_to_close_timeout values for activities",
			);
		}
		if (
			file === "src/workflows.py" &&
			/workflow\.logger\.\w+\(\s*f["'][^"']*\{result\}/.test(contents)
		) {
			failures.push(
				"src/workflows.py must not stringify activity exception objects in workflow logs; log the URL or exception type only so workflow tasks keep yielding quickly",
			);
		}
		const lines = contents.split("\n");
		lines.forEach((line, index) => {
			const lineNumber = index + 1;
			if (/\s+$/.test(line))
				failures.push(`${file}:${lineNumber} trailing whitespace`);
			if (line.includes("\t"))
				failures.push(`${file}:${lineNumber} tab indentation`);
			if (/^\s*except\s*:/.test(line))
				failures.push(`${file}:${lineNumber} bare except`);
			if (line.includes("TEMPORAL_HOST")) {
				failures.push(
					`${file}:${lineNumber} use TEMPORAL_ADDRESS instead of TEMPORAL_HOST`,
				);
			}
			if (line.includes("rpc_metadata")) {
				failures.push(
					`${file}:${lineNumber} use the Temporal Cloud api_key parameter, not rpc_metadata`,
				);
			}
			if (file === "src/client.py" && line.includes("json.dumps(event)")) {
				failures.push(
					`${file}:${lineNumber} serialize dataclass payloads with to_jsonable before json.dumps`,
				);
			}
			if (line.includes("pi-gtm-demo-codeact")) {
				failures.push(
					`${file}:${lineNumber} remove stale pi-gtm-demo-codeact task queue literal; generated code must use runtime TEMPORAL_TASK_QUEUE`,
				);
			}
			if (/case-studies\/example|example-\d+|Company-\{?/.test(line)) {
				failures.push(
					`${file}:${lineNumber} generated scaffold must crawl live Temporal case-study pages, not examples`,
				);
			}
			if (/api[_-]?key\s*=\s*["'][^"']+["']/i.test(line)) {
				failures.push(`${file}:${lineNumber} literal API key-like value`);
			}
		});
	}
	if (failures.length > 0) {
		throw new Error(`Generated scaffold lint failed:\n${failures.join("\n")}`);
	}
	return [
		"generated-code lint: passed 6 Python files",
		"rules: no trailing whitespace, no tabs, no bare except, no literal API keys",
	].join("\n");
}

function modelsSource(): string {
	return `from dataclasses import dataclass, field
from typing import Optional


@dataclass
class CaseStudyRecord:
    url: str
    company: str
    headline: str
    summary: str
    evidence_quote: str
    temporal_value: str
    industry: Optional[str] = None
    use_case: Optional[str] = None


@dataclass
class FailedPage:
    url: str
    step: str
    reason: str
    attempts: int
    retryable: bool


@dataclass
class ResearchState:
    target_count: int = 20
    status: str = "discovering"
    discovered_urls: list[str] = field(default_factory=list)
    attempted_urls: list[str] = field(default_factory=list)
    records: list[CaseStudyRecord] = field(default_factory=list)
    failed_pages: list[FailedPage] = field(default_factory=list)
    reviewer_notes: list[str] = field(default_factory=list)
    approved: bool = False
`;
}

function activitiesSource(): string {
	return `import hashlib
	import html
	import json
	import os
	import re
	import shlex
	import subprocess
	import threading
	import urllib.error
	import urllib.request
	from datetime import datetime, timezone
	from pathlib import Path
	from typing import Optional
	from urllib.parse import urlparse

	from temporalio import activity
	from temporalio.exceptions import ApplicationError

	from models import CaseStudyRecord

	TEMPORAL_CUSTOMER_STORIES_URL = "https://temporal.io/in-use"
	TEMPORAL_SITEMAP_URL = "https://temporal.io/sitemap.xml"
	CASE_STUDY_PATTERN = re.compile(r"https://temporal\\.io/resources/case-studies/[a-z0-9\\-/]+", re.I)
	PI_EXTRACTION_HTML_LIMIT = 45000
	PI_EXTRACTION_CACHE_VERSION = "pi-case-study-extraction-v1"
	PI_EXTRACTION_CACHE_PATH = os.getenv("PI_EXTRACTION_CACHE_PATH")
	PI_EXTRACTION_CACHE_LOCK = threading.Lock()


	@activity.defn
	def discover_case_study_urls(
	    start_url: str = TEMPORAL_CUSTOMER_STORIES_URL,
	    sitemap_url: str = TEMPORAL_SITEMAP_URL,
	) -> list[str]:
	    urls: list[str] = []
	    for source in (start_url, sitemap_url):
	        page = fetch_text(source)
	        urls.extend(CASE_STUDY_PATTERN.findall(page))
	        sitemap_matches = re.finditer(
	            r"<loc>\\s*([^<]+?/resources/case-studies/[^<]+?)\\s*</loc>",
	            page,
	        )
	        urls.extend(match.group(1).strip() for match in sitemap_matches)
	    return sorted({normalize_url(url) for url in urls if is_case_study_url(url)})


	@activity.defn
	def fetch_and_extract_case_study(url: str) -> CaseStudyRecord:
	    try:
	        page = fetch_text(url)
	    except urllib.error.HTTPError as err:
	        if err.code == 404:
	            raise ApplicationError(
	                f"Missing case-study page: {url}",
	                type="NotFound",
	                non_retryable=True,
	            ) from err
	        raise ApplicationError(
	            f"Retryable HTTP failure for {url}: {err.code}",
	            type="FetchFailure",
	        ) from err
	    try:
	        record = extract_record(url, page)
	    except ApplicationError:
	        raise
	    except Exception as err:
	        raise ApplicationError(
	            f"Pi runtime extraction failed for {url}: {err}",
	            type="ExtractionFailure",
	        ) from err
	    if record is None:
	        raise ApplicationError(
	            f"Not a valid Temporal case-study page: {url}",
	            type="ValidationError",
	            non_retryable=True,
	        )
	    return record


	@activity.defn
	def export_marketing_html(records: list[CaseStudyRecord]) -> str:
	    normalized_records = [coerce_case_study_record(record) for record in records]
	    cards = "\\n".join(
	        "<article>"
	        f"<h2>{html.escape(record.company)}</h2>"
	        f"<p>{html.escape(record.temporal_value)}</p>"
	        f"<a href='{html.escape(record.url)}'>Source</a>"
	        "</article>"
	        for record in normalized_records
	    )
	    return f"<!doctype html><html><body><h1>Temporal customer proof</h1>{cards}</body></html>"


	def coerce_case_study_record(record: object) -> CaseStudyRecord:
	    if isinstance(record, CaseStudyRecord):
	        return record
	    if isinstance(record, dict):
	        return CaseStudyRecord(
	            url=str(record.get("url") or ""),
	            company=str(record.get("company") or ""),
	            headline=str(record.get("headline") or ""),
	            summary=str(record.get("summary") or ""),
	            evidence_quote=str(record.get("evidence_quote") or record.get("evidenceQuote") or ""),
	            temporal_value=str(record.get("temporal_value") or record.get("temporalValue") or ""),
	            industry=payload_string(record, "industry"),
	            use_case=payload_string(record, "use_case", "useCase"),
	        )
	    raise ApplicationError(
	        f"Unsupported case-study record payload: {type(record).__name__}",
	        type="ValidationError",
	        non_retryable=True,
	    )


	def fetch_text(url: str) -> str:
	    request = urllib.request.Request(url, headers={"User-Agent": "pi-codeact-temporal-demo/0.1"})
	    with urllib.request.urlopen(request, timeout=20) as response:
	        return response.read().decode("utf-8", errors="replace")


	def extract_record(url: str, page: str) -> Optional[CaseStudyRecord]:
	    if not is_case_study_url(url):
	        return None
	    payload = run_pi_extraction(build_extraction_prompt(url, page))
	    valid = payload.get("valid")
	    if valid is False or (isinstance(valid, str) and valid.lower() in {"false", "no", "invalid"}):
	        return None
	    return record_from_payload(url, payload)


	def run_pi_extraction(prompt: str) -> dict[str, object]:
	    cache_key = extraction_cache_key(prompt)
	    cached = read_extraction_cache(cache_key)
	    if cached is not None:
	        return cached
	    command = shlex.split(os.getenv("PI_COMMAND", "pi"))
	    try:
	        completed = subprocess.run(
	            [
	                *command,
	                "--mode",
	                "json",
	                "--no-session",
	                "--no-tools",
	                "-p",
	                prompt,
	            ],
	            text=True,
	            capture_output=True,
	            timeout=180,
	            check=False,
	        )
	    except FileNotFoundError as err:
	        raise ApplicationError(
	            "Pi runtime is unavailable for semantic case-study extraction.",
	            type="PiRuntimeUnavailable",
	            non_retryable=True,
	        ) from err
	    except subprocess.TimeoutExpired as err:
	        raise ApplicationError(
	            "Pi runtime extraction timed out.",
	            type="PiRuntimeTimeout",
	        ) from err
	    if completed.returncode != 0:
	        raise ApplicationError(
	            f"Pi runtime extraction exited {completed.returncode}: {completed.stderr or completed.stdout}",
	            type="PiRuntimeFailure",
	        )
	    assistant_text = extract_assistant_text(completed.stdout)
	    try:
	        parsed = parse_extraction_response(assistant_text or completed.stdout)
	    except (ValueError, json.JSONDecodeError) as err:
	        raise ApplicationError(
	            "Pi extraction response could not be parsed into fields.",
	            type="ValidationError",
	            non_retryable=True,
	        ) from err
	    if not isinstance(parsed, dict):
	        raise ApplicationError(
	            "Pi extraction response could not be parsed into fields.",
	            type="ValidationError",
	            non_retryable=True,
	        )
	    write_extraction_cache(cache_key, parsed)
	    return parsed


	def extraction_cache_key(prompt: str) -> str:
	    material = f"{PI_EXTRACTION_CACHE_VERSION}\\n{prompt}".encode("utf-8")
	    return hashlib.sha256(material).hexdigest()


	def read_extraction_cache(cache_key: str) -> Optional[dict[str, object]]:
	    if not PI_EXTRACTION_CACHE_PATH:
	        return None
	    with PI_EXTRACTION_CACHE_LOCK:
	        try:
	            raw = Path(PI_EXTRACTION_CACHE_PATH).read_text(encoding="utf-8")
	            data = json.loads(raw)
	        except (FileNotFoundError, OSError, json.JSONDecodeError):
	            return None
	        entry = (data.get("entries") or {}).get(cache_key)
	        if not isinstance(entry, dict):
	            return None
	        if entry.get("version") != PI_EXTRACTION_CACHE_VERSION:
	            return None
	        payload = entry.get("payload")
	        return payload if isinstance(payload, dict) else None


	def write_extraction_cache(cache_key: str, payload: dict[str, object]) -> None:
	    if not PI_EXTRACTION_CACHE_PATH:
	        return
	    with PI_EXTRACTION_CACHE_LOCK:
	        path = Path(PI_EXTRACTION_CACHE_PATH)
	        try:
	            data = json.loads(path.read_text(encoding="utf-8"))
	        except (FileNotFoundError, OSError, json.JSONDecodeError):
	            data = {"version": 1, "entries": {}}
	        entries = data.setdefault("entries", {})
	        if not isinstance(entries, dict):
	            data["entries"] = {}
	            entries = data["entries"]
	        entries[cache_key] = {
	            "version": PI_EXTRACTION_CACHE_VERSION,
	            "stored_at": datetime.now(timezone.utc).isoformat(),
	            "payload": payload,
	        }
	        path.parent.mkdir(parents=True, exist_ok=True)
	        path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\\n", encoding="utf-8")


	def build_extraction_prompt(url: str, page: str) -> str:
	    bounded_page = truncate_page(page)
	    parts = [
	        "You are Pi extracting one structured customer-proof record from a Temporal-owned case-study page.",
	        "Use semantic reading of the supplied page content, not regex or local fixtures.",
	        "Use only facts present in the supplied page content. Do not invent customers, metrics, quotes, use cases, or claims.",
	        'If the page is not a valid Temporal customer case study or there is not enough evidence, return {"valid":false,"reason":"short reason"} or a short labeled invalid response.',
	        "Prefer one JSON object with fields valid, url, company, headline, summary, evidence_quote, temporal_value, industry, and use_case.",
	        "JSON does not have to be the only text in the response; labeled fields are acceptable.",
	        "Labeled field fallback shape: Company:, Headline:, Summary:, Evidence quote:, Temporal value:, Industry:, Use case:.",
	        "Required valid fields are company, headline, summary, evidence_quote, and temporal_value.",
	        f"Source URL: {url}",
	        f"Supplied page HTML ({len(page)} characters, {len(bounded_page)} included):",
	        bounded_page,
	    ]
	    return "\\n\\n".join(parts)


	def truncate_page(page: str) -> str:
	    if len(page) <= PI_EXTRACTION_HTML_LIMIT:
	        return page
	    head_length = int(PI_EXTRACTION_HTML_LIMIT * 0.72)
	    tail_length = PI_EXTRACTION_HTML_LIMIT - head_length
	    omitted = len(page) - PI_EXTRACTION_HTML_LIMIT
	    return "\\n".join(
	        [
	            page[:head_length],
	            f"<!-- omitted {omitted} middle characters -->",
	            page[-tail_length:],
	        ]
	    )


	def extract_assistant_text(stdout: str) -> str:
	    last_assistant = ""
	    for line in stdout.splitlines():
	        if not line.strip():
	            continue
	        try:
	            event = json.loads(line)
	        except json.JSONDecodeError:
	            continue
	        if event.get("type") == "message_end":
	            message = event.get("message") or {}
	            if message.get("role") == "assistant":
	                last_assistant = text_from_content(message.get("content"))
	        if event.get("type") == "agent_end":
	            messages = event.get("messages") or []
	            for message in reversed(messages):
	                if message.get("role") == "assistant":
	                    last_assistant = text_from_content(message.get("content"))
	                    break
	    return last_assistant


	def text_from_content(content: object) -> str:
	    if isinstance(content, str):
	        return content
	    if not isinstance(content, list):
	        return ""
	    parts = []
	    for item in content:
	        if isinstance(item, dict) and item.get("type") == "text":
	            text = item.get("text")
	            if isinstance(text, str):
	                parts.append(text)
	    return "".join(parts)


	FIELD_ALIASES = {
	    "valid": "valid",
	    "sourceurl": "url",
	    "url": "url",
	    "company": "company",
	    "customer": "company",
	    "headline": "headline",
	    "title": "headline",
	    "summary": "summary",
	    "evidencequote": "evidence_quote",
	    "quote": "evidence_quote",
	    "temporalvalue": "temporal_value",
	    "value": "temporal_value",
	    "industry": "industry",
	    "usecase": "use_case",
	}


	def parse_extraction_response(text: str) -> dict[str, object]:
	    try:
	        parsed = parse_json_object(text)
	        if isinstance(parsed, dict):
	            return parsed
	    except (ValueError, json.JSONDecodeError):
	        pass
	    fields = parse_labeled_fields(text)
	    if fields:
	        return fields
	    raise ValueError("Pi extraction response did not contain parseable fields.")


	def parse_json_object(text: str) -> object:
	    start = text.find("{")
	    if start < 0:
	        raise ValueError("Pi extraction response did not contain a JSON object.")
	    depth = 0
	    in_string = False
	    escaped = False
	    for index in range(start, len(text)):
	        character = text[index]
	        if escaped:
	            escaped = False
	            continue
	        if character == "\\\\":
	            escaped = True
	            continue
	        if character == '"':
	            in_string = not in_string
	            continue
	        if in_string:
	            continue
	        if character == "{":
	            depth += 1
	            continue
	        if character == "}":
	            depth -= 1
	            if depth == 0:
	                return json.loads(text[start : index + 1])
	    raise ValueError("Pi extraction response contained an unterminated JSON object.")


	def parse_labeled_fields(text: str) -> dict[str, object]:
	    fields: dict[str, str] = {}
	    current_key: Optional[str] = None
	    for raw_line in text.splitlines():
	        line = raw_line.strip()
	        if not line:
	            continue
	        match = re.match(r"^(?:[-*]\\s*)?(?:\\*\\*)?([A-Za-z][A-Za-z _/-]{1,40})(?:\\*\\*)?\\s*:\\s*(.*)$", line)
	        if match:
	            key = FIELD_ALIASES.get(normalize_label(match.group(1)))
	            if key:
	                fields[key] = clean_labeled_value(match.group(2))
	                current_key = key
	                continue
	        if current_key:
	            fields[current_key] = " ".join([fields[current_key], line]).strip()
	    return fields


	def normalize_label(label: str) -> str:
	    return re.sub(r"[^a-z0-9]", "", label.lower())


	def clean_labeled_value(value: str) -> str:
	    return " ".join(value.strip().strip("'\\"").split())


	def record_from_payload(url: str, payload: dict[str, object]) -> CaseStudyRecord:
	    company = payload_string(payload, "company")
	    headline = payload_string(payload, "headline")
	    summary = payload_string(payload, "summary")
	    evidence_quote = payload_string(payload, "evidence_quote", "evidenceQuote")
	    temporal_value = payload_string(payload, "temporal_value", "temporalValue")
	    missing = [
	        name
	        for name, value in [
	            ("company", company),
	            ("headline", headline),
	            ("summary", summary),
	            ("evidence_quote", evidence_quote),
	            ("temporal_value", temporal_value),
	        ]
	        if not value
	    ]
	    if missing:
	        raise ApplicationError(
	            f"Pi extraction response missing required field(s): {', '.join(missing)}",
	            type="ValidationError",
	            non_retryable=True,
	        )
	    return CaseStudyRecord(
	        url=normalize_url(url),
	        company=company,
	        headline=headline,
	        summary=summary,
	        evidence_quote=evidence_quote,
	        temporal_value=temporal_value,
	        industry=payload_string(payload, "industry"),
	        use_case=payload_string(payload, "use_case", "useCase"),
	    )


	def payload_string(payload: dict[str, object], *keys: str) -> Optional[str]:
	    for key in keys:
	        value = payload.get(key)
	        if isinstance(value, str):
	            cleaned = " ".join(value.split()).strip()
	            if cleaned and cleaned.lower() not in {"n/a", "na", "unknown", "null"}:
	                return cleaned
	    return None


	def normalize_url(url: str) -> str:
	    return url.rstrip("/")


	def is_case_study_url(url: str) -> bool:
	    parsed = urlparse(url)
	    return parsed.netloc == "temporal.io" and parsed.path.startswith("/resources/case-studies/")
	`.replace(/^\t/gm, "");
}

function workflowSource(): string {
	return `from datetime import timedelta
import asyncio

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from activities import discover_case_study_urls, fetch_and_extract_case_study, export_marketing_html
    from models import FailedPage, ResearchState


@workflow.defn
class TemporalCaseStudyResearchWorkflow:
    def __init__(self) -> None:
        self._state = ResearchState()
        self._paused = False

    @workflow.signal
    async def pause_for_review(self, note: str) -> None:
        self._paused = True
        self._state.status = "needs_review"
        self._state.reviewer_notes.append(note)

    @workflow.signal
    async def approve_export(self, note: str = "approved") -> None:
        self._state.approved = True
        self._state.reviewer_notes.append(note)

    @workflow.query
    def current_state(self) -> ResearchState:
        return self._state

    @workflow.run
    async def run(self, target_count: int = 20, batch_size: int = 8, page_budget: int = 40) -> ResearchState:
        self._state.target_count = target_count
        retry_policy = RetryPolicy(
            initial_interval=timedelta(seconds=2),
            maximum_interval=timedelta(seconds=30),
            maximum_attempts=3,
            non_retryable_error_types=["ValidationError", "NotFound"],
        )
        urls = await workflow.execute_activity(
            discover_case_study_urls,
            start_to_close_timeout=timedelta(minutes=2),
            retry_policy=retry_policy,
        )
        self._state.discovered_urls = urls
        self._state.status = "extracting"
        bounded_urls = urls[:page_budget]

        for index in range(0, len(bounded_urls), batch_size):
            batch = bounded_urls[index:index + batch_size]
            self._state.attempted_urls.extend(batch)
            tasks = [
                workflow.execute_activity(
                    fetch_and_extract_case_study,
                    url,
                    start_to_close_timeout=timedelta(minutes=2),
                    schedule_to_close_timeout=timedelta(minutes=6),
                    retry_policy=retry_policy,
                )
                for url in batch
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for url, result in zip(batch, results):
                if isinstance(result, Exception):
                    self._state.failed_pages.append(
                        FailedPage(url=url, step="fetch_extract", reason=str(result), attempts=3, retryable=True)
                    )
                else:
                    self._state.records.append(result)
            if len(self._state.records) >= target_count:
                break

        self._state.records = self._state.records[:target_count]

        if len(self._state.records) < target_count:
            self._state.status = "needs_review"
            await workflow.wait_condition(lambda: self._state.approved or self._paused)
        else:
            self._state.status = "ready_for_approval"
            await workflow.wait_condition(lambda: self._state.approved)

        if self._state.approved:
            await workflow.execute_activity(
                export_marketing_html,
                self._state.records,
                start_to_close_timeout=timedelta(minutes=1),
                retry_policy=retry_policy,
            )
            self._state.status = "completed"
        return self._state
`;
}

function workerSource(): string {
	return `import asyncio
from concurrent.futures import ThreadPoolExecutor
import os

from temporalio.client import Client
from temporalio.worker import Worker

from activities import discover_case_study_urls, fetch_and_extract_case_study, export_marketing_html
from workflows import TemporalCaseStudyResearchWorkflow


def required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} must be set")
    return value


TASK_QUEUE = required_env("TEMPORAL_TASK_QUEUE")


async def main() -> None:
    api_key = os.getenv("TEMPORAL_API_KEY")
    client = await Client.connect(
        os.getenv("TEMPORAL_ADDRESS", "localhost:7233"),
        namespace=os.getenv("TEMPORAL_NAMESPACE", "default"),
        api_key=api_key,
        tls=True if api_key else False,
    )
    with ThreadPoolExecutor(max_workers=16) as activity_executor:
        worker = Worker(
            client,
            task_queue=TASK_QUEUE,
            workflows=[TemporalCaseStudyResearchWorkflow],
            activities=[discover_case_study_urls, fetch_and_extract_case_study, export_marketing_html],
            activity_executor=activity_executor,
        )
        await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
`;
}

function clientSource(): string {
	return `import asyncio
from dataclasses import asdict, is_dataclass
import json
import os
import uuid

from temporalio.client import Client

from workflows import TemporalCaseStudyResearchWorkflow


def required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} must be set")
    return value


TASK_QUEUE = required_env("TEMPORAL_TASK_QUEUE")


def to_jsonable(value):
    if is_dataclass(value):
        return asdict(value)
    if isinstance(value, list):
        return [to_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {key: to_jsonable(item) for key, item in value.items()}
    return value


def emit(event: str, **payload) -> None:
    print(
        "CODEACT_TEMPORAL_EVENT "
        + json.dumps({"event": event, **to_jsonable(payload)}, sort_keys=True),
        flush=True,
    )


def state_list_count(state: object, key: str) -> int:
    value = state.get(key) if isinstance(state, dict) else getattr(state, key, None)
    return len(value) if isinstance(value, list) else 0


async def main() -> None:
    api_key = os.getenv("TEMPORAL_API_KEY")
    client = await Client.connect(
        os.getenv("TEMPORAL_ADDRESS", "localhost:7233"),
        namespace=os.getenv("TEMPORAL_NAMESPACE", "default"),
        api_key=api_key,
        tls=True if api_key else False,
    )
    workflow_id = os.getenv("CODEACT_WORKFLOW_ID") or f"temporal-case-study-research-{uuid.uuid4()}"
    target_count = int(os.getenv("CODEACT_TARGET_COUNT", "20"))
    batch_size = int(os.getenv("CODEACT_BATCH_SIZE", "8"))
    page_budget = int(os.getenv("CODEACT_PAGE_BUDGET", "40"))
    emit(
        "workflow_starting",
        workflow_id=workflow_id,
        workflow_type="TemporalCaseStudyResearchWorkflow",
        task_queue=TASK_QUEUE,
        activities=["discover_case_study_urls", "fetch_and_extract_case_study", "export_marketing_html"],
    )
    handle = await client.start_workflow(
        TemporalCaseStudyResearchWorkflow.run,
        args=[target_count, batch_size, page_budget],
        id=workflow_id,
        task_queue=TASK_QUEUE,
    )
    try:
        state = await handle.query(TemporalCaseStudyResearchWorkflow.current_state)
    except Exception as err:
        emit("workflow_query_failed", workflow_id=workflow_id, error=type(err).__name__)
    else:
        emit("workflow_started", workflow_id=workflow_id, state=state)
    if os.getenv("CODEACT_AUTO_APPROVE", "1") == "1":
        await handle.signal(TemporalCaseStudyResearchWorkflow.approve_export, "approved from generated client")
        emit("approval_signal_sent", workflow_id=workflow_id)
    result = await handle.result()
    result_state = to_jsonable(result)
    emit(
        "workflow_completed",
        workflow_id=workflow_id,
        state=result,
        records=state_list_count(result_state, "records"),
        failures=state_list_count(result_state, "failed_pages"),
        attempted=state_list_count(result_state, "attempted_urls"),
    )


if __name__ == "__main__":
    asyncio.run(main())
`;
}

function extractorSource(): string {
	return `from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict
import json
from typing import Callable

from activities import fetch_and_extract_case_study


def bounded_parallel_extract(urls: list[str], limit: int = 8) -> dict:
    records = []
    failures = []
    with ThreadPoolExecutor(max_workers=limit) as executor:
        future_to_url = {executor.submit(fetch_and_extract_case_study, url): url for url in urls}
        for future in as_completed(future_to_url):
            url = future_to_url[future]
            try:
                records.append(asdict(future.result()))
            except Exception as exc:
                failures.append({"url": url, "reason": str(exc)})
    return {"records": records, "failures": failures}


def main(load_urls: Callable[[], list[str]]) -> None:
    print(json.dumps(bounded_parallel_extract(load_urls()), indent=2))
`;
}

function readmeSource(taskQueue: string): string {
	return `# CodeAct Generated Temporal Python Scaffold

This scaffold is generated by the Pi CodeAct escape hatch for the Temporal case-study research demo.

It demonstrates:

- Workflow and Activity file separation.
- Network crawling only inside Activities.
- Workflow state exposed through a Query.
- Reviewer pause and approval through Signals.
- RetryPolicy for fetch/extract/export Activities.
- Bounded parallel extraction with \`asyncio.gather(..., return_exceptions=True)\`.
- Worker and client code bound to task queue \`${taskQueue}\`.

No API keys or Temporal Cloud secrets are written into generated files. Runtime credentials are read from environment variables.
`;
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
