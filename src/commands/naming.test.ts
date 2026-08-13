import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readRegistrationSource } from "../mcp-tools/registration-test-helpers.ts";
import {
	captureOutput,
	cleanup,
	makeStrictFixture as makeFixture,
	makeGitFixture,
	runCli,
} from "./__test-helpers";
import { namingCommand } from "./naming.ts";

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

const NEXT_METADATA_CODE_FILES = [
	"apple-icon.tsx",
	"icon.tsx",
	"manifest.ts",
	"robots.ts",
] as const;

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

	test("NAM-001: --case flags every file outside the target casing", async () => {
		const dir = await makeFixture("target-case", {
			...withFiles(PASCAL_FUNCTION_NAMES, functionFile),
			"src/group/already-kebab.ts": functionFile("alreadyKebab"),
		});

		const result = await captureOutput(async () =>
			namingCommand({
				directory: path.join(dir, "src"),
				case: "kebab-case",
				json: true,
			})
		);
		const report = JSON.parse(result.stdout) as {
			findings: Array<{ file: string; suggestedName: string }>;
			summary: { case?: string };
		};

		expect(report.summary.case).toBe("kebab-case");
		expect(report.findings).toHaveLength(PASCAL_FUNCTION_NAMES.length);
		expect(report.findings).toContainEqual(
			expect.objectContaining({
				file: "group/BuildReport.ts",
				suggestedName: "build-report.ts",
			})
		);

		await cleanup(dir);
	});

	// @BDD: ANLY-001-Verified
	// @BDD: ANLY-002-Verified
	test("excludes a custom Next distDir while retaining authored declarations", async () => {
		const dir = await makeFixture("next-generated", {
			"next.config.mjs": "export default { distDir: 'next-build' };\n",
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: [
					"types/**/*.d.ts",
					"next-build/types/**/*.ts",
					"next-build/dev/types/**/*.ts",
				],
			}),
			"types/Authored_Name.d.ts":
				"export interface AuthoredName { id: string }\n",
			"next-build/types/cache-life.d.ts":
				"export declare const cacheLife: string;\n",
			"next-build/dev/types/route-metadata.d.ts":
				"export declare const routeMetadata: string;\n",
		});

		const jsonResult = await captureOutput(async () => {
			await namingCommand({ directory: dir, case: "camelCase", json: true });
		});
		const report = JSON.parse(jsonResult.stdout);
		expect(report.summary.totalFiles).toBe(1);
		expect(report.summary.excludedGeneratedFileCount).toBe(2);
		expect(report.excludedGeneratedFiles).toEqual([
			"next-build/dev/types/route-metadata.d.ts",
			"next-build/types/cache-life.d.ts",
		]);
		expect(report.findings).toEqual([
			expect.objectContaining({ file: "types/Authored_Name.d.ts" }),
		]);
		expect(report.warnings).toContain(
			"Excluded 2 framework-generated TypeScript file(s) from analysis."
		);

		const humanResult = await captureOutput(async () => {
			await namingCommand({ directory: dir, case: "camelCase" });
		});
		expect(humanResult.stdout).toContain(
			"Excluded 2 framework-generated TypeScript file(s) from analysis."
		);

		await cleanup(dir);
	});

	test("NAM-003: --case warns that --majority-threshold is ignored", async () => {
		const dir = await makeFixture("target-warning", {
			"src/group/BuildReport.ts": functionFile("BuildReport"),
		});

		const result = await captureOutput(async () =>
			namingCommand({
				directory: path.join(dir, "src"),
				case: "kebab-case",
				majorityThreshold: 0.9,
				json: true,
			})
		);
		const report = JSON.parse(result.stdout) as { warnings: string[] };

		expect(result.stderr).toContain("--majority-threshold is ignored");
		expect(report.warnings).toContainEqual(
			expect.stringContaining("--majority-threshold is ignored")
		);

		await cleanup(dir);
	});

	test("documents and validates the supported --case values", async () => {
		const help = await runCli(["naming", "--help"]);
		expect(help.exitCode).toBe(0);
		expect(help.stdout).toContain("--case=STYLE");
		expect(help.stdout).toContain(
			"kebab-case, camelCase, PascalCase, or snake_case"
		);

		const invalid = await runCli(["naming", "src", "--case=TitleCase"]);
		expect(invalid.exitCode).toBe(1);
		expect(invalid.stderr).toContain("Error: --case must be");
	});

	test("never suggests a rename equal to the current filename", async () => {
		const dir = await makeFixture("noop-index", {
			...withFiles(CAMEL_NAMES, functionFile),
			"src/group/index.ts": "export const groupIndex = 1;\n",
		});

		const result = await captureOutput(async () =>
			namingCommand({ directory: path.join(dir, "src"), json: true })
		);
		const report = JSON.parse(result.stdout) as {
			findings: Array<{ file: string; suggestedName: string }>;
		};
		for (const finding of report.findings) {
			expect(finding.suggestedName).not.toBe(path.basename(finding.file));
		}
		expect(
			report.findings.some((f) => f.file.endsWith("index.ts"))
		).toBeFalse();

		await cleanup(dir);
	});

	test("exempts Next.js reserved filenames inside an app router tree", async () => {
		const dir = await makeFixture("reserved-app", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { jsx: "preserve", strict: true },
				include: ["**/*.ts", "**/*.tsx"],
			}),
			...withFiles(CAMEL_NAMES, functionFile),
			...Object.fromEntries(
				NEXT_METADATA_CODE_FILES.map((file) => [
					`src/app/${file}`,
					functionFile("metadata"),
				])
			),
			"src/app/not-found.tsx":
				"export default function NotFound() { return null; }\n",
			"src/app/route.ts": "export function GET() { return 1; }\n",
			"src/app/global-error.tsx":
				"export default function GlobalError() { return null; }\n",
			"src/app/my-widget.ts": functionFile("myWidget"),
		});

		const result = await captureOutput(async () =>
			namingCommand({
				directory: path.join(dir, "src"),
				json: true,
				case: "camelCase",
			})
		);
		const report = JSON.parse(result.stdout) as {
			findings: Array<{ file: string }>;
		};
		const flagged = report.findings.map((f) => path.basename(f.file));
		expect(flagged).not.toContain("not-found.tsx");
		expect(flagged).not.toContain("route.ts");
		expect(flagged).not.toContain("global-error.tsx");
		for (const file of NEXT_METADATA_CODE_FILES) {
			expect(flagged).not.toContain(file);
		}

		await cleanup(dir);
	});

	test("keeps metadata stems eligible outside valid App Router locations", async () => {
		const dir = await makeFixture("metadata-nonframework", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { jsx: "preserve", strict: true },
				include: ["**/*.ts", "**/*.tsx"],
			}),
			...Object.fromEntries(
				NEXT_METADATA_CODE_FILES.map((file) => [
					`src/group/${file}`,
					functionFile("metadata"),
				])
			),
			"src/app/blog/manifest.ts": functionFile("manifest"),
			"src/app/blog/robots.ts": functionFile("robots"),
		});

		const result = await captureOutput(async () =>
			namingCommand({
				directory: path.join(dir, "src"),
				case: "PascalCase",
				json: true,
			})
		);
		const report = JSON.parse(result.stdout) as {
			findings: Array<{ file: string; suggestedName: string }>;
		};
		const findings = new Map(
			report.findings.map((finding) => [finding.file, finding.suggestedName])
		);

		expect(findings.get("group/apple-icon.tsx")).toBe("AppleIcon.tsx");
		expect(findings.get("group/icon.tsx")).toBe("Icon.tsx");
		expect(findings.get("group/manifest.ts")).toBe("Manifest.ts");
		expect(findings.get("group/robots.ts")).toBe("Robots.ts");
		expect(findings.get("app/blog/manifest.ts")).toBe("Manifest.ts");
		expect(findings.get("app/blog/robots.ts")).toBe("Robots.ts");

		await cleanup(dir);
	});

	// @BDD: NAM-004-Verified
	test("filters the same metadata findings from JSON and human reports", async () => {
		const dir = await makeFixture("metadata-output-parity", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { jsx: "preserve", strict: true },
				include: ["**/*.ts", "**/*.tsx"],
			}),
			...Object.fromEntries(
				NEXT_METADATA_CODE_FILES.flatMap((file) => [
					[`src/app/${file}`, functionFile("frameworkMetadata")],
					[`src/group/${file}`, functionFile("ordinaryMetadata")],
				])
			),
		});

		const jsonResult = await captureOutput(async () =>
			namingCommand({
				directory: path.join(dir, "src"),
				case: "PascalCase",
				json: true,
			})
		);
		const report = JSON.parse(jsonResult.stdout) as {
			findings: Array<{ file: string; suggestedName: string }>;
		};
		expect(report.findings.map((finding) => finding.file)).toEqual(
			NEXT_METADATA_CODE_FILES.map((file) => `group/${file}`)
		);

		const humanResult = await captureOutput(async () =>
			namingCommand({
				directory: path.join(dir, "src"),
				case: "PascalCase",
			})
		);
		expect(humanResult.stdout).toContain("Summary: 4 finding(s)");
		expect(humanResult.stdout).not.toContain("\napp\n");
		for (const finding of report.findings) {
			expect(humanResult.stdout).toContain(
				`${path.basename(finding.file)} -> ${finding.suggestedName}`
			);
		}

		await cleanup(dir);
	});

	test("keeps reserved stems eligible outside any app router tree", async () => {
		const dir = await makeFixture("reserved-nonframework", {
			...withFiles(CAMEL_NAMES, functionFile),
			"src/group/not-found.ts": functionFile("notFound"),
		});

		const result = await captureOutput(async () =>
			namingCommand({ directory: path.join(dir, "src"), json: true })
		);
		const report = JSON.parse(result.stdout) as {
			findings: Array<{ file: string; suggestedName: string }>;
		};
		const notFound = report.findings.find((f) =>
			f.file.endsWith("not-found.ts")
		);
		expect(notFound?.suggestedName).toBe("notFound.ts");

		await cleanup(dir);
	});

	test("keeps reserved stems eligible inside a package literally named app", async () => {
		const dir = await makeFixture("reserved-app-package", {
			...Object.fromEntries(
				CAMEL_NAMES.map((n) => [`packages/app/lib/${n}.ts`, functionFile(n)])
			),
			"packages/app/lib/not-found.ts": functionFile("notFound"),
		});

		const result = await captureOutput(async () =>
			namingCommand({ directory: path.join(dir, "packages"), json: true })
		);
		const report = JSON.parse(result.stdout) as {
			findings: Array<{ file: string; suggestedName: string }>;
		};
		const notFound = report.findings.find((f) =>
			f.file.endsWith("not-found.ts")
		);
		expect(notFound?.suggestedName).toBe("notFound.ts");

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

	// @BDD: NAM-005-Verified
	test("--fix never plans a no-op or reserved-file rename", async () => {
		const dir = await makeGitFixture("fix-reserved", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { jsx: "preserve", strict: true },
				include: ["**/*.ts", "**/*.tsx"],
			}),
			...withFiles(CAMEL_NAMES, functionFile),
			...Object.fromEntries(
				NEXT_METADATA_CODE_FILES.map((file) => [
					`src/app/${file}`,
					functionFile("metadata"),
				])
			),
			"src/app/not-found.tsx":
				"export default function NotFound() { return null; }\n",
			"src/app/route.ts": "export function GET() { return 1; }\n",
			"src/app/my-widget.ts": functionFile("myWidget"),
		});

		const result = await captureOutput(async () =>
			namingCommand({
				directory: path.join(dir, "src"),
				fix: true,
				dryRun: true,
				json: true,
				case: "PascalCase",
			})
		);
		const out = JSON.parse(result.stdout) as {
			renames: Array<{ from: string; to: string }>;
		};
		for (const rename of out.renames) {
			expect(path.basename(rename.to)).not.toBe(path.basename(rename.from));
		}
		const planned = out.renames.map((r) => path.basename(r.from));
		expect(planned).not.toContain("not-found.tsx");
		expect(planned).not.toContain("route.ts");
		for (const file of NEXT_METADATA_CODE_FILES) {
			expect(planned).not.toContain(file);
		}
		expect(planned).toContain("my-widget.ts");

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

	test("NAM-002: --case --fix renames files and updates importers", async () => {
		const dir = await makeGitFixture("target-fix", {
			"src/components/UserProfile.ts": functionFile("UserProfile"),
			"src/app.ts":
				'import { UserProfile } from "./components/UserProfile";\nexport const app = UserProfile();\n',
		});

		const result = await captureOutput(async () =>
			namingCommand({
				directory: path.join(dir, "src"),
				case: "kebab-case",
				fix: true,
				json: true,
			})
		);
		const out = JSON.parse(result.stdout) as {
			renames: Array<{ from: string; to: string }>;
			success: boolean;
		};

		expect(out.success).toBe(true);
		expect(out.renames).toHaveLength(1);
		expect(
			await hasExactFile(path.join(dir, "src/components/user-profile.ts"))
		).toBe(true);
		expect(await readFile(path.join(dir, "src/app.ts"), "utf8")).toContain(
			'./components/user-profile"'
		);

		await cleanup(dir);
	});

	test("--case --fix supports case-only renames", async () => {
		const dir = await makeGitFixture("target-case-only", {
			"src/UserProfile.ts": functionFile("UserProfile"),
		});

		await captureOutput(async () =>
			namingCommand({
				directory: path.join(dir, "src"),
				case: "camelCase",
				fix: true,
				json: true,
			})
		);

		expect(await hasExactFile(path.join(dir, "src/UserProfile.ts"))).toBe(
			false
		);
		expect(await hasExactFile(path.join(dir, "src/userProfile.ts"))).toBe(true);

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

	test("--fix preserves dirty edits when forced verification fails", async () => {
		const dir = await makeGitFixture("fix-forced-dirty", {
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
		const dirtyPath = path.join(dir, "src/group/alphaOne.ts");
		await Bun.write(
			dirtyPath,
			`${await Bun.file(dirtyPath).text()}// dirty user edit\n`
		);

		const result = await runCli([
			"naming",
			path.join(dir, "src"),
			"--fix",
			"--force",
			"--json",
		]);
		const out = JSON.parse(result.stdout) as {
			success: boolean;
			rolledBack: boolean;
			worktreeDirtyRollbackDisabled: boolean;
		};
		expect(result.exitCode).toBe(1);
		expect(out.success).toBe(false);
		expect(out.rolledBack).toBe(false);
		expect(out.worktreeDirtyRollbackDisabled).toBe(true);
		expect(result.stderr).toContain("naming rollback is disabled");
		expect(await Bun.file(dirtyPath).text()).toContain("// dirty user edit");
		expect(await hasExactFile(path.join(dir, "src/group/BuildReport.ts"))).toBe(
			false
		);
		expect(await hasExactFile(path.join(dir, "src/group/buildReport.ts"))).toBe(
			true
		);

		await cleanup(dir);
	});

	test("--fix keeps renames when a pre-existing error only moves to the renamed path", async () => {
		// Regression for #209: a renamed file re-reports its pre-existing error at
		// the new path; raw-string diffing counted it as new and rolled back a
		// correct rename (#128). translateBeforeFile maps old -> new.
		const dir = await makeGitFixture("fix-shifted-preexisting", {
			"src/group/BuildReport.ts": `export function BuildReport() { return "BuildReport"; }\nexport const wrong: number = "pre-existing";\n`,
			...withFiles(CAMEL_NAMES, functionFile),
		});

		const result = await captureOutput(async () =>
			namingCommand({ directory: path.join(dir, "src"), fix: true, json: true })
		);
		const out = JSON.parse(result.stdout) as {
			success: boolean;
			rolledBack: boolean;
		};
		expect(out.success).toBe(true);
		expect(out.rolledBack).toBe(false);
		expect(await hasExactFile(path.join(dir, "src/group/buildReport.ts"))).toBe(
			true
		);
		expect(await hasExactFile(path.join(dir, "src/group/BuildReport.ts"))).toBe(
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

	// ─── convention sampling (#203) ──────────────────────────────────────────
	//
	// A single-word all-lowercase stem matches CAMEL_CASE_PATTERN, so before the
	// fix every such file counted as camelCase evidence. Dogfooding resect on
	// resect surfaced it: src/types/ has 14 single-word files and exactly two
	// multi-word ones, both kebab-case, yet naming reported "88% of sibling
	// files use camelCase" and advised renaming both toward camelCase — a
	// convention with zero instances anywhere in src/.

	/** Stems with no word boundary: valid kebab, camel and snake simultaneously. */
	const SINGLE_WORD_NAMES = [
		"graph",
		"deps",
		"analysis",
		"barrel",
		"commands",
		"impact",
		"inline",
		"move",
		"progress",
		"similar",
		"tidy",
		"transform",
	];

	test("single-word filenames do not create a camelCase majority", async () => {
		// Mirrors src/types/: many ambiguous stems, two multi-word kebab files.
		const dir = await makeFixture("single-word-sample", {
			...withFiles(SINGLE_WORD_NAMES, functionFile),
			"src/group/mock-cleanup.ts": functionFile("mockCleanup"),
			"src/group/test-relocation.ts": functionFile("testRelocation"),
		});

		const result = await captureOutput(async () =>
			namingCommand({ directory: path.join(dir, "src"), json: true })
		);
		const report = JSON.parse(result.stdout);

		expect(report.findings).toHaveLength(0);
		await cleanup(dir);
	});

	test("a single-word filename is never itself a violation", async () => {
		// It conforms to every convention, so no majority can indict it.
		const dir = await makeFixture("single-word-innocent", {
			...withFiles(PASCAL_FUNCTION_NAMES, functionFile),
			"src/group/graph.ts": functionFile("graph"),
		});

		const result = await captureOutput(async () =>
			namingCommand({ directory: path.join(dir, "src"), json: true })
		);
		const report = JSON.parse(result.stdout);
		const flagged = (report.findings as Array<{ file: string }>).map((f) =>
			path.basename(f.file)
		);

		expect(flagged).not.toContain("graph.ts");
		await cleanup(dir);
	});

	test("a real multi-word majority still indicts an outlier", async () => {
		// The fix must not blunt the feature: with genuine camelCase evidence,
		// a kebab-case outlier is still reported.
		const dir = await makeFixture("real-camel-majority", {
			...withFiles(CAMEL_NAMES, functionFile),
			"src/group/mock-cleanup.ts": functionFile("mockCleanup"),
		});

		const result = await captureOutput(async () =>
			namingCommand({ directory: path.join(dir, "src"), json: true })
		);
		const report = JSON.parse(result.stdout);
		const findings = report.findings as Array<{
			file: string;
			siblingCasingMajority: string;
			siblingCount: number;
		}>;

		expect(findings).toHaveLength(1);
		expect(path.basename(findings[0]?.file ?? "")).toBe("mock-cleanup.ts");
		expect(findings[0]?.siblingCasingMajority).toBe("camelCase");
		await cleanup(dir);
	});

	test("the reported denominator counts only discriminating siblings", async () => {
		// "88% of 16" was misleading because 14 of those 16 carried no signal.
		// The percentage and its denominator must both come from the sample the
		// majority was actually inferred from.
		const dir = await makeFixture("discriminating-denominator", {
			...withFiles(CAMEL_NAMES, functionFile),
			...withFiles(SINGLE_WORD_NAMES, functionFile),
			"src/group/mock-cleanup.ts": functionFile("mockCleanup"),
		});

		const result = await captureOutput(async () =>
			namingCommand({ directory: path.join(dir, "src"), json: true })
		);
		const report = JSON.parse(result.stdout);
		const findings = report.findings as Array<{
			siblingCount: number;
			siblingMajorityCount: number;
			siblingMajorityPercent: number;
		}>;

		expect(findings).toHaveLength(1);
		const finding = findings[0];
		if (!finding) {
			throw new Error("expected one finding");
		}
		// CAMEL_NAMES + the kebab outlier discriminate; the single-word stems
		// must not inflate the denominator.
		expect(finding.siblingCount).toBe(CAMEL_NAMES.length + 1);
		expect(finding.siblingMajorityCount).toBe(CAMEL_NAMES.length);
		expect(finding.siblingMajorityPercent).toBeGreaterThan(0.9);
		await cleanup(dir);
	});

	test("an underscore-prefixed file is not renamed to fit a casing majority", async () => {
		// `__test-helpers` marks a test-support file; package.json#files excludes
		// it by that exact prefix, so renaming it would break the exclusion.
		const dir = await makeFixture("underscore-prefixed", {
			...withFiles(CAMEL_NAMES, functionFile),
			"src/group/__test-helpers.ts": functionFile("testHelpers"),
		});

		const result = await captureOutput(async () =>
			namingCommand({ directory: path.join(dir, "src"), json: true })
		);
		const report = JSON.parse(result.stdout);
		const flagged = (report.findings as Array<{ file: string }>).map((f) =>
			path.basename(f.file)
		);

		expect(flagged).not.toContain("__test-helpers.ts");
		await cleanup(dir);
	});

	test("registers the MCP naming tool with fix parameter", async () => {
		// Registrations moved to per-domain modules in #187; they sit inside
		// `register<Domain>Tools(server)`, hence the extra tab.
		const registrationSource = await readRegistrationSource();
		const toolSource = await readFile(
			path.resolve(import.meta.dir, "../mcp-tools/read-only.ts"),
			"utf8"
		);
		expect(registrationSource).toContain(
			'\tserver.registerTool(\n\t\t"naming"'
		);
		expect(toolSource).toContain("buildNamingReport");
		expect(toolSource).toContain("applyNamingFix");
		expect(registrationSource).toContain("fix: z");
		expect(registrationSource).toContain("case: z");
		expect(registrationSource).toContain(".enum(FILENAME_CASING_STYLES)");
	});
});
