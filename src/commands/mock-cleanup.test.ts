import { describe, expect, test } from "bun:test";
import path from "node:path";
import { readRegistrationSource } from "../mcp-tools/registration-test-helpers.ts";
import {
	CLI,
	captureOutput,
	cleanup,
	initializeGitRepository,
	makeFixture,
	runCli,
} from "./__test-helpers";
import { mockCleanupCommand } from "./mock-cleanup.ts";

function tsconfig(): string {
	return JSON.stringify({
		compilerOptions: {
			strict: true,
			target: "ESNext",
			module: "Preserve",
			moduleResolution: "bundler",
			skipLibCheck: true,
		},
		include: ["**/*.ts"],
	});
}

async function makeMockFixture(name: string, files: Record<string, string>) {
	return makeFixture(
		`mock-cleanup-${name}`,
		{
			"tsconfig.json": tsconfig(),
			...files,
		},
		{ outsideRepo: true }
	);
}

describe("mock-cleanup command", () => {
	test("reports and removes orphan vi.mock factory keys", async () => {
		const dir = await makeMockFixture("orphans", {
			"mod.ts": "export const foo = 1;\nexport const bar = 2;\n",
			"mod.test.ts": `
				declare const vi: {
					fn(): unknown;
					mock(specifier: string, factory: () => Record<string, unknown>): void;
				};
				vi.mock("./mod", () => ({ foo: vi.fn(), bar: vi.fn(), baz: vi.fn() }));
			`,
		});

		try {
			const audit = await captureOutput(async () =>
				mockCleanupCommand({ directory: dir, json: true })
			);
			const report = JSON.parse(audit.stdout);
			expect(report.orphans).toHaveLength(1);
			expect(report.orphans[0].orphanKey).toBe("baz");

			const human = await captureOutput(async () =>
				mockCleanupCommand({ directory: dir })
			);
			expect(human.stdout).toContain("mod.test.ts:");
			expect(human.stdout).toContain("baz -> ./mod");

			const fix = await captureOutput(async () =>
				mockCleanupCommand({
					directory: dir,
					fix: true,
					force: true,
					json: true,
				})
			);
			const result = JSON.parse(fix.stdout);
			expect(result.success).toBe(true);
			expect(result.modifiedFiles).toHaveLength(1);

			const next = await Bun.file(path.join(dir, "mod.test.ts")).text();
			expect(next).toContain("{ foo: vi.fn(), bar: vi.fn() }");
			expect(next).not.toContain("baz");
		} finally {
			await cleanup(dir);
		}
	});

	test("keeps the fix applied when a pre-existing error only shifts position", async () => {
		// Regression for #209: the factory edit shifts the column of an unrelated
		// pre-existing error on the same line; raw-string diffing misreported the
		// shifted diagnostic as new and rolled back a correct fix (#128).
		const dir = await makeMockFixture("shifted-preexisting", {
			"mod.ts": "export const foo = 1;\n",
			"mod.test.ts": `
				declare const vi: {
					fn(): unknown;
					mock(specifier: string, factory: () => Record<string, unknown>): void;
				};
				vi.mock("./mod", () => ({ foo: vi.fn(), baz: vi.fn() })); const wrong: number = "shifted";
			`,
		});

		try {
			const fix = await captureOutput(async () =>
				mockCleanupCommand({
					directory: dir,
					fix: true,
					force: true,
					json: true,
				})
			);
			const result = JSON.parse(fix.stdout);
			expect(result.success).toBe(true);
			expect(result.rolledBack).toBe(false);

			const next = await Bun.file(path.join(dir, "mod.test.ts")).text();
			expect(next).not.toContain("baz");
			expect(next).toContain('const wrong: number = "shifted"');
		} finally {
			await cleanup(dir);
		}
	});

	test("preserves dirty edits when forced verification fails", async () => {
		const dir = await makeMockFixture("forced-dirty-failure", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					types: ["missing-resect-test-types"],
				},
				include: ["**/*.ts"],
			}),
			"mod.ts": "export const foo = 1;\n",
			"mod.test.ts": `
				declare const vi: {
					fn(): unknown;
					mock(specifier: string, factory: () => Record<string, unknown>): void;
				};
				vi.mock("./mod", () => ({ foo: vi.fn(), baz: vi.fn() }));
			`,
		});

		try {
			await initializeGitRepository(dir, {
				branch: "main",
				commitMessage: "fixture",
			});
			const testPath = path.join(dir, "mod.test.ts");
			await Bun.write(
				testPath,
				`${await Bun.file(testPath).text()}// dirty user edit\n`
			);

			const fix = await runCli([
				"mock-cleanup",
				dir,
				"--fix",
				"--force",
				"--json",
			]);
			const result = JSON.parse(fix.stdout) as {
				success: boolean;
				rolledBack: boolean;
				worktreeDirtyRollbackDisabled: boolean;
			};
			expect(result.success).toBe(false);
			expect(result.rolledBack).toBe(false);
			expect(result.worktreeDirtyRollbackDisabled).toBe(true);
			expect(fix.stderr).toContain("mock-cleanup rollback is disabled");
			const contents = await Bun.file(testPath).text();
			expect(contents).toContain("// dirty user edit");
			expect(contents).not.toContain("baz");
		} finally {
			await cleanup(dir);
		}
	});

	test("reports spread factories as skipped and leaves fix as a no-op", async () => {
		const dir = await makeMockFixture("spread", {
			"mod.ts": "export const foo = 1;\n",
			"mod.test.ts": `
				declare const vi: {
					fn(): unknown;
					mock(specifier: string, factory: () => Record<string, unknown>): void;
				};
				const actual = { foo: 1 };
				vi.mock("./mod", () => ({ ...actual, baz: vi.fn() }));
			`,
		});

		try {
			const audit = await captureOutput(async () =>
				mockCleanupCommand({ directory: dir, json: true })
			);
			const report = JSON.parse(audit.stdout);
			expect(report.orphans).toHaveLength(0);
			expect(report.skipped).toHaveLength(1);
			expect(report.skipped[0].reason).toBe("spread");

			const before = await Bun.file(path.join(dir, "mod.test.ts")).text();
			await captureOutput(async () =>
				mockCleanupCommand({
					directory: dir,
					fix: true,
					force: true,
					json: true,
				})
			);
			const after = await Bun.file(path.join(dir, "mod.test.ts")).text();
			expect(after).toBe(before);
		} finally {
			await cleanup(dir);
		}
	});

	test("leaves the mock call in place when removing every factory key", async () => {
		const dir = await makeMockFixture("empty-factory", {
			"mod.ts": "export const foo = 1;\n",
			"mod.test.ts": `
				declare const jest: {
					fn(): unknown;
					mock(specifier: string, factory: () => Record<string, unknown>): void;
				};
				jest.mock("./mod", () => ({ baz: jest.fn() }));
			`,
		});

		try {
			await captureOutput(async () =>
				mockCleanupCommand({
					directory: dir,
					fix: true,
					force: true,
					json: true,
				})
			);

			const next = await Bun.file(path.join(dir, "mod.test.ts")).text();
			expect(next).toContain('jest.mock("./mod", () => ({}));');
			expect(next).not.toContain("baz");
		} finally {
			await cleanup(dir);
		}
	});

	test("MCP tool is registered with dryRun default behavior", async () => {
		// Registrations moved to per-domain modules in #187; they sit inside
		// `register<Domain>Tools(server)`, hence the extra tab.
		const registrationSource = await readRegistrationSource();
		const toolSource = await Bun.file(
			path.resolve(import.meta.dir, "../mcp-tools/read-only.ts")
		).text();

		expect(registrationSource).toContain(
			'\tserver.registerTool(\n\t\t"mock-cleanup"'
		);
		expect(toolSource).toContain("const dryRun = options.dryRun ?? true");
	});

	test("missing directory argument exits with error", async () => {
		const proc = Bun.spawn([...CLI, "mock-cleanup"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;

		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("mock-cleanup requires a <directory> argument");
	});
});
