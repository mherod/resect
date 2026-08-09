#!/usr/bin/env bun

/**
 * resect MCP server — exposes resect's analysis and refactoring capabilities as
 * Model Context Protocol tools over stdio.
 *
 * This module owns server construction, the register calls, and `main()`.
 * Everything else lives under `./mcp-tools/`:
 *
 *  - `register-analysis.ts`, `register-hygiene.ts`, `register-mutation.ts` own
 *    the tool names, descriptions, and Zod input schemas (#187).
 *  - `read-only.ts` (#185) and `mutating.ts` (#186) own the implementations.
 *  - `shared.ts` owns the guard, result, and error-handling helpers.
 *
 * None of those modules imports this one, so the dependency direction stays
 * one-way and the registration modules can be tested in isolation.
 *
 * Design notes:
 *  - A stdio MCP server speaks JSON-RPC on stdout, so NOTHING may be written to
 *    stdout except the transport itself. The tool modules deliberately call the
 *    data-returning functions (`search`, `analyze`, `buildAuditReport`,
 *    `moveModule`, `renameSymbol`, `normalizeImports`, …) rather than the
 *    `*Command` wrappers, which print via the `logger` (stdout) and call
 *    `process.exit()` on bad input — both fatal here.
 *  - Every tool handler is wrapped in `withErrorHandling` so failures become an
 *    `isError` result instead of throwing/exiting and killing the server.
 *  - Mutating tools (`move`, `rename`, `alias`) default to `dryRun: true` so
 *    callers always preview the diff first. When `dryRun` is false and
 *    `verify` is on (the default), each tool runs `tsc --noEmit` before AND
 *    after applying changes; the diagnostic delta is included in the result
 *    so the caller can see exactly which errors the refactor introduced or
 *    fixed. That defaulting is applied at each registration, so it is visible
 *    beside the schema that documents it.
 *  - Mutating tools use `isWorktreeDirty` (not `ensureCleanWorktree`, which
 *    calls `process.exit`). A dirty worktree becomes a structured error
 *    unless `force: true` is set.
 *  - `extract-common` is exposed via `runExtractCommon` with the same
 *    `dryRun: true` default and structured-result contract as the other
 *    mutating tools (#60).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { version } from "../package.json";
import { registerAnalysisTools } from "./mcp-tools/register-analysis.ts";
import { registerHygieneTools } from "./mcp-tools/register-hygiene.ts";
import { registerMutationTools } from "./mcp-tools/register-mutation.ts";

// Re-exported for the tests that import these from the server entry:
// `src/mcp-entrypoints.test.ts`, `src/mcp-rename.test.ts`, and
// `src/mcp-schema-parity.test.ts`. The definitions live in
// `./mcp-tools/read-only.ts` (#185), `./mcp-tools/mutating.ts` (#186), and
// `./mcp-tools/register-mutation.ts` (#187).
export { renameTool } from "./mcp-tools/mutating.ts";
export { analyzeTool, unusedTool } from "./mcp-tools/read-only.ts";
export { renameSpecifierInputSchema } from "./mcp-tools/register-mutation.ts";

// ── Server wiring ───────────────────────────────────────────────────

const server = new McpServer({ name: "resect", version });

registerAnalysisTools(server);
registerHygieneTools(server);
registerMutationTools(server);

async function main(): Promise<void> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	process.stderr.write(`resect MCP server v${version} running on stdio\n`);
}

/**
 * Boot the stdio server and report fatal startup errors.
 *
 * `bin/resect-mcp.js` imports this module rather than executing it, so
 * `import.meta.main` is false there and the guard below never fires. The bin
 * shim calls this directly; the guard keeps `bun src/mcp-server.ts` and the
 * compiled `bin/resect-mcp-bin` working while leaving test imports inert.
 */
export function runMain(): void {
	main().catch((error) => {
		process.stderr.write(
			`Fatal error: ${error instanceof Error ? error.stack : String(error)}\n`
		);
		process.exit(1);
	});
}

if (import.meta.main) {
	runMain();
}
