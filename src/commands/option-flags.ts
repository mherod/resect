import type { ParseArgsConfig } from "node:util";
import { AUDIT_OPTION_DESCRIPTORS, toFlagSpec } from "./command-descriptor.ts";

/** A canonical long-form option name accepted by the CLI parser. */
export type OptionName =
	| "help"
	| "version"
	| "verbose"
	| "dry-run"
	| "project"
	| "type"
	| "prefer"
	| "alias-prefer"
	| "rename-specifier"
	| "force"
	| "journal"
	| "verify"
	| "no-verify"
	| "fix"
	| "fix-category"
	| "json"
	| "threshold"
	| "max-groups"
	| "max-changes"
	| "strict"
	| "name-threshold"
	| "same-name-only"
	| "skip-same-file"
	| "only-related-to"
	| "min-lines"
	| "skip-directives"
	| "skip-wrappers"
	| "kinds"
	| "group"
	| "output"
	| "workspace"
	| "experimental"
	| "scope"
	| "out"
	| "bucket"
	| "format"
	| "fan-out-threshold"
	| "fan-in-threshold"
	| "export-threshold"
	| "min-siblings"
	| "majority-threshold"
	| "case"
	| "include-tests"
	| "convention-threshold"
	| "ignore"
	| "entrypoint-globs"
	| "transform"
	| "batch"
	| "extensions"
	| "include-ignored";

/** parseArgs option spec for a single flag, narrowed to what resect uses. */
type FlagSpec =
	| { type: "boolean"; short?: string }
	| { type: "string"; short?: string; multiple?: true };

/**
 * THE single source of truth for resect's global CLI option flags.
 * Keys are the kebab-case flag names exactly as passed on the CLI and read
 * from the parsed `values` bag. Order is preserved from the original cli.ts
 * declaration so any insertion-order-sensitive behaviour is unchanged.
 */
export const OPTION_FLAGS = {
	help: { type: "boolean", short: "h" },
	version: { type: "boolean", short: "v" },
	verbose: { type: "boolean" },
	"dry-run": { type: "boolean", short: "n" },
	project: { type: "string", short: "p" },
	type: { type: "string", short: "t" },
	prefer: { type: "string" },
	"alias-prefer": { type: "string" },
	"rename-specifier": { type: "string", multiple: true },
	force: { type: "boolean" },
	journal: { type: "boolean" },
	verify: { type: "boolean" },
	"no-verify": { type: "boolean" },
	fix: { type: "boolean" },
	"fix-category": { type: "string", multiple: true },
	json: { type: "boolean" },
	threshold: { type: "string" },
	"max-groups": { type: "string" },
	"max-changes": { type: "string" },
	strict: { type: "boolean" },
	"name-threshold": { type: "string" },
	"same-name-only": { type: "boolean" },
	"skip-same-file": { type: "boolean" },
	"only-related-to": { type: "string" },
	"min-lines": { type: "string" },
	"skip-directives": { type: "boolean" },
	"skip-wrappers": { type: "boolean" },
	kinds: { type: "string" },
	group: { type: "string" },
	output: { type: "string", short: "o" },
	workspace: { type: "boolean" },
	experimental: { type: "boolean" },
	scope: { type: "string" },
	out: { type: "string" },
	bucket: { type: "string" },
	format: { type: "string" },
	"fan-out-threshold": toFlagSpec(AUDIT_OPTION_DESCRIPTORS[3]),
	"fan-in-threshold": toFlagSpec(AUDIT_OPTION_DESCRIPTORS[4]),
	"export-threshold": toFlagSpec(AUDIT_OPTION_DESCRIPTORS[5]),
	"min-siblings": { type: "string" },
	"majority-threshold": { type: "string" },
	case: { type: "string" },
	"include-tests": { type: "boolean" },
	"convention-threshold": { type: "string" },
	ignore: { type: "string" },
	"entrypoint-globs": { type: "string", multiple: true },
	transform: { type: "string" },
	batch: { type: "string" },
	extensions: { type: "string" },
	"include-ignored": { type: "boolean" },
} as const satisfies Record<OptionName, FlagSpec>;

/** The exact object shape `parseArgs({ options })` expects. */
export const PARSE_ARGS_OPTIONS = OPTION_FLAGS as NonNullable<
	ParseArgsConfig["options"]
>;

const BOOLEAN_FLAGS = new Set<string>();
const SHORT_BOOLEAN_FLAGS = new Map<string, string>();

for (const [name, spec] of Object.entries(OPTION_FLAGS) as [
	string,
	FlagSpec,
][]) {
	if (spec.type === "boolean") {
		BOOLEAN_FLAGS.add(name);
		if (spec.short) {
			SHORT_BOOLEAN_FLAGS.set(spec.short, name);
		}
	}
}

const FALSY_VALUES = new Set(["false", "0", "no", "off"]);
const TRUTHY_VALUES = new Set(["true", "1", "yes", "on"]);

/**
 * Normalize `<flag>=<value>` for a boolean flag into the bare-flag form
 * `parseArgs` accepts. Only explicit truthy/falsy spellings are recognised:
 * returning `null` for anything else leaves the token untouched so `parseArgs`
 * raises its own strict error, rather than turning a typo like `--force=fales`
 * into an enabled `--force` that would silently bypass the worktree guard.
 */
function normalizeBooleanFlag(
	bareFlag: string,
	rawValue: string
): string[] | null {
	const value = rawValue.toLowerCase();
	if (FALSY_VALUES.has(value)) {
		return [];
	}
	if (TRUTHY_VALUES.has(value)) {
		return [bareFlag];
	}
	return null;
}

/**
 * Preprocess CLI arguments to normalize special flags before passing to parseArgs.
 * Standardizes boolean flags passed with equals syntax (e.g. -n=false, --dry-run=false).
 *
 * Everything after a bare `--` is left verbatim: `parseArgs` treats those tokens
 * as positionals, so rewriting them would drop dash-prefixed paths such as
 * `move -- --dry-run=false target.ts`.
 */
export function preprocessArgs(cliArgs: string[]): string[] {
	const out: string[] = [];
	let sawSeparator = false;

	for (const arg of cliArgs) {
		if (sawSeparator) {
			out.push(arg);
			continue;
		}
		if (arg === "--") {
			sawSeparator = true;
			out.push(arg);
			continue;
		}

		if (cliArgs[0] === "tidy" && arg.startsWith("--fix=")) {
			out.push("--fix", "--fix-category", arg.slice("--fix=".length));
			continue;
		}

		const eqIndex = arg.indexOf("=");
		let normalized: string[] | null = null;

		if (eqIndex !== -1) {
			if (arg.startsWith("--")) {
				const flagName = arg.slice(2, eqIndex);
				if (BOOLEAN_FLAGS.has(flagName)) {
					normalized = normalizeBooleanFlag(
						`--${flagName}`,
						arg.slice(eqIndex + 1)
					);
				}
			} else if (arg.startsWith("-") && arg.length > 1) {
				const shortFlag = arg.slice(1, eqIndex);
				const longName = SHORT_BOOLEAN_FLAGS.get(shortFlag);
				if (longName !== undefined) {
					normalized = normalizeBooleanFlag(
						`-${shortFlag}`,
						arg.slice(eqIndex + 1)
					);
				}
			}
		}

		if (normalized === null) {
			out.push(arg);
		} else {
			out.push(...normalized);
		}
	}

	return out;
}

type FlagValue<F extends FlagSpec> = F extends { type: "boolean" }
	? boolean
	: F extends { type: "string"; multiple: true }
		? string[]
		: string;

type DerivedCliValues = {
	[K in keyof typeof OPTION_FLAGS]?: FlagValue<(typeof OPTION_FLAGS)[K]>;
};

/**
 * The parsed CLI values bag.
 *
 * Derived from `OPTION_FLAGS` via a mapped type. The `entrypoint-globs` key
 * preserves its pre-existing `string | string[]` union (the asymmetry vs
 * `rename-specifier`/`fix-category` which are `string[]` array-only is
 * intentional and must not be "corrected").
 */
export type CliValues = Omit<DerivedCliValues, "entrypoint-globs"> & {
	"entrypoint-globs"?: string | string[];
};

/** Return explicitly supplied options that the selected command does not use. */
export function findUnsupportedOptions(
	values: CliValues,
	supportedOptions: readonly OptionName[]
): OptionName[] {
	const supported = new Set<OptionName>(supportedOptions);
	return (Object.keys(values) as OptionName[]).filter(
		(option) => !supported.has(option)
	);
}
