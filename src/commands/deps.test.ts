import { describe, expect, test } from "bun:test";
import path from "node:path";
import { clearWorkspaceCache } from "../core/workspace.ts";
import { cleanup, makeFixture, runCli } from "./__test-helpers.ts";
import { buildDependencyContractReport, executeDeps } from "./deps.ts";

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

async function makeDepsFixture(
	name: string,
	overrides: { turboDependsOn?: string[] } = {}
): Promise<string> {
	return makeFixture(
		`deps-${name}`,
		{
			"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
			"package.json": json({
				name: "deps-workspace",
				packageManager: "pnpm@11.9.0",
			}),
			"turbo.json": json({
				tasks: {
					"@test/consumer#build": {
						dependsOn: overrides.turboDependsOn ?? [],
					},
				},
			}),
			"packages/schema/package.json": json({
				name: "@test/schema",
				scripts: { build: "tsc" },
			}),
			"packages/provider/package.json": json({
				name: "@test/provider",
				dependencies: {
					"@test/schema": "workspace:*",
					zod: "^4.0.0",
				},
				resect: {
					consumerDependencies: ["@test/schema", "zod"],
				},
			}),
			"packages/consumer/package.json": json({
				name: "@test/consumer",
				dependencies: { "@test/provider": "workspace:*" },
			}),
		},
		{ outsideRepo: true }
	);
}

describe("deps command", () => {
	test("reports manifest and Turbo dependency-contract drift", async () => {
		const dir = await makeDepsFixture("report");
		try {
			const { report } = await buildDependencyContractReport(dir);
			expect(report.summary).toMatchObject({
				policies: 1,
				requirements: 2,
				changes: 2,
				taskChanges: 1,
				conflicts: 0,
				issues: 0,
			});
			expect(report.taskChanges[0]).toMatchObject({
				consumerName: "@test/consumer",
				dependencyName: "@test/schema",
				taskName: "@test/consumer#build",
				turboDependency: "@test/schema#build",
			});
		} finally {
			clearWorkspaceCache();
			await cleanup(dir);
		}
	});

	test("dry-run fix returns structured edits without writing", async () => {
		const dir = await makeDepsFixture("dry-run");
		const manifestPath = path.join(dir, "packages", "consumer", "package.json");
		try {
			const before = await Bun.file(manifestPath).text();
			const result = await executeDeps({
				directory: dir,
				fix: true,
				dryRun: true,
			});
			expect(result.applied).toBe(false);
			expect(result.dryRun).toBe(true);
			expect(result.edits).toHaveLength(2);
			expect(await Bun.file(manifestPath).text()).toBe(before);
		} finally {
			clearWorkspaceCache();
			await cleanup(dir);
		}
	});

	test("applies manifests and Turbo edges then verifies idempotence", async () => {
		const dir = await makeDepsFixture("apply");
		try {
			let refreshCount = 0;
			const result = await executeDeps(
				{ directory: dir, fix: true, force: true },
				{
					refreshLockfile: async (workspace) => {
						refreshCount += 1;
						await Bun.write(
							path.join(workspace.root, "pnpm-lock.yaml"),
							"lockfileVersion: '9.0'\n"
						);
						return {
							command: ["pnpm", "install", "--lockfile-only"],
							lockfilePath: path.join(workspace.root, "pnpm-lock.yaml"),
						};
					},
				}
			);

			expect(result.success).toBe(true);
			expect(result.applied).toBe(true);
			expect(result.modifiedFiles).toEqual([
				"packages/consumer/package.json",
				"pnpm-lock.yaml",
				"turbo.json",
			]);
			expect(refreshCount).toBe(1);
			expect(result.verificationReport?.summary).toMatchObject({
				changes: 0,
				taskChanges: 0,
				conflicts: 0,
				issues: 0,
			});

			const manifest = JSON.parse(
				await Bun.file(
					path.join(dir, "packages", "consumer", "package.json")
				).text()
			);
			expect(manifest.dependencies).toEqual({
				"@test/provider": "workspace:*",
				"@test/schema": "workspace:*",
				zod: "^4.0.0",
			});
			const turbo = JSON.parse(
				await Bun.file(path.join(dir, "turbo.json")).text()
			);
			expect(turbo.tasks["@test/consumer#build"].dependsOn).toEqual([
				"@test/schema#build",
			]);
		} finally {
			clearWorkspaceCache();
			await cleanup(dir);
		}
	});

	test("rolls every planned file back when lockfile refresh fails", async () => {
		const dir = await makeDepsFixture("rollback");
		const manifestPath = path.join(dir, "packages", "consumer", "package.json");
		const turboPath = path.join(dir, "turbo.json");
		try {
			const manifestBefore = await Bun.file(manifestPath).text();
			const turboBefore = await Bun.file(turboPath).text();
			let caught: unknown;
			try {
				await executeDeps(
					{ directory: dir, fix: true, force: true },
					{
						refreshLockfile: async () => {
							throw new Error("simulated lockfile failure");
						},
					}
				);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(Error);
			expect((caught as Error).message).toContain("simulated lockfile failure");
			expect(await Bun.file(manifestPath).text()).toBe(manifestBefore);
			expect(await Bun.file(turboPath).text()).toBe(turboBefore);
		} finally {
			clearWorkspaceCache();
			await cleanup(dir);
		}
	});

	test("does not add explicit Turbo edges when ^build already covers them", async () => {
		const dir = await makeDepsFixture("turbo-caret", {
			turboDependsOn: ["^build"],
		});
		try {
			const { report } = await buildDependencyContractReport(dir);
			expect(report.taskChanges).toEqual([]);
		} finally {
			clearWorkspaceCache();
			await cleanup(dir);
		}
	});

	test("reports malformed Turbo task dependencies and blocks repairs", async () => {
		const dir = await makeDepsFixture("turbo-invalid");
		try {
			await Bun.write(
				path.join(dir, "turbo.json"),
				json({
					tasks: {
						"@test/consumer#build": { dependsOn: "^build" },
					},
				})
			);
			clearWorkspaceCache();
			const { report } = await buildDependencyContractReport(dir);
			expect(report.issues).toHaveLength(1);
			expect(report.issues[0]?.code).toBe("invalid-turbo-config");
			let caught: unknown;
			try {
				await executeDeps({ directory: dir, fix: true, dryRun: true });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(Error);
			expect((caught as Error).message).toContain(
				"fix the policy/configuration"
			);
		} finally {
			clearWorkspaceCache();
			await cleanup(dir);
		}
	});

	test("CLI reports JSON drift and strict mode exits non-zero", async () => {
		const dir = await makeDepsFixture("cli-strict");
		try {
			const report = await runCli(["deps", dir, "--json"]);
			expect(report.exitCode, report.stderr).toBe(0);
			const parsed = JSON.parse(report.stdout);
			expect(parsed.report.summary.changes).toBe(2);
			expect(parsed.report.summary.taskChanges).toBe(1);

			const strict = await runCli(["deps", dir, "--strict", "--json"]);
			expect(strict.exitCode).toBe(1);
			expect(JSON.parse(strict.stdout).success).toBe(false);
		} finally {
			clearWorkspaceCache();
			await cleanup(dir);
		}
	});

	test("CLI requires a workspace directory argument", async () => {
		const result = await runCli(["deps"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("deps requires a <directory> argument");
	});
});
