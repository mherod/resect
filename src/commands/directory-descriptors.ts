/**
 * Directory-family declarations (discover, workspace, deps) stay zod-free.
 * MCP defaults such as deps' safe `dryRun:true` remain in the tool handlers.
 */
import type {
	OptionDescriptor,
	PositionalDescriptor,
} from "./command-descriptor.ts";
import { MCP_DESCRIPTIONS } from "./mcp-descriptions.ts";

const DISCOVER_HELP_COLUMN = 21;
const DIRECTORY_HELP_COLUMN = 15;

export const DISCOVER_OPTION_DESCRIPTORS = [
	{
		name: "verbose",
		key: "verbose",
		type: "boolean",
		cliHelp: {
			description: "Show detailed file ownership and path aliases",
			column: DISCOVER_HELP_COLUMN,
		},
	},
	{
		name: "workspace",
		key: "workspace",
		type: "boolean",
		cliHelp: {
			description: "Scan across all workspace packages",
			column: DISCOVER_HELP_COLUMN,
		},
	},
	{
		name: "only-related-to",
		key: "onlyRelatedTo",
		type: "string",
		cliHelp: {
			description:
				"Filter file ownership output to a file, folder, or glob pattern",
			column: DISCOVER_HELP_COLUMN,
		},
	},
	{
		name: "json",
		key: "json",
		type: "boolean",
		cliHelp: {
			description: "Output results as JSON",
			column: DISCOVER_HELP_COLUMN,
		},
	},
] as const satisfies readonly OptionDescriptor[];

export const DISCOVER_POSITIONAL_DESCRIPTORS = [
	{
		key: "directory",
		type: "string",
		mcp: { required: true, description: MCP_DESCRIPTIONS.directory.discover },
	},
] as const satisfies readonly PositionalDescriptor[];

export const WORKSPACE_OPTION_DESCRIPTORS = [
	{
		name: "verbose",
		key: "verbose",
		type: "boolean",
		cliHelp: {
			description: "Show detailed export maps",
			column: DIRECTORY_HELP_COLUMN,
		},
	},
	{
		name: "json",
		key: "json",
		type: "boolean",
		cliHelp: {
			description: "Output results as JSON",
			column: DIRECTORY_HELP_COLUMN,
		},
	},
] as const satisfies readonly OptionDescriptor[];

export const WORKSPACE_POSITIONAL_DESCRIPTORS = [
	{
		key: "directory",
		type: "string",
		mcp: { required: true, description: MCP_DESCRIPTIONS.directory.workspace },
	},
] as const satisfies readonly PositionalDescriptor[];

export const DEPS_OPTION_DESCRIPTORS = [
	{
		name: "fix",
		key: "fix",
		type: "boolean",
		cliHelp: {
			description: "Repair manifest and Turbo dependency drift",
			column: DIRECTORY_HELP_COLUMN,
		},
		mcp: {
			description: "Plan or apply dependency contract repairs (default false)",
		},
	},
	{
		name: "dry-run",
		key: "dryRun",
		type: "boolean",
		cliHelp: {
			description: "Preview --fix edits without writing files",
			column: DIRECTORY_HELP_COLUMN,
		},
		mcp: {
			description:
				"Preview repairs without writing files (default true for MCP safety)",
		},
	},
	{
		name: "force",
		key: "force",
		type: "boolean",
		cliHelp: {
			description: "Allow --fix in a dirty git worktree",
			column: DIRECTORY_HELP_COLUMN,
		},
		mcp: { description: MCP_DESCRIPTIONS.force.repairs },
	},
	{
		name: "strict",
		key: "strict",
		type: "boolean",
		cliHelp: {
			description:
				"Exit non-zero when drift, conflicts, or policy issues are found",
			column: DIRECTORY_HELP_COLUMN,
		},
		mcp: {
			description:
				"Return the tool result as an error when drift, conflicts, or policy issues are found",
		},
	},
	{
		name: "json",
		key: "json",
		type: "boolean",
		cliHelp: {
			description: "Output the structured report and planned edits as JSON",
			column: DIRECTORY_HELP_COLUMN,
		},
	},
] as const satisfies readonly OptionDescriptor[];

export const DEPS_POSITIONAL_DESCRIPTORS = [
	{
		key: "directory",
		type: "string",
		mcp: {
			required: true,
			description: MCP_DESCRIPTIONS.directory.dependencies,
		},
	},
] as const satisfies readonly PositionalDescriptor[];
