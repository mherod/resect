/**
 * Shared option-value domains for command flags.
 *
 * These tuples are the single runtime source of truth for the small closed sets
 * of accepted flag values. The CLI dispatcher (`registry.ts`) validates raw
 * `--flag` strings against them and the MCP server (`mcp-server.ts`) feeds them
 * straight into `z.enum(...)`, so the accepted set can never drift between the
 * two entry points. Pure data — no I/O, no imports.
 *
 * Tidy fix categories are NOT duplicated here: their runtime tuple
 * (`ALL_TIDY_FIX_CATEGORIES`) already lives in `tidy.ts` next to the apply
 * logic and is re-exported for the MCP schema.
 */

/** `alias --prefer` and `tidy --alias-prefer` import-rewrite strategies. */
export const PREFER_STRATEGIES = ["alias", "relative", "shortest"] as const;
export type PreferStrategy = (typeof PREFER_STRATEGIES)[number];

/**
 * `move --extensions` and `alias --extensions` file-extension policy (#175).
 *
 * Orthogonal to `PREFER_STRATEGIES`: `prefer` chooses the specifier *style*
 * (alias vs relative), this chooses whether a synthesised relative path carries
 * the target's real extension. `explicit` exists for consumers whose loader
 * resolves fully-specified ESM paths — notably
 * `node --experimental-strip-types`, which cannot resolve `../lib/locale` and
 * needs `../lib/locale.ts`.
 */
export const EXTENSION_POLICIES = ["preserve", "explicit"] as const;
export type ExtensionPolicy = (typeof EXTENSION_POLICIES)[number];

/** `find --type` result filter. */
export const FIND_TYPES = ["file", "export", "all"] as const;
export type FindType = (typeof FIND_TYPES)[number];

/** `naming --case` explicit filename casing targets. */
export const FILENAME_CASING_STYLES = [
	"kebab-case",
	"camelCase",
	"PascalCase",
	"snake_case",
] as const;
export type FilenameCasingStyle = (typeof FILENAME_CASING_STYLES)[number];

/**
 * Membership check that narrows an arbitrary string to a domain's member type.
 * Lets CLI handlers validate `values.<flag>` and keep the narrowed type without
 * a separate `as` cast.
 */
export function isInDomain<const T extends string>(
	domain: readonly T[],
	value: string
): value is T {
	return (domain as readonly string[]).includes(value);
}
