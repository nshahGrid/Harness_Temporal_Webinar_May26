import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, Connection } from "@temporalio/client";
import { packageRoot } from "./paths.ts";

loadDotEnv();

export interface TemporalEnv {
	address: string;
	namespace: string;
	apiKey?: string;
	taskQueue: string;
}

export function getTemporalEnv(): TemporalEnv {
	const address = process.env.TEMPORAL_ADDRESS;
	const namespace = process.env.TEMPORAL_NAMESPACE;
	const apiKey = process.env.TEMPORAL_API_KEY;
	const configuredAddress = isConfiguredEnvValue(address) ? address : undefined;
	const configuredNamespace = isConfiguredEnvValue(namespace)
		? namespace
		: undefined;
	const missing: string[] = [];
	if (!configuredAddress) missing.push("TEMPORAL_ADDRESS");
	if (!configuredNamespace) missing.push("TEMPORAL_NAMESPACE");
	if (apiKey !== undefined && !isConfiguredEnvValue(apiKey)) {
		missing.push("TEMPORAL_API_KEY");
	}
	if (address?.includes(".tmprl.cloud") && !isConfiguredEnvValue(apiKey)) {
		missing.push("TEMPORAL_API_KEY");
	}
	if (!configuredAddress || !configuredNamespace || missing.length > 0) {
		const keys = unique(missing).join(", ");
		throw new Error(
			`${keys} must be set to real values. Copy .env.example to .env and replace placeholder Temporal values first.`,
		);
	}
	return {
		address: configuredAddress,
		namespace: configuredNamespace,
		apiKey,
		taskQueue: process.env.TEMPORAL_TASK_QUEUE || "pi-gtm-demo",
	};
}

export function hasTemporalEnv(): boolean {
	return Boolean(
		isConfiguredEnvValue(process.env.TEMPORAL_ADDRESS) &&
			isConfiguredEnvValue(process.env.TEMPORAL_NAMESPACE) &&
			(process.env.TEMPORAL_API_KEY === undefined ||
				isConfiguredEnvValue(process.env.TEMPORAL_API_KEY)),
	);
}

export function isConfiguredEnvValue(
	value: string | undefined,
): value is string {
	const trimmed = value?.trim();
	if (!trimmed) return false;
	return !["replace-me", "your-namespace", "your-account", "your-address"].some(
		(placeholder) => trimmed.toLowerCase().includes(placeholder),
	);
}

export async function createTemporalClient(): Promise<{
	client: Client;
	taskQueue: string;
}> {
	const env = getTemporalEnv();
	const connection = await Connection.connect({
		address: env.address,
		apiKey: env.apiKey,
		tls: env.apiKey ? true : undefined,
	});
	return {
		client: new Client({ connection, namespace: env.namespace }),
		taskQueue: env.taskQueue,
	};
}

function loadDotEnv(): void {
	const envPath = join(packageRoot, ".env");
	if (!existsSync(envPath)) return;
	const contents = readFileSync(envPath, "utf8");
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (!match) continue;
		const [, key, rawValue] = match;
		if (process.env[key] !== undefined) continue;
		process.env[key] = stripQuotes(rawValue.trim());
	}
}

function stripQuotes(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}
