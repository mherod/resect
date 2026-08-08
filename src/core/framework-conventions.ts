import path from "node:path";

type AppRouterConventionScope = "app-root" | "route-segment";

/**
 * Next.js App Router code filenames whose meaning comes from their name and
 * position rather than from what they export. The scope keeps root-only
 * conventions from exempting ordinary same-stem files in nested route segments.
 *
 * https://nextjs.org/docs/app/getting-started/project-structure
 * https://nextjs.org/docs/app/api-reference/file-conventions/metadata
 */
const NEXT_APP_ROUTER_CONVENTIONS = new Map<string, AppRouterConventionScope>([
	["apple-icon", "route-segment"],
	["default", "route-segment"],
	["error", "route-segment"],
	["global-error", "app-root"],
	["icon", "route-segment"],
	["layout", "route-segment"],
	["loading", "route-segment"],
	["manifest", "app-root"],
	["not-found", "route-segment"],
	["opengraph-image", "route-segment"],
	["page", "route-segment"],
	["robots", "app-root"],
	["route", "route-segment"],
	["sitemap", "route-segment"],
	["template", "route-segment"],
	["twitter-image", "route-segment"],
]);

/**
 * Monorepo directories that hold packages rather than route segments; an `app`
 * directly inside one of these is a package name, not an App Router root.
 */
const WORKSPACE_CONTAINER_SEGMENTS = new Set([
	"apps",
	"libs",
	"modules",
	"packages",
]);

/**
 * True when an `app` segment plausibly roots a Next.js App Router tree.
 *
 * A bare `includes("app")` also matches a workspace package literally named
 * `app` (`packages/app/lib/not-found.ts`), which would exempt every reserved
 * stem beneath it. Requiring the segment's parent not to be a workspace
 * container keeps `apps/web/app`, `src/app`, and a repository-root `app`
 * recognised while rejecting the package-name case. This only ever narrows the
 * exemption, so it cannot create a new one.
 */
function findAppRouterRootSegmentIndex(segments: string[]): number {
	return segments.findIndex((segment, index) => {
		if (segment !== "app") {
			return false;
		}
		const parent = segments[index - 1];
		return parent === undefined || !WORKSPACE_CONTAINER_SEGMENTS.has(parent);
	});
}

export function hasAppRouterRootSegment(filePath: string): boolean {
	return findAppRouterRootSegmentIndex(filePath.split(path.sep)) !== -1;
}

/**
 * Directory names that conventionally hold modules shared across features.
 *
 * Next.js documents storing project files outside `app/` in top-level folders
 * like these, so a module living here is an architectural choice rather than a
 * placement mistake.
 */
const SHARED_MODULE_ROOTS = new Set([
	"common",
	"components",
	"config",
	"hooks",
	"lib",
	"services",
	"shared",
	"styles",
	"types",
	"utils",
]);

/**
 * True when a project-relative path sits under a conventional shared root.
 *
 * Recognises both documented layouts — a top-level `components/` and a
 * `src/components/` — by position rather than by matching one fixed repository
 * shape, so the segment only counts at the project root or directly beneath
 * `src`. A `shared` directory nested deep inside a feature is not a shared root.
 */
export function isSharedModuleRoot(relativePath: string): boolean {
	const [first, second] = relativePath.split(path.sep);
	if (first !== undefined && SHARED_MODULE_ROOTS.has(first)) {
		return true;
	}
	return first === "src" && second !== undefined
		? SHARED_MODULE_ROOTS.has(second)
		: false;
}

/**
 * True when a file is a framework-owned convention file in a valid framework
 * location — its name and position carry the behaviour, so its exports are not
 * evidence about naming style or about colliding with a same-named module.
 *
 * Shared so commands agree on one definition of "framework convention" instead
 * of each keeping a private copy; `stem` is accepted for callers that already
 * computed one (e.g. after stripping a `.d.ts` suffix).
 */
export function isFrameworkConventionFile(
	filePath: string,
	stem?: string
): boolean {
	const resolvedStem = stem ?? path.basename(filePath, path.extname(filePath));
	const scope = NEXT_APP_ROUTER_CONVENTIONS.get(resolvedStem);
	if (!scope) {
		return false;
	}

	const segments = filePath.split(path.sep);
	const appRootIndex = findAppRouterRootSegmentIndex(segments);
	if (appRootIndex === -1) {
		return false;
	}

	return scope === "route-segment" || appRootIndex === segments.length - 2;
}
