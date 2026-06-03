import { afterAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { loadProject, resolveTsConfig } from "../core/project.ts";
import { cleanup, makeTempDir } from "./__test-helpers.ts";
import { moveModule, rollbackTransformMove } from "./move.ts";

// rollbackTransformMove restores via `git restore`, so the fixture must be a real
// git repo committed at a clean boundary (the precondition moveModule enforces).
const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) {
		await cleanup(dir);
	}
});

async function gitInitFixture(files: Record<string, string>): Promise<string> {
	const dir = await makeTempDir("move-transform-rollback");
	dirs.push(dir);
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(dir, rel);
		await mkdir(path.dirname(full), { recursive: true });
		await Bun.write(full, content);
	}
	const sh = Bun.$.cwd(dir);
	await sh`git init -q`.quiet();
	await sh`git config user.email test@example.com`.quiet();
	await sh`git config user.name Test`.quiet();
	await sh`git add -A`.quiet();
	await sh`git commit -q -m fixture`.quiet();
	return dir;
}

const TSCONFIG = JSON.stringify({
	compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
	include: ["**/*.ts"],
});

describe("move --transform verify/rollback (#125)", () => {
	test("rolls back the move when a transform introduces a type error", async () => {
		// `config.value` is valid; rewriting it to `broken.value` references an
		// undeclared identifier → TS2304 after the move.
		const dir = await gitInitFixture({
			"tsconfig.json": TSCONFIG,
			"src/a.ts":
				"export const config = { value: 1 };\nexport const x = config.value;\n",
		});

		const absSource = path.join(dir, "src/a.ts");
		const tsconfigPath = resolveTsConfig(dir, path.dirname(absSource));
		if (!tsconfigPath) {
			throw new Error("tsconfig not found");
		}
		const project = loadProject(tsconfigPath, absSource);

		const { runTypeCheck } = await import("../core/verify.ts");

		const result = await moveModule(
			absSource,
			path.join(dir, "src/b/a.ts"),
			project,
			false,
			false,
			undefined,
			false,
			[{ from: "config.value", to: "broken.value" }]
		);
		expect(result.transformRewrites).toHaveLength(1);

		// Mirror the caller's verify gate: the rewrite introduced a type error.
		const errors = await runTypeCheck(project);
		expect(errors.length).toBeGreaterThan(0);

		const rolledBack = await rollbackTransformMove(project, result);
		expect(rolledBack).toBe(true);

		// The move was reversed: source restored to its original content, dest gone.
		expect(await Bun.file(path.join(dir, "src/b/a.ts")).exists()).toBe(false);
		const restored = await Bun.file(absSource).text();
		expect(restored).toContain("config.value");
		expect(restored).not.toContain("broken.value");
	});

	test("a clean transform move passes verify and is not rolled back", async () => {
		const dir = await gitInitFixture({
			"tsconfig.json": TSCONFIG,
			"src/a.ts":
				"export const env = { A: '1', B: '2' };\nexport const x = env.A;\n",
		});

		const absSource = path.join(dir, "src/a.ts");
		const tsconfigPath = resolveTsConfig(dir, path.dirname(absSource));
		if (!tsconfigPath) {
			throw new Error("tsconfig not found");
		}
		const project = loadProject(tsconfigPath, absSource);
		const { runTypeCheck } = await import("../core/verify.ts");

		// `env.A` → `env.B`: both valid keys, so the move type-checks cleanly.
		const result = await moveModule(
			absSource,
			path.join(dir, "src/b/a.ts"),
			project,
			false,
			false,
			undefined,
			false,
			[{ from: "env.A", to: "env.B" }]
		);
		expect(result.transformRewrites).toHaveLength(1);

		const errors = await runTypeCheck(project);
		expect(errors).toEqual([]);
		// Verify passed → no rollback; the moved file persists with the rewrite.
		expect(await Bun.file(path.join(dir, "src/b/a.ts")).exists()).toBe(true);
		const moved = await Bun.file(path.join(dir, "src/b/a.ts")).text();
		expect(moved).toContain("env.B");
	});
});
