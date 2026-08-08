import { randomUUID } from "node:crypto";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRuntime } from "../runtime/index.ts";
import type { Runtime } from "../runtime/types.ts";
import { findGitRoot, toGitPath } from "./git.ts";

const caseSensitivityCache = new Map<string, boolean>();

interface SafeCaseRenameOptions {
	forceCaseInsensitive?: boolean;
	gitMove?: (from: string, to: string) => Promise<void>;
}

export function isCaseOnlyBasenameChange(from: string, to: string): boolean {
	const fromBase = path.basename(from);
	const toBase = path.basename(to);
	return fromBase !== toBase && fromBase.toLowerCase() === toBase.toLowerCase();
}

export function isSameDirectoryCaseOnlyRename(
	from: string,
	to: string
): boolean {
	return (
		path.resolve(path.dirname(from)) === path.resolve(path.dirname(to)) &&
		isCaseOnlyBasenameChange(from, to)
	);
}

export async function isCaseInsensitiveFs(dir: string): Promise<boolean> {
	const resolvedDir = path.resolve(dir);
	const cached = caseSensitivityCache.get(resolvedDir);
	if (cached !== undefined) {
		return cached;
	}

	await mkdir(resolvedDir, { recursive: true });
	const probeName = `.__resect_case_probe_${process.pid}_${Date.now()}_${randomUUID()}`;
	const probePath = path.join(resolvedDir, probeName);
	const variantPath = path.join(resolvedDir, probeName.toUpperCase());

	await writeFile(probePath, "");
	try {
		await stat(variantPath);
		caseSensitivityCache.set(resolvedDir, true);
		return true;
	} catch {
		caseSensitivityCache.set(resolvedDir, false);
		return false;
	} finally {
		await unlink(probePath).catch(() => undefined);
	}
}

export async function shouldUseSafeCaseRename(
	from: string,
	to: string
): Promise<boolean> {
	return (
		isCaseOnlyBasenameChange(from, to) &&
		(await isCaseInsensitiveFs(path.dirname(from)))
	);
}

export async function safeCaseRename(
	rt: Runtime,
	from: string,
	to: string,
	options: SafeCaseRenameOptions = {}
): Promise<void> {
	const caseInsensitive =
		options.forceCaseInsensitive ??
		(await isCaseInsensitiveFs(path.dirname(from)));
	if (!(caseInsensitive && isCaseOnlyBasenameChange(from, to))) {
		await mkdir(path.dirname(to), { recursive: true });
		await rt.fs.rename(from, to);
		return;
	}

	await mkdir(path.dirname(to), { recursive: true });
	const intermediate = `${from}.resect-tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
	const gitMove = options.gitMove ?? (await createGitMove(path.dirname(from)));
	if (gitMove) {
		await twoStepMove(gitMove, from, intermediate, to);
		return;
	}

	await twoStepMove(
		async (source, target) => rt.fs.rename(source, target),
		from,
		intermediate,
		to
	);
}

async function createGitMove(
	dir: string
): Promise<((from: string, to: string) => Promise<void>) | null> {
	const root = await findGitRoot(dir);
	if (!root) {
		return null;
	}
	return async (from: string, to: string) => {
		const fromPath = await toGitPath(root, from);
		const toPath = await toGitPath(root, to);
		const result = await runGit(root, ["mv", fromPath, toPath]);
		if (result.exitCode !== 0) {
			throw new Error(
				result.stderr || `git mv failed: ${fromPath} -> ${toPath}`
			);
		}
	};
}

async function twoStepMove(
	move: (from: string, to: string) => Promise<void>,
	from: string,
	intermediate: string,
	to: string
): Promise<void> {
	await move(from, intermediate);
	try {
		await move(intermediate, to);
	} catch (error) {
		let cleanupError: unknown;
		try {
			await move(intermediate, from);
		} catch (cleanup) {
			cleanupError = cleanup;
		}
		const message = error instanceof Error ? error.message : String(error);
		if (cleanupError) {
			const cleanupMessage =
				cleanupError instanceof Error
					? cleanupError.message
					: "unknown cleanup error";
			throw new Error(`${message}; cleanup failed: ${cleanupMessage}`);
		}
		throw error;
	}
}

async function runGit(
	cwd: string,
	args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const { stdout, stderr, exitCode } = await getRuntime().process.exec(
		["git", ...args],
		{ cwd }
	);
	return { stdout, stderr, exitCode: exitCode ?? 0 };
}
