import { type ScenarioId, scenarioIds } from "../types.ts";

export function readArg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

export function hasFlag(name: string): boolean {
	return process.argv.includes(name);
}

export function readScenario(): ScenarioId {
	const scenario =
		readArg("--scenario") || "temporal-case-study-marketing-page";
	if (!scenarioIds.includes(scenario as ScenarioId)) {
		throw new Error(
			`Unknown --scenario "${scenario}". Expected one of: ${scenarioIds.join(", ")}`,
		);
	}
	return scenario as ScenarioId;
}
