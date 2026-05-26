import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildTemporalScaffoldFilePrompt,
	buildTemporalScaffoldFileRepairPrompt,
	buildTemporalScaffoldLlmPrompt,
	buildTemporalScaffoldPlanPrompt,
	buildTemporalScaffoldRepairPrompt,
} from "../src/harness/pi-harness.ts";
import {
	createTemporalScaffoldPlan,
	createTemporalScaffoldSpec,
	parseTemporalScaffoldFileContentsFromLlm,
	parseTemporalScaffoldPlanFromLlm,
	parseTemporalScaffoldSpecFromBash,
	renderTemporalScaffoldBashScript,
	selectTemporalScaffoldRepairPaths,
	validateTemporalScaffold,
	writeTemporalScaffold,
} from "../src/harness/temporal-scaffold.ts";

test("CodeAct bash heredoc scaffold round-trips into required generated files", () => {
	const rendered = renderTemporalScaffoldBashScript(
		createTemporalScaffoldSpec(),
	);
	const parsed = parseTemporalScaffoldSpecFromBash(rendered);

	assert.deepEqual(
		parsed.files.map((file) => file.path),
		[
			"requirements.txt",
			"src/models.py",
			"src/activities.py",
			"src/workflows.py",
			"src/worker.py",
			"src/client.py",
			"src/extractor.py",
			"README.md",
		],
	);
	assert.ok(
		parsed.files
			.find((file) => file.path === "src/workflows.py")
			?.contents.includes("@workflow.defn"),
	);
	assert.ok(
		parsed.files
			.find((file) => file.path === "src/workflows.py")
			?.contents.includes("RetryPolicy"),
	);
});

test("CodeAct scaffold prompts spell out PI_COMMAND runtime invocation", () => {
	const plan = createTemporalScaffoldPlan();
	const legacyPrompt = buildTemporalScaffoldLlmPrompt();
	const legacyRepair = buildTemporalScaffoldRepairPrompt(
		legacyPrompt,
		'Generated scaffold src/activities.py is missing "PI_COMMAND"',
		'result = subprocess.run(["pi", "ask", prompt])',
		1,
	);
	const prompt = buildTemporalScaffoldPlanPrompt();
	const file = buildTemporalScaffoldFilePrompt(plan, "src/activities.py");
	const repair = buildTemporalScaffoldFileRepairPrompt(
		plan,
		"src/activities.py",
		'Generated scaffold src/activities.py is missing "PI_COMMAND"',
		'result = subprocess.run(["pi", "ask", prompt])',
		{},
		["src/activities.py"],
		1,
	);

	for (const text of [prompt, file, repair, legacyPrompt, legacyRepair]) {
		assert.match(text, /PI_COMMAND/);
		assert.match(text, /--mode/);
		assert.match(text, /--no-session/);
		assert.match(text, /--no-tools/);
		assert.match(text, /extract_assistant_text/);
		assert.match(text, /text_from_content/);
		assert.match(text, /parse_extraction_response/);
		assert.match(text, /parse_json_object/);
		assert.match(text, /parse_labeled_fields/);
		assert.match(text, /JSON object|labeled fields/);
		assert.match(text, /PI_EXTRACTION_CACHE_PATH/);
		assert.match(text, /read_extraction_cache/);
		assert.match(text, /write_extraction_cache/);
		assert.match(
			text,
			/unparseable Pi extraction responses|could not be parsed into fields/,
		);
		assert.match(text, /non_retryable=True/);
		assert.match(text, /synchronous def|not async def|activity_executor/);
		assert.match(text, /workflow_query_failed|handle\.query|Timeout expired/);
		assert.match(
			text,
			/activity exception objects|stringify|workflow logs|\{result\}/,
		);
		assert.match(text, /state=result/);
		assert.match(text, /result = await handle\.result\(\)/);
		assert.match(text, /result_state = to_jsonable\(result\)/);
		assert.match(text, /state_list_count/);
		assert.match(text, /TEMPORAL_TASK_QUEUE/);
		assert.match(text, /TASK_QUEUE = required_env\("TEMPORAL_TASK_QUEUE"\)/);
		assert.doesNotMatch(text, /pi-gtm-demo-codeact/);
		assert.match(
			text,
			/dict-shaped record payloads|dict-shaped CaseStudyRecord payloads/,
		);
	}
});

test("CodeAct scaffold plan and file parsers accept coordinated outputs", () => {
	const plan = createTemporalScaffoldPlan();
	const parsedPlan = parseTemporalScaffoldPlanFromLlm(
		JSON.stringify(plan, null, 2),
	);
	assert.equal(parsedPlan.workflowName, "TemporalCaseStudyResearchWorkflow");
	assert.deepEqual(
		parsedPlan.files.map((file) => file.path),
		[
			"requirements.txt",
			"src/models.py",
			"src/activities.py",
			"src/workflows.py",
			"src/worker.py",
			"src/client.py",
			"src/extractor.py",
			"README.md",
		],
	);

	const fileContents = parseTemporalScaffoldFileContentsFromLlm(
		"```python\nfrom temporalio import workflow\n```",
		"src/workflows.py",
	);
	assert.equal(fileContents, "from temporalio import workflow");
	assert.deepEqual(
		selectTemporalScaffoldRepairPaths("TEMPORAL_TASK_QUEUE mismatch"),
		["src/workflows.py", "src/worker.py", "src/client.py"],
	);
});

test("CodeAct scaffold validation rejects exact assistant JSON parsing", async () => {
	const targetDir = await mkdtemp(join(tmpdir(), "pi-temporal-scaffold-"));
	try {
		const spec = createTemporalScaffoldSpec();
		const badSpec = {
			...spec,
			files: spec.files.map((file) =>
				file.path === "src/activities.py"
					? {
							...file,
							contents: file.contents.replace(
								"return json.loads(text[start : index + 1])",
								"return json.loads(text)",
							),
						}
					: file,
			),
		};
		await writeTemporalScaffold(targetDir, badSpec);

		await assert.rejects(
			() => validateTemporalScaffold(targetDir),
			/entire assistant answer/,
		);
	} finally {
		await rm(targetDir, { recursive: true, force: true });
	}
});

test("CodeAct scaffold validation rejects result attribute count parsing", async () => {
	const targetDir = await mkdtemp(join(tmpdir(), "pi-temporal-scaffold-"));
	try {
		const spec = createTemporalScaffoldSpec();
		const badSpec = {
			...spec,
			files: spec.files.map((file) =>
				file.path === "src/client.py"
					? {
							...file,
							contents: file.contents
								.replace(
									'records=state_list_count(result_state, "records"),',
									"records=len(result.records),",
								)
								.replace(
									'failures=state_list_count(result_state, "failed_pages"),',
									"failures=len(result.failed_pages),",
								)
								.replace(
									'attempted=state_list_count(result_state, "attempted_urls"),',
									"attempted=len(result.attempted_urls),",
								),
						}
					: file,
			),
		};
		await writeTemporalScaffold(targetDir, badSpec);

		await assert.rejects(
			() => validateTemporalScaffold(targetDir),
			/normalize handle\.result\(\)/,
		);
	} finally {
		await rm(targetDir, { recursive: true, force: true });
	}
});

test("CodeAct scaffold validation rejects whole-stdout Pi JSON parsing", async () => {
	const targetDir = await mkdtemp(join(tmpdir(), "pi-temporal-scaffold-"));
	try {
		const spec = createTemporalScaffoldSpec();
		const badSpec = {
			...spec,
			files: spec.files.map((file) =>
				file.path === "src/activities.py"
					? {
							...file,
							contents: file.contents.replace(
								[
									"    assistant_text = extract_assistant_text(completed.stdout)",
									"    try:",
									"        parsed = parse_extraction_response(assistant_text or completed.stdout)",
									"    except (ValueError, json.JSONDecodeError) as err:",
									"        raise ApplicationError(",
									'            "Pi extraction response could not be parsed into fields.",',
									'            type="ValidationError",',
									"            non_retryable=True,",
									"        ) from err",
								].join("\n"),
								[
									"    output = completed.stdout.strip()",
									"    parsed = json.loads(output)",
								].join("\n"),
							),
						}
					: file,
			),
		};
		await writeTemporalScaffold(targetDir, badSpec);

		await assert.rejects(
			() => validateTemporalScaffold(targetDir),
			/Pi --mode json NDJSON/,
		);
	} finally {
		await rm(targetDir, { recursive: true, force: true });
	}
});

test("CodeAct scaffold validation rejects retryable invalid Pi JSON failures", async () => {
	const targetDir = await mkdtemp(join(tmpdir(), "pi-temporal-scaffold-"));
	try {
		const spec = createTemporalScaffoldSpec();
		const badSpec = {
			...spec,
			files: spec.files.map((file) =>
				file.path === "src/activities.py"
					? {
							...file,
							contents: `${file.contents}

def invalid_json_failure_for_test(url: str) -> None:
    raise ApplicationError(f"Pi returned invalid JSON for {url}")
`,
						}
					: file,
			),
		};
		await writeTemporalScaffold(targetDir, badSpec);

		await assert.rejects(
			() => validateTemporalScaffold(targetDir),
			/invalid Pi JSON/,
		);
	} finally {
		await rm(targetDir, { recursive: true, force: true });
	}
});

test("CodeAct scaffold validation rejects top-level agent_end content parsing", async () => {
	const targetDir = await mkdtemp(join(tmpdir(), "pi-temporal-scaffold-"));
	try {
		const spec = createTemporalScaffoldSpec();
		const badSpec = {
			...spec,
			files: spec.files.map((file) =>
				file.path === "src/activities.py"
					? {
							...file,
							contents: file.contents.replace(
								[
									'            messages = event.get("messages") or []',
									"            for message in reversed(messages):",
									'                if message.get("role") == "assistant":',
									'                    last_assistant = text_from_content(message.get("content"))',
									"                    break",
								].join("\n"),
								[
									'            content = event.get("content", [])',
									"            last_assistant = text_from_content(content)",
								].join("\n"),
							),
						}
					: file,
			),
		};
		await writeTemporalScaffold(targetDir, badSpec);

		await assert.rejects(
			() => validateTemporalScaffold(targetDir),
			/event\.get\("messages"\)/,
		);
	} finally {
		await rm(targetDir, { recursive: true, force: true });
	}
});

test("CodeAct scaffold validation rejects workflow exception stringification logs", async () => {
	const targetDir = await mkdtemp(join(tmpdir(), "pi-temporal-scaffold-"));
	try {
		const spec = createTemporalScaffoldSpec();
		const badSpec = {
			...spec,
			files: spec.files.map((file) =>
				file.path === "src/workflows.py"
					? {
							...file,
							contents: file.contents.replace(
								[
									"                if isinstance(result, Exception):",
									"                    self._state.failed_pages.append(",
								].join("\n"),
								[
									"                if isinstance(result, Exception):",
									'                    workflow.logger.warning(f"Failed to extract {url}: {result}")',
									"                    self._state.failed_pages.append(",
								].join("\n"),
							),
						}
					: file,
			),
		};
		await writeTemporalScaffold(targetDir, badSpec);

		await assert.rejects(
			() => validateTemporalScaffold(targetDir),
			/activity exception objects/,
		);
	} finally {
		await rm(targetDir, { recursive: true, force: true });
	}
});

test("CodeAct scaffold validation rejects async blocking activity functions", async () => {
	const targetDir = await mkdtemp(join(tmpdir(), "pi-temporal-scaffold-"));
	try {
		const spec = createTemporalScaffoldSpec();
		const badSpec = {
			...spec,
			files: spec.files.map((file) =>
				file.path === "src/activities.py"
					? {
							...file,
							contents: file.contents
								.replace(
									"def discover_case_study_urls(",
									"async def discover_case_study_urls(",
								)
								.replace(
									"def fetch_and_extract_case_study(",
									"async def fetch_and_extract_case_study(",
								),
						}
					: file,
			),
		};
		await writeTemporalScaffold(targetDir, badSpec);

		await assert.rejects(
			() => validateTemporalScaffold(targetDir),
			/synchronous def functions/,
		);
	} finally {
		await rm(targetDir, { recursive: true, force: true });
	}
});

test("CodeAct scaffold validation rejects hardcoded generated task queues", async () => {
	const targetDir = await mkdtemp(join(tmpdir(), "pi-temporal-scaffold-"));
	try {
		const spec = createTemporalScaffoldSpec();
		const badSpec = {
			...spec,
			files: spec.files.map((file) =>
				file.path === "src/worker.py" || file.path === "src/client.py"
					? {
							...file,
							contents: file.contents.replace(
								'TASK_QUEUE = required_env("TEMPORAL_TASK_QUEUE")',
								'TASK_QUEUE = "pi-gtm-demo-codeact"',
							),
						}
					: file,
			),
		};
		await writeTemporalScaffold(targetDir, badSpec);

		await assert.rejects(
			() => validateTemporalScaffold(targetDir),
			/TEMPORAL_TASK_QUEUE/,
		);
	} finally {
		await rm(targetDir, { recursive: true, force: true });
	}
});

test("CodeAct scaffold validation rejects workflow-level activity task queues", async () => {
	const targetDir = await mkdtemp(join(tmpdir(), "pi-temporal-scaffold-"));
	try {
		const spec = createTemporalScaffoldSpec();
		const badSpec = {
			...spec,
			files: spec.files.map((file) =>
				file.path === "src/workflows.py"
					? {
							...file,
							contents: file.contents.replace(
								"retry_policy=retry_policy,\n        )",
								'retry_policy=retry_policy,\n            task_queue="pi-gtm-demo-codeact",\n        )',
							),
						}
					: file,
			),
		};
		await writeTemporalScaffold(targetDir, badSpec);

		await assert.rejects(
			() => validateTemporalScaffold(targetDir),
			/runtime TEMPORAL_TASK_QUEUE|pi-gtm-demo-codeact/,
		);
	} finally {
		await rm(targetDir, { recursive: true, force: true });
	}
});

test("CodeAct scaffold validation rejects export-only dataclass field access", async () => {
	const targetDir = await mkdtemp(join(tmpdir(), "pi-temporal-scaffold-"));
	try {
		const spec = createTemporalScaffoldSpec();
		const badSpec = {
			...spec,
			files: spec.files.map((file) =>
				file.path === "src/activities.py"
					? {
							...file,
							contents: file.contents
								.replace(
									"    normalized_records = [coerce_case_study_record(record) for record in records]\n",
									"",
								)
								.replace(
									"        for record in normalized_records",
									"        for record in records",
								)
								.replace(
									"def coerce_case_study_record(record: object) -> CaseStudyRecord:",
									"def ignored_case_study_record(record: object) -> CaseStudyRecord:",
								)
								.replace("if isinstance(record, dict):", "if False:"),
						}
					: file,
			),
		};
		await writeTemporalScaffold(targetDir, badSpec);

		await assert.rejects(
			() => validateTemporalScaffold(targetDir),
			/dict-shaped CaseStudyRecord payloads/,
		);
	} finally {
		await rm(targetDir, { recursive: true, force: true });
	}
});

test("CodeAct scaffold validation requires non-fatal workflow queries", async () => {
	const targetDir = await mkdtemp(join(tmpdir(), "pi-temporal-scaffold-"));
	try {
		const spec = createTemporalScaffoldSpec();
		const badSpec = {
			...spec,
			files: spec.files.map((file) =>
				file.path === "src/client.py"
					? {
							...file,
							contents: file.contents.replace(
								[
									"    try:",
									"        state = await handle.query(TemporalCaseStudyResearchWorkflow.current_state)",
									"    except Exception as err:",
									'        emit("workflow_query_failed", workflow_id=workflow_id, error=type(err).__name__)',
									"    else:",
									'        emit("workflow_started", workflow_id=workflow_id, state=state)',
								].join("\n"),
								[
									"    state = await handle.query(TemporalCaseStudyResearchWorkflow.current_state)",
									'    emit("workflow_started", workflow_id=workflow_id, state=state)',
								].join("\n"),
							),
						}
					: file,
			),
		};
		await writeTemporalScaffold(targetDir, badSpec);

		await assert.rejects(
			() => validateTemporalScaffold(targetDir),
			/workflow_query_failed/,
		);
	} finally {
		await rm(targetDir, { recursive: true, force: true });
	}
});

test("CodeAct scaffold validation rejects unsupported workflow info timeout", async () => {
	const targetDir = await mkdtemp(join(tmpdir(), "pi-temporal-scaffold-"));
	try {
		const spec = createTemporalScaffoldSpec();
		const badSpec = {
			...spec,
			files: spec.files.map((file) =>
				file.path === "src/workflows.py"
					? {
							...file,
							contents: file.contents.replace(
								"start_to_close_timeout=timedelta(minutes=2),",
								"start_to_close_timeout=workflow.info().workflow_execution_timeout,",
							),
						}
					: file,
			),
		};
		await writeTemporalScaffold(targetDir, badSpec);

		await assert.rejects(
			() => validateTemporalScaffold(targetDir),
			/workflow_execution_timeout/,
		);
	} finally {
		await rm(targetDir, { recursive: true, force: true });
	}
});

test("CodeAct scaffold validation rejects activity imports inside workflow methods", async () => {
	const targetDir = await mkdtemp(join(tmpdir(), "pi-temporal-scaffold-"));
	try {
		const spec = createTemporalScaffoldSpec();
		const activityImport =
			"from activities import discover_case_study_urls, fetch_and_extract_case_study, export_marketing_html";
		const badSpec = {
			...spec,
			files: spec.files.map((file) =>
				file.path === "src/workflows.py"
					? {
							...file,
							contents: file.contents
								.replace(`    ${activityImport}\n`, "")
								.replace(
									"        self._state.target_count = target_count",
									`        ${activityImport}\n\n        self._state.target_count = target_count`,
								),
						}
					: file,
			),
		};
		await writeTemporalScaffold(targetDir, badSpec);

		await assert.rejects(
			() => validateTemporalScaffold(targetDir),
			/Temporal workflow sandbox|top-level with workflow\.unsafe\.imports_passed_through/,
		);
	} finally {
		await rm(targetDir, { recursive: true, force: true });
	}
});

test("CodeAct scaffold validation rejects broad case-study URL matching", async () => {
	const targetDir = await mkdtemp(join(tmpdir(), "pi-temporal-scaffold-"));
	try {
		const spec = createTemporalScaffoldSpec();
		const badSpec = {
			...spec,
			files: spec.files.map((file) =>
				file.path === "src/activities.py"
					? {
							...file,
							contents: file.contents
								.replace("[a-z0-9\\-/]+", '[^\\s"<>]+')
								.replace("urllib.error.HTTPError as err", "Exception as err")
								.replace("err.code == 404", "False"),
						}
					: file,
			),
		};
		await writeTemporalScaffold(targetDir, badSpec);

		await assert.rejects(
			() => validateTemporalScaffold(targetDir),
			/\[a-z0-9\\-\/\]\+|bounded Temporal case-study URL regex|HTTPError 404/,
		);
	} finally {
		await rm(targetDir, { recursive: true, force: true });
	}
});

test("CodeAct bash scaffold parser accepts common Pi heredoc variants", () => {
	const spec = createTemporalScaffoldSpec();
	const blocks = spec.files.map((file, index) => {
		const marker = `PI_TEST_${index}`;
		const contents = file.contents.trimEnd();
		if (index % 3 === 0)
			return `cat <<${marker} > ${file.path}\n${contents}\n${marker}`;
		if (index % 3 === 1)
			return `cat > ${file.path} <<${marker}\n${contents}\n${marker}`;
		return `tee ${file.path} >/dev/null <<'${marker}'\n${contents}\n${marker}`;
	});
	const markdown = blocks
		.map((block) => `\`\`\`bash\n${block}\n\`\`\``)
		.join("\n\n");
	const parsed = parseTemporalScaffoldSpecFromBash(markdown);

	assert.equal(parsed.files.length, spec.files.length);
	assert.ok(
		parsed.files
			.find((file) => file.path === "requirements.txt")
			?.contents.includes("temporalio"),
	);
	assert.ok(
		parsed.files
			.find((file) => file.path === "src/workflows.py")
			?.contents.includes("@workflow.signal"),
	);
});

test("CodeAct bash scaffold parser accepts CRLF scripts", () => {
	const rendered = renderTemporalScaffoldBashScript(
		createTemporalScaffoldSpec(),
	).replace(/\n/g, "\r\n");
	const parsed = parseTemporalScaffoldSpecFromBash(rendered);

	assert.ok(
		parsed.files
			.find((file) => file.path === "README.md")
			?.contents.includes("CodeAct"),
	);
});

test("CodeAct bash scaffold parser rejects incomplete generated action scripts", () => {
	const incomplete = [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		"mkdir -p src",
		"cat > 'src/workflows.py' <<'PI_TEMPORAL_WORKFLOWS_PY'",
		"from temporalio import workflow",
		"PI_TEMPORAL_WORKFLOWS_PY",
	].join("\n");

	assert.throws(
		() => parseTemporalScaffoldSpecFromBash(incomplete),
		/missing requirements\.txt/,
	);
});

test("CodeAct bash scaffold parser rejects unterminated heredocs", () => {
	const incomplete = [
		"#!/usr/bin/env bash",
		"cat > requirements.txt <<REQS",
		"temporalio>=1.8.0",
	].join("\n");

	assert.throws(
		() => parseTemporalScaffoldSpecFromBash(incomplete),
		/unterminated heredoc/,
	);
});
