import { afterAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { makeTempDir, runGitCommand } from "./commands/__test-helpers.ts";
import { renameTool } from "./mcp-server.ts";

const tempDirs: string[] = [];

afterAll(async () => {
	for (const dir of tempDirs) {
		await rm(dir, { recursive: true, force: true });
	}
});

const DUPLICATE_SOURCE = `
export function formatUser(user: { first: string; last: string }) {
	return (user.first + " " + user.last).trim().toUpperCase();
}

export function combineName(person: { first: string; last: string }) {
	return (person.first + " " + person.last).trim().toUpperCase();
}
`;

interface RenamePayload {
	success: boolean;
	worktreeDirty: boolean;
	errors: Array<{ message: string }>;
}

function parsePayload(result: CallToolResult): RenamePayload {
	const content = result.content[0];
	if (content?.type !== "text") {
		throw new Error("Expected an MCP text result");
	}
	return JSON.parse(content.text) as RenamePayload;
}

async function setupProject(): Promise<{ dir: string; filePath: string }> {
	const dir = await makeTempDir("mcp-rename");
	tempDirs.push(dir);
	await writeFile(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				module: "ESNext",
				moduleResolution: "Bundler",
				noEmit: true,
				strict: true,
				target: "ESNext",
				types: [],
			},
			include: ["**/*.ts"],
		})
	);
	const filePath = path.join(dir, "mod.ts");
	await writeFile(filePath, DUPLICATE_SOURCE);
	await runGitCommand(dir, ["init", "--template="]);
	await runGitCommand(dir, ["add", "."]);
	await runGitCommand(dir, [
		"-c",
		"user.name=Resect Test",
		"-c",
		"user.email=resect@example.invalid",
		"commit",
		"-m",
		"initial",
	]);
	return { dir, filePath };
}

const runMcpRename = async (
	filePath: string,
	force: boolean
): Promise<CallToolResult> => {
	const result = await renameTool({
		file: filePath,
		oldName: "formatUser",
		newName: "combineName",
		dryRun: true,
		force,
		verify: false,
		verbose: false,
	});
	return result;
};

describe("MCP rename force handling", () => {
	test("force=false blocks a conflicting rename", async () => {
		const { filePath } = await setupProject();
		const result = parsePayload(await runMcpRename(filePath, false));

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toContain("--force");
	});

	test("force=true reaches the rename conflict override", async () => {
		const { filePath } = await setupProject();
		const result = parsePayload(await runMcpRename(filePath, true));

		expect(result.success).toBe(true);
	});

	test("dirty-worktree force semantics remain unchanged", async () => {
		const { filePath } = await setupProject();
		await writeFile(filePath, `${DUPLICATE_SOURCE}\n// dirty\n`);

		const blocked = await runMcpRename(filePath, false);
		expect(blocked.isError).toBe(true);
		expect(blocked.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Working tree has uncommitted changes"),
		});

		const forced = parsePayload(await runMcpRename(filePath, true));
		expect(forced.worktreeDirty).toBe(true);
		expect(forced.success).toBe(true);
	});
});
