import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
	captureOutput,
	cleanup,
	makeFixture as makeFixtureBase,
	runCli,
} from "./__test-helpers";
import { namingCommand } from "./naming.ts";

async function makeGitFixture(name: string, files: Record<string, string>) {
	const dir = await makeFixtureBase(`naming-${name}`, files, {
		tsconfig: true,
		outsideRepo: true,
	});
	const gitSetup = Bun.spawn(["git", "init", "-b", "main"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	await gitSetup.exited;
	const gitConfig1 = Bun.spawn(["git", "config", "user.email", "resect-test"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	await gitConfig1.exited;
	const gitConfig2 = Bun.spawn(["git", "config", "user.name", "Test User"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	await gitConfig2.exited;
	const gitAdd = Bun.spawn(["git", "add", "."], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	await gitAdd.exited;
	const gitCommit = Bun.spawn(["git", "commit", "-m", "initial"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	await gitCommit.exited;
	return dir;
}

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

const CAMEL_NAMES = [
	"alphaOne",
	"betaTwo",
	"gammaThree",
	"deltaFour",
	"epsilonFive",
	"zetaSix",
	"etaSeven",
	"thetaEight",
	"iotaNine",
	"kappaTen",
] as const;

const PASCAL_FUNCTION_NAMES = [
	"BuildReport",
	"LoadAccount",
	"ParseConfig",
	"RenderPanel",
] as const;

async function makeFixture(name: string, files: Record<string, string>) {
	return makeFixtureBase(`naming-${name}`, files, { tsconfig: true });
}

function functionFile(name: string): string {
	return `export function ${name}() { return "${name}"; }\n`;
}

function classFile(name: string): string {
	return `export class ${name} { value = "${name}"; }\n`;
}

function withFiles(
	names: readonly string[],
	makeContent: (name: string) => string
) {
	const files: Record<string, string> = {};
	for (const name of names) {
		files[`src/group/${name}.ts`] = makeContent(name);
	}
	return files;
}

describe("naming command", () => {
	test("reports PascalCase function files in a camelCase-majority directory", async () => {
		const dir = await makeFixture("camel-majority", {
			...withFiles(CAMEL_NAMES, functionFile),
			...withFiles(PASCAL_FUNCTION_NAMES, functionFile),
		});

		const result = await captureOutput(async () =>
			namingCommand({ directory: path.join(dir, "src"), json: true })
		);
		const report = JSON.parse(result.stdout);
		expect(report.schemaVersion).toBe("1");
		expect(report.findings).toHaveLength(4);
		expect(report.summary.totalFindings).toBe(4);
		for (const finding of report.findings as Array<{
			currentCasing: string;
			suggestedName: string;
			primaryExportKind: string;
			siblingCasingMajority: string;
		}>) {
			expect(finding.currentCasing).toBe("PascalCase");
			expect(finding.primaryExportKind).toBe("function");
			expect(finding.siblingCasingMajority).toBe("camelCase");
			expect(finding.suggestedName).toStartWith(
				finding.suggestedName.charAt(0).toLowerCase()
			);
		}

		await cleanup(dir);
	});

	test("keeps PascalCase class files when the export kind justifies casing", async () => {
		const dir = await makeFixture("class-justified", {
			...withFiles(CAMEL_NAMES, functionFile),
			"src/group/AccountService.ts": classFile("AccountService"),
		});

		const result = await captureOutput(async () =>
			namingCommand({ directory: path.join(dir, "src"), json: true })
		);
		const report = JSON.parse(result.stdout);
		expect(report.findings).toHaveLength(0);

		await cleanup(dir);
	});

	test("does not report a no-op rename for conventional index files", async () => {
		const dir = await makeFixture("index-no-op", {
			"src/group/alpha-one.ts": functionFile("alphaOne"),
			"src/group/beta-two.ts": functionFile("betaTwo"),
			"src/group/gamma-three.ts": functionFile("gammaThree"),
			"src/group/index.ts": 'export * from "./alpha-one";\n',
		});

		const result = await captureOutput(async () =>
			namingCommand({ directory: path.join(dir, "src"), json: true })
		);
		const report = JSON.parse(result.stdout) as {
			findings: Array<{ file: string; suggestedName: string }>;
		};
		expect(report.findings).not.toContainEqual(
			expect.objectContaining({
				file: "group/index.ts",
				suggestedName: "index.ts",
			})
		);

		await cleanup(dir);
	});

	test("preserves Next App Router convention filenames", async () => {
		const dir = await makeFixture("next-conventions", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { jsx: "preserve", strict: true },
				include: ["**/*.ts", "**/*.tsx"],
			}),
			"src/app/admin/alphaOne.tsx": functionFile("alphaOne"),
			"src/app/admin/betaTwo.tsx": functionFile("betaTwo"),
			"src/app/admin/gammaThree.tsx": functionFile("gammaThree"),
			"src/app/admin/not-found.tsx": functionFile("NotFound"),
		});

		const result = await captureOutput(async () =>
			namingCommand({ directory: path.join(dir, "src"), json: true })
		);
		const report = JSON.parse(result.stdout) as {
			findings: Array<{ file: string }>;
		};
		expect(report.findings.map((finding) => finding.file)).not.toContain(
			"app/admin/not-found.tsx"
		);

		await cleanup(dir);
	});

	test("does not report when no directory casing has a majority", async () => {
		const dir = await makeFixture("no-majority", {
			...withFiles(CAMEL_NAMES.slice(0, 5), functionFile),
			...withFiles(
				[
					"BuildReport",
					"LoadAccount",
					"ParseConfig",
					"RenderPanel",
					"SyncStore",
				],
				functionFile
			),
		});

		const result = await captureOutput(async () =>
			namingCommand({ directory: path.join(dir, "src"), json: true })
		);
		const report = JSON.parse(result.stdout);
		expect(report.findings).toHaveLength(0);

		await cleanup(dir);
	});

	test("honors --majority-threshold", async () => {
		const dir = await makeFixture("threshold", {
			...withFiles(CAMEL_NAMES, functionFile),
			...withFiles(PASCAL_FUNCTION_NAMES, functionFile),
		});

		const result = await captureOutput(async () =>
			namingCommand({
				directory: path.join(dir, "src"),
				json: true,
				majorityThreshold: 0.8,
			})
		);
		const report = JSON.parse(result.stdout);
		expect(report.findings).toHaveLength(0);

		await cleanup(dir);
	});

	test("prints a grouped human-readable report", async () => {
		const dir = await makeFixture("human", {
			...withFiles(CAMEL_NAMES, functionFile),
			...withFiles(PASCAL_FUNCTION_NAMES, functionFile),
		});

		const result = await captureOutput(async () =>
			namingCommand({ directory: path.join(dir, "src") })
		);
		expect(result.stdout).toContain("Naming Report");
		expect(result.stdout).toContain("group");
		expect(result.stdout).toContain("BuildReport.ts -> buildReport.ts");

		await cleanup(dir);
	});

	test("--fix --dry-run lists planned renames without applying them", async () => {
		const dir = await makeGitFixture("fix-dryrun", {
			"src/group/BuildReport.ts": functionFile("BuildReport"),
			"src/group/LoadAccount.ts": functionFile("LoadAccount"),
			"src/group/ParseConfig.ts": functionFile("ParseConfig"),
			"src/group/RenderPanel.ts": functionFile("RenderPanel"),
			...withFiles(CAMEL_NAMES, functionFile),
		});

		const result = await captureOutput(async () =>
			namingCommand({
				directory: path.join(dir, "src"),
				fix: true,
				dryRun: true,
				json: true,
			})
		);
		const out = JSON.parse(result.stdout) as {
			renames: Array<{ from: string; to: string }>;
			dryRun: boolean;
		};
		expect(out.dryRun).toBe(true);
		expect(out.renames.length).toBeGreaterThan(0);

		// Files must not have been renamed
		expect(await hasExactFile(path.join(dir, "src/group/BuildReport.ts"))).toBe(
			true
		);
		expect(await hasExactFile(path.join(dir, "src/group/buildReport.ts"))).toBe(
			false
		);

		await cleanup(dir);
	});

	test("--fix renames a single PascalCase file in a camelCase-majority directory", async () => {
		const dir = await makeGitFixture("fix-single", {
			"src/group/BuildReport.ts": functionFile("BuildReport"),
			...withFiles(CAMEL_NAMES, functionFile),
		});

		const result = await captureOutput(async () =>
			namingCommand({ directory: path.join(dir, "src"), fix: true, json: true })
		);
		const out = JSON.parse(result.stdout) as {
			success: boolean;
			renames: Array<{ from: string; to: string }>;
		};
		expect(out.success).toBe(true);
		expect(out.renames.length).toBe(1);

		expect(await hasExactFile(path.join(dir, "src/group/BuildReport.ts"))).toBe(
			false
		);
		expect(await hasExactFile(path.join(dir, "src/group/buildReport.ts"))).toBe(
			true
		);

		await cleanup(dir);
	});

	test("--fix renames multiple PascalCase files in one pass", async () => {
		const dir = await makeGitFixture("fix-multi", {
			...withFiles(PASCAL_FUNCTION_NAMES, functionFile),
			...withFiles(CAMEL_NAMES, functionFile),
		});

		const result = await captureOutput(async () =>
			namingCommand({ directory: path.join(dir, "src"), fix: true, json: true })
		);
		const out = JSON.parse(result.stdout) as {
			success: boolean;
			renames: Array<{ from: string; to: string }>;
		};
		expect(out.success).toBe(true);
		expect(out.renames.length).toBe(PASCAL_FUNCTION_NAMES.length);

		for (const name of PASCAL_FUNCTION_NAMES) {
			const lower = `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
			expect(await hasExactFile(path.join(dir, `src/group/${name}.ts`))).toBe(
				false
			);
			expect(await hasExactFile(path.join(dir, `src/group/${lower}.ts`))).toBe(
				true
			);
		}

		await cleanup(dir);
	});

	test("--fix rolls back when closing typecheck cannot complete", async () => {
		const dir = await makeGitFixture("fix-rollback", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					types: ["missing-resect-test-types"],
				},
				include: ["**/*.ts"],
			}),
			"src/group/BuildReport.ts": functionFile("BuildReport"),
			...withFiles(CAMEL_NAMES, functionFile),
		});

		const result = await runCli([
			"naming",
			path.join(dir, "src"),
			"--fix",
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		const out = JSON.parse(result.stdout) as {
			success: boolean;
			rolledBack: boolean;
		};
		expect(out.success).toBe(false);
		expect(out.rolledBack).toBe(true);

		// Rollback must restore the original file and remove the renamed one.
		expect(await hasExactFile(path.join(dir, "src/group/BuildReport.ts"))).toBe(
			true
		);
		expect(await hasExactFile(path.join(dir, "src/group/buildReport.ts"))).toBe(
			false
		);

		await cleanup(dir);
	});

	test("--fix refuses on dirty worktree without --force", async () => {
		const dir = await makeGitFixture("fix-dirty", {
			"src/group/BuildReport.ts": functionFile("BuildReport"),
			...withFiles(CAMEL_NAMES, functionFile),
		});
		// Make the worktree dirty
		await Bun.write(
			path.join(dir, "src/group/alphaOne.ts"),
			`// dirty\n${functionFile("alphaOne")}`
		);

		const result = await runCli(["naming", path.join(dir, "src"), "--fix"]);
		expect(result.exitCode).toBe(1);

		await cleanup(dir);
	});

	test("registers the MCP naming tool with fix parameter", async () => {
		const serverSource = await readFile(
			path.resolve(import.meta.dir, "../mcp-server.ts"),
			"utf8"
		);
		expect(serverSource).toContain('server.registerTool(\n\t"naming"');
		expect(serverSource).toContain("buildNamingReport");
		expect(serverSource).toContain("applyNamingFix");
		expect(serverSource).toContain("fix: z");
	});
});
