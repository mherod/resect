import path from "node:path";

/**
 * Next.js App Router filenames whose meaning comes from their name and position
 * in the route tree rather than from what they export.
 *
 * https://nextjs.org/docs/app/getting-started/project-structure
 */
const NEXT_APP_ROUTER_STEMS = new Set([
	"default",
	"error",
	"global-error",
	"layout",
	"loading",
	"not-found",
	"opengraph-image",
	"page",
	"route",
	"sitemap",
	"template",
	"twitter-image",
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
export function hasAppRouterRootSegment(filePath: string): boolean {
	const segments = filePath.split(path.sep);
	return segments.some((segment, index) => {
		if (segment !== "app") {
			return false;
		}
		const parent = segments[index - 1];
		return parent === undefined || !WORKSPACE_CONTAINER_SEGMENTS.has(parent);
	});
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
	return (
		NEXT_APP_ROUTER_STEMS.has(resolvedStem) && hasAppRouterRootSegment(filePath)
	);
}
