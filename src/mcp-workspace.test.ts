import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
	captureOutput,
	makeFixture,
	parseMcpTextPayload,
} from "./commands/__test-helpers.ts";
import { auditCommand } from "./commands/audit.ts";
import { renameTool } from "./mcp-tools/mutating.ts";
import { auditTool } from "./mcp-tools/read-only.ts";

const fixtureDirs: string[] = [];

afterAll(async () => {
	for (const dir of fixtureDirs) {
		await rm(dir, { recursive: true, force: true });
	}
});

async function makeWorkspaceFixture(name: string): Promise<string> {
	const dir = await makeFixture(
		name,
		{
			"package.json": JSON.stringify({
				private: true,
				workspaces: ["packages/*"],
			}),
			"packages/core/package.json": JSON.stringify({ name: "@fixture/core" }),
			"packages/core/tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["src/**/*.ts"],
			}),
			"packages/core/src/value.ts": "export const oldName = 1;\n",
			"packages/app/package.json": JSON.stringify({ name: "@fixture/app" }),
			"packages/app/tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["src/**/*.ts"],
			}),
			"packages/app/src/use.ts":
				'import { oldName } from "../../core/src/value";\nexport const used = oldName;\n',
		},
		{ outsideRepo: true }
	);
	fixtureDirs.push(dir);
	return dir;
}

describe("MCP workspace parity (#215)", () => {
	test("audit workspace output matches the CLI workspace report", async () => {
		const dir = await makeWorkspaceFixture("mcp-audit-workspace");
		const project = path.join(dir, "packages/core/tsconfig.json");
		const options = {
			directory: dir,
			project,
			workspace: true,
			fanOutThreshold: 0,
			fanInThreshold: 0,
			exportThreshold: 0,
		};
		const cliOutput = await captureOutput(async () => {
			await auditCommand({ ...options, json: true });
		});
		const mcpReport = parseMcpTextPayload<Record<string, unknown>>(
			await auditTool(dir, options)
		);
		const cliReport = JSON.parse(cliOutput.stdout) as Record<string, unknown>;

		expect(mcpReport).toMatchObject(cliReport);
		expect(mcpReport.totalFiles).toBe(2);
		expect(mcpReport.highFanIn).toContainEqual(
			expect.objectContaining({
				file: "packages/core/src/value.ts",
				fanIn: 1,
			})
		);
	});

	test("rename updates a sibling workspace package", async () => {
		const dir = await makeWorkspaceFixture("mcp-rename-workspace");
		const source = path.join(dir, "packages/core/src/value.ts");
		const consumer = path.join(dir, "packages/app/src/use.ts");
		const result = parseMcpTextPayload<{
			success: boolean;
			updatedReferences: Array<{ file: string }>;
		}>(
			await renameTool({
				file: source,
				oldName: "oldName",
				newName: "newName",
				project: path.join(dir, "packages/core/tsconfig.json"),
				workspace: true,
				dryRun: false,
				force: false,
				verify: false,
				verbose: false,
			})
		);

		expect(result.success, JSON.stringify(result)).toBe(true);
		expect(result.updatedReferences).toContainEqual(
			expect.objectContaining({ file: "../app/src/use.ts" })
		);
		expect(await Bun.file(source).text()).toContain("newName");
		expect(await Bun.file(consumer).text()).toContain(
			'import { newName as oldName } from "../../core/src/value"'
		);
	});
});
