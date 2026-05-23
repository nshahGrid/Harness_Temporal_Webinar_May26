import { spawn } from "node:child_process";
import { getTemporalEnv } from "../env.ts";
import { redactedErrorMessage, redactSecrets } from "../redact.ts";

try {
	getTemporalEnv();
} catch (error) {
	console.error(redactedErrorMessage(error));
	console.error(
		"\nCopy .env.example to .env, fill in Temporal values, then run npm run cloud again.",
	);
	process.exit(1);
}

const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [
	start("worker", ["run", "worker"]),
	start("web", ["run", "web"]),
];

process.on("SIGINT", () => {
	for (const child of children) child.kill("SIGINT");
});

process.on("SIGTERM", () => {
	for (const child of children) child.kill("SIGTERM");
});

function start(label: string, args: string[]) {
	const child = spawn(npmBin, args, {
		cwd: process.cwd(),
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk) => write(label, chunk));
	child.stderr.on("data", (chunk) => write(label, chunk));
	child.on("exit", (code, signal) => {
		if (signal) {
			console.log(`[${label}] stopped by ${signal}`);
			return;
		}
		console.log(`[${label}] exited with code ${code}`);
		if (code && code !== 0) process.exitCode = code;
	});
	return child;
}

function write(label: string, chunk: Buffer): void {
	for (const line of chunk.toString().split(/\r?\n/)) {
		if (line) console.log(`[${label}] ${redactSecrets(line)}`);
	}
}
