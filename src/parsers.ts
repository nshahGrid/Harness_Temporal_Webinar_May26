export function parseCsv(text: string): Record<string, string>[] {
	const rows = text
		.trim()
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.map(parseCsvLine);
	const [headers, ...records] = rows;
	if (!headers) return [];
	return records.map((record) =>
		Object.fromEntries(
			headers.map((header, index) => [header, record[index] ?? ""]),
		),
	);
}

function parseCsvLine(line: string): string[] {
	const cells: string[] = [];
	let current = "";
	let quoted = false;
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		const next = line[index + 1];
		if (char === '"' && quoted && next === '"') {
			current += '"';
			index++;
		} else if (char === '"') {
			quoted = !quoted;
		} else if (char === "," && !quoted) {
			cells.push(current.trim());
			current = "";
		} else {
			current += char;
		}
	}
	cells.push(current.trim());
	return cells;
}

export function extractHtmlSignals(html: string): Record<string, unknown> {
	const title = firstMatch(html, /<title>(.*?)<\/title>/is);
	const h1 = firstMatch(html, /<h1[^>]*>(.*?)<\/h1>/is);
	const headings = [...html.matchAll(/<h[2-3][^>]*>(.*?)<\/h[2-3]>/gis)].map(
		(match) => cleanHtml(match[1]),
	);
	const ctas = [
		...html.matchAll(
			/<a[^>]+href=["'][^"']*["'][^>]*>(.*?)<\/a>|<button[^>]*>(.*?)<\/button>/gis,
		),
	]
		.map((match) => cleanHtml(match[1] || match[2] || ""))
		.filter(Boolean);
	const forms = [...html.matchAll(/<form\b/gi)].length;
	return {
		title: cleanHtml(title),
		h1: cleanHtml(h1),
		headings,
		ctas,
		formCount: forms,
		wordCount: cleanHtml(html).split(/\s+/).filter(Boolean).length,
	};
}

export function parseSimpleYaml(text: string): Record<string, string> {
	const output: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf(":");
		if (separator === -1) continue;
		const key = trimmed.slice(0, separator).trim();
		const value = trimmed
			.slice(separator + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		output[key] = value;
	}
	return output;
}

function firstMatch(text: string, pattern: RegExp): string {
	return pattern.exec(text)?.[1] ?? "";
}

function cleanHtml(text: string): string {
	return text
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
