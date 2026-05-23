const WEBINAR_SAFE_ENV_KEYS = [
	"TEMPORAL_ADDRESS",
	"TEMPORAL_NAMESPACE",
	"TEMPORAL_API_KEY",
	"TEMPORAL_TASK_QUEUE",
	"ANTHROPIC_API_KEY",
	"PI_COMMAND",
] as const;

const SENSITIVE_KEY_PATTERN =
	/[A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|credential|authorization)[A-Za-z0-9_]*/i;

export function redactSecrets(value: unknown): string {
	let text = stringifyForLog(value);
	text = redactAssignments(text);
	text = redactKnownEnvValues(text);
	return text;
}

export function redactedError(error: unknown): string {
	return redactSecrets(error);
}

export function redactedErrorMessage(error: unknown): string {
	return redactSecrets(error instanceof Error ? error.message : error);
}

function stringifyForLog(value: unknown): string {
	if (value instanceof Error) {
		return value.stack ?? `${value.name}: ${value.message}`;
	}
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function redactAssignments(text: string): string {
	let redacted = text.replace(
		new RegExp(
			`(["'])(${WEBINAR_SAFE_ENV_KEYS.join("|")})\\1\\s*:\\s*("[^"]*"|'[^']*'|[^\\s,;\\]}]+)`,
			"g",
		),
		'$1$2$1: "[redacted]"',
	);
	redacted = redacted.replace(
		/(["'])([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|credential|authorization)[A-Za-z0-9_]*)\1\s*:\s*("[^"]*"|'[^']*'|[^\s,;\]}]+)/gi,
		'$1$2$1: "[redacted]"',
	);
	redacted = redacted.replace(
		new RegExp(
			`\\b(${WEBINAR_SAFE_ENV_KEYS.join("|")})\\b\\s*[:=]\\s*("[^"]*"|'[^']*'|[^\\s,;\\]}]+)`,
			"g",
		),
		"$1=[redacted]",
	);
	redacted = redacted.replace(
		/\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|credential|authorization)[A-Za-z0-9_]*)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;\]}]+)/gi,
		"$1=[redacted]",
	);
	return redacted;
}

function redactKnownEnvValues(text: string): string {
	let redacted = text;
	for (const key of WEBINAR_SAFE_ENV_KEYS) {
		const value = process.env[key];
		if (!shouldRedactValue(value)) continue;
		redacted = redacted.replaceAll(value, "[redacted]");
	}
	for (const key of Object.keys(process.env)) {
		if (!isWebinarSafeEnvKey(key) && !SENSITIVE_KEY_PATTERN.test(key)) continue;
		const value = process.env[key];
		if (!shouldRedactValue(value)) continue;
		redacted = redacted.replaceAll(value, "[redacted]");
	}
	return redacted;
}

function shouldRedactValue(value: string | undefined): value is string {
	if (!value || value.length < 4) return false;
	return !/^(replace-me|sk-ant-replace-me|your-namespace(?:\.your-account)?)$/i.test(
		value,
	);
}

function isWebinarSafeEnvKey(
	key: string,
): key is (typeof WEBINAR_SAFE_ENV_KEYS)[number] {
	return WEBINAR_SAFE_ENV_KEYS.includes(
		key as (typeof WEBINAR_SAFE_ENV_KEYS)[number],
	);
}
