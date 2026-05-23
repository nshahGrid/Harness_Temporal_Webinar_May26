import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { exportArtifactActivity } from "../activities.ts";
import { createTemporalClient, hasTemporalEnv } from "../env.ts";
import { runTemporalPiHarnessDemo } from "../harness/demo.ts";
import type {
	GeneratedFile,
	HarnessAgentMode,
	HarnessAgentResult,
	HarnessDemoResult,
} from "../harness/types.ts";
import { artifactsDir, packageRelative, packageRoot } from "../paths.ts";
import {
	checkPiRuntime,
	generateWithPi,
	streamGenerateWithPi,
} from "../pi-runner.ts";
import { buildAgentHandshake, buildPolicyInspection } from "../policy.ts";
import { redactedErrorMessage, redactSecrets } from "../redact.ts";
import { buildFixturePiOutput, buildPromptPack } from "../scenario-data.ts";
import {
	getScenarioDefinition,
	scenarioDefinitions,
} from "../scenario-definitions.ts";
import type {
	AgentHandshakeInput,
	ApprovalDecision,
	DemoWorkflowState,
	PiOutput,
	PolicyInspectionInput,
	ReliabilityMode,
	ScenarioId,
} from "../types.ts";
import {
	agentHandshakeSignal,
	demoStateQuery,
	gtmDemoWorkflow,
	inspectPolicySignal,
	submitApprovalSignal,
	submitPiOutputSignal,
} from "../workflows.ts";
import { buildAgentLadder, buildDemoModes } from "./agent-ladder.ts";

const port = Number(process.env.PORT || 8787);
const runIds = new Set<string>();
const localRuns = new Map<string, DemoWorkflowState>();
const harnessRuns = new Map<string, HarnessDemoResult>();
const simulatedPiFailures = new Set<string>();

const server = createServer(async (request, response) => {
	try {
		await route(request, response);
	} catch (error) {
		sendJson(response, 500, { error: redactedErrorMessage(error) });
	}
});

async function route(
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const url = new URL(
		request.url || "/",
		`http://${request.headers.host || "localhost"}`,
	);
	if (request.method === "GET" && url.pathname === "/") {
		const html = await readFile(
			join(packageRoot, "src", "web", "index.html"),
			"utf8",
		);
		send(response, 200, "text/html; charset=utf-8", html);
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/scenarios") {
		sendJson(response, 200, scenarioDefinitions);
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/agent-ladder") {
		sendJson(response, 200, buildAgentLadder());
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/demo-modes") {
		sendJson(response, 200, buildDemoModes());
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/runtime") {
		sendJson(
			response,
			200,
			hasTemporalEnv() ? { mode: "temporal-cloud" } : { mode: "local-fixture" },
		);
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/artifacts/open") {
		await openArtifactsFolder();
		sendJson(response, 200, { opened: packageRelative(artifactsDir) });
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/artifacts/view") {
		await viewArtifact(url, response);
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/pi-health") {
		sendJson(
			response,
			200,
			await checkPiRuntime({ smoke: url.searchParams.get("smoke") === "1" }),
		);
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/runs") {
		sendJson(response, 200, await listRuns());
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/harness-runs") {
		sendJson(response, 200, [...harnessRuns.values()].map(publicHarnessResult));
		return;
	}
	if (
		request.method === "POST" &&
		url.pathname === "/api/harness-runs/stream"
	) {
		await streamHarnessRun(request, response);
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/harness-runs") {
		const body = (await readJson(request)) as {
			agent?: HarnessAgentMode | "all";
		};
		const result = await runTemporalPiHarnessDemo({
			agent: body.agent ?? "all",
			runId: `demo-harness-${Date.now()}`,
		});
		harnessRuns.set(result.runId, result);
		sendJson(response, 200, publicHarnessResult(result));
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/runs") {
		const body = (await readJson(request)) as {
			scenarioId?: ScenarioId;
			reliabilityMode?: ReliabilityMode;
		};
		if (!body.scenarioId) throw new Error("scenarioId is required");
		const workflowId = `${body.scenarioId}-${Date.now()}`;
		const reliabilityMode = body.reliabilityMode ?? "clean-run";
		if (hasTemporalEnv()) {
			const { client, taskQueue } = await createTemporalClient();
			await client.workflow.start(gtmDemoWorkflow, {
				taskQueue,
				workflowId,
				args: [
					{
						scenarioId: body.scenarioId,
						runId: workflowId,
						requestedBy: "web-ui",
						reliabilityMode,
					},
				],
			});
		} else {
			localRuns.set(
				workflowId,
				await startLocalRun(body.scenarioId, workflowId, reliabilityMode),
			);
		}
		runIds.add(workflowId);
		sendJson(response, 200, { workflowId });
		return;
	}
	const generateStreamMatch = /^\/api\/runs\/([^/]+)\/generate-stream$/.exec(
		url.pathname,
	);
	if (request.method === "POST" && generateStreamMatch) {
		await streamPiGeneration(generateStreamMatch[1], request, response);
		return;
	}
	const generateMatch = /^\/api\/runs\/([^/]+)\/generate$/.exec(url.pathname);
	if (request.method === "POST" && generateMatch) {
		const body = (await readJson(request)) as { mode?: "pi" | "fixture" };
		const state = await getState(generateMatch[1]);
		const pack = state.promptPack ?? (await buildPromptPack(state.scenarioId));
		const output: PiOutput =
			body.mode === "fixture"
				? {
						source: "fixture",
						generatedAt: new Date().toISOString(),
						markdown: buildFixturePiOutput(
							await buildPromptPack(state.scenarioId, {
								includePreparedResearch: true,
							}),
						),
					}
				: await generateWithPi(pack);
		sendJson(
			response,
			200,
			await submitPiOutput(generateMatch[1], state, output),
		);
		return;
	}
	const approvalMatch = /^\/api\/runs\/([^/]+)\/approval$/.exec(url.pathname);
	if (request.method === "POST" && approvalMatch) {
		const body = (await readJson(request)) as {
			decision?: "approved" | "rejected";
			notes?: string;
		};
		if (body.decision !== "approved" && body.decision !== "rejected") {
			throw new Error('decision must be "approved" or "rejected"');
		}
		if (localRuns.has(approvalMatch[1])) {
			const state = await getState(approvalMatch[1]);
			const decision: ApprovalDecision = {
				decision: body.decision,
				reviewer: "web-ui",
				notes: body.notes,
				decidedAt: new Date().toISOString(),
			};
			let nextState = addEvent(
				{ ...state, approval: decision },
				`Approval decision: ${decision.decision}`,
			);
			if (decision.decision === "rejected") {
				nextState = addEvent(
					{ ...nextState, phase: "rejected" },
					"Run rejected; no final artifact exported",
				);
			} else {
				nextState = addEvent(
					{ ...nextState, phase: "exporting" },
					"Exporting approved artifact",
				);
				const artifact = await exportArtifactActivity({
					...nextState,
					phase: "completed",
				});
				nextState = addEvent(
					{ ...nextState, artifact, phase: "completed" },
					`Completed with artifact ${artifact.relativePath}`,
				);
			}
			localRuns.set(approvalMatch[1], nextState);
			sendJson(response, 200, nextState);
			return;
		}
		const { client } = await createTemporalClient();
		await client.workflow
			.getHandle(approvalMatch[1])
			.signal(submitApprovalSignal, {
				decision: body.decision,
				reviewer: "web-ui",
				notes: body.notes,
				decidedAt: new Date().toISOString(),
			});
		sendJson(response, 200, await getState(approvalMatch[1]));
		return;
	}
	const policyMatch = /^\/api\/runs\/([^/]+)\/policy-inspection$/.exec(
		url.pathname,
	);
	if (request.method === "POST" && policyMatch) {
		const body = (await readJson(request)) as PolicyInspectionInput;
		sendJson(response, 200, await submitPolicyInspection(policyMatch[1], body));
		return;
	}
	const handshakeMatch = /^\/api\/runs\/([^/]+)\/agent-handshake$/.exec(
		url.pathname,
	);
	if (request.method === "POST" && handshakeMatch) {
		const body = (await readJson(request)) as AgentHandshakeInput;
		sendJson(
			response,
			200,
			await submitAgentHandshake(handshakeMatch[1], body),
		);
		return;
	}
	sendJson(response, 404, { error: "Not found" });
}

async function listRuns(): Promise<DemoWorkflowState[]> {
	const states = await Promise.all(
		[...runIds].map((runId) => getState(runId).catch(() => undefined)),
	);
	return states.filter((state): state is DemoWorkflowState => Boolean(state));
}

async function getState(workflowId: string): Promise<DemoWorkflowState> {
	const localRun = localRuns.get(workflowId);
	if (localRun) return sanitizePromptPackState(localRun);
	const { client } = await createTemporalClient();
	return sanitizePromptPackState(
		await client.workflow.getHandle(workflowId).query(demoStateQuery),
	);
}

async function sanitizePromptPackState(
	state: DemoWorkflowState,
): Promise<DemoWorkflowState> {
	if (!state.promptPack || !isStalePromptPack(state.promptPack)) return state;
	const compactPack = await buildPromptPack(state.scenarioId);
	return {
		...state,
		promptPack: {
			...compactPack,
			recoveryEvents: state.promptPack.recoveryEvents,
		},
	};
}

function isStalePromptPack(pack: {
	prompt?: string;
	preparedData?: Record<string, unknown>;
}): boolean {
	const prompt = pack.prompt ?? "";
	return (
		prompt.includes("Prepared live research result") ||
		prompt.includes('"discoveredUrls"') ||
		prompt.includes('"attemptedUrls"') ||
		prompt.includes('"records"') ||
		prompt.includes("$JSON.stringify") ||
		Boolean(pack.preparedData?.researchResult)
	);
}

async function startLocalRun(
	scenarioId: ScenarioId,
	runId: string,
	reliabilityMode: ReliabilityMode,
): Promise<DemoWorkflowState> {
	const definition = getScenarioDefinition(scenarioId);
	let state: DemoWorkflowState = {
		runId,
		scenarioId,
		title: definition.title,
		reliabilityMode,
		phase: "preparing",
		timeline: [],
	};
	state = addEvent(state, "Local fixture workflow started");
	state = addEvent(
		{
			...state,
			promptPack: await buildPromptPack(scenarioId),
			phase: "waiting_for_pi",
		},
		"Prepared prompt pack and waiting for Pi generation",
	);
	return state;
}

function addEvent(
	state: DemoWorkflowState,
	message: string,
): DemoWorkflowState {
	return {
		...state,
		timeline: [...state.timeline, { at: new Date().toISOString(), message }],
	};
}

function readJson(request: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk.toString();
		});
		request.on("end", () => {
			try {
				resolve(body ? JSON.parse(body) : {});
			} catch (error) {
				reject(error);
			}
		});
		request.on("error", reject);
	});
}

function sendJson(
	response: ServerResponse,
	status: number,
	body: unknown,
): void {
	send(
		response,
		status,
		"application/json; charset=utf-8",
		redactSecrets(JSON.stringify(body, null, 2)),
	);
}

async function streamPiGeneration(
	workflowId: string,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const body = (await readJson(request)) as { mode?: "pi" | "fixture" };
	const state = await getState(workflowId);
	const pack = state.promptPack ?? (await buildPromptPack(state.scenarioId));
	response.writeHead(200, {
		"content-type": "application/x-ndjson; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		"x-accel-buffering": "no",
		connection: "keep-alive",
	});
	const writeEvent = (event: unknown) => {
		response.write(`${redactSecrets(JSON.stringify(event))}\n`);
	};
	const stopHeartbeat = startNdjsonHeartbeat(response);
	try {
		writeEvent({ type: "start", workflowId, mode: body.mode ?? "pi" });
		writeEvent({
			type: "prompt_pack",
			prompt: pack.prompt,
			promptCharacters: pack.prompt.length,
			preloadedDiscoveredUrls: pack.preparedData.preloadedDiscoveredUrls ?? 0,
			preloadedExtractedRecords:
				pack.preparedData.preloadedExtractedRecords ?? 0,
		});
		if (body.mode !== "fixture" && shouldSimulatePiFailure(state)) {
			simulatedPiFailures.add(workflowId);
			writeEvent({
				type: "pi",
				event: {
					type: "stderr",
					text: "Simulated Anthropic API 529 overloaded before final assistant output.",
				},
			});
			writeEvent({ type: "temporal_state", state });
			writeEvent({
				type: "error",
				message:
					"Simulated LLM API failure. Temporal kept the workflow in waiting_for_pi with the prepared prompt pack, so you can retry Stream Pi Generation without starting over.",
			});
			return;
		}
		const output: PiOutput =
			body.mode === "fixture"
				? {
						source: "fixture",
						generatedAt: new Date().toISOString(),
						markdown: buildFixturePiOutput(
							await buildPromptPack(state.scenarioId, {
								includePreparedResearch: true,
							}),
						),
					}
				: await streamGenerateWithPi(pack, (event) =>
						writeEvent({ type: "pi", event }),
					);
		if (body.mode === "fixture") {
			for (const line of output.markdown.split("\n")) {
				writeEvent({
					type: "pi",
					event: { type: "assistant_delta", delta: `${line}\n` },
				});
			}
			writeEvent({
				type: "pi",
				event: { type: "assistant_final", markdown: output.markdown },
			});
		}
		writeEvent({
			type: "temporal_signal_start",
			signal: "submitPiOutputSignal",
		});
		const nextState = await submitPiOutput(workflowId, state, output);
		writeEvent({ type: "temporal_state", state: nextState });
		writeEvent({ type: "done", state: nextState });
	} catch (error) {
		writeEvent({ type: "error", message: redactedErrorMessage(error) });
	} finally {
		stopHeartbeat();
		response.end();
	}
}

function shouldSimulatePiFailure(state: DemoWorkflowState): boolean {
	if (!state.runId || simulatedPiFailures.has(state.runId)) return false;
	if (state.reliabilityMode === "recoverable-failures") return true;
	if (state.reliabilityMode === "random-chaos") return Math.random() < 0.5;
	return false;
}

async function submitPiOutput(
	workflowId: string,
	state: DemoWorkflowState,
	output: PiOutput,
): Promise<DemoWorkflowState> {
	if (localRuns.has(workflowId)) {
		const nextState = addEvent(
			{
				...state,
				piOutput: output,
				phase: "waiting_for_approval",
			},
			`Received ${output.source} Pi output; waiting for approval`,
		);
		localRuns.set(workflowId, nextState);
		return nextState;
	}
	const { client } = await createTemporalClient();
	await client.workflow
		.getHandle(workflowId)
		.signal(submitPiOutputSignal, output);
	return getState(workflowId);
}

async function submitPolicyInspection(
	workflowId: string,
	input: PolicyInspectionInput,
): Promise<DemoWorkflowState> {
	if (localRuns.has(workflowId)) {
		const state = await getState(workflowId);
		const inspection = buildPolicyInspection(
			state,
			input,
			input.requestedAt || new Date().toISOString(),
		);
		const nextState = addEvent(
			{
				...state,
				policyInspections: [...(state.policyInspections ?? []), inspection],
			},
			`Policy inspection ${inspection.id}: ${inspection.status} for ${inspection.policyId}`,
		);
		localRuns.set(workflowId, nextState);
		return nextState;
	}
	const { client } = await createTemporalClient();
	await client.workflow.getHandle(workflowId).signal(inspectPolicySignal, {
		...input,
		requestedAt: input.requestedAt || new Date().toISOString(),
	});
	return getState(workflowId);
}

async function submitAgentHandshake(
	workflowId: string,
	input: AgentHandshakeInput,
): Promise<DemoWorkflowState> {
	if (localRuns.has(workflowId)) {
		const state = await getState(workflowId);
		const handshake = buildAgentHandshake(
			state,
			input,
			input.createdAt || new Date().toISOString(),
		);
		const nextState = addEvent(
			{
				...state,
				agentHandshakes: [...(state.agentHandshakes ?? []), handshake],
			},
			`Agent handshake ${handshake.id}: ${handshake.fromAgent} to ${handshake.toAgent} is ${handshake.status}`,
		);
		localRuns.set(workflowId, nextState);
		return nextState;
	}
	const { client } = await createTemporalClient();
	await client.workflow.getHandle(workflowId).signal(agentHandshakeSignal, {
		...input,
		createdAt: input.createdAt || new Date().toISOString(),
	});
	return getState(workflowId);
}

async function streamHarnessRun(
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const body = (await readJson(request)) as {
		agent?: HarnessAgentMode | "all";
	};
	response.writeHead(200, {
		"content-type": "application/x-ndjson; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		"x-accel-buffering": "no",
		connection: "keep-alive",
	});
	const writeEvent = (event: unknown) => {
		response.write(
			`${redactSecrets(JSON.stringify(publicHarnessStreamEvent(event)))}\n`,
		);
	};
	const stopHeartbeat = startNdjsonHeartbeat(response);
	try {
		const result = await runTemporalPiHarnessDemo({
			agent: body.agent ?? "all",
			runId: `demo-harness-${Date.now()}`,
			onStream: writeEvent,
		});
		harnessRuns.set(result.runId, result);
	} catch (error) {
		writeEvent({ type: "error", message: redactedErrorMessage(error) });
	} finally {
		stopHeartbeat();
		response.end();
	}
}

function startNdjsonHeartbeat(response: ServerResponse): () => void {
	const interval = setInterval(() => {
		if (response.destroyed || response.writableEnded) return;
		response.write(
			`${JSON.stringify({ type: "heartbeat", at: new Date().toISOString() })}\n`,
		);
	}, 10_000);
	interval.unref();
	return () => clearInterval(interval);
}

function publicHarnessStreamEvent(event: unknown): unknown {
	if (!event || typeof event !== "object") return event;
	const value = event as {
		type?: string;
		artifact?: GeneratedFile;
		result?: HarnessAgentResult | HarnessDemoResult;
	};
	if (value.artifact)
		return { ...value, artifact: publicArtifact(value.artifact) };
	if (value.result && "results" in value.result)
		return { ...value, result: publicHarnessResult(value.result) };
	if (value.result && "artifacts" in value.result)
		return { ...value, result: publicAgentResult(value.result) };
	return event;
}

function publicHarnessResult(result: HarnessDemoResult) {
	return {
		runId: result.runId,
		reportPath: displayArtifactPath(result.reportPath),
		reportViewUrl: artifactViewUrl(result.reportPath),
		comparisonPath: result.comparisonPath
			? displayArtifactPath(result.comparisonPath)
			: undefined,
		comparisonViewUrl: result.comparisonPath
			? artifactViewUrl(result.comparisonPath)
			: undefined,
		results: result.results.map(publicAgentResult),
	};
}

function publicAgentResult(result: HarnessAgentResult) {
	return {
		...result,
		artifacts: result.artifacts.map(publicArtifact),
	};
}

function publicArtifact(artifact: GeneratedFile) {
	return {
		relativePath: displayArtifactPath(artifact.path),
		purpose: artifact.purpose,
		viewUrl: artifactViewUrl(artifact.path),
	};
}

function displayArtifactPath(path: string): string {
	const marker = "/artifacts/";
	const index = path.indexOf(marker);
	return index >= 0
		? `artifacts/${path.slice(index + marker.length)}`
		: "Report exported locally";
}

function artifactViewUrl(path: string): string | undefined {
	const displayPath = displayArtifactPath(path);
	if (!displayPath.startsWith("artifacts/")) return undefined;
	return `/api/artifacts/view?path=${encodeURIComponent(displayPath)}`;
}

async function viewArtifact(url: URL, response: ServerResponse): Promise<void> {
	const requestedPath = url.searchParams.get("path");
	if (!requestedPath) throw new Error("path is required");
	const base = resolve(artifactsDir);
	const absolutePath = requestedPath.startsWith("artifacts/")
		? resolve(packageRoot, requestedPath)
		: resolve(artifactsDir, requestedPath);
	if (absolutePath !== base && !absolutePath.startsWith(`${base}${sep}`)) {
		throw new Error(
			"Artifact path must stay under the demo artifacts directory",
		);
	}
	const body = await readFile(absolutePath, "utf8");
	send(response, 200, contentTypeFor(absolutePath), body);
}

function contentTypeFor(path: string): string {
	const extension = extname(path).toLowerCase();
	if (extension === ".html") return "text/html; charset=utf-8";
	if (extension === ".md") return "text/markdown; charset=utf-8";
	if (extension === ".json") return "application/json; charset=utf-8";
	if (extension === ".py") return "text/x-python; charset=utf-8";
	return "text/plain; charset=utf-8";
}

async function openArtifactsFolder(): Promise<void> {
	await mkdir(artifactsDir, { recursive: true });
	const command =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "explorer.exe"
				: "xdg-open";
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, [artifactsDir], {
			detached: true,
			stdio: "ignore",
		});
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
		child.once("error", reject);
	});
}

function send(
	response: ServerResponse,
	status: number,
	contentType: string,
	body: string,
): void {
	response.writeHead(status, { "content-type": contentType });
	response.end(body);
}

server.listen(port, () => {
	console.log(`Pi + Temporal case-study web UI: http://localhost:${port}`);
});
