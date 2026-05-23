import assert from "node:assert/strict";
import { test } from "node:test";
import { redactedError, redactSecrets } from "../src/redact.ts";

test("redacts configured Temporal and Anthropic values", () => {
	const previous = snapshotEnv([
		"TEMPORAL_API_KEY",
		"TEMPORAL_ADDRESS",
		"ANTHROPIC_API_KEY",
	]);
	process.env.TEMPORAL_API_KEY = "super-secret-temporal-key";
	process.env.TEMPORAL_ADDRESS = "demo.example.tmprl.cloud:7233";
	process.env.ANTHROPIC_API_KEY = "sk-ant-demo-secret";
	try {
		const output = redactSecrets(
			"Temporal failed for TEMPORAL_API_KEY=super-secret-temporal-key at demo.example.tmprl.cloud:7233 with sk-ant-demo-secret",
		);
		assert.doesNotMatch(output, /super-secret-temporal-key/);
		assert.doesNotMatch(output, /demo\.example\.tmprl\.cloud/);
		assert.doesNotMatch(output, /sk-ant-demo-secret/);
		assert.match(output, /\[redacted\]/);
	} finally {
		restoreEnv(previous);
	}
});

test("redacts non-key demo env values such as namespace, task queue, and Pi command", () => {
	const previous = snapshotEnv([
		"TEMPORAL_NAMESPACE",
		"TEMPORAL_TASK_QUEUE",
		"PI_COMMAND",
	]);
	process.env.TEMPORAL_NAMESPACE = "demo.namespace";
	process.env.TEMPORAL_TASK_QUEUE = "demo-task-queue";
	process.env.PI_COMMAND = "pi --provider anthropic --model demo";
	try {
		const output = redactSecrets(
			'{"namespace":"demo.namespace","queue":"demo-task-queue","command":"pi --provider anthropic --model demo"}',
		);
		assert.doesNotMatch(output, /demo\.namespace/);
		assert.doesNotMatch(output, /demo-task-queue/);
		assert.doesNotMatch(output, /pi --provider anthropic --model demo/);
		assert.match(output, /\[redacted\]/);
	} finally {
		restoreEnv(previous);
	}
});

test("redacts error messages and stack text", () => {
	const previous = snapshotEnv(["TEMPORAL_API_KEY"]);
	process.env.TEMPORAL_API_KEY = "secret-in-stack";
	try {
		const error = new Error("request failed with secret-in-stack");
		const output = redactedError(error);
		assert.doesNotMatch(output, /secret-in-stack/);
		assert.match(output, /Error: request failed with \[redacted\]/);
	} finally {
		restoreEnv(previous);
	}
});

test("redacts structured secret fields without redacting author fields", () => {
	const output = redactSecrets({
		apiKey: "literal-secret-value",
		author: "Case Study Team",
	});
	assert.doesNotMatch(output, /literal-secret-value/);
	assert.match(output, /"apiKey": "\[redacted\]"/);
	assert.match(output, /"author": "Case Study Team"/);
});

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
	return new Map(keys.map((key) => [key, process.env[key]]));
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
