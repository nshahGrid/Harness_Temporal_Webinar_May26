import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const fixturesDir = join(packageRoot, "fixtures");
export const artifactsDir = join(packageRoot, "artifacts");

export function packageRelative(path: string): string {
	return relative(packageRoot, path).replaceAll("\\", "/");
}
