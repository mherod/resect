/**
 * Shared helpers for the resect MCP tool implementations.
 *
 * This module is a dependency of both `src/mcp-tools/read-only.ts` and
 * `src/mcp-server.ts`, so it must never import the server — keeping the
 * dependency direction one-way avoids an import cycle (#185).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isWorktreeDirty } from "../core/git.ts";
import {
	loadResectConfig,
	type ResolvedResectConfig,
	resolveResectConfig,
} from "../core/project-config.ts";

// ── Mutating-tool helpers ──────────────────────────────────────────

/** Structured worktree check that does NOT call process.exit on dirty. */
export async function checkWorktree(
	cwd: string,
	force: boolean
): Promise<{ dirty: boolean; blocked: boolean }> {
	const dirty = await isWorktreeDirty(cwd);
	return { dirty, blocked: dirty && !force };
}

/** Error message returned by mutating tools when the worktree is dirty and force is off. */
export const WORKTREE_BLOCKED_MESSAGE =
	"Working tree has uncommitted changes. Commit/stash first, or rerun with force=true.";

// ── Result helpers ──────────────────────────────────────────────────

/** Convert Map/Set values so JSON.stringify produces readable output. */
function mapReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Map) {
		return Object.fromEntries(value);
	}
	if (value instanceof Set) {
		return [...value];
	}
	return value;
}

export function jsonText(data: unknown): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(data, mapReplacer, 2) }],
	};
}

export function errorText(message: string): CallToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/** Format any thrown error as an `isError` tool result. */
export function toError(error: unknown): CallToolResult {
	return errorText(error instanceof Error ? error.message : String(error));
}

/**
 * Run a tool handler, converting any thrown error into an `isError` tool
 * result. Replaces the identical try/catch+toError block every tool
 * registration used to repeat (#138).
 */
export async function withErrorHandling(
	fn: () => Promise<CallToolResult>
): Promise<CallToolResult> {
	try {
		return await fn();
	} catch (error) {
		return toError(error);
	}
}

/** Single source for the "no owning tsconfig" tool error. */
export function tsconfigNotFound(targetPath: string): CallToolResult {
	return errorText(`Could not find tsconfig.json for ${targetPath}`);
}

export async function mcpConfig(
	command: string
): Promise<ResolvedResectConfig> {
	return resolveResectConfig(await loadResectConfig(), command);
}
