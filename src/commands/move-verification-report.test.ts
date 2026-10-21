import { expect, test } from "bun:test";
import path from "node:path";
import { moveTool } from "../mcp-tools/mutating.ts";
import { cleanup, makeFixture, runCli } from "./__test-helpers.ts";

for (const surface of ["cli", "mcp"] as const) {
	test(`${surface} move reports incomplete verification without changing the plain-move policy`, async () => {
		const dir = await makeFixture(
			`move-incomplete-${surface}`,
			{
				"tsconfig.json": JSON.stringify({
					compilerOptions: {
						types: ["resect-deliberately-missing-types"],
						noEmit: true,
					},
					include: ["src/**/*.ts"],
				}),
				"src/value.ts": "export const value = 1;",
				"src/consumer.ts":
					"import { value } from './value'; console.log(value);",
			},
			{ outsideRepo: true }
		);
		try {
			const source = path.join(dir, "src/value.ts");
			const target = path.join(dir, "src/moved/value.ts");
			const project = path.join(dir, "tsconfig.json");
			let text: string;
			if (surface === "cli") {
				const result = await runCli(
					["move", source, target, "-p", project, "--json"],
					{ cwd: dir }
				);
				expect(result.exitCode).toBe(1);
				text = result.stdout;
			} else {
				const result = await moveTool({
					source,
					target,
					project,
					dryRun: false,
					force: false,
					verify: true,
					verbose: false,
				});
				const block = result.content[0];
				if (block?.type !== "text") {
					throw new Error("Expected a text report");
				}
				text = block.text;
			}
			const report = JSON.parse(text);
			expect(report.success).toBe(false);
			expect(report.typecheck.success).toBe(false);
			expect(report.typecheck.verificationIncomplete).toBe(true);
			expect(report.rolledBack).toBe(false);
			expect(report.worktreeDirtyRollbackDisabled).toBe(false);
			expect(await Bun.file(target).exists()).toBe(true);
			expect(await Bun.file(source).exists()).toBe(false);
		} finally {
			await cleanup(dir);
		}
	});
}
