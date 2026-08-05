import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getRuntime } from "../runtime/index.ts";

const moduleCache = new Map<string, { hash: string; value: unknown }>();

/**
 * Load an executable config module without serving stale exports in long-lived
 * processes. Bun caches module URLs, so changed source is imported from a fresh
 * temporary path and cached by its content hash.
 */
export async function loadConfigModule(
	absPath: string,
	description: string,
	beforeExecute?: () => void
): Promise<unknown> {
	const rt = getRuntime();
	const source = await rt.fs.readFile(absPath);
	const hash = createHash("sha256").update(source).digest("hex");
	const cached = moduleCache.get(absPath);
	if (cached?.hash === hash) {
		return cached.value;
	}

	let loadDir: string | undefined;
	try {
		loadDir = await mkdtemp(path.join(tmpdir(), "resect-config-load-"));
		const ext = path.extname(absPath) || ".js";
		const loadPath = path.join(loadDir, `config${ext}`);
		await rt.fs.writeFile(loadPath, source);
		beforeExecute?.();
		const value = await import(pathToFileURL(loadPath).href);
		moduleCache.set(absPath, { hash, value });
		return value;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to load ${description} ${absPath}: ${detail}`);
	} finally {
		if (loadDir) {
			await rm(loadDir, { recursive: true, force: true }).catch(
				() => undefined
			);
		}
	}
}

export function unwrapDefaultConfigModule(mod: unknown): unknown {
	if (mod && typeof mod === "object") {
		const namespace = mod as Record<string, unknown>;
		if (namespace.default !== undefined) {
			return namespace.default;
		}
	}
	return mod;
}
