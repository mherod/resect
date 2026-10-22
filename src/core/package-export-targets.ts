import path from "node:path";
import { isWithinPath } from "./path-utils.ts";

export const PACKAGE_SOURCE_EXTENSIONS = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".mts",
	".cts",
	".mjs",
	".cjs",
];

export function collectExportSpecifiers(
	value: unknown,
	specifiers: string[]
): void {
	if (typeof value === "string") {
		specifiers.push(value);
		return;
	}
	if (value && typeof value === "object") {
		for (const nested of Object.values(value)) {
			collectExportSpecifiers(nested, specifiers);
		}
	}
}

function addExtensionCandidates(
	basePath: string,
	candidates: Set<string>
): void {
	candidates.add(basePath);
	const declarationBase = basePath.replace(/\.d\.(?:c|m)?ts$/i, "");
	const parsed = path.parse(declarationBase);
	const withoutExtension = parsed.ext
		? path.join(parsed.dir, parsed.name)
		: declarationBase;
	for (const extension of PACKAGE_SOURCE_EXTENSIONS) {
		candidates.add(`${withoutExtension}${extension}`);
	}
	if (!parsed.ext) {
		for (const extension of PACKAGE_SOURCE_EXTENSIONS) {
			candidates.add(path.join(declarationBase, `index${extension}`));
		}
	}
}

/** Existing source candidates for direct and conventional emitted entrypoints. */
export function expandEntrypointCandidates(
	packageRoot: string,
	specifier: string,
	sourceDir: string | undefined
): string[] {
	if (
		specifier.includes("*") ||
		path.isAbsolute(specifier) ||
		/^[a-z]+:/i.test(specifier)
	) {
		return [];
	}
	const relativeSpecifier = specifier.replace(/^\.\//, "");
	const candidates = new Set<string>();
	addExtensionCandidates(
		path.resolve(packageRoot, relativeSpecifier),
		candidates
	);
	if (sourceDir) {
		const [firstPart, ...rest] = relativeSpecifier.split(/[\\/]/);
		if (firstPart && ["dist", "build", "lib"].includes(firstPart)) {
			addExtensionCandidates(
				path.resolve(packageRoot, sourceDir, ...rest),
				candidates
			);
		}
	}
	return [...candidates];
}

/** Candidate source barrels keyed by their dedicated public export, without I/O. */
export function subpathBarrelCandidates(
	packageRoot: string,
	exports: unknown,
	sourceDir: string | undefined
): Map<string, string[]> {
	const result = new Map<string, string[]>();
	if (!exports || typeof exports !== "object" || Array.isArray(exports)) {
		return result;
	}
	const sourceRoot = path.resolve(packageRoot, sourceDir ?? ".");
	for (const [key, value] of Object.entries(exports)) {
		if (!key.startsWith("./") || key.includes("*")) {
			continue;
		}
		const targets: string[] = [];
		collectExportSpecifiers(value, targets);
		const candidates = new Set<string>();
		for (const target of targets) {
			for (const candidate of expandEntrypointCandidates(
				packageRoot,
				target,
				sourceDir
			)) {
				if (
					isWithinPath(sourceRoot, candidate) &&
					["index.ts", "index.tsx", "index.js"].includes(
						path.basename(candidate)
					)
				) {
					candidates.add(candidate);
				}
			}
		}
		result.set(key, [...candidates]);
	}
	return result;
}
