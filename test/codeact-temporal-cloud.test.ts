import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runGeneratedTemporalCloudScaffold } from "../src/harness/codeact-temporal-cloud.ts";

test("CodeAct Cloud runner launches generated Python entrypoints as modules", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-temporal-cloud-runner-"));
	const previous = new Map<string, string | undefined>(
		[
			"PYTHON",
			"TEMPORAL_ADDRESS",
			"TEMPORAL_NAMESPACE",
			"TEMPORAL_API_KEY",
			"TEMPORAL_TASK_QUEUE",
			"TEMPORAL_CODEACT_TASK_QUEUE",
			"CODEACT_TEMPORAL_SHARED_TASK_QUEUE",
			"FAKE_PYTHON_LOG",
		].map((key) => [key, process.env[key]]),
	);
	try {
		const fakePythonPath = join(tempDir, "fake-python");
		const logPath = join(tempDir, "python-args.log");
		await writeFile(fakePythonPath, fakePythonSource(), "utf8");
		await chmod(fakePythonPath, 0o755);

		process.env.PYTHON = fakePythonPath;
		process.env.TEMPORAL_ADDRESS = "localhost:7233";
		process.env.TEMPORAL_NAMESPACE = "default";
		delete process.env.TEMPORAL_API_KEY;
		process.env.TEMPORAL_TASK_QUEUE = "demo-task-queue";
		delete process.env.TEMPORAL_CODEACT_TASK_QUEUE;
		delete process.env.CODEACT_TEMPORAL_SHARED_TASK_QUEUE;
		process.env.FAKE_PYTHON_LOG = logPath;

		const result = await runGeneratedTemporalCloudScaffold({
			scaffoldDir: tempDir,
			runId: "module-import-test",
			targetCount: 1,
			pageBudget: 1,
			concurrency: 1,
			timeoutMs: 10_000,
		});

		assert.equal(result.cloudRun.status, "completed");
		assert.equal(result.research?.records.length, 1);

		const invocations = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]);
		assert.ok(invocations.some((args) => args.join(" ") === "-m src.worker"));
		assert.ok(invocations.some((args) => args.join(" ") === "-m src.client"));
		assert.ok(!invocations.some((args) => args.includes("src/worker.py")));
		assert.ok(!invocations.some((args) => args.includes("src/client.py")));
	} finally {
		restoreEnv(previous);
		await rm(tempDir, { recursive: true, force: true });
	}
});

function fakePythonSource(): string {
	return `#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);
if (process.env.FAKE_PYTHON_LOG) {
  fs.appendFileSync(process.env.FAKE_PYTHON_LOG, JSON.stringify(args) + "\\n");
}

if (args[0] === "-c") {
  process.exit(0);
}

if (args[0] === "-m" && args[1] === "src.worker") {
  console.log("fake generated worker started");
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => undefined, 1000);
  return;
}

if (args[0] === "-m" && args[1] === "src.client") {
  const url = "https://temporal.io/resources/case-studies/test-customer";
  console.log(
    "CODEACT_TEMPORAL_EVENT " + JSON.stringify({
      event: "workflow_completed",
      workflow_id: process.env.CODEACT_WORKFLOW_ID,
      state: {
        target_count: 1,
        status: "completed",
        discovered_urls: [url],
        attempted_urls: [url],
        records: [{
          url,
          company: "Test Customer",
          headline: "Test Customer uses Temporal",
          summary: "Test summary",
          evidence_quote: "Test quote",
          temporal_value: "Test value"
        }],
        failed_pages: [],
        reviewer_notes: [],
        approved: true
      },
      records: 1,
      failures: 0,
      attempted: 1
    })
  );
  process.exit(0);
}

process.exit(1);
`;
}

function restoreEnv(values: Map<string, string | undefined>): void {
	for (const [key, value] of values) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}
