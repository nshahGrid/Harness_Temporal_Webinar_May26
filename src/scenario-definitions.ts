import type { ScenarioDefinition } from "./types.ts";

export const scenarioDefinitions: ScenarioDefinition[] = [
	{
		id: "temporal-case-study-marketing-page",
		title: "Temporal Customer Proof Marketing Page",
		shortDescription:
			"Search Temporal's live customer-story pages, extract proof points, and compare LLM-selected ReAct output with CodeAct-generated Temporal code.",
		skillName: "temporal-case-study-marketing-page",
		artifactName: "temporal-case-study-marketing-page.html",
		temporalStory: [
			"Treat live customer-proof research as a durable workflow: discover links, fetch pages, extract records, pause on partial coverage, approve, and export.",
			"Retry flaky page-fetch or extraction activities without losing already extracted case-study records.",
			"Use Queries to inspect current research state and Signals for policy inspection, agent handoff, reviewer pause, and human approval.",
			"Use the CodeAct bash path to generate Python Temporal scaffold code with workflow, activities, retry policy, signals, queries, and bounded parallel execution.",
		],
	},
];

export function getScenarioDefinition(id: string): ScenarioDefinition {
	const scenario = scenarioDefinitions.find(
		(definition) => definition.id === id,
	);
	if (!scenario) {
		throw new Error(
			`Unknown scenario "${id}". Expected one of: ${scenarioDefinitions.map((s) => s.id).join(", ")}`,
		);
	}
	return scenario;
}
