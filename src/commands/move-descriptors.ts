import {
	type CliParseResult,
	type OptionDescriptor,
	type PositionalDescriptor,
	toRegistryOptions,
} from "./command-descriptor.ts";
import {
	EXTENSION_POLICIES,
	isInDomain,
	PREFER_STRATEGIES,
} from "./option-domains.ts";
import type { CliValues } from "./option-flags.ts";

function parseMoveEnum<const Domain extends readonly string[]>(
	raw: boolean | string | string[] | undefined,
	domain: Domain,
	message: string
): CliParseResult<Domain[number] | undefined> {
	if (raw === undefined) {
		return { ok: true, value: undefined };
	}
	return typeof raw === "string" && isInDomain(domain, raw)
		? { ok: true, value: raw }
		: { ok: false, message };
}

// Shared scalar semantics; transport defaults remain with their handlers.
const MOVE_OPTIONS = {
	batch: { name: "batch", key: "batch", type: "string" },
	dryRun: {
		name: "dry-run",
		key: "dryRun",
		type: "boolean",
		short: "n",
		mcp: {
			description:
				"Preview the move without writing files (default true). Set false to actually apply",
		},
	},
	force: {
		name: "force",
		key: "force",
		type: "boolean",
		mcp: {
			description:
				"Override the dirty-worktree guard (default false). Use with care — the guard prevents data loss on a clean commit boundary",
		},
	},
	journal: {
		name: "journal",
		key: "journal",
		type: "boolean",
		mcp: {
			description:
				"Record an applied move in `.resect/history.json` for a later undo",
		},
	},
	json: { name: "json", key: "json", type: "boolean" },
	verbose: {
		name: "verbose",
		key: "verbose",
		type: "boolean",
		mcp: { description: "Include extra detail in the result (default false)" },
	},
	verify: {
		name: "verify",
		key: "verify",
		type: "boolean",
		mcp: {
			description:
				"Run `tsc --noEmit` before and after the move and return the diagnostic delta (default true). Ignored when dryRun=true",
		},
	},
	noVerify: { name: "no-verify", key: "noVerify", type: "boolean" },
	project: {
		name: "project",
		key: "project",
		type: "string",
		short: "p",
		mcp: {
			description:
				"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the source file",
		},
	},
	workspace: { name: "workspace", key: "workspace", type: "boolean" },
	transform: {
		name: "transform",
		key: "transform",
		type: "string",
		mcp: {
			description:
				"Path to a declarative `.resect/transforms.js` config (epic #103), resolved relative to the project root. Parsed/validated before the move; a missing or malformed config fails the move and writes nothing",
		},
	},
	prefer: {
		name: "prefer",
		key: "prefer",
		type: "enum",
		domain: PREFER_STRATEGIES,
		parseCli: (raw) =>
			parseMoveEnum(
				raw,
				PREFER_STRATEGIES,
				"Error: --prefer must be 'alias', 'relative', or 'shortest'"
			),
		mcp: {
			description:
				"Import-specifier style for rewritten references (#173). Omit to preserve each importer's existing style (relative stays relative, aliased stays aliased). 'relative' forces relative paths — needed when the output must run under `node --experimental-strip-types`, which does not resolve tsconfig paths",
		},
	},
	extensions: {
		name: "extensions",
		key: "extensions",
		type: "enum",
		domain: EXTENSION_POLICIES,
		parseCli: (raw) =>
			parseMoveEnum(
				raw,
				EXTENSION_POLICIES,
				"Error: --extensions must be 'preserve' or 'explicit'"
			),
		mcp: {
			description:
				"File-extension policy for rewritten specifiers (#175), orthogonal to `prefer`. 'preserve' (default) keeps each importer's existing convention; 'explicit' emits the target file's real extension. Pair with prefer='relative' for `node --experimental-strip-types`, whose loader cannot resolve an extensionless specifier",
		},
	},
} as const satisfies Record<string, OptionDescriptor>;

/** Preserve the CLI capability order independently of the MCP input order. */
export const MOVE_OPTION_DESCRIPTORS = [
	MOVE_OPTIONS.batch,
	MOVE_OPTIONS.dryRun,
	MOVE_OPTIONS.force,
	MOVE_OPTIONS.journal,
	MOVE_OPTIONS.json,
	MOVE_OPTIONS.verbose,
	MOVE_OPTIONS.verify,
	MOVE_OPTIONS.noVerify,
	MOVE_OPTIONS.project,
	MOVE_OPTIONS.workspace,
	MOVE_OPTIONS.transform,
	MOVE_OPTIONS.prefer,
	MOVE_OPTIONS.extensions,
] as const;

// Batch is intentionally absent: MCP accepts structured pairs, CLI a JSON path.
export const MOVE_MCP_OPTION_DESCRIPTORS = [
	MOVE_OPTIONS.project,
	MOVE_OPTIONS.dryRun,
	MOVE_OPTIONS.force,
	MOVE_OPTIONS.journal,
	MOVE_OPTIONS.verify,
	MOVE_OPTIONS.verbose,
	MOVE_OPTIONS.transform,
	MOVE_OPTIONS.prefer,
	MOVE_OPTIONS.extensions,
] as const;

export const MOVE_POSITIONAL_DESCRIPTORS = [
	{
		key: "source",
		type: "string",
		mcp: {
			description:
				"Absolute or cwd-relative path to one existing file. Required with target when batch is omitted",
		},
	},
	{
		key: "target",
		type: "string",
		mcp: {
			description:
				"Absolute or cwd-relative destination for source. Required with source when batch is omitted",
		},
	},
] as const satisfies readonly PositionalDescriptor[];

/** Single and batch CLI routes share coercion and legacy verification precedence. */
export function parseMoveCliOptions(values: CliValues) {
	const parsed = toRegistryOptions(MOVE_OPTION_DESCRIPTORS, values);
	if (!parsed.ok) {
		return parsed;
	}
	const { noVerify, ...options } = parsed.value;
	return { ok: true as const, value: { ...options, verify: !noVerify } };
}
