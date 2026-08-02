import type { ParseArgsConfig } from "node:util";

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
	"fan-out-threshold": { type: "string" },
	"fan-in-threshold": { type: "string" },
	"export-threshold": { type: "string" },
	"min-siblings": { type: "string" },
	"majority-threshold": { type: "string" },
	"include-tests": { type: "boolean" },
	"convention-threshold": { type: "string" },
	ignore: { type: "string" },
	"entrypoint-globs": { type: "string", multiple: true },
	transform: { type: "string" },
} as const satisfies Record<string, FlagSpec>;

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

/**
 * Preprocess CLI arguments to normalize special flags before passing to parseArgs.
 * Standardizes boolean flags passed with equals syntax (e.g. -n=false, --dry-run=false).
 */
export function preprocessArgs(cliArgs: string[]): string[] {
	return cliArgs.flatMap((arg) => {
		if (cliArgs[0] === "tidy" && arg.startsWith("--fix=")) {
			return ["--fix", "--fix-category", arg.slice("--fix=".length)];
		}

		if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				const flagName = arg.slice(2, eqIndex);
				if (BOOLEAN_FLAGS.has(flagName)) {
					const value = arg.slice(eqIndex + 1).toLowerCase();
					if (FALSY_VALUES.has(value)) {
						return [];
					}
					return [`--${flagName}`];
				}
			}
		} else if (arg.startsWith("-") && arg.length > 1) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				const shortFlag = arg.slice(1, eqIndex);
				if (SHORT_BOOLEAN_FLAGS.has(shortFlag)) {
					const value = arg.slice(eqIndex + 1).toLowerCase();
					if (FALSY_VALUES.has(value)) {
						return [];
					}
					return [`-${shortFlag}`];
				}
			}
		}

		return [arg];
	});
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
