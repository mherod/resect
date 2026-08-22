import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeGitRepository } from "../commands/__test-helpers.ts";
import {
	discoverProject,
	type ProjectDiscovery,
	setDiscoveryReglobThrottleMs,
} from "./tsconfig-discovery";

async function initGitRepo(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	await initializeGitRepository(dir, { branch: "main", commit: false });
}

/** Write a minimal compiling project (tsconfig + one source file) at `dir`. */
async function writeProject(dir: string): Promise<void> {
	await mkdir(path.join(dir, "src"), { recursive: true });
	await writeFile(path.join(dir, "src", "index.ts"), "export const x = 1;\n");
	await writeFile(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({ include: ["src/**/*.ts"] })
	);
}

function configPaths(discovery: ProjectDiscovery, baseDir: string): string[] {
	return discovery.configs
		.map((config) => path.relative(baseDir, config.path))
		.sort();
}

describe("discoverProject cache", () => {
	test("rebuilds discovery when a tsconfig's content changes (same tsconfig set)", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-discovery-content-"));
		try {
			const srcDir = path.join(dir, "src");
			await mkdir(srcDir, { recursive: true });
			await writeFile(path.join(srcDir, "a.ts"), "export const a = 1;\n");
			await writeFile(path.join(srcDir, "b.ts"), "export const b = 2;\n");
			const tsconfigPath = path.join(dir, "tsconfig.json");
			await writeFile(
				tsconfigPath,
				JSON.stringify({
					compilerOptions: { strict: true },
					include: ["src/**/*.ts"],
				})
			);

			const first = discoverProject(dir);
			const firstRoot = first.configs.find((c) =>
				c.path.endsWith("tsconfig.json")
			);
			expect(firstRoot).toBeDefined();
			// include matches both a.ts and b.ts
			expect(firstRoot?.files.length ?? 0).toBe(2);

			// Narrow include to just a.ts — same tsconfig file, edited content.
			// Force a distinctly-later mtime so staleness is detectable on any
			// filesystem regardless of mtime resolution.
			await writeFile(
				tsconfigPath,
				JSON.stringify({
					compilerOptions: { strict: true },
					include: ["src/a.ts"],
				})
			);
			const future = new Date(Date.now() + 10_000);
			await utimes(tsconfigPath, future, future);

			const second = discoverProject(dir);
			const secondRoot = second.configs.find((c) =>
				c.path.endsWith("tsconfig.json")
			);
			// A stale cache would still report 2 files from the original include.
			expect(secondRoot?.files.length ?? 0).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("detects a newly-added tsconfig on the next discovery (throttled re-glob)", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-discovery-add-"));
		// Disable the throttle so the cache-hit re-glob runs deterministically.
		setDiscoveryReglobThrottleMs(0);
		try {
			const srcDir = path.join(dir, "src");
			await mkdir(srcDir, { recursive: true });
			await writeFile(path.join(srcDir, "a.ts"), "export const a = 1;\n");
			await writeFile(
				path.join(dir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: { strict: true },
					include: ["src/**/*.ts"],
				})
			);

			const first = discoverProject(dir);
			const firstCount = first.configs.length;
			expect(firstCount).toBe(1);

			// Add a brand-new nested tsconfig AFTER the first discovery cached.
			// Its mtime is absent from the snapshot, so only a re-glob can catch it.
			const pkgDir = path.join(dir, "pkg");
			await mkdir(pkgDir, { recursive: true });
			await writeFile(path.join(pkgDir, "c.ts"), "export const c = 3;\n");
			await writeFile(
				path.join(pkgDir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: { strict: true },
					include: ["c.ts"],
				})
			);

			const second = discoverProject(dir);
			// A presence-only / mtime-only cache would still report 1 config.
			expect(second.configs.length).toBe(firstCount + 1);
			expect(
				second.configs.some(
					(c) => c.path === path.join(pkgDir, "tsconfig.json")
				)
			).toBe(true);
		} finally {
			setDiscoveryReglobThrottleMs(2000);
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("does not descend into a gitignored nested checkout", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-discovery-ignored-"));
		try {
			await initGitRepo(dir);
			await writeProject(dir);
			await writeFile(path.join(dir, ".gitignore"), ".worktrees/\nvendor/\n");

			// Ignored by the repository but absent from SKIP_DIRECTORIES, so a
			// name-denylist boundary would walk straight into both.
			for (const ignored of [".worktrees", "vendor"]) {
				await writeProject(path.join(dir, ignored, "nested"));
			}

			const discovery = discoverProject(dir);
			expect(configPaths(discovery, dir)).toEqual(["tsconfig.json"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("excludes a nested separate checkout from the owning scan", async () => {
		const dir = await mkdtemp(
			path.join(tmpdir(), "resect-discovery-checkout-")
		);
		try {
			await initGitRepo(dir);
			await writeProject(dir);

			// Not gitignored — recognised by carrying its own .git entry.
			const nested = path.join(dir, "external-checkout");
			await writeProject(nested);
			await initGitRepo(nested);

			const discovery = discoverProject(dir);
			expect(configPaths(discovery, dir)).toEqual(["tsconfig.json"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("keeps built-in skips outside a git repository", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-discovery-nogit-"));
		try {
			await writeProject(dir);
			await writeProject(path.join(dir, "node_modules", "pkg"));
			await writeProject(path.join(dir, "packages", "lib"));

			const discovery = discoverProject(dir);
			expect(configPaths(discovery, dir)).toEqual([
				path.join("packages", "lib", "tsconfig.json"),
				"tsconfig.json",
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("resolves an explicitly selected project inside an ignored path", async () => {
		const dir = await mkdtemp(
			path.join(tmpdir(), "resect-discovery-explicit-")
		);
		try {
			await initGitRepo(dir);
			await writeProject(dir);
			await writeFile(path.join(dir, ".gitignore"), "vendor/\n");
			const nested = path.join(dir, "vendor", "nested");
			await writeProject(nested);
			await writeProject(path.join(nested, "packages", "inner"));

			// Pointing discovery at the ignored checkout must resolve its own
			// configs, including nested ones, rather than pruning the subtree.
			const discovery = discoverProject(nested);
			expect(configPaths(discovery, nested)).toEqual([
				path.join("packages", "inner", "tsconfig.json"),
				"tsconfig.json",
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("rebuilds discovery when ignore rules change", async () => {
		const dir = await mkdtemp(
			path.join(tmpdir(), "resect-discovery-ignorerule-")
		);
		try {
			await initGitRepo(dir);
			await writeProject(dir);
			const gitignorePath = path.join(dir, ".gitignore");
			await writeFile(gitignorePath, "vendor/\n");
			await writeProject(path.join(dir, "vendor", "nested"));

			expect(configPaths(discoverProject(dir), dir)).toEqual(["tsconfig.json"]);

			// Stop ignoring vendor/. A cache keyed only on tsconfig mtimes would
			// keep hiding a project the repository no longer ignores.
			await writeFile(gitignorePath, "# nothing ignored\n");
			const future = new Date(Date.now() + 10_000);
			await utimes(gitignorePath, future, future);

			expect(configPaths(discoverProject(dir), dir)).toEqual([
				"tsconfig.json",
				path.join("vendor", "nested", "tsconfig.json"),
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("ignores nested agent worktrees during tsconfig discovery", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-discovery-agents-"));
		try {
			await mkdir(path.join(dir, "src"), { recursive: true });
			await writeFile(
				path.join(dir, "src", "index.ts"),
				"export const live = true;\n"
			);
			await writeFile(
				path.join(dir, "tsconfig.json"),
				JSON.stringify({ include: ["src/**/*.ts"] })
			);

			for (const agentDirectory of [".claude", ".codex"]) {
				const worktree = path.join(dir, agentDirectory, "worktrees", "nested");
				await mkdir(worktree, { recursive: true });
				await writeFile(
					path.join(worktree, "tsconfig.json"),
					JSON.stringify({ include: ["src/**/*.ts"] })
				);
			}

			const discovery = discoverProject(dir);
			expect(discovery.configs.map((config) => config.path)).toEqual([
				path.join(dir, "tsconfig.json"),
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("rebuilds discovery when an inherited extends configuration changes (#244)", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-discovery-extends-"));
		try {
			const srcDir = path.join(dir, "src");
			await mkdir(srcDir, { recursive: true });
			await writeFile(path.join(srcDir, "a.ts"), "export const thing = 1;\n");
			await writeFile(path.join(srcDir, "b.ts"), "export const thing = 2;\n");
			// The base deliberately does NOT match the tsconfig*.json glob, so
			// only the extends-chain snapshot can watch it.
			const basePath = path.join(dir, "base-config.json");
			await writeFile(
				basePath,
				JSON.stringify({
					compilerOptions: {
						strict: true,
						baseUrl: ".",
						paths: { "@thing": ["./src/a.ts"] },
					},
				})
			);
			await writeFile(
				path.join(dir, "tsconfig.json"),
				JSON.stringify({
					extends: "./base-config.json",
					include: ["src/**/*.ts"],
				})
			);

			const first = discoverProject(dir);
			expect(
				first.configs
					.find((c) => c.path.endsWith("tsconfig.json"))
					?.pathAliases.get("@thing")
			).toEqual(["./src/a.ts"]);

			// Change ONLY the inherited base; the globbed tsconfig set and every
			// source file are untouched. Force a distinctly-later mtime.
			await writeFile(
				basePath,
				JSON.stringify({
					compilerOptions: {
						strict: true,
						baseUrl: ".",
						paths: { "@thing": ["./src/b.ts"] },
					},
				})
			);
			const future = new Date(Date.now() + 10_000);
			await utimes(basePath, future, future);

			const second = discoverProject(dir);
			expect(
				second.configs
					.find((c) => c.path.endsWith("tsconfig.json"))
					?.pathAliases.get("@thing")
			).toEqual(["./src/b.ts"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
