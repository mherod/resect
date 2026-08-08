import path from "node:path";
import { logger } from "../cli-logger.ts";
import { removeExtension } from "../core/constants.ts";
import type { SimilarityGroup } from "../types/similar.ts";
import {
	type FunctionNode,
	locateFunctionNode,
	pickCanonical,
} from "./extract-common-select.ts";

export interface ExtractionPlan {
	group: SimilarityGroup;
	/** The function copy to keep (canonical source) */
	canonical: FunctionNode;
	/** Copies to remove and replace with imports */
	duplicates: FunctionNode[];
}

export async function planExtractions(
	groups: SimilarityGroup[]
): Promise<ExtractionPlan[]> {
	const plans: ExtractionPlan[] = [];

	for (const group of groups) {
		const nodes: FunctionNode[] = [];
		for (const fn of group.functions) {
			const node = locateFunctionNode(fn);
			if (node) {
				nodes.push(node);
			}
		}
		if (nodes.length < 2) {
			continue;
		}
		const { canonical, duplicates } = pickCanonical(nodes);
		const canonicalRefs = canonical.capturedModuleRefs.join(",");

		// Pre-read canonical file content for cycle detection
		let canonicalContent = "";
		try {
			canonicalContent = await Bun.file(canonical.info.file).text();
		} catch {
			// If unreadable, skip cycle check
		}

		const safeDuplicates = duplicates.filter((dup) => {
			// Same-file, different-name declarations are intentional aliases
			// (e.g. type FlushCallbacks = (s: Store) => void and
			//       type RecomputeInvalidatedAtoms = (s: Store) => void)
			if (
				dup.info.file === canonical.info.file &&
				dup.info.name !== canonical.info.name
			) {
				return false;
			}
			// For value (non-type) extractions, skip if it would create a
			// runtime circular dependency: the canonical file already imports
			// from the duplicate's file, and we'd add the reverse import.
			const isType = dup.info.kind === "type" || dup.info.kind === "interface";
			if (
				!isType &&
				dup.info.file !== canonical.info.file &&
				wouldCreateCycle(canonicalContent, canonical.info.file, dup.info.file)
			) {
				const dupFile = path.basename(dup.info.file);
				const canonFile = path.basename(canonical.info.file);
				logger.warn(
					`⚠️  Skipping ${dup.info.name} in ${dupFile}: would create circular import with ${canonFile}`
				);
				return false;
			}
			const dupRefs = dup.capturedModuleRefs.join(",");
			if (dupRefs === canonicalRefs) {
				return true;
			}
			// Different module-scope captures — unsafe to extract
			const dupFile = path.basename(dup.info.file);
			const canonFile = path.basename(canonical.info.file);
			logger.warn(
				`⚠️  Skipping ${dup.info.name} in ${dupFile}: captures ` +
					`[${dup.capturedModuleRefs.join(", ") || "none"}] vs canonical in ` +
					`${canonFile}: [${canonical.capturedModuleRefs.join(", ") || "none"}]`
			);
			return false;
		});

		if (safeDuplicates.length === 0) {
			continue;
		}
		plans.push({ group, canonical, duplicates: safeDuplicates });
	}

	return plans;
}

/**
 * Check if the canonical file's content contains an import that resolves
 * to the duplicate's file, meaning adding a reverse import would create
 * a runtime circular dependency.
 */
function wouldCreateCycle(
	canonicalContent: string,
	canonicalFile: string,
	dupFile: string
): boolean {
	const canonDir = path.dirname(canonicalFile);
	const dupNoExt = removeExtension(dupFile);

	const importMatches = canonicalContent.matchAll(
		/(?:import|from)\s+['"]([^'"]+)['"]/g
	);
	for (const m of importMatches) {
		const spec = m[1];
		if (!spec?.startsWith(".")) {
			continue;
		}
		const resolved = path.resolve(canonDir, spec);
		const resolvedNoExt = removeExtension(resolved);
		if (resolvedNoExt === dupNoExt || resolved === dupFile) {
			return true;
		}
	}
	return false;
}
