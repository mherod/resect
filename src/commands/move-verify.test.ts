import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import path from "node:path";
import { CLI, cleanup, makeFixture } from "./__test-helpers.ts";

async function fileExists(filePath: string): Promise<boolean> {
	return Bun.file(filePath).exists();
}

// Real tsc --noEmit runs before+after the move; give it the canonical suite
// timeout (matches tidy.test.ts) so this doesn't flake under full-suite
// CPU contention.
setDefaultTimeout(20_000);

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) {
		await cleanup(dir);
	}
});

describe("move --verify with pre-existing type errors (#128)", () => {
	test("moving a file with a pre-existing error does not report it as new (regression #128)", async () => {
		const dir = await makeFixture(
			"move-verify-preexisting",
			{
				// Pre-existing type error inside the file being moved.
				"src/foo.ts":
					'export const bad: string = 123;\nexport const ok = "hello";\n',
				"src/consumer.ts": 'import { ok } from "./foo";\nconsole.log(ok);\n',
			},
			{ tsconfig: true, outsideRepo: true }
		);
		dirs.push(dir);

		const proc = Bun.spawn([...CLI, "move", "src/foo.ts", "src/moved/foo.ts"], {
			cwd: dir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;

		expect(proc.exitCode).toBe(0);
		expect(stdout + stderr).toContain("1 before, 0 new, 0 fixed");
		expect(stdout + stderr).not.toContain("❌");
		expect(stdout + stderr).toContain("✅ Type checking passed");

		expect(await fileExists(path.join(dir, "src/moved/foo.ts"))).toBe(true);
		expect(await fileExists(path.join(dir, "src/foo.ts"))).toBe(false);
	});

	test("moving a file still reports a genuinely new error introduced by the move", async () => {
		const dir = await makeFixture(
			"move-verify-genuine-new",
			{
				"src/foo.ts": 'export const ok = "hello";\n',
				// Relies on a relative sibling import that will break once foo.ts
				// moves to a different directory without specifier rewriting
				// covering this shape (a plain re-export the mover doesn't touch).
				"src/broken.ts": 'export const bad: string = 123;\nimport "./foo";\n',
			},
			{ tsconfig: true, outsideRepo: true }
		);
		dirs.push(dir);

		// Baseline: src/broken.ts already has one pre-existing error before any move.
		const proc = Bun.spawn([...CLI, "move", "src/foo.ts", "src/moved/foo.ts"], {
			cwd: dir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;

		// The pre-existing, untouched error in broken.ts must not block success —
		// only a genuinely new error should. Since resect rewrites the "./foo"
		// specifier correctly, this move should succeed with the same single
		// pre-existing error still present (not duplicated as new).
		expect(proc.exitCode).toBe(0);
		expect(stdout + stderr).not.toContain("❌");
		expect(stdout + stderr).toContain("✅ Type checking passed");
	});
});
