import { isConfiguredEnvValue } from "../env.ts";

const temporalKeys = [
	"TEMPORAL_ADDRESS",
	"TEMPORAL_NAMESPACE",
	"TEMPORAL_API_KEY",
	"TEMPORAL_TASK_QUEUE",
];
const piKeys = ["ANTHROPIC_API_KEY", "PI_COMMAND"];
const temporalCloudRequired = [
	"TEMPORAL_ADDRESS",
	"TEMPORAL_NAMESPACE",
	"TEMPORAL_API_KEY",
];
const piRequired = ["ANTHROPIC_API_KEY"];

console.log("Temporal case-study demo environment\n");
printGroup("Temporal Cloud", temporalKeys);
printGroup("Pi generation", piKeys);

const incompleteTemporal = temporalCloudRequired.filter(
	(key) => envStatus(key) !== "set",
);
const incompletePi = piRequired.filter((key) => envStatus(key) !== "set");
if (incompleteTemporal.length > 0 || incompletePi.length > 0) {
	console.log("\nFull cloud demo mode needs real values for:");
	for (const key of [...incompleteTemporal, ...incompletePi]) {
		console.log(`- ${key} (${envStatus(key)})`);
	}
	console.log(
		"\nCreate .env from .env.example, fill in Temporal values, then run npm run cloud.",
	);
	console.log(
		"For harness-only mode without Temporal Cloud, set CODEACT_TEMPORAL_CLOUD=0 and run npm run check-pi.",
	);
	process.exitCode = 1;
} else {
	console.log("\nReady for npm run cloud.");
}

function printGroup(title: string, keys: string[]): void {
	console.log(`${title}:`);
	for (const key of keys) {
		console.log(`  ${key}: ${envStatus(key)}`);
	}
}

function envStatus(key: string): "set" | "placeholder" | "missing" {
	const value = process.env[key];
	if (!value) return "missing";
	return isConfiguredEnvValue(value) ? "set" : "placeholder";
}
