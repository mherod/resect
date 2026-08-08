import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProject, resolveTsConfig } from "../core/project.ts";
import { discoverWorkspace } from "../core/workspace.ts";
import type { MoveResult } from "../types/move.ts";
import { moveModule } from "./move.ts";

export const CLI = ["bun", path.resolve(import.meta.dir, "../cli.ts")];

export async function runGitCommand(
	cwd: string,
	args: string[]
): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${stdout}${stderr}`);
	}
	return stdout;
}

/**
 * Run `moveModule` against a fixture directory, resolving its tsconfig and
 * (optional) workspace the way the cross-package move suites need. Shared by
 * the move test suites (#118 dependency sync, #121 self-import rewrite) so the
 * fixture-move plumbing lives in one place.
 */
export async function moveInFixture(
	dir: string,
	source: string,
	target: string,
	dryRun = false,
	force = false
): Promise<MoveResult> {
	const absSource = path.join(dir, source);
	const tsconfigPath = resolveTsConfig(dir, path.dirname(absSource));
	if (!tsconfigPath) {
		throw new Error("tsconfig not found");
	}
	const project = loadProject(tsconfigPath, absSource);
	const workspace = (await discoverWorkspace(dir)) ?? undefined;
	return moveModule(
		absSource,
		path.join(dir, target),
		project,
		dryRun,
		false,
		workspace,
		force
	);
}

interface CliResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

interface FixtureOptions {
	/** When true, writes a default tsconfig.json unless one is provided in files */
	tsconfig?: boolean;
	/** Put generated fixtures outside the repo when files use *.test.* names */
	outsideRepo?: boolean;
}

export async function makeFixture(
	prefix: string,
	files: Record<string, string>,
	options?: FixtureOptions
): Promise<string> {
	const fixtureRoot = options?.outsideRepo
		? path.join(tmpdir(), "resect-fixtures")
		: path.join(import.meta.dir, "__fixtures__");
	const dir = path.join(fixtureRoot, `${prefix}-${Date.now()}`);
	await mkdir(dir, { recursive: true });
	if (options?.tsconfig && !files["tsconfig.json"]) {
		await writeFile(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { strict: true },
				include: ["**/*.ts"],
			})
		);
	}
	for (const [filePath, content] of Object.entries(files)) {
		const full = path.join(dir, filePath);
		await mkdir(path.dirname(full), { recursive: true });
		await writeFile(full, content);
	}
	return dir;
}

/**
 * Create a uniquely-named throwaway temp directory under the OS tmpdir,
 * named `resect-<prefix>-XXXXXX`. The caller owns cleanup (track the returned
 * path and `rm` it in an afterAll). Shared by tests needing a real on-disk
 * working directory outside the repo (e.g. move, filesystem-case).
 */
export async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), `resect-${prefix}-`));
	return dir;
}

export async function cleanup(dir: string) {
	await rm(dir, { recursive: true, force: true });
}

/**
 * Run a command function in-process while capturing everything it writes to
 * stdout/stderr (the CLI logger and command output both go through
 * `process.stdout/stderr.write`). Use this instead of `runCli` whenever the
 * command can run in-process — it avoids a `bun cli.ts` subprocess cold-start
 * (~300-500ms each), keeping the unit suite fast. Reserve `runCli` for tests
 * that must exercise the real CLI entry point (arg parsing, process exit).
 */
export async function captureOutput(
	fn: () => Promise<void> | void
): Promise<{ stdout: string; stderr: string }> {
	const originalStdout = process.stdout.write.bind(process.stdout);
	const originalStderr = process.stderr.write.bind(process.stderr);
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: unknown) => {
		stdout += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: unknown) => {
		stderr += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		await fn();
	} finally {
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
	}
	return { stdout, stderr };
}

export async function runCli(args: string[]): Promise<CliResult> {
	const proc = Bun.spawn([...CLI, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { stdout, stderr, exitCode: proc.exitCode };
}
