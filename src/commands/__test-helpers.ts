import { afterAll } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const CLI = ["bun", path.resolve(import.meta.dir, "../cli.ts")];

const fixtureDirectories = new Set<string>();

afterAll(async () => {
	for (const dir of [...fixtureDirectories]) {
		await cleanup(dir);
	}
});

export interface CliResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

export interface RunCliOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
}

export type TsconfigPreset = "strict" | "strict-base-url" | "bundler";

export interface GitFixtureOptions {
	branch?: string;
	commit?: boolean;
	commitMessage?: string;
}

export interface ProjectFixtureOptions {
	name: string;
	files: Record<string, string>;
	tsconfig?: TsconfigPreset | Record<string, unknown>;
	git?: boolean | GitFixtureOptions;
	outsideRepo?: boolean;
	root?: string;
}

export interface ProjectFixture {
	dir: string;
	path: (relativePath: string) => string;
	run: (args: string[], options?: RunCliOptions) => Promise<CliResult>;
	runJson: <T>(args: string[], options?: RunCliOptions) => Promise<T>;
	captureOutput: (
		fn: () => Promise<void> | void
	) => Promise<{ stdout: string; stderr: string }>;
	cleanup: () => Promise<void>;
}

interface FixtureOptions {
	/** When true, writes the strict preset unless one is provided in files. */
	tsconfig?: boolean | TsconfigPreset | Record<string, unknown>;
	/** Put generated fixtures outside the repo when files use *.test.* names. */
	outsideRepo?: boolean;
	/** Override the directory under which the unique fixture is created. */
	root?: string;
}

const TSCONFIG_PRESETS: Record<TsconfigPreset, Record<string, unknown>> = {
	strict: {
		compilerOptions: { strict: true },
		include: ["**/*.ts"],
	},
	"strict-base-url": {
		compilerOptions: { baseUrl: ".", strict: true },
		include: ["**/*.ts"],
	},
	bundler: {
		compilerOptions: {
			module: "ESNext",
			moduleResolution: "Bundler",
			noEmit: true,
			strict: true,
			target: "ESNext",
			types: [],
		},
		include: ["**/*.ts"],
	},
};

function resolveTsconfig(
	tsconfig: ProjectFixtureOptions["tsconfig"]
): Record<string, unknown> | undefined {
	if (!tsconfig) {
		return undefined;
	}
	return typeof tsconfig === "string" ? TSCONFIG_PRESETS[tsconfig] : tsconfig;
}

function normalizeFixtureTsconfig(
	tsconfig: FixtureOptions["tsconfig"]
): ProjectFixtureOptions["tsconfig"] {
	if (tsconfig === true) {
		return "strict";
	}
	if (tsconfig === false) {
		return undefined;
	}
	return tsconfig;
}

export function parseMcpTextPayload<T>(result: CallToolResult): T {
	const content = result.content[0];
	if (content?.type !== "text") {
		throw new Error("Expected an MCP text result");
	}
	return JSON.parse(content.text) as T;
}

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

export async function initializeGitRepository(
	dir: string,
	options: GitFixtureOptions = {}
): Promise<void> {
	const initArgs = options.branch
		? ["init", "-b", options.branch]
		: ["init", "--template="];
	await runGitCommand(dir, initArgs);
	await runGitCommand(dir, ["config", "user.name", "Resect Test"]);
	await runGitCommand(dir, ["config", "user.email", "resect@example.invalid"]);
	if (options.commit === false) {
		return;
	}
	await runGitCommand(dir, ["add", "."]);
	await runGitCommand(dir, [
		"commit",
		"-m",
		options.commitMessage ?? "initial",
	]);
}

export async function makeProject(
	options: ProjectFixtureOptions
): Promise<ProjectFixture> {
	const fixtureRoot =
		options.root ??
		(options.outsideRepo
			? path.join(tmpdir(), "resect-fixtures")
			: path.join(import.meta.dir, "__fixtures__"));
	await mkdir(fixtureRoot, { recursive: true });
	const dir = await mkdtemp(path.join(fixtureRoot, `${options.name}-`));
	fixtureDirectories.add(dir);

	const tsconfig = resolveTsconfig(options.tsconfig);
	if (tsconfig && !options.files["tsconfig.json"]) {
		await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
	}
	for (const [relativePath, content] of Object.entries(options.files)) {
		const fullPath = path.join(dir, relativePath);
		await mkdir(path.dirname(fullPath), { recursive: true });
		await writeFile(fullPath, content);
	}
	if (options.git) {
		await initializeGitRepository(
			dir,
			typeof options.git === "boolean" ? undefined : options.git
		);
	}

	const run = async (args: string[], runOptions?: RunCliOptions) =>
		runCli(args, { cwd: runOptions?.cwd ?? dir, env: runOptions?.env });
	return {
		dir,
		path: (relativePath: string) => path.join(dir, relativePath),
		run,
		runJson: async <T>(args: string[], runOptions?: RunCliOptions) => {
			const result = await run(args, runOptions);
			if (result.exitCode !== 0) {
				throw new Error(
					`CLI exited with ${result.exitCode}: ${result.stderr.length > 0 ? result.stderr : result.stdout}`
				);
			}
			return JSON.parse(result.stdout) as T;
		},
		captureOutput,
		cleanup: async () => {
			await cleanup(dir);
		},
	};
}

export async function makeFixture(
	prefix: string,
	files: Record<string, string>,
	options?: FixtureOptions
): Promise<string> {
	const tsconfig = normalizeFixtureTsconfig(options?.tsconfig);
	const project = await makeProject({
		name: prefix,
		files,
		tsconfig,
		outsideRepo: options?.outsideRepo,
		root: options?.root,
	});
	return project.dir;
}

export async function makeStrictFixture(
	name: string,
	files: Record<string, string>,
	options?: Omit<FixtureOptions, "tsconfig">
): Promise<string> {
	return makeFixture(name, files, { ...options, tsconfig: "strict" });
}

export async function makeBaseUrlFixture(
	name: string,
	files: Record<string, string>,
	options?: Omit<FixtureOptions, "tsconfig">
): Promise<string> {
	return makeFixture(name, files, {
		...options,
		tsconfig: "strict-base-url",
	});
}

export async function makeExternalStrictFixture(
	name: string,
	files: Record<string, string>
): Promise<string> {
	return makeFixture(name, files, {
		outsideRepo: true,
		tsconfig: "strict",
	});
}

export async function makeGitFixture(
	name: string,
	files: Record<string, string>,
	options?: Omit<FixtureOptions, "tsconfig"> & {
		git?: GitFixtureOptions;
		tsconfig?: TsconfigPreset | Record<string, unknown>;
	}
): Promise<string> {
	const project = await makeProject({
		name,
		files,
		tsconfig: options?.tsconfig ?? "strict",
		outsideRepo: options?.outsideRepo ?? true,
		root: options?.root,
		git: options?.git ?? true,
	});
	return project.dir;
}

/** Create an automatically-cleaned throwaway directory under the OS tmpdir. */
export async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), `resect-${prefix}-`));
	fixtureDirectories.add(dir);
	return dir;
}

export async function cleanup(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
	fixtureDirectories.delete(dir);
}

/**
 * Run a command function in-process while capturing everything it writes to
 * stdout/stderr. Reserve `runCli` for tests that need the real CLI entry point.
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

export async function runCli(
	args: string[],
	options: RunCliOptions = {}
): Promise<CliResult> {
	const proc = Bun.spawn([...CLI, ...args], {
		cwd: options.cwd,
		env: options.env ? { ...process.env, ...options.env } : undefined,
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
