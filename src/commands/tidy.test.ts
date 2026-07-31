import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CLI, cleanup, makeFixture as makeFixtureBase } from "./__test-helpers";

// These tests spawn the CLI subprocess and run tsc --noEmit before+after a fix,
// which can exceed bun's 5s default under full-suite CPU contention. Match the
// canonical suite timeout (package.json `test` uses --timeout=20000) so the
// rollback tests don't flake when the suite is invoked without that flag (e.g.
// the bare `bun test` in .husky/pre-commit).
setDefaultTimeout(20_000);

async function makeFixture(name: string, files: Record<string, string>) {
	return makeFixtureBase(`tidy-${name}`, files, { tsconfig: true });
}

async function makeGitFixture(name: string, files: Record<string, string>) {
	const dir = await makeFixtureBase(`tidy-${name}`, files, {
		tsconfig: true,
		outsideRepo: true,
	});
	await gitCommand(dir, ["init", "-b", "main"]);
	await gitCommand(dir, ["config", "user.email", "resect-test"]);
	await gitCommand(dir, ["config", "user.name", "Test User"]);
	await gitCommand(dir, ["add", "."]);
	await gitCommand(dir, ["commit", "-m", "initial"]);
	return dir;
}

async function gitCommand(cwd: string, args: string[]): Promise<void> {
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
}

const DUPLICATE_A = `
export function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  const date = parts[0];
  return date;
}
`;

const DUPLICATE_B = `
export function formatTimestamp(value: Date): string {
  const str = value.toISOString();
  const segments = str.split("T");
  const result = segments[0];
  return result;
}
`;

const EXPORT_SURFACE = Array.from(
	{ length: 9 },
	(_, index) => `export const value${index} = ${index};`
).join("\n");

describe("tidy command", () => {
	test("requires the experimental flag", async () => {
		const dir = await makeFixture("gate", {
			"src/orphan.ts": "export function orphan() { return 1; }",
		});

		const proc = Bun.spawn([...CLI, "tidy", path.join(dir, "src")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("experimental");

		await cleanup(dir);
	});

	test("emits grouped human-readable report", async () => {
		const dir = await makeFixture("human", {
			"src/orphan.ts": "export function orphan() { return 1; }",
			"src/dup-a.ts": DUPLICATE_A,
			"src/dup-b.ts": DUPLICATE_B,
			"src/surface.ts": EXPORT_SURFACE,
		});

		const proc = Bun.spawn(
			[...CLI, "tidy", path.join(dir, "src"), "--experimental"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("Unused exports");
		expect(stdout).toContain("Similar declarations");
		expect(stdout).toContain("Module health");

		await cleanup(dir);
	});

	test("json contains versioned grouped findings and summary", async () => {
		const dir = await makeFixture("json", {
			"src/orphan.ts": "export function orphan() { return 1; }",
			"src/dup-a.ts": DUPLICATE_A,
			"src/dup-b.ts": DUPLICATE_B,
			"src/surface.ts": EXPORT_SURFACE,
		});

		const proc = Bun.spawn(
			[...CLI, "tidy", path.join(dir, "src"), "--experimental", "--json"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.schemaVersion).toBe("1-experimental");
		expect(report.findings.unused.length).toBeGreaterThan(0);
		expect(report.findings.similar.length).toBeGreaterThan(0);
		expect(report.findings.audit.length).toBeGreaterThan(0);
		expect(report.summary.totalFindings).toBe(
			report.findings.unused.length +
				report.findings.similar.length +
				report.findings.audit.length
		);
		expect(report.summary.filesTouched).toBe(0);

		await cleanup(dir);
	});

	test("scope filters findings to the requested subtree", async () => {
		const dir = await makeFixture("scope", {
			"src/core/cookies/orphan.ts":
				"export function scopedOnly() { return 1; }",
			"src/other/orphan.ts": "export function outsideOnly() { return 2; }",
		});
		const scope = path.join(dir, "src/core/cookies");

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--json",
				"--scope",
				scope,
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.findings.unused.length).toBeGreaterThan(0);
		for (const finding of report.findings.unused as { sourceFile: string }[]) {
			expect(finding.sourceFile).toStartWith("core/cookies/");
		}

		await cleanup(dir);
	});

	test("--out writes the selected report format to disk", async () => {
		const dir = await makeFixture("out", {
			"src/orphan.ts": "export function orphan() { return 1; }",
		});
		const outPath = path.join(dir, "tidy-report.json");

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--json",
				"--out",
				outPath,
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(await readFile(outPath, "utf8"));
		expect(report.schemaVersion).toBe("1-experimental");

		await cleanup(dir);
	});

	test("--fix de-exports internally used unused exports", async () => {
		const dir = await makeGitFixture("fix-de-export", {
			"src/util.ts": `
export function helper() {
	return 1;
}

export function usedInternal() {
	return helper();
}
`,
		});

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.applied).toContainEqual(
			expect.objectContaining({
				category: "dead-exports",
				file: "util.ts",
				mutationKind: "de-export",
				target: "helper",
				wasRolledBack: false,
			})
		);
		expect(report.summary.filesTouched).toBe(1);
		expect(report.typecheckDelta).toEqual(
			expect.objectContaining({
				errorsAfter: 0,
				verificationIncomplete: false,
			})
		);
		const content = await readFile(path.join(dir, "src/util.ts"), "utf8");
		expect(content).toContain("function helper()");
		expect(content).not.toContain("export function helper()");
		expect(content).toContain("export function usedInternal()");

		await cleanup(dir);
	});

	test("--fix --dry-run aggregates structured edits without writing", async () => {
		const dir = await makeGitFixture("fix-preview", {
			"src/util.ts": `
export function helper() {
	return 1;
}

export function usedInternal() {
	return helper();
}
`,
		});
		const file = path.join(dir, "src/util.ts");
		const before = await readFile(file, "utf8");

		const human = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix=dead-exports",
				"--dry-run",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const humanStdout = await new Response(human.stdout).text();
		await human.exited;
		expect(human.exitCode).toBe(0);
		expect(humanStdout).toContain("--- a/util.ts");
		expect(humanStdout).toContain("-export function helper()");
		expect(humanStdout).toContain("+function helper()");

		const json = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix=dead-exports",
				"--dry-run",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const jsonStdout = await new Response(json.stdout).text();
		await json.exited;
		expect(json.exitCode).toBe(0);
		const report = JSON.parse(jsonStdout);
		expect(report.applied).toHaveLength(0);
		expect(report.edits).toHaveLength(1);
		expect(report.edits[0]).toEqual(
			expect.objectContaining({
				file: "util.ts",
				oldText: expect.stringContaining("export function helper()"),
				newText: expect.stringContaining("function helper()"),
			})
		);
		expect(
			before.slice(0, report.edits[0].start) +
				report.edits[0].newText +
				before.slice(report.edits[0].end)
		).not.toContain("export function helper()");
		expect(await readFile(file, "utf8")).toBe(before);

		await cleanup(dir);
	});

	test("--fix refuses a dirty worktree without force", async () => {
		const dir = await makeGitFixture("dirty-refusal", {
			"src/util.ts": `
export function helper() {
	return 1;
}

export function usedInternal() {
	return helper();
}
`,
		});
		const file = path.join(dir, "src/util.ts");
		await writeFile(
			file,
			`${await readFile(file, "utf8")}\nconst dirty = true;\n`
		);

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("working tree has uncommitted changes");
		expect(await readFile(file, "utf8")).toContain("export function helper()");

		await cleanup(dir);
	});

	test("--force bypasses dirty worktree guard and disables rollback warning", async () => {
		const dir = await makeGitFixture("force-dirty", {
			"src/util.ts": `
export function helper() {
	return 1;
}

export function usedInternal() {
	return helper();
}
`,
			"src/dirty.ts": "export const dirty = true;\n",
		});
		await writeFile(
			path.join(dir, "src/dirty.ts"),
			"export const dirty = false;\n"
		);

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix",
				"--force",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stderr).toContain("rollback is disabled");
		const report = JSON.parse(stdout);
		expect(report.summary.filesTouched).toBe(1);
		const content = await readFile(path.join(dir, "src/util.ts"), "utf8");
		expect(content).not.toContain("export function helper()");

		await cleanup(dir);
	});

	test("--max-changes aborts before writing", async () => {
		const dir = await makeGitFixture("max-changes", {
			"src/util.ts": `
export function helperA() {
	return 1;
}

export function helperB() {
	return 2;
}

export function usedInternal() {
	return helperA() + helperB();
}
`,
		});
		const file = path.join(dir, "src/util.ts");
		const before = await readFile(file, "utf8");

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix=dead-exports",
				"--max-changes",
				"1",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("exceeds --max-changes 1");
		const report = JSON.parse(stdout);
		expect(report.applied).toHaveLength(0);
		expect(await readFile(file, "utf8")).toBe(before);

		await cleanup(dir);
	});

	test("--fix rolls back when closing typecheck introduces an error", async () => {
		const dir = await makeGitFixture("rollback", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					module: "esnext",
					target: "es2022",
					strict: true,
				},
				include: ["**/*.ts"],
			}),
			"src/util.ts": `
export function loop(): number {
	return loop();
}

await Promise.resolve();
`,
		});
		const file = path.join(dir, "src/util.ts");

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("tidy rolled back");
		const report = JSON.parse(stdout);
		expect(report.applied).toContainEqual(
			expect.objectContaining({
				target: "loop",
				wasRolledBack: true,
			})
		);
		expect(report.typecheckDelta.newErrors.length).toBeGreaterThan(0);
		expect(await readFile(file, "utf8")).toContain("export function loop");

		await cleanup(dir);
	});

	test("--fix rolls back when typecheck verification is incomplete", async () => {
		const dir = await makeGitFixture("rollback-incomplete", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					types: ["missing-resect-test-types"],
				},
				include: ["**/*.ts"],
			}),
			"src/util.ts": `
export function helper() {
	return 1;
}

export function usedInternal() {
	return helper();
}
`,
		});
		const file = path.join(dir, "src/util.ts");

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("type checking did not complete");
		const report = JSON.parse(stdout);
		expect(report.typecheckDelta.verificationIncomplete).toBe(true);
		expect(report.typecheckDelta.incompleteReason.length).toBeGreaterThan(0);
		expect(report.applied).toContainEqual(
			expect.objectContaining({
				target: "helper",
				wasRolledBack: true,
			})
		);
		expect(await readFile(file, "utf8")).toContain("export function helper");

		await cleanup(dir);
	});

	test("--fix=alias-normalisation rewrites specifiers per --alias-prefer", async () => {
		const dir = await makeGitFixture("alias-normalise", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					baseUrl: ".",
					paths: { "@/*": ["src/*"] },
				},
			}),
			"src/a.ts": "export const a = 1;\n",
			"src/b.ts":
				'import { a } from "./a";\n\nexport function useA() {\n\treturn a;\n}\n',
		});

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix=alias-normalisation",
				"--alias-prefer=alias",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.applied).toContainEqual(
			expect.objectContaining({
				category: "alias-normalisation",
				file: "b.ts",
				mutationKind: "alias-normalise",
				wasRolledBack: false,
			})
		);
		expect(report.typecheckDelta).toEqual(
			expect.objectContaining({ verificationIncomplete: false })
		);
		const content = await readFile(path.join(dir, "src/b.ts"), "utf8");
		expect(content).toContain('from "@/a"');
		expect(content).not.toContain('from "./a"');

		await cleanup(dir);
	});

	test("--fix leaves imports untouched when --alias-prefer is absent", async () => {
		const dir = await makeGitFixture("alias-no-prefer", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					baseUrl: ".",
					paths: { "@/*": ["src/*"] },
				},
			}),
			"src/a.ts": "export const a = 1;\n",
			"src/b.ts":
				'import { a } from "./a";\n\nexport function useA() {\n\treturn a;\n}\n',
		});
		const file = path.join(dir, "src/b.ts");
		const before = await readFile(file, "utf8");

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix=alias-normalisation",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(
			report.applied.some(
				(fix: { category: string }) => fix.category === "alias-normalisation"
			)
		).toBe(false);
		expect(await readFile(file, "utf8")).toBe(before);

		await cleanup(dir);
	});

	test("--max-changes counts alias-normalisation changes and aborts", async () => {
		const dir = await makeGitFixture("alias-max-changes", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					baseUrl: ".",
					paths: { "@/*": ["src/*"] },
				},
			}),
			"src/a.ts": "export const a = 1;\n",
			"src/b.ts":
				'import { a } from "./a";\n\nexport function useAinB() {\n\treturn a;\n}\n',
			"src/c.ts":
				'import { a } from "./a";\n\nexport function useAinC() {\n\treturn a + 1;\n}\n',
		});
		const fileB = path.join(dir, "src/b.ts");
		const before = await readFile(fileB, "utf8");

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix=alias-normalisation",
				"--alias-prefer=alias",
				"--max-changes=1",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("exceeds --max-changes");
		expect(await readFile(fileB, "utf8")).toBe(before);

		await cleanup(dir);
	});

	test("--fix=mock-cleanup removes orphan mock factory keys", async () => {
		const dir = await makeGitFixture("mock-cleanup", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					target: "ESNext",
					module: "Preserve",
					moduleResolution: "bundler",
					skipLibCheck: true,
				},
				include: ["**/*.ts"],
			}),
			"src/mod.ts": "export const foo = 1;\nexport const bar = 2;\n",
			"src/mod.test.ts": `
				declare const vi: {
					fn(): unknown;
					mock(specifier: string, factory: () => Record<string, unknown>): void;
				};
				vi.mock("./mod", () => ({ foo: vi.fn(), bar: vi.fn(), baz: vi.fn() }));
			`,
		});

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix=mock-cleanup",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.applied).toContainEqual(
			expect.objectContaining({
				category: "mock-cleanup",
				file: "mod.test.ts",
				mutationKind: "mock-cleanup",
				wasRolledBack: false,
			})
		);
		expect(report.typecheckDelta).toEqual(
			expect.objectContaining({ verificationIncomplete: false })
		);
		const content = await readFile(path.join(dir, "src/mod.test.ts"), "utf8");
		expect(content).not.toContain("baz");
		expect(content).toContain("foo");

		await cleanup(dir);
	});

	test("bare --fix leaves mock factories untouched (safe-default exclusion)", async () => {
		const dir = await makeGitFixture("mock-cleanup-safe-default", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					target: "ESNext",
					module: "Preserve",
					moduleResolution: "bundler",
					skipLibCheck: true,
				},
				include: ["**/*.ts"],
			}),
			"src/mod.ts": "export const foo = 1;\n",
			"src/mod.test.ts": `
				declare const vi: {
					fn(): unknown;
					mock(specifier: string, factory: () => Record<string, unknown>): void;
				};
				vi.mock("./mod", () => ({ foo: vi.fn(), baz: vi.fn() }));
			`,
		});
		const file = path.join(dir, "src/mod.test.ts");
		const before = await readFile(file, "utf8");

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(
			report.applied.some(
				(fix: { category: string }) => fix.category === "mock-cleanup"
			)
		).toBe(false);
		expect(await readFile(file, "utf8")).toBe(before);

		await cleanup(dir);
	});

	// Case-only renames are invisible to stat() on case-insensitive filesystems
	// (macOS APFS), so compare the exact on-disk basename via a directory listing.
	async function hasExactFile(filePath: string): Promise<boolean> {
		try {
			const entries = await readdir(path.dirname(filePath));
			return entries.includes(path.basename(filePath));
		} catch {
			return false;
		}
	}

	const CASE_RENAME_FILES: Record<string, string> = {
		"tsconfig.json": JSON.stringify({
			compilerOptions: { strict: true, target: "ESNext", module: "Preserve" },
			include: ["**/*.ts"],
		}),
		// camelCase-majority sibling directory + one PascalCase function file.
		"src/group/alphaOne.ts": 'export function alphaOne() { return "a"; }\n',
		"src/group/betaTwo.ts": 'export function betaTwo() { return "b"; }\n',
		"src/group/gammaThree.ts": 'export function gammaThree() { return "g"; }\n',
		"src/group/deltaFour.ts": 'export function deltaFour() { return "d"; }\n',
		"src/group/BuildReport.ts":
			'export function BuildReport() { return "r"; }\n',
		// Consumer in a different directory imports the PascalCase file; its
		// specifier must be rewritten when the file is renamed.
		"src/consumer.ts":
			'import { BuildReport } from "./group/BuildReport";\n\nexport const report = BuildReport();\n',
	};

	test("--fix=case-renames renames the file and rewrites importers", async () => {
		const dir = await makeGitFixture("case-rename-apply", CASE_RENAME_FILES);

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix=case-renames",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.applied).toContainEqual(
			expect.objectContaining({
				category: "case-renames",
				mutationKind: "case-rename",
				target: "BuildReport.ts → buildReport.ts",
				wasRolledBack: false,
			})
		);
		// File renamed on disk (case-only).
		expect(await hasExactFile(path.join(dir, "src/group/BuildReport.ts"))).toBe(
			false
		);
		expect(await hasExactFile(path.join(dir, "src/group/buildReport.ts"))).toBe(
			true
		);
		// Importer specifier rewritten.
		const consumer = await readFile(path.join(dir, "src/consumer.ts"), "utf8");
		expect(consumer).toContain('"./group/buildReport"');
		expect(consumer).not.toContain('"./group/BuildReport"');

		await cleanup(dir);
	});

	test("--fix=case-renames rolls back the move when closing typecheck is incomplete", async () => {
		const dir = await makeGitFixture("case-rename-rollback", {
			...CASE_RENAME_FILES,
			// Unresolvable @types entry makes the closing tsc verification incomplete,
			// forcing a move-aware rollback.
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					target: "ESNext",
					module: "Preserve",
					types: ["missing-resect-test-types"],
				},
				include: ["**/*.ts"],
			}),
		});

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix=case-renames",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("tidy rolled back");
		const report = JSON.parse(stdout);
		expect(report.applied).toContainEqual(
			expect.objectContaining({
				category: "case-renames",
				wasRolledBack: true,
			})
		);
		// The rename was reversed: original PascalCase name restored, new name gone.
		expect(await hasExactFile(path.join(dir, "src/group/BuildReport.ts"))).toBe(
			true
		);
		expect(await hasExactFile(path.join(dir, "src/group/buildReport.ts"))).toBe(
			false
		);
		// Importer specifier restored.
		const consumer = await readFile(path.join(dir, "src/consumer.ts"), "utf8");
		expect(consumer).toContain('"./group/BuildReport"');

		await cleanup(dir);
	});

	test("bare --fix leaves case-renames untouched (safe-default exclusion)", async () => {
		const dir = await makeGitFixture(
			"case-rename-safe-default",
			CASE_RENAME_FILES
		);

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(
			report.applied.some(
				(fix: { category: string }) => fix.category === "case-renames"
			)
		).toBe(false);
		// The PascalCase file is left in place under bare --fix.
		expect(await hasExactFile(path.join(dir, "src/group/BuildReport.ts"))).toBe(
			true
		);
		expect(await hasExactFile(path.join(dir, "src/group/buildReport.ts"))).toBe(
			false
		);

		await cleanup(dir);
	});

	// file-moves: colocation heuristic — a file with exactly one importer in a
	// different directory is a move candidate.
	const FILE_MOVES_FILES: Record<string, string> = {
		"tsconfig.json": JSON.stringify({
			compilerOptions: { strict: true, target: "ESNext", module: "Preserve" },
			include: ["**/*.ts"],
		}),
		// helper.ts lives in utils/ but is only used by feature/consumer.ts.
		"src/utils/helper.ts":
			'export function helper(): string { return "help"; }\n',
		"src/feature/consumer.ts":
			'import { helper } from "../utils/helper";\nexport const result = helper();\n',
	};

	test("--fix=file-moves moves single-importer file next to its consumer", async () => {
		const dir = await makeGitFixture("file-moves-apply", FILE_MOVES_FILES);

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix=file-moves",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.applied).toContainEqual(
			expect.objectContaining({
				category: "file-moves",
				mutationKind: "move",
				wasRolledBack: false,
			})
		);
		// helper.ts relocated from utils/ to feature/.
		expect(await Bun.file(path.join(dir, "src/utils/helper.ts")).exists()).toBe(
			false
		);
		expect(
			await Bun.file(path.join(dir, "src/feature/helper.ts")).exists()
		).toBe(true);
		// consumer.ts specifier rewritten to local sibling.
		const consumer = await Bun.file(
			path.join(dir, "src/feature/consumer.ts")
		).text();
		expect(consumer).toContain('"./helper"');
		expect(consumer).not.toContain('"../utils/helper"');

		await cleanup(dir);
	});

	test("--fix=file-moves rolls back the move when closing typecheck is incomplete", async () => {
		const dir = await makeGitFixture("file-moves-rollback", {
			...FILE_MOVES_FILES,
			// Unresolvable @types entry forces typecheck to be incomplete, triggering
			// move-aware rollback.
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					target: "ESNext",
					module: "Preserve",
					types: ["missing-resect-test-types"],
				},
				include: ["**/*.ts"],
			}),
		});

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix=file-moves",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("tidy rolled back");
		const report = JSON.parse(stdout);
		expect(report.applied).toContainEqual(
			expect.objectContaining({
				category: "file-moves",
				wasRolledBack: true,
			})
		);
		// Move reversed: original path restored.
		expect(await Bun.file(path.join(dir, "src/utils/helper.ts")).exists()).toBe(
			true
		);
		expect(
			await Bun.file(path.join(dir, "src/feature/helper.ts")).exists()
		).toBe(false);

		await cleanup(dir);
	});

	test("bare --fix leaves file-moves untouched (safe-default exclusion)", async () => {
		const dir = await makeGitFixture(
			"file-moves-safe-default",
			FILE_MOVES_FILES
		);

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(
			report.applied.some(
				(fix: { category: string }) => fix.category === "file-moves"
			)
		).toBe(false);
		// helper.ts left in its original location under bare --fix.
		expect(await Bun.file(path.join(dir, "src/utils/helper.ts")).exists()).toBe(
			true
		);

		await cleanup(dir);
	});

	// layout-relocations: organise LCA-based heuristic — a file whose importers
	// all cluster in one subdirectory is a relocation candidate.
	const LAYOUT_RELOC_FILES: Record<string, string> = {
		"tsconfig.json": JSON.stringify({
			compilerOptions: { strict: true, target: "ESNext", module: "Preserve" },
			include: ["**/*.ts"],
		}),
		// util.ts lives in shared/ but all importers are in calc/.
		"src/shared/util.ts":
			'export function util(): string { return "utility"; }\n',
		"src/calc/a.ts":
			'import { util } from "../shared/util";\nexport const a = util();\n',
		"src/calc/b.ts":
			'import { util } from "../shared/util";\nexport const b = util() + "!";\n',
	};

	test("--fix=layout-relocations moves LCA-misplaced file next to its consumers", async () => {
		const dir = await makeGitFixture("layout-reloc-apply", LAYOUT_RELOC_FILES);

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix=layout-relocations",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.applied).toContainEqual(
			expect.objectContaining({
				category: "layout-relocations",
				mutationKind: "move",
				wasRolledBack: false,
			})
		);
		// util.ts relocated from shared/ to calc/.
		expect(await Bun.file(path.join(dir, "src/shared/util.ts")).exists()).toBe(
			false
		);
		expect(await Bun.file(path.join(dir, "src/calc/util.ts")).exists()).toBe(
			true
		);
		// Importer specifiers rewritten to local sibling.
		const aContent = await Bun.file(path.join(dir, "src/calc/a.ts")).text();
		expect(aContent).toContain('"./util"');
		expect(aContent).not.toContain('"../shared/util"');

		await cleanup(dir);
	});

	test("--fix=layout-relocations rolls back when closing typecheck is incomplete", async () => {
		const dir = await makeGitFixture("layout-reloc-rollback", {
			...LAYOUT_RELOC_FILES,
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					target: "ESNext",
					module: "Preserve",
					types: ["missing-resect-test-types"],
				},
				include: ["**/*.ts"],
			}),
		});

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix=layout-relocations",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("tidy rolled back");
		const report = JSON.parse(stdout);
		expect(report.applied).toContainEqual(
			expect.objectContaining({
				category: "layout-relocations",
				wasRolledBack: true,
			})
		);
		// Move reversed: original path restored.
		expect(await Bun.file(path.join(dir, "src/shared/util.ts")).exists()).toBe(
			true
		);
		expect(await Bun.file(path.join(dir, "src/calc/util.ts")).exists()).toBe(
			false
		);

		await cleanup(dir);
	});

	test("bare --fix leaves layout-relocations untouched (safe-default exclusion)", async () => {
		const dir = await makeGitFixture(
			"layout-reloc-safe-default",
			LAYOUT_RELOC_FILES
		);

		const proc = Bun.spawn(
			[
				...CLI,
				"tidy",
				path.join(dir, "src"),
				"--experimental",
				"--fix",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(
			report.applied.some(
				(fix: { category: string }) => fix.category === "layout-relocations"
			)
		).toBe(false);
		// util.ts left in its original location under bare --fix.
		expect(await Bun.file(path.join(dir, "src/shared/util.ts")).exists()).toBe(
			true
		);

		await cleanup(dir);
	});
});
