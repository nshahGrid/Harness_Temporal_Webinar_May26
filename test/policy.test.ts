import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentHandshake, buildPolicyInspection } from "../src/policy.ts";
import type { DemoWorkflowState } from "../src/types.ts";

test("policy inspection moves from pending to passed after agent output exists", () => {
	const baseState: DemoWorkflowState = {
		runId: "policy-test",
		scenarioId: "temporal-case-study-marketing-page",
		title: "Temporal Customer Proof Marketing Page",
		phase: "waiting_for_pi",
		timeline: [],
		promptPack: {
			scenarioId: "temporal-case-study-marketing-page",
			title: "Temporal Customer Proof Marketing Page",
			summary: "summary",
			prompt: "draft safely",
			temporalStory: [],
			fixturePaths: [],
			preparedData: {},
		},
	};

	const pending = buildPolicyInspection(
		baseState,
		{},
		"2026-05-22T00:00:00.000Z",
	);
	assert.equal(pending.status, "pending");

	const passedState: DemoWorkflowState = {
		...baseState,
		phase: "waiting_for_approval",
		piOutput: {
			source: "fixture",
			generatedAt: "2026-05-22T00:00:00.000Z",
			markdown: "Draft only. Nothing was sent.",
		},
	};
	const passed = buildPolicyInspection(
		passedState,
		{},
		"2026-05-22T00:00:01.000Z",
	);
	assert.equal(passed.status, "passed");
	assert.match(passed.recommendation, /human review/i);

	const handshake = buildAgentHandshake(
		{ ...passedState, policyInspections: [passed] },
		{ fromAgent: "case-study-research-agent", toAgent: "policy-review-agent" },
		"2026-05-22T00:00:02.000Z",
	);
	assert.equal(handshake.status, "ready_for_review");
	assert.equal(handshake.policyStatus, "passed");
});
