/** Query declarations stay zod-free; CLI requirements never constrain MCP inputs. */
import type {
	OptionDescriptor,
	PositionalDescriptor,
} from "./command-descriptor.ts";
import { MCP_DESCRIPTIONS } from "./mcp-descriptions.ts";
import { FIND_TYPES } from "./option-domains.ts";

export const FIND_OPTION_DESCRIPTORS = [
	{
		name: "project",
		key: "project",
		type: "string",
		short: "p",
		cliRequired: {
			message: "Error: find requires -p <project> option",
			usageCommand: "find",
		},
		cliHelp: {
			description: "Path to project directory (required)",
			column: 21,
		},
		mcp: { required: true, description: MCP_DESCRIPTIONS.project.required },
	},
	{
		name: "type",
		key: "type",
		type: "enum",
		domain: FIND_TYPES,
		short: "t",
		cliInvalidMessage: "Error: --type must be 'file', 'export', or 'all'",
		cliHelp: {
			description: "Filter: file, export, or all (default: all)",
			column: 21,
		},
		mcp: {
			description:
				"Restrict matches: 'file' = filenames only, 'export' = exported symbol names only, 'all' = both (default 'all')",
		},
	},
	{
		name: "verbose",
		key: "verbose",
		type: "boolean",
		cliHelp: { description: "Show helpful tips for next steps", column: 21 },
	},
	{
		name: "workspace",
		key: "workspace",
		type: "boolean",
		cliHelp: { description: "Scan across all workspace packages", column: 21 },
	},
	{
		name: "only-related-to",
		key: "onlyRelatedTo",
		type: "string",
		cliHelp: {
			description: "Limit searched files to a file, folder, or glob pattern",
			column: 21,
		},
	},
	{
		name: "json",
		key: "json",
		type: "boolean",
		cliHelp: { description: "Output results as JSON", column: 21 },
	},
] as const satisfies readonly OptionDescriptor[];

export const FIND_POSITIONAL_DESCRIPTORS = [
	{
		key: "query",
		type: "string",
		mcp: {
			required: true,
			description:
				"Symbol or filename fragment, case-insensitive and partial (e.g. 'Entity', 'parseConfig')",
		},
	},
] as const satisfies readonly PositionalDescriptor[];

export const ANALYZE_OPTION_DESCRIPTORS = [
	{
		name: "verbose",
		key: "verbose",
		type: "boolean",
		cliHelp: { description: "Show detailed reference information", column: 21 },
	},
	{
		name: "project",
		key: "project",
		type: "string",
		short: "p",
		cliHelp: {
			description: "Path to project directory or tsconfig.json",
			column: 21,
		},
		mcp: { description: MCP_DESCRIPTIONS.project.analyzeFile },
	},
	{
		name: "workspace",
		key: "workspace",
		type: "boolean",
		cliHelp: { description: "Scan across all workspace packages", column: 21 },
	},
	{
		name: "only-related-to",
		key: "onlyRelatedTo",
		type: "string",
		cliHelp: {
			description:
				"Filter referencedBy results to a file, folder, or glob pattern",
			column: 21,
		},
	},
	{
		name: "entrypoint-globs",
		key: "entrypointGlobs",
		type: "string",
		multiple: true,
		cliHelp: {
			description:
				"Glob pattern(s) for externally dispatched entrypoints; repeatable",
			column: 21,
		},
		mcp: {
			description:
				"Optional glob pattern(s) for filename-dispatched entrypoints whose exports should be treated as externally consumed",
			cardinality: "scalar-or-array",
		},
	},
	{
		name: "json",
		key: "json",
		type: "boolean",
		cliHelp: { description: "Output results as JSON", column: 21 },
	},
] as const satisfies readonly OptionDescriptor[];

export const ANALYZE_POSITIONAL_DESCRIPTORS = [
	{
		key: "file",
		type: "string",
		mcp: {
			required: true,
			description:
				"Absolute or cwd-relative path to the single source file to analyze (e.g. 'src/core/graph.ts')",
		},
	},
] as const satisfies readonly PositionalDescriptor[];

export const ANALYZE_IMPACT_OPTION_DESCRIPTORS = [
	{
		name: "verbose",
		key: "verbose",
		type: "boolean",
		cliHelp: {
			description: "Show resolved source/target paths",
			column: 18,
			order: 2,
		},
	},
	{
		name: "project",
		key: "project",
		type: "string",
		short: "p",
		cliHelp: {
			description: "Path to project directory or tsconfig.json",
			column: 18,
			order: 0,
		},
		mcp: { description: MCP_DESCRIPTIONS.project.analyzeSource },
	},
	{
		name: "workspace",
		key: "workspace",
		type: "boolean",
		cliHelp: {
			description: "Scan across all workspace packages",
			column: 18,
			order: 1,
		},
	},
	{
		name: "json",
		key: "json",
		type: "boolean",
		cliHelp: { description: "Output results as JSON", column: 18, order: 3 },
	},
] as const satisfies readonly OptionDescriptor[];

export const ANALYZE_IMPACT_POSITIONAL_DESCRIPTORS = [
	{
		key: "source",
		type: "string",
		mcp: {
			required: true,
			description:
				"Absolute or cwd-relative path to the file you plan to move or rename (e.g. 'src/utils/foo.ts')",
		},
	},
	{
		key: "target",
		type: "string",
		mcp: {
			required: true,
			description:
				"Proposed destination path for the move/rename (e.g. 'packages/shared/src/foo.ts')",
		},
	},
] as const satisfies readonly PositionalDescriptor[];

export const AFFECTED_OPTION_DESCRIPTORS = [
	{
		name: "verbose",
		key: "verbose",
		type: "boolean",
		cliHelp: {
			description: "Show detailed reference information",
			column: 21,
			order: 3,
		},
	},
	{
		name: "project",
		key: "project",
		type: "string",
		short: "p",
		cliHelp: {
			description: "Path to project directory or tsconfig.json",
			column: 21,
			order: 0,
		},
		mcp: { description: MCP_DESCRIPTIONS.project.optional },
	},
	{
		name: "workspace",
		key: "workspace",
		type: "boolean",
		cliHelp: {
			description: "Scan across all workspace packages",
			column: 21,
			order: 1,
		},
		mcp: { description: "Scan across all workspace packages" },
	},
	{
		name: "json",
		key: "json",
		type: "boolean",
		cliHelp: { description: "Output results as JSON", column: 21, order: 2 },
	},
] as const satisfies readonly OptionDescriptor[];

export const AFFECTED_POSITIONAL_DESCRIPTORS = [
	{
		key: "files",
		type: "string",
		mcp: {
			required: true,
			cardinality: "array",
			description: "List of file paths that have changed",
		},
	},
] as const satisfies readonly PositionalDescriptor[];
