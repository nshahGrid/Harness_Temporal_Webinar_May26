import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createTemporalScaffoldSpec,
	parseTemporalScaffoldSpecFromBash,
	renderTemporalScaffoldBashScript,
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
