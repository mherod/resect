import { describe, expect, test } from "bun:test";
import { COMMANDS } from "./commands/registry.ts";
import type { NamingOptions } from "./index.ts";

/**
 * Entry-point parity guard.
 *
 * resect has three entry points — the CLI (registry `COMMANDS`), the MCP
 * server, and the programmatic library API (`src/index.ts`). The library API
 * must expose every command the CLI registers, so a consumer importing
 * `@mherod/resect` can drive the same surface the CLI does. This test fails if
 * a command is added to the CLI registry without a matching `<name>Command`
 * export from the library API (the gap that left `unused`/`barrel` CLI/MCP-only).
 */
const toCommandExport = (kebabName: string): string => {
	const camel = kebabName.replace(/-([a-z])/g, (_, c: string) =>
		c.toUpperCase()
	);
	return `${camel}Command`;
};

describe("library API / CLI parity", () => {
	for (const { name } of COMMANDS) {
		const exportName = toCommandExport(name);
		test(`exports ${exportName} for the "${name}" command`, async () => {
			const api: Record<string, unknown> = await import("./index.ts");
			expect(typeof api[exportName]).toBe("function");
		});
	}

	test("naming options expose the explicit case target", () => {
		const options: NamingOptions = {
			directory: "src",
			case: "kebab-case",
		};
		expect(options.case).toBe("kebab-case");
	});
});
