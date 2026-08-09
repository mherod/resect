import path from "node:path";
import ts from "typescript";
import type {
	ExtensionPolicy,
	PreferStrategy,
} from "../commands/option-domains.ts";
import type { ProjectConfig } from "../types.ts";
import {
	removeExtension,
	STYLESHEET_EXTENSIONS,
	TS_JS_VUE_EXTENSIONS,
	VUE_EXTENSION,
} from "./constants.ts";
import type { WorkspaceInfo, WorkspacePackage } from "./workspace.ts";

export type ResolveResult =
	| { kind: "resolved"; path: string }
	| { kind: "external"; specifier: string }
	/**
	 * An existing non-TypeScript asset the bundler owns, such as a stylesheet
	 * imported by a framework entrypoint (#188). Distinct from `resolved` so the
	 * file never becomes a TypeScript dependency-graph node, and distinct from
	 * `unresolvable` so it emits no diagnostic.
	 */
	| { kind: "asset"; path: string; specifier: string }
	| { kind: "unresolvable"; specifier: string; diagnostic: string };

/**
 * Resolve a bare, alias-style specifier to an existing file via the project's
 * `paths` mapping. Shared by the `.vue` and stylesheet fallbacks, which both
 * need alias expansion that `ts.resolveModuleName` does not perform for
 * non-TypeScript extensions.
 */
function resolveExistingFileByAlias(
	specifier: string,
	project: ProjectConfig
): string | null {
	const baseUrl = project.compilerOptions.baseUrl ?? project.rootDir;
	for (const [alias, paths] of project.pathAliases) {
		const isWildcard = alias.endsWith("/*");
		const prefix = isWildcard ? alias.slice(0, -1) : alias;
		if (!specifier.startsWith(prefix)) {
			continue;
		}
		const remainder = isWildcard ? specifier.slice(prefix.length) : "";
		for (const pathPattern of paths) {
			const resolvedPattern = pathPattern.endsWith("/*")
				? pathPattern.slice(0, -1)
				: pathPattern;
			const absolutePath = path.resolve(baseUrl, resolvedPattern + remainder);
			if (ts.sys.fileExists(absolutePath)) {
				return absolutePath;
			}
		}
	}
	return null;
}

/**
 * Locate an existing file for a specifier TypeScript module resolution cannot
 * handle, covering both relative/absolute paths and alias expansion.
 */
function findExistingNonModuleFile(
	specifier: string,
	fromFile: string,
	project: ProjectConfig
): string | null {
	if (isRelativeImport(specifier) || path.isAbsolute(specifier)) {
		const absolutePath = path.resolve(path.dirname(fromFile), specifier);
		return ts.sys.fileExists(absolutePath) ? absolutePath : null;
	}
	if (isBareImport(specifier)) {
		return resolveExistingFileByAlias(specifier, project);
	}
	return null;
}

/**
 * Resolve a module specifier to a structured result distinguishing
 * resolved paths, external packages, and unresolvable specifiers.
 */
export function resolveModuleSpecifier(
	specifier: string,
	fromFile: string,
	project: ProjectConfig
): ResolveResult {
	const result = ts.resolveModuleName(
		specifier,
		fromFile,
		project.compilerOptions,
		ts.sys
	);

	if (result.resolvedModule) {
		if (result.resolvedModule.isExternalLibraryImport) {
			return { kind: "external", specifier };
		}
		return { kind: "resolved", path: result.resolvedModule.resolvedFileName };
	}

	// .vue specifiers are not resolved by ts.resolveModuleName — handle directly
	if (VUE_EXTENSION.test(specifier)) {
		const vuePath = findExistingNonModuleFile(specifier, fromFile, project);
		if (vuePath) {
			return { kind: "resolved", path: vuePath };
		}
		return {
			kind: "unresolvable",
			specifier,
			diagnostic: `Cannot resolve "${specifier}" from ${fromFile}`,
		};
	}

	// Stylesheets are bundler-owned assets, not TypeScript modules (#188). An
	// existing one resolves to `asset` so no diagnostic fires and no graph node
	// is created; a missing relative one still falls through to `unresolvable`.
	if (STYLESHEET_EXTENSIONS.test(specifier)) {
		const assetPath = findExistingNonModuleFile(specifier, fromFile, project);
		if (assetPath) {
			return { kind: "asset", path: assetPath, specifier };
		}
	}

	// Bare specifiers without ./ or ../ are external packages
	if (isBareImport(specifier)) {
		return { kind: "external", specifier };
	}

	return {
		kind: "unresolvable",
		specifier,
		diagnostic: `Cannot resolve "${specifier}" from ${fromFile}`,
	};
}

/**
 * Calculate the new import specifier after a file move
 */
export function calculateNewSpecifier(
	oldSpecifier: string,
	fromFile: string,
	oldTargetPath: string,
	newTargetPath: string,
	project: ProjectConfig,
	prefer?: PreferStrategy,
	extensions: ExtensionPolicy = "preserve"
): string {
	if (prefer === "relative") {
		return calculateRelativeSpecifier(
			fromFile,
			newTargetPath,
			oldSpecifier,
			extensions
		);
	}

	const aliasMatch = matchPathAlias(oldSpecifier, project);

	if (prefer === "alias") {
		if (aliasMatch) {
			const updated = updateAliasedSpecifier(
				oldSpecifier,
				aliasMatch,
				oldTargetPath,
				newTargetPath,
				fromFile,
				project
			);
			if (updated.startsWith("../") || updated.startsWith("./")) {
				const crossPackageAlias = findAliasForPath(newTargetPath, project);
				if (crossPackageAlias) {
					return crossPackageAlias;
				}
			}
			return updated;
		}
		const alias = findAliasForPath(newTargetPath, project);
		if (alias) {
			return alias;
		}
		return calculateRelativeSpecifier(
			fromFile,
			newTargetPath,
			oldSpecifier,
			extensions
		);
	}

	if (prefer === "shortest") {
		let aliasedSpecifier: string | null = null;
		if (aliasMatch) {
			aliasedSpecifier = updateAliasedSpecifier(
				oldSpecifier,
				aliasMatch,
				oldTargetPath,
				newTargetPath,
				fromFile,
				project
			);
		}
		if (!aliasedSpecifier || aliasedSpecifier.startsWith(".")) {
			aliasedSpecifier = findAliasForPath(newTargetPath, project);
		}
		const relativeSpecifier = calculateRelativeSpecifier(
			fromFile,
			newTargetPath,
			oldSpecifier,
			extensions
		);
		if (
			aliasedSpecifier &&
			aliasedSpecifier.length < relativeSpecifier.length
		) {
			return aliasedSpecifier;
		}
		return relativeSpecifier;
	}

	// Default behavior (prefer === undefined):
	// If the old specifier was a path alias: update aliased specifier
	if (aliasMatch) {
		const updated = updateAliasedSpecifier(
			oldSpecifier,
			aliasMatch,
			oldTargetPath,
			newTargetPath,
			fromFile,
			project
		);
		// If updateAliasedSpecifier couldn't map to the same alias,
		// try to find a different alias that covers the new target
		if (updated.startsWith("../") || updated.startsWith("./")) {
			const crossPackageAlias = findAliasForPath(newTargetPath, project);
			if (crossPackageAlias) {
				return crossPackageAlias;
			}
		}
		return updated;
	}

	// For relative imports: preserve relative import style
	if (isRelativeImport(oldSpecifier)) {
		return calculateRelativeSpecifier(
			fromFile,
			newTargetPath,
			oldSpecifier,
			extensions
		);
	}

	// For bare specifiers (packages), return unchanged
	return oldSpecifier;
}

/**
 * Find a path alias that can be used to import the given absolute file path
 */
export function findAliasForPath(
	targetPath: string,
	project: ProjectConfig
): string | null {
	const baseUrl = project.compilerOptions.baseUrl ?? project.rootDir;
	const normalizedTarget = normalizePath(targetPath);

	// Try each path alias to see if it covers the target
	// Prioritize wildcard aliases over exact matches for paths with subpaths
	const candidates: Array<{
		alias: string;
		result: string;
		isWildcard: boolean;
	}> = [];

	for (const [alias, paths] of project.pathAliases) {
		const isWildcard = alias.endsWith("/*");

		for (const pathPattern of paths) {
			const resolvedPattern = pathPattern.endsWith("/*")
				? pathPattern.slice(0, -1)
				: pathPattern;

			const absolutePattern = normalizePath(
				path.resolve(baseUrl, resolvedPattern)
			);

			if (normalizedTarget.startsWith(absolutePattern)) {
				const remainder = removeExtension(
					normalizedTarget.slice(absolutePattern.length).replace(/^\//, "")
				);

				// For wildcard aliases, use them if there's a remainder
				// For exact aliases, only use if there's NO remainder (exact match)
				if (isWildcard && remainder) {
					const aliasPrefix = alias.slice(0, -1); // Remove /*
					candidates.push({
						alias,
						result: aliasPrefix + remainder,
						isWildcard: true,
					});
				} else if (!(isWildcard || remainder)) {
					// Exact match - target is exactly at the alias root
					candidates.push({
						alias,
						result: alias,
						isWildcard: false,
					});
				}
			}
		}
	}

	// Prefer wildcard matches over exact matches (more specific)
	const wildcardMatch = candidates.find((c) => c.isWildcard);
	if (wildcardMatch) {
		return wildcardMatch.result;
	}

	const exactMatch = candidates.find((c) => !c.isWildcard);
	if (exactMatch) {
		return exactMatch.result;
	}

	return null;
}

/**
 * Check if a specifier matches any path alias
 */
export function matchPathAlias(
	specifier: string,
	project: ProjectConfig
): { alias: string; paths: string[]; remainder: string } | null {
	for (const [alias, paths] of project.pathAliases) {
		// Handle exact matches and wildcard patterns
		if (alias.endsWith("/*")) {
			const prefix = alias.slice(0, -1); // Remove trailing *
			if (specifier.startsWith(prefix)) {
				return {
					alias,
					paths,
					remainder: specifier.slice(prefix.length),
				};
			}
		} else if (specifier === alias) {
			return { alias, paths, remainder: "" };
		}
	}

	return null;
}

/**
 * Update an aliased import specifier after a file move
 */
function updateAliasedSpecifier(
	oldSpecifier: string,
	aliasMatch: { alias: string; paths: string[]; remainder: string },
	oldTargetPath: string,
	newTargetPath: string,
	fromFile: string,
	project: ProjectConfig
): string {
	const baseUrl = project.compilerOptions.baseUrl ?? project.rootDir;
	const normalizedNewTarget = normalizePath(newTargetPath);

	// Find which path pattern matched the old target
	for (const pathPattern of aliasMatch.paths) {
		const resolvedPattern = pathPattern.endsWith("/*")
			? pathPattern.slice(0, -1)
			: pathPattern;

		const absolutePattern = normalizePath(
			path.resolve(baseUrl, resolvedPattern)
		);

		if (oldTargetPath.startsWith(absolutePattern)) {
			// Check if the NEW target is ALSO within this alias scope
			if (normalizedNewTarget.startsWith(absolutePattern)) {
				// New target is in the same alias scope - update the remainder.
				// Strip any leading slash before joining so a wildcard alias prefix
				// that already ends in "/" (e.g. "@/*" -> "@/") doesn't produce a
				// double slash (#160).
				const newRemainder = removeExtension(
					normalizedNewTarget.slice(absolutePattern.length).replace(/^\//, "")
				);

				const aliasPrefix = aliasMatch.alias.endsWith("/*")
					? aliasMatch.alias.slice(0, -1)
					: aliasMatch.alias;

				const aliased = newRemainder
					? `${aliasPrefix}${aliasPrefix.endsWith("/") ? "" : "/"}${newRemainder}`
					: aliasPrefix;

				// An alias that resolves to the root's own barrel `index`
				// (`<alias>/index`) is (almost) never an exported subpath, so it
				// fails to resolve (TS2307).
				if (aliased.endsWith("/index")) {
					// #121: the importing file now lives inside this alias's own
					// root — a self-referential barrel import. Rewrite it as a
					// relative import to the (sibling) target instead.
					if (normalizePath(fromFile).startsWith(`${absolutePattern}/`)) {
						return calculateRelativeSpecifier(
							fromFile,
							newTargetPath,
							oldSpecifier
						);
					}
					// #122: the importer is outside the alias root (e.g. an
					// unrelated package's barrel). The bare alias resolves to the
					// same barrel from any location, so drop the redundant `/index`
					// and leave the package specifier untouched.
					return aliased.slice(0, -"/index".length);
				}

				return aliased;
			}
			// New target is OUTSIDE this alias scope - need a different approach
			break;
		}
	}

	// The new target is not in the same alias scope
	// Try to find a different alias that covers the new location
	const crossPackageAlias = findAliasForPath(newTargetPath, project);
	if (crossPackageAlias) {
		return crossPackageAlias;
	}

	// Last resort: fall back to relative path from the importing file
	return calculateRelativeSpecifier(fromFile, newTargetPath, oldSpecifier);
}

/**
 * Calculate a relative import specifier from one file to another.
 *
 * Both `fromFile` and `toFile` are resolved to absolute paths before computing
 * the relative specifier. This is defensive against callers that may pass a
 * cwd-relative path (e.g. when an upstream resolver returned an unnormalized
 * path) — anchoring on absolute paths is the only way to guarantee the
 * resulting specifier resolves back to the same file. See issue #67.
 */
export function calculateRelativeSpecifier(
	fromFile: string,
	toFile: string,
	oldSpecifier?: string,
	extensions: ExtensionPolicy = "preserve"
): string {
	const absFromFile = path.isAbsolute(fromFile)
		? fromFile
		: path.resolve(fromFile);
	const absToFile = path.isAbsolute(toFile) ? toFile : path.resolve(toFile);
	const fromDir = path.dirname(absFromFile);
	// `path.relative` yields platform separators, so on Windows this is
	// `..\lib\locale`. A module specifier is a string literal: backslashes read
	// as escapes, not separators, and the `/index` collapse below would miss.
	// Module specifiers are always POSIX-style.
	let relativePath = path
		.relative(fromDir, absToFile)
		.split(path.sep)
		.join("/");

	// Extension policy (#175). `preserve` (the default) mirrors the original
	// specifier's style: if the old specifier carried a .ts/.tsx/etc extension,
	// keep it; otherwise strip. `explicit` keeps the target file's real
	// extension regardless of what the old specifier looked like, for consumers
	// whose loader needs fully-specified ESM paths — `node
	// --experimental-strip-types` cannot resolve an extensionless `../lib/locale`.
	const keepExtension =
		extensions === "explicit" ||
		(oldSpecifier ? TS_JS_VUE_EXTENSIONS.test(oldSpecifier) : false);

	if (!keepExtension) {
		relativePath = removeExtension(relativePath);
	}

	// Handle index files. A specifier that still carries its extension never
	// matches here, so `./dir/index.ts` is left intact under both an
	// extension-preserving source specifier and `explicit` — collapsing it to
	// `./dir` would drop the extension the policy exists to emit.
	if (relativePath.endsWith("/index") || relativePath === "index") {
		relativePath = relativePath.replace(/\/?index$/, "") || ".";
	}

	// Ensure it starts with ./ or ../
	if (!relativePath.startsWith(".")) {
		relativePath = `./${relativePath}`;
	}

	return relativePath;
}

/**
 * Check if a specifier is a relative import
 */
export function isRelativeImport(specifier: string): boolean {
	return specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * Check if a specifier is a bare/package import
 */
export function isBareImport(specifier: string): boolean {
	return !(isRelativeImport(specifier) || path.isAbsolute(specifier));
}

/**
 * Normalize a file path (resolve symlinks, normalize slashes)
 */
export function normalizePath(filePath: string): string {
	return path.normalize(filePath).replace(/\\/g, "/");
}

/**
 * Find which package a file belongs to in a workspace
 */
export function findPackageForPath(
	filePath: string,
	workspace: WorkspaceInfo
): { packageName: string; packagePath: string } | null {
	const normalizedPath = normalizePath(filePath);

	for (const pkg of workspace.packages) {
		const normalizedPkgPath = normalizePath(pkg.path);
		if (normalizedPath.startsWith(`${normalizedPkgPath}/`)) {
			return { packageName: pkg.name, packagePath: pkg.path };
		}
	}

	return null;
}

/**
 * Extract the npm package name from a bare module specifier.
 *
 * `"lodash"` → `"lodash"`; `"lodash/fp"` → `"lodash"`;
 * `"@scope/pkg"` → `"@scope/pkg"`; `"@scope/pkg/sub"` → `"@scope/pkg"`.
 * Returns `null` for relative/absolute specifiers (not packages).
 */
export function packageNameFromSpecifier(specifier: string): string | null {
	if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
		return null;
	}
	const parts = specifier.split("/");
	if (specifier.startsWith("@")) {
		// Scoped package: name is the first two segments (@scope/name).
		return parts.length >= 2 && parts[0] && parts[1]
			? `${parts[0]}/${parts[1]}`
			: null;
	}
	const name = parts[0];
	return name && name.length > 0 ? name : null;
}

/**
 * Check if two paths are in different workspace packages
 */
export function isCrossPackageMove(
	sourcePath: string,
	targetPath: string,
	workspace: WorkspaceInfo
): boolean {
	const sourcePackage = findPackageForPath(sourcePath, workspace);
	const targetPackage = findPackageForPath(targetPath, workspace);

	if (!(sourcePackage && targetPackage)) {
		return false;
	}

	return sourcePackage.packageName !== targetPackage.packageName;
}

/**
 * Find an explicit, dedicated `exports` entry (non-root, non-wildcard) whose key
 * maps to the given src-relative subpath. Returns the sub-path import specifier
 * (e.g. "@scope/utils/cn") or null when no dedicated entry matches.
 *
 * This is what lets a package's explicit sub-path export win over a root-barrel
 * re-export when both could resolve the moved file (issue #93).
 */
function findExplicitSubpathExport(
	pkg: WorkspacePackage,
	srcSubpath: string
): string | null {
	if (!(pkg.exports && typeof pkg.exports === "object")) {
		return null;
	}

	for (const exportKey of Object.keys(pkg.exports)) {
		// The root entry maps to the barrel; wildcards are handled separately as
		// a lower-priority fallback. Only dedicated named sub-paths win here.
		if (exportKey === "." || exportKey.includes("*")) {
			continue;
		}

		const normalizedKey = exportKey.replace(/^\.\//, "");
		if (
			normalizedKey === srcSubpath ||
			normalizedKey === `${srcSubpath}/index`
		) {
			return `${pkg.name}/${normalizedKey}`;
		}
	}

	return null;
}

/** Escape regex metacharacters so a literal string can be embedded in a RegExp. */
function escapeRegExpChars(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a RegExp matching a package.json `exports` wildcard key (e.g. "./*.js",
 * "./[locale]/*") against a subpath. Node's exports semantics allow at most one
 * "*" per key; keys with zero or more than one are rejected (returns null)
 * rather than silently matching the wrong thing or throwing on unescaped
 * regex metacharacters like "[", "(", "+" (#130).
 */
function buildWildcardExportPattern(exportKey: string): RegExp | null {
	const starCount = exportKey.split("*").length - 1;
	if (starCount !== 1) {
		return null;
	}
	const normalizedKey = exportKey.replace(/^\.\//, "");
	const [prefix = "", suffix = ""] = normalizedKey.split("*");
	return new RegExp(
		`^${escapeRegExpChars(prefix)}(.+)${escapeRegExpChars(suffix)}$`
	);
}

/**
 * Resolve the package that owns `targetPath` and the file's package-relative
 * subpaths. `subpath` is the path within the package (extension stripped);
 * `srcSubpath` additionally strips a leading "src/" so it lines up with how
 * packages declare their dist-based `exports`. Returns null when no workspace
 * package owns the file.
 */
function resolvePackageSubpath(
	targetPath: string,
	workspace: WorkspaceInfo
): { pkg: WorkspacePackage; subpath: string; srcSubpath: string } | null {
	const targetPackage = findPackageForPath(targetPath, workspace);
	if (!targetPackage) {
		return null;
	}

	const pkg = workspace.packages.find(
		(p) => p.name === targetPackage.packageName
	);
	if (!pkg) {
		return null;
	}

	const relativePath = path.relative(pkg.path, normalizePath(targetPath));
	const subpath = removeExtension(relativePath);
	const srcSubpath = subpath.replace(/^src\//, "");
	return { pkg, subpath, srcSubpath };
}

export interface SubpathExportMatch {
	/** Owning package name, e.g. "@scope/utils" */
	packageName: string;
	/** Normalized export key, e.g. "cn" */
	exportKey: string;
	/** Full import specifier, e.g. "@scope/utils/cn" */
	specifier: string;
}

/**
 * If `targetPath` is covered by a dedicated, non-wildcard `exports` sub-path
 * entry of its owning package, return that match. This is the signal behind
 * issue #93: consumers can (and by convention should) import the file via its
 * dedicated sub-path rather than collapsing through the package root barrel.
 * Returns null when no workspace package owns the file or it has no dedicated
 * sub-path entry.
 */
export function findSubpathExportForFile(
	targetPath: string,
	workspace: WorkspaceInfo
): SubpathExportMatch | null {
	const resolved = resolvePackageSubpath(targetPath, workspace);
	if (!resolved) {
		return null;
	}
	const specifier = findExplicitSubpathExport(
		resolved.pkg,
		resolved.srcSubpath
	);
	if (!specifier) {
		return null;
	}
	return {
		packageName: resolved.pkg.name,
		exportKey: specifier.slice(resolved.pkg.name.length + 1),
		specifier,
	};
}

/**
 * For cross-package moves, determine the best import specifier from the destination package.
 *
 * When addingToBarrel is true, assumes the file will be exported from the package's
 * main barrel (index.ts), so imports should use just the package name.
 *
 * A dedicated sub-path `exports` entry that maps to the moved file takes
 * precedence over the root barrel, so consumers keep their sub-path convention.
 */
export function findCrossPackageImport(
	targetPath: string,
	workspace: WorkspaceInfo,
	addingToBarrel = true
): string | null {
	const resolved = resolvePackageSubpath(targetPath, workspace);
	if (!resolved) {
		return null;
	}
	const { pkg, subpath, srcSubpath } = resolved;

	// A dedicated sub-path export wins over the root barrel: if the package
	// explicitly exposes this file (e.g. "./cn"), consumers expect
	// "@scope/utils/cn" rather than collapsing to the package root just because
	// index.ts re-exports it (issue #93).
	const explicitExport = findExplicitSubpathExport(pkg, srcSubpath);
	if (explicitExport) {
		return explicitExport;
	}

	// If we're adding to the barrel AND the barrel exists, use the package name.
	// The export will be added to the barrel, so consumers can import from the package.
	// Without a barrel file, we must fall through to subpath imports to avoid broken imports.
	// If it's in the src directory, it will be exported from the barrel.
	const hasBarrel = pkg.barrelFiles && pkg.barrelFiles.length > 0;
	if (
		addingToBarrel &&
		hasBarrel &&
		pkg.srcDir &&
		subpath.startsWith(`${pkg.srcDir}/`)
	) {
		return pkg.name;
	}

	// Handle wildcard exports (lowest-priority "exports" match): a "./*" entry
	// maps any sub-path, but only after the explicit and barrel preferences above.
	if (pkg.exports && typeof pkg.exports === "object") {
		for (const [exportKey, exportValue] of Object.entries(pkg.exports)) {
			if (!exportKey.includes("*")) {
				continue;
			}

			// Check if the export value maps src to dist
			const valueStr = typeof exportValue === "string" ? exportValue : null;
			if (valueStr) {
				// e.g., "./*": "./dist/*.js" and we have "src/foo" -> try "foo"
				const srcSubpathNoExt = srcSubpath.replace(/\/index$/, "");
				const pattern = buildWildcardExportPattern(exportKey);
				if (pattern && srcSubpathNoExt.match(pattern)) {
					return `${pkg.name}/${srcSubpathNoExt}`;
				}
			}
		}
	}

	// Check if the package has a src directory that maps to main export
	if (pkg.srcDir && subpath.startsWith(`${pkg.srcDir}/`)) {
		const srcRelative = subpath.slice(pkg.srcDir.length + 1);
		// If it's the index file, use package name directly
		if (srcRelative === "index" || srcRelative === "") {
			return pkg.name;
		}
		// Only use bare package name if barrel exists — otherwise use subpath
		if (hasBarrel) {
			return pkg.name;
		}
		return `${pkg.name}/${subpath}`;
	}

	// Default: just use package name + subpath
	return subpath ? `${pkg.name}/${subpath}` : pkg.name;
}
