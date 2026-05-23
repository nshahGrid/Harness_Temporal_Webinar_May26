import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { packageRoot } from "./paths.ts";
import { redactedErrorMessage, redactSecrets } from "./redact.ts";
import { getScenarioDefinition } from "./scenario-definitions.ts";
import type { PiOutput, PromptPack } from "./types.ts";

export type PiStreamEvent =
	| { type: "pi_event"; eventType: string }
	| { type: "assistant_delta"; delta: string }
	| { type: "assistant_final"; markdown: string }
	| { type: "tool_start"; toolName: string; args: unknown }
	| { type: "tool_update"; toolName: string; partialResult: unknown }
	| { type: "tool_end"; toolName: string; result: unknown; isError: boolean }
	| { type: "stderr"; text: string }
	| { type: "stdout"; text: string };

export interface PiRuntimeStatus {
	ok: boolean;
	source: "configured" | "local-source-fallback" | "missing";
	commandLabel: string;
	message: string;
	checkedGeneration?: boolean;
	provider?: string;
	model?: string;
}

export interface PiTextGenerationRequest {
	prompt: string;
	skillName?: string;
	timeoutMs?: number;
	tools?: string[];
}

export interface PiToolSummary {
	toolName: string;
	args?: unknown;
	isError?: boolean;
	resultPreview?: string;
}

export interface PiTextGenerationResult {
	markdown: string;
	toolCalls: PiToolSummary[];
}

interface ResolvedPiCommand extends PiRuntimeStatus {
	binary: string;
	args: string[];
}

export async function checkPiRuntime(
	options: { smoke?: boolean } = {},
): Promise<PiRuntimeStatus> {
	const resolved = resolvePiCommand();
	if (!resolved.ok) return resolved;
	const { code, stderr } = await execCapture(resolved.binary, [
		...resolved.args,
		"--help",
	]);
	if (code === 0) {
		const status: PiRuntimeStatus = {
			ok: true,
			source: resolved.source,
			commandLabel: resolved.commandLabel,
			message: `${resolved.message} Pi CLI responded to --help.${authPrecedenceWarning()}`,
		};
		if (!options.smoke) return status;
		return smokeCheckPiGeneration(resolved, status);
	}
	return {
		ok: false,
		source: resolved.source,
		commandLabel: resolved.commandLabel,
		message: redactSecrets(`Pi CLI exited with code ${code}. ${stderr}`),
	};
}

async function smokeCheckPiGeneration(
	resolved: ResolvedPiCommand,
	status: PiRuntimeStatus,
): Promise<PiRuntimeStatus> {
	const { stdout, stderr, code, timedOut } = await execCapture(
		resolved.binary,
		[
			...resolved.args,
			"--mode",
			"json",
			"--no-session",
			"--no-tools",
			"-p",
			"Reply exactly OK.",
		],
		undefined,
		undefined,
		90_000,
	);
	if (code === 0) {
		const assistantError = extractPiAssistantError(stdout);
		if (assistantError) {
			return {
				...status,
				ok: false,
				checkedGeneration: true,
				message: buildPiGenerationFailureMessage(
					code,
					timedOut,
					assistantError,
				),
			};
		}
		const summary = extractPiSmokeSummary(stdout);
		const target =
			summary.provider && summary.model
				? ` using ${summary.provider}/${summary.model}`
				: "";
		return {
			...status,
			checkedGeneration: true,
			provider: summary.provider,
			model: summary.model,
			message: `${status.message} Real LLM generation succeeded${target}.`,
		};
	}
	return {
		...status,
		ok: false,
		checkedGeneration: true,
		message: buildPiGenerationFailureMessage(code, timedOut, stderr || stdout),
	};
}

export async function generateWithPi(pack: PromptPack): Promise<PiOutput> {
	const invocation = buildPiInvocation(pack);
	const { stdout, stderr, code } = await execCapture(
		invocation.binary,
		invocation.args,
	);
	if (code !== 0) {
		throw new Error(
			redactSecrets(`Pi command failed with exit ${code}\n${stderr || stdout}`),
		);
	}
	const assistantError = extractPiAssistantError(stdout);
	if (assistantError) {
		throw new Error(
			buildPiGenerationFailureMessage(code, false, assistantError),
		);
	}
	return {
		source: "pi",
		generatedAt: new Date().toISOString(),
		markdown: extractAssistantMarkdown(stdout),
	};
}

export async function generateTextWithPi(
	request: PiTextGenerationRequest,
): Promise<string> {
	return (await generateTextWithPiDetailed(request)).markdown;
}

export async function generateTextWithPiDetailed(
	request: PiTextGenerationRequest,
): Promise<PiTextGenerationResult> {
	const invocation = buildPiTextInvocation(request);
	const { stdout, stderr, code, timedOut } = await execCapture(
		invocation.binary,
		invocation.args,
		undefined,
		undefined,
		request.timeoutMs,
	);
	if (code !== 0) {
		throw new Error(
			redactSecrets(`Pi command failed with exit ${code}\n${stderr || stdout}`),
		);
	}
	const assistantError = extractPiAssistantError(stdout);
	if (assistantError) {
		throw new Error(
			buildPiGenerationFailureMessage(code, timedOut, assistantError),
		);
	}
	return {
		markdown: extractAssistantMarkdown(stdout),
		toolCalls: extractPiToolSummaries(stdout),
	};
}

export async function streamGenerateWithPi(
	pack: PromptPack,
	onEvent: (event: PiStreamEvent) => void,
): Promise<PiOutput> {
	const invocation = buildPiInvocation(pack);
	let finalMarkdownSeen = false;
	const emit = (event: PiStreamEvent) => {
		if (event.type === "assistant_final") finalMarkdownSeen = true;
		onEvent(event);
	};
	const { stdout, stderr, code } = await execCapture(
		invocation.binary,
		invocation.args,
		(line) => handlePiStdoutLine(line, emit),
		(text) => emit({ type: "stderr", text: redactSecrets(text) }),
	);
	if (code !== 0) {
		throw new Error(
			redactSecrets(`Pi command failed with exit ${code}\n${stderr || stdout}`),
		);
	}
	const assistantError = extractPiAssistantError(stdout);
	if (assistantError) {
		throw new Error(
			buildPiGenerationFailureMessage(code, false, assistantError),
		);
	}
	const markdown = extractAssistantMarkdown(stdout);
	if (!finalMarkdownSeen)
		emit({ type: "assistant_final", markdown: redactSecrets(markdown) });
	return {
		source: "pi",
		generatedAt: new Date().toISOString(),
		markdown,
	};
}

function buildPiInvocation(pack: PromptPack): {
	binary: string;
	args: string[];
} {
	const scenario = getScenarioDefinition(pack.scenarioId);
	const skillPath = join(packageRoot, "skills", scenario.skillName, "SKILL.md");
	const resolved = resolvePiCommand();
	if (!resolved.ok) throw new Error(resolved.message);
	return {
		binary: resolved.binary,
		args: [
			...resolved.args,
			"--mode",
			"json",
			"--no-session",
			"--tools",
			"free_web_search,free_fetch_content",
			"--skill",
			skillPath,
			`Use the ${scenario.skillName} skill to produce the final draft for this Temporal demo.\n\n${pack.prompt}`,
		],
	};
}

function buildPiTextInvocation(request: PiTextGenerationRequest): {
	binary: string;
	args: string[];
} {
	const resolved = resolvePiCommand();
	if (!resolved.ok) throw new Error(resolved.message);
	const skillArgs = request.skillName
		? ["--skill", join(packageRoot, "skills", request.skillName, "SKILL.md")]
		: [];
	return {
		binary: resolved.binary,
		args: [
			...resolved.args,
			"--mode",
			"json",
			"--no-session",
			...(request.tools?.length
				? ["--tools", request.tools.join(",")]
				: ["--no-tools"]),
			...skillArgs,
			"-p",
			request.prompt,
		],
	};
}

function resolvePiCommand(): ResolvedPiCommand {
	const command = process.env.PI_COMMAND || "pi";
	const [binary, ...prefixArgs] = splitCommand(command);
	if (isRunnableCommand(binary)) {
		return {
			ok: true,
			source: "configured",
			commandLabel: "Configured PI_COMMAND",
			message: "Configured Pi command is available.",
			binary,
			args: prefixArgs,
		};
	}

	if (binary === "pi") {
		const fallback = localSourcePiCommand(prefixArgs);
		if (fallback) return fallback;
	}

	return {
		ok: false,
		source: "missing",
		commandLabel: "Pi command unavailable",
		message:
			"Configured PI_COMMAND binary is not available. Install the pi CLI, put it on PATH, or use the repo-local source CLI.",
		binary,
		args: prefixArgs,
	};
}

function localSourcePiCommand(
	prefixArgs: string[],
): ResolvedPiCommand | undefined {
	const codingAgentRoot = join(packageRoot, "..", "..");
	const repoRoot = join(codingAgentRoot, "..", "..");
	const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
	const piCli = join(codingAgentRoot, "src", "cli.ts");
	if (!existsSync(tsxCli) || !existsSync(piCli)) return undefined;
	return {
		ok: true,
		source: "local-source-fallback",
		commandLabel: "Repo-local Pi source CLI",
		message:
			"`pi` is not on PATH, so the demo is using the repo-local Pi source CLI.",
		binary: process.execPath,
		args: [tsxCli, piCli, ...prefixArgs],
	};
}

function isRunnableCommand(command: string): boolean {
	if (command.includes("/") || isAbsolute(command))
		return isExecutablePath(command);
	for (const dir of (process.env.PATH || "").split(delimiter)) {
		if (!dir) continue;
		if (isExecutablePath(join(dir, command))) return true;
	}
	return false;
}

function isExecutablePath(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function splitCommand(command: string): string[] {
	return (
		command
			.match(/(?:[^\s"]+|"[^"]*")+/g)
			?.map((part) => part.replace(/^"|"$/g, "")) ?? [command]
	);
}

function execCapture(
	command: string,
	args: string[],
	onStdoutLine?: (line: string) => void,
	onStderrChunk?: (text: string) => void,
	timeoutMs?: number,
): Promise<{
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
}> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: packageRoot,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let stdoutBuffer = "";
		let timedOut = false;
		const timer = timeoutMs
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGTERM");
				}, timeoutMs)
			: undefined;
		child.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			stdout += text;
			if (!onStdoutLine) return;
			stdoutBuffer += text;
			const lines = stdoutBuffer.split(/\r?\n/);
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line.trim()) onStdoutLine(line);
			}
		});
		child.stderr.on("data", (chunk) => {
			const text = chunk.toString();
			stderr += text;
			onStderrChunk?.(text);
		});
		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			reject(new Error(redactedErrorMessage(error)));
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			if (onStdoutLine && stdoutBuffer.trim()) onStdoutLine(stdoutBuffer);
			resolve({ stdout, stderr, code, timedOut });
		});
	});
}

function handlePiStdoutLine(
	line: string,
	onEvent: (event: PiStreamEvent) => void,
): void {
	try {
		const event = JSON.parse(line) as {
			type?: string;
			assistantMessageEvent?: { type?: string; delta?: string };
			message?: { role?: string; content?: Array<PiMessageContentBlock> };
			messages?: Array<PiMessage>;
			toolCallId?: string;
			toolName?: string;
			args?: unknown;
			partialResult?: unknown;
			result?: unknown;
			isError?: boolean;
		};
		if (event.type) onEvent({ type: "pi_event", eventType: event.type });
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent?.type === "text_delta"
		) {
			onEvent({
				type: "assistant_delta",
				delta: redactSecrets(event.assistantMessageEvent.delta ?? ""),
			});
			return;
		}
		if (event.type === "tool_execution_start") {
			onEvent({
				type: "tool_start",
				toolName: event.toolName ?? "tool",
				args: redactStructured(event.args),
			});
			return;
		}
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent?.type === "toolcall_start"
		) {
			const toolCall = latestToolCall(event.message?.content);
			onEvent({
				type: "tool_start",
				toolName: toolCall?.name ?? event.toolName ?? "tool",
				args: redactStructured(toolCall?.arguments ?? {}),
			});
			return;
		}
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent?.type === "toolcall_delta"
		) {
			const toolCall = latestToolCall(event.message?.content);
			onEvent({
				type: "tool_update",
				toolName: toolCall?.name ?? event.toolName ?? "tool",
				partialResult: redactStructured(
					toolCall?.arguments ?? toolCall?.partialJson ?? {},
				),
			});
			return;
		}
		if (event.type === "tool_execution_update") {
			onEvent({
				type: "tool_update",
				toolName: event.toolName ?? "tool",
				partialResult: redactStructured(event.partialResult),
			});
			return;
		}
		if (event.type === "tool_execution_end") {
			onEvent({
				type: "tool_end",
				toolName: event.toolName ?? "tool",
				result: redactStructured(event.result),
				isError: Boolean(event.isError),
			});
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const markdown = textFromContent(event.message.content);
			if (markdown)
				onEvent({ type: "assistant_final", markdown: redactSecrets(markdown) });
			return;
		}
		if (event.type === "agent_end" && event.messages) {
			for (const toolResult of event.messages.filter(
				(message) => message.role === "toolResult",
			)) {
				onEvent({
					type: "tool_end",
					toolName: toolResult.toolName ?? "tool",
					result: redactStructured(textFromContent(toolResult.content)),
					isError: false,
				});
			}
			return;
		}
	} catch {
		onEvent({ type: "stdout", text: redactSecrets(line) });
	}
}

function redactStructured(value: unknown): unknown {
	if (typeof value === "string") return redactSecrets(value);
	try {
		return JSON.parse(redactSecrets(JSON.stringify(value)));
	} catch {
		return redactSecrets(value);
	}
}

function extractAssistantMarkdown(stdout: string): string {
	let lastAssistant = "";
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as {
				type?: string;
				message?: {
					role?: string;
					content?: Array<{ type?: string; text?: string }>;
				};
				messages?: Array<{
					role?: string;
					content?: Array<{ type?: string; text?: string }>;
				}>;
			};
			if (event.type === "message_end" && event.message?.role === "assistant") {
				lastAssistant = textFromContent(event.message.content);
			}
			if (event.type === "agent_end" && event.messages) {
				const assistant = [...event.messages]
					.reverse()
					.find((message) => message.role === "assistant");
				if (assistant) lastAssistant = textFromContent(assistant.content);
			}
		} catch {
			// Ignore non-JSON lines so local wrapper scripts can print diagnostics.
		}
	}
	return lastAssistant || stdout.trim();
}

function extractPiAssistantError(stdout: string): string | undefined {
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as {
				type?: string;
				message?: {
					role?: string;
					stopReason?: string;
					errorMessage?: string;
				};
			};
			if (
				(event.type === "message_end" || event.type === "turn_end") &&
				event.message?.role === "assistant" &&
				(event.message.stopReason === "error" || event.message.errorMessage)
			) {
				return (
					event.message.errorMessage || "Pi assistant stopped with an error."
				);
			}
		} catch {
			// Ignore non-JSON diagnostics.
		}
	}
	return undefined;
}

function extractPiSmokeSummary(stdout: string): {
	provider?: string;
	model?: string;
} {
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as {
				message?: { provider?: string; model?: string };
				messages?: Array<{ role?: string; provider?: string; model?: string }>;
			};
			const message =
				event.message ??
				event.messages?.find((candidate) => candidate.role === "assistant");
			if (message?.provider || message?.model)
				return { provider: message.provider, model: message.model };
		} catch {
			// Ignore non-JSON diagnostics.
		}
	}
	return {};
}

function extractPiToolSummaries(stdout: string): PiToolSummary[] {
	const calls = new Map<string, PiToolSummary>();
	const ordered: PiToolSummary[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as {
				type?: string;
				message?: PiMessage;
				messages?: PiMessage[];
				toolCallId?: string;
				toolName?: string;
				args?: unknown;
				result?: unknown;
				isError?: boolean;
			};
			if (event.type === "tool_execution_start") {
				const id = event.toolCallId ?? `${ordered.length}`;
				const summary = {
					toolName: event.toolName ?? "tool",
					args: redactStructured(event.args),
				};
				calls.set(id, summary);
				ordered.push(summary);
			}
			if (event.type === "message_update") {
				const toolCall = latestToolCall(event.message?.content);
				if (toolCall?.id && toolCall.name && !calls.has(toolCall.id)) {
					const summary = {
						toolName: toolCall.name,
						args: redactStructured(toolCall.arguments ?? {}),
					};
					calls.set(toolCall.id, summary);
					ordered.push(summary);
				}
			}
			if (event.type === "tool_execution_end") {
				const id = event.toolCallId ?? `${ordered.length - 1}`;
				const summary = calls.get(id);
				if (summary) {
					summary.isError = Boolean(event.isError);
					summary.resultPreview = compactDetail(
						JSON.stringify(redactStructured(event.result)),
					).slice(0, 500);
				}
			}
			if (event.type === "agent_end" && event.messages) {
				for (const message of event.messages) {
					if (message.role !== "toolResult") continue;
					const id = message.toolCallId ?? `${ordered.length}`;
					let summary = calls.get(id);
					if (!summary) {
						summary = { toolName: message.toolName ?? "tool" };
						calls.set(id, summary);
						ordered.push(summary);
					}
					summary.isError = false;
					summary.resultPreview = compactDetail(
						textFromContent(message.content),
					).slice(0, 500);
				}
			}
		} catch {
			// Ignore non-JSON diagnostics.
		}
	}
	return ordered;
}

interface PiMessageContentBlock {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
	partialJson?: string;
}

interface PiMessage {
	role?: string;
	content?: PiMessageContentBlock[];
	toolCallId?: string;
	toolName?: string;
}

function latestToolCall(
	content: PiMessageContentBlock[] | undefined,
): PiMessageContentBlock | undefined {
	return [...(content ?? [])]
		.reverse()
		.find((block) => block.type === "toolCall");
}

function textFromContent(content: PiMessageContentBlock[] | undefined): string {
	return (content ?? [])
		.filter((block) => block.type === "text" && block.text)
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function authPrecedenceWarning(): string {
	const command = process.env.PI_COMMAND || "pi";
	if (/\banthropic\b/i.test(command) && process.env.ANTHROPIC_OAUTH_TOKEN) {
		return " ANTHROPIC_OAUTH_TOKEN is set and takes precedence over ANTHROPIC_API_KEY.";
	}
	return "";
}

function buildPiGenerationFailureMessage(
	code: number | null,
	timedOut: boolean,
	output: string,
): string {
	const detail = compactDetail(output);
	if (timedOut) {
		return `Pi CLI starts, but the real LLM smoke test timed out after 90 seconds.${detail ? ` Last output: ${detail}` : ""}`;
	}
	if (
		/personal access tokens are not supported|checking third-party user token/i.test(
			output,
		)
	) {
		return [
			"Pi CLI starts, but provider auth failed before generation.",
			"That error usually means this process is seeing an OAuth/PAT-style token for an endpoint that does not accept it.",
			"For this Anthropic demo, unset ANTHROPIC_OAUTH_TOKEN in the terminal that runs npm run cloud, keep ANTHROPIC_API_KEY set to a standard Anthropic API key, then restart npm run cloud.",
			detail ? `Raw provider error: ${detail}` : "",
		]
			.filter(Boolean)
			.join(" ");
	}
	return `Pi CLI starts, but real LLM generation failed with exit ${code}.${detail ? ` ${detail}` : ""}`;
}

function compactDetail(output: string): string {
	return redactSecrets(output).replace(/\s+/g, " ").trim().slice(0, 1200);
}
