/**
 * Module reachability for the `unused` command (#193).
 *
 * A single static-import pass treats every syntactic importer as live, so a
 * dead exported wrapper keeps its otherwise unreachable dependency looking
 * used. Reachability closes that gap: modules are walked forward from the live
 * roots (package entrypoints, convention entrypoints, and consumers outside the
 * analysed directory), and anything never visited is dead. Because an
 * unreachable module has, by definition, no reachable importer, every export it
 * declares is removable — directly when nothing imports it, transitively when
 * its only importers are themselves unreachable.
 *
 * The walk is a breadth-first traversal guarded by a visited set, so an
 * unreachable import cycle terminates instead of spinning.
 */

import type { DependencyGraph } from "../core/graph.ts";
import { normalizePath } from "../core/resolver.ts";

export interface ReachabilityResult {
	/** Modules reachable from a live root. Everything else is dead. */
	liveModules: ReadonlySet<string>;
	/** The roots the walk started from, for explaining a verdict. */
	roots: ReadonlySet<string>;
}

/**
 * Walk forward from the live roots over the module import graph.
 *
 * Only files present in `graph.imports` participate; unresolved and external
 * specifiers have no node and so cannot keep anything alive.
 */
export function computeModuleReachability(
	graph: DependencyGraph,
	roots: Iterable<string>
): ReachabilityResult {
	const normalizedRoots = new Set<string>();
	for (const root of roots) {
		const normalized = normalizePath(root);
		if (graph.imports.has(normalized)) {
			normalizedRoots.add(normalized);
		}
	}

	const liveModules = new Set<string>(normalizedRoots);
	const queue = [...normalizedRoots];

	while (queue.length > 0) {
		// Breadth-first: shift the frontier, push newly discovered modules. The
		// `liveModules` guard is what makes a cycle terminate.
		const current = queue.shift();
		if (current === undefined) {
			break;
		}
		for (const ref of graph.imports.get(current) ?? []) {
			if (!ref.resolvedPath) {
				continue;
			}
			const target = normalizePath(ref.resolvedPath);
			if (!graph.imports.has(target) || liveModules.has(target)) {
				continue;
			}
			liveModules.add(target);
			queue.push(target);
		}
	}

	return { liveModules, roots: normalizedRoots };
}

/**
 * Shortest chain of dead modules from a directly-dead module to `file`,
 * following importer edges. Explains *why* a module is only transitively dead:
 * each hop is a module that must be removed before the next becomes removable.
 *
 * Returns the chain ending at `file`, or just `[file]` when no dead importer
 * leads to it.
 */
export function findDeadImportChain(
	file: string,
	graph: DependencyGraph,
	liveModules: ReadonlySet<string>,
	directlyDeadModules: ReadonlySet<string>
): string[] {
	const target = normalizePath(file);
	// Breadth-first over dead importers, so the first directly-dead module found
	// yields the shortest explanation.
	const visited = new Set<string>([target]);
	const queue: string[][] = [[target]];

	while (queue.length > 0) {
		const chain = queue.shift();
		if (chain === undefined) {
			break;
		}
		const head = chain[0];
		if (head === undefined) {
			continue;
		}
		if (chain.length > 1 && directlyDeadModules.has(head)) {
			return chain;
		}
		for (const importer of deadImportersOf(head, graph, liveModules)) {
			if (visited.has(importer)) {
				continue;
			}
			visited.add(importer);
			queue.push([importer, ...chain]);
		}
	}

	return [target];
}

/** Dead (unreachable) modules that import `file`. */
export function deadImportersOf(
	file: string,
	graph: DependencyGraph,
	liveModules: ReadonlySet<string>
): string[] {
	const target = normalizePath(file);
	const importers = new Set<string>();

	for (const ref of graph.importedBy.get(target) ?? []) {
		const source = normalizePath(ref.sourceFile);
		if (source !== target && !liveModules.has(source)) {
			importers.add(source);
		}
	}

	return [...importers].sort();
}
