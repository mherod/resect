import type {
	CliOptionParser,
	CliParseResult,
	OptionDescriptor,
	PositionalDescriptor,
} from "./command-descriptor.ts";
import { MCP_DESCRIPTIONS } from "./mcp-descriptions.ts";
import {
	isInDomain,
	SIMILARITY_BUCKETS,
	SIMILARITY_KINDS,
	type SimilarityBucket,
	type SimilarityKind,
} from "./option-domains.ts";

const SIMILAR_DEFAULTS = { threshold: 0.8, maxGroups: 10 } as const;
type RawValue = Parameters<CliOptionParser>[0];

// Preserve the shipped CLI conversions, including empty strings and Infinity.
// MCP numeric leaves deliberately have independent, unconstrained schemas.
function parseSimilarNumber(
	flag: string,
	raw: RawValue,
	fallback?: number,
	max?: number
): CliParseResult<number | undefined> {
	const value = raw === undefined ? fallback : Number(raw);
	if (
		value !== undefined &&
		(Number.isNaN(value) || value < 0 || (max !== undefined && value > max))
	) {
		return {
			ok: false,
			message:
				max === undefined
					? "Error: --max-groups must be a non-negative integer"
					: `Error: --${flag} must be a number between 0.0 and 1.0`,
		};
	}
	return { ok: true, value };
}

function parseKinds(
	raw: RawValue
): CliParseResult<SimilarityKind[] | undefined> {
	return {
		ok: true,
		value:
			typeof raw === "string" && raw
				? raw
						.split(",")
						.map((value) => value.trim())
						.filter((value) => isInDomain(SIMILARITY_KINDS, value))
				: undefined,
	};
}

function parseBucket(
	raw: RawValue
): CliParseResult<SimilarityBucket | undefined> {
	if (
		raw &&
		(typeof raw !== "string" || !isInDomain(SIMILARITY_BUCKETS, raw))
	) {
		return {
			ok: false,
			message: "Error: --bucket must be 'exact', 'high', or 'medium'",
		};
	}
	// The legacy dispatcher passes the empty string through as a falsy bucket.
	return { ok: true, value: raw as SimilarityBucket | undefined };
}

function parseFormat(raw: RawValue): CliParseResult<"compact" | undefined> {
	return raw === undefined || raw === "compact"
		? { ok: true, value: raw }
		: { ok: false, message: "Error: --format must be 'compact'" };
}

export const BARREL_OPTION_DESCRIPTORS = [
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
		mcp: { description: MCP_DESCRIPTIONS.project.directory },
	},
	{
		name: "json",
		key: "json",
		type: "boolean",
		cliHelp: { description: "Output results as JSON", column: 18, order: 1 },
	},
	{
		name: "workspace",
		key: "workspace",
		type: "boolean",
		cliHelp: {
			description: "Scan across all workspace packages",
			column: 18,
			order: 2,
		},
		mcp: {
			description:
				"Scan barrels across every workspace package, not just the resolved tsconfig",
		},
	},
	{
		name: "verbose",
		key: "verbose",
		type: "boolean",
		cliHelp: { description: "Show detailed output", column: 18, order: 3 },
	},
	{
		name: "include-ignored",
		key: "includeIgnored",
		type: "boolean",
		cliHelp: {
			description:
				"Analyse git-ignored files too. Off by default: an emitted\nbundle re-exporting its chunks is structurally a barrel, but\nnot one you maintain",
			column: 21,
			order: 4,
			continuationColumn: 18,
		},
		mcp: { description: MCP_DESCRIPTIONS.includeIgnored.analysis },
	},
] as const satisfies readonly OptionDescriptor[];

export const BARREL_POSITIONAL_DESCRIPTORS = [
	{
		key: "directory",
		type: "string",
		mcp: { required: true, description: MCP_DESCRIPTIONS.directory.scan },
	},
] as const satisfies readonly PositionalDescriptor[];

export const UNUSED_OPTION_DESCRIPTORS = [
	{
		name: "project",
		key: "project",
		type: "string",
		short: "p",
		cliHelp: {
			description: "Path to project directory or tsconfig.json",
			column: 19,
			order: 0,
		},
		mcp: { description: MCP_DESCRIPTIONS.project.directory },
	},
	{
		name: "json",
		key: "json",
		type: "boolean",
		cliHelp: { description: "Output results as JSON", column: 19, order: 1 },
	},
	{
		name: "verbose",
		key: "verbose",
		type: "boolean",
		cliHelp: { description: "Show detailed output", column: 19, order: 2 },
	},
	{
		name: "ignore",
		key: "ignore",
		type: "string",
		cliHelp: {
			description: 'Glob pattern to exclude files (e.g. "*.test.ts")',
			column: 24,
			order: 3,
		},
		mcp: {
			description:
				"Glob of files to exclude from the scan, e.g. '*.test.ts' to drop test files (which often hold the only references)",
		},
	},
	{
		name: "workspace",
		key: "workspace",
		type: "boolean",
		cliHelp: {
			description:
				"Merge sibling workspace packages into the usage graph, so an\nexport consumed only from another package is not reported\ndead. The report still covers <directory> only.",
			column: 24,
			order: 4,
			continuationColumn: 24,
		},
		mcp: {
			description:
				"Merge sibling workspace packages into the usage graph so an export consumed only from another package is not reported dead. The report still covers `directory` only",
		},
	},
	{
		name: "entrypoint-globs",
		key: "entrypointGlobs",
		type: "string",
		multiple: true,
		cliHelp: {
			description:
				'Glob pattern(s) for convention entrypoints to exclude from\norphan/dead reporting (e.g. "hooks/**", "scripts/*.ts").\nRepeat the flag for multiple patterns.',
			column: 24,
			order: 5,
			continuationColumn: 24,
		},
		mcp: {
			description:
				"Glob pattern(s) for convention entrypoints dispatched by filename (e.g. 'hooks/**', 'scripts/*') to exclude from dead-export candidates, e.g. \"hooks/**\"",
			cardinality: "scalar-or-array",
		},
	},
	{
		name: "include-ignored",
		key: "includeIgnored",
		type: "boolean",
		cliHelp: {
			description:
				"Analyse git-ignored files too. Off by default: build\noutput that imports a source export makes it look\nconsumed, hiding a genuinely dead export",
			column: 24,
			order: 6,
			continuationColumn: 24,
		},
		mcp: { description: MCP_DESCRIPTIONS.includeIgnored.analysis },
	},
] as const satisfies readonly OptionDescriptor[];

export const UNUSED_POSITIONAL_DESCRIPTORS = [
	{
		key: "directory",
		type: "string",
		mcp: { required: true, description: MCP_DESCRIPTIONS.directory.scan },
	},
] as const satisfies readonly PositionalDescriptor[];

export const SIMILAR_OPTION_DESCRIPTORS = [
	{
		name: "project",
		key: "project",
		type: "string",
		short: "p",
		cliHelp: {
			description: "Path to project directory or tsconfig.json",
			column: 20,
			order: 16,
		},
		mcp: { description: MCP_DESCRIPTIONS.project.directory },
	},
	{
		name: "json",
		key: "json",
		type: "boolean",
		cliHelp: { description: "Output results as JSON", column: 20, order: 0 },
	},
	{
		name: "threshold",
		key: "threshold",
		type: "number",
		default: SIMILAR_DEFAULTS.threshold,
		parseCli: (raw) =>
			parseSimilarNumber("threshold", raw, SIMILAR_DEFAULTS.threshold, 1),
		cliHelp: {
			description: "Minimum similarity score 0.0–1.0 (default: 0.8)",
			column: 20,
			order: 1,
		},
		mcp: {
			description:
				"Minimum structural similarity to group, 0.0–1.0 (default 0.8). Higher = only very-alike declarations; lower = more, looser matches",
		},
	},
	{
		name: "max-groups",
		key: "maxGroups",
		type: "number",
		default: SIMILAR_DEFAULTS.maxGroups,
		parseCli: (raw) =>
			parseSimilarNumber("max-groups", raw, SIMILAR_DEFAULTS.maxGroups),
		cliHelp: {
			description:
				"Maximum number of groups to display (default: 10, 0 for unlimited)",
			column: 20,
			order: 2,
		},
		mcp: {
			description:
				"Cap on groups returned, highest-scoring first; 0 = unlimited (default 10)",
		},
	},
	{
		name: "strict",
		key: "strict",
		type: "boolean",
		cliHelp: {
			description:
				"Exit with error code 1 if similar declarations are found (for CI/hooks)",
			column: 20,
			order: 3,
		},
	},
	{
		name: "workspace",
		key: "workspace",
		type: "boolean",
		cliHelp: {
			description: "Scan across all workspace packages",
			column: 20,
			order: 14,
		},
	},
	{
		name: "name-threshold",
		key: "nameThreshold",
		type: "number",
		parseCli: (raw) => parseSimilarNumber("name-threshold", raw, undefined, 1),
		cliHelp: {
			description:
				"Only group declarations whose names also meet this similarity (0.0–1.0)",
			column: 20,
			order: 4,
		},
		mcp: {
			description:
				"Also require member NAME similarity to meet this score (0.0–1.0), so only similarly-named declarations group together",
		},
	},
	{
		name: "same-name-only",
		key: "sameNameOnly",
		type: "boolean",
		cliHelp: {
			description: "Only group declarations with identical names",
			column: 20,
			order: 5,
		},
		mcp: {
			description:
				"Only group declarations that share an identical name (strictest name filter; overrides nameThreshold)",
		},
	},
	{
		name: "skip-same-file",
		key: "skipSameFile",
		type: "boolean",
		cliHelp: {
			description: "Skip groups where all declarations are in the same file",
			column: 20,
			order: 6,
		},
		mcp: {
			description:
				"Drop groups whose members all live in one file, leaving only cross-file duplication",
		},
	},
	{
		name: "only-related-to",
		key: "onlyRelatedTo",
		type: "string",
		cliHelp: {
			description:
				"Only show groups related to a file or folder (path or glob)",
			column: 20,
			order: 7,
		},
	},
	{
		name: "min-lines",
		key: "minLines",
		type: "number",
		parseCli: (raw): CliParseResult<number | undefined> => ({
			ok: true,
			value: raw ? Number(raw) : undefined,
		}),
		cliHelp: {
			description:
				"Exclude declarations with fewer body lines (filters thin wrappers)",
			column: 20,
			order: 8,
		},
		mcp: {
			description:
				"Ignore declarations whose body has fewer than N lines, to skip trivial one-liners",
		},
	},
	{
		name: "skip-directives",
		key: "skipDirectives",
		type: "boolean",
		cliHelp: {
			description: "Skip functions containing compile-time directives",
			column: 20,
			order: 9,
		},
	},
	{
		name: "skip-wrappers",
		key: "skipWrappers",
		type: "boolean",
		cliHelp: {
			description:
				"Skip thin wrapper functions (single return + call expression)",
			column: 20,
			order: 10,
		},
	},
	{
		name: "kinds",
		key: "kinds",
		type: "enum",
		domain: SIMILARITY_KINDS,
		parseCli: parseKinds,
		cliHelp: {
			description:
				"Comma-separated list of declaration kinds to include:\nfunction, type, interface (default: all)",
			column: 20,
			order: 11,
			continuationColumn: 20,
		},
		mcp: {
			description:
				"Limit to specific declaration kinds (default: all of function, type, interface)",
			cardinality: "array",
		},
	},
	{
		name: "bucket",
		key: "bucket",
		type: "enum",
		domain: SIMILARITY_BUCKETS,
		parseCli: parseBucket,
		cliHelp: {
			description: "Filter groups by similarity bucket: exact, high, or medium",
			column: 20,
			order: 12,
		},
		mcp: {
			description:
				"Only return groups in this similarity bucket (exact/high/medium)",
		},
	},
	{
		name: "format",
		key: "format",
		type: "enum",
		domain: ["compact"],
		parseCli: parseFormat,
		cliHelp: {
			description:
				"Output format: compact (minimal name + file:line per group)",
			column: 20,
			order: 13,
		},
	},
	{
		name: "include-ignored",
		key: "includeIgnored",
		type: "boolean",
		cliHelp: {
			description:
				"Analyse git-ignored files too. Off by default: a bundled\ncopy of a source declaration is a guaranteed duplicate of it",
			column: 20,
			order: 15,
			continuationColumn: 20,
		},
		mcp: { description: MCP_DESCRIPTIONS.includeIgnored.analysis },
	},
] as const satisfies readonly OptionDescriptor[];

export const SIMILAR_POSITIONAL_DESCRIPTORS = [
	{
		key: "directory",
		type: "string",
		mcp: { required: true, description: MCP_DESCRIPTIONS.directory.scan },
	},
] as const satisfies readonly PositionalDescriptor[];
