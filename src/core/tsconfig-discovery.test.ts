import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	discoverProject,
	setDiscoveryReglobThrottleMs,
} from "./tsconfig-discovery";

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
});
