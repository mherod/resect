import { describe, expect, setDefaultTimeout, test } from "bun:test";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { makeFixture } from "./commands/__test-helpers.ts";
import { moveTool } from "./mcp-tools/mutating.ts";

setDefaultTimeout(20_000);

interface MovePayload {
	success: boolean;
	typecheck?: {
		success: boolean;
		errorsBefore: string[];
		newErrors: string[];
	};
}

function parsePayload(result: CallToolResult): MovePayload {
	const content = result.content[0];
	if (content?.type !== "text") {
		throw new Error("Expected an MCP text result");
	}
	return JSON.parse(content.text) as MovePayload;
}

describe("MCP move verification", () => {
	test("moving a file preserves the identity of its pre-existing diagnostics", async () => {
		const dir = await makeFixture(
			"mcp-move-verify-preexisting",
			{
				"src/foo.ts":
					'export const bad: string = 123;\nexport const ok = "hello";\n',
				"src/consumer.ts": 'import { ok } from "./foo";\nconsole.log(ok);\n',
			},
			{ outsideRepo: true, tsconfig: true }
		);

		const source = path.join(dir, "src/foo.ts");
		const target = path.join(dir, "src/moved/foo.ts");
		const result = parsePayload(
			await moveTool({
				source,
				target,
				project: path.join(dir, "tsconfig.json"),
				dryRun: false,
				force: false,
				verify: true,
				verbose: false,
			})
		);

		expect(result.success).toBe(true);
		expect(result.typecheck?.errorsBefore).toHaveLength(1);
		expect(result.typecheck?.newErrors).toHaveLength(0);
		expect(result.typecheck?.success).toBe(true);
		expect(await Bun.file(target).exists()).toBe(true);
		expect(await Bun.file(source).exists()).toBe(false);
	});
});
