import type ts from "typescript";
import type { MoveResult } from "../types/move.ts";
import type { ProjectConfig } from "../types.ts";
import type { DependencyGraph } from "./graph.ts";
import { normalizePath } from "./resolver.ts";
import { scanBarrelExports, scanModuleReferences } from "./scanner.ts";

export type MoveSourceReader = (
	file: string
) => Promise<ts.SourceFile | undefined>;

/** Publish a successful sequential move to all dependency graph indexes. */
export async function refreshMoveGraph(
	graph: DependencyGraph,
	result: MoveResult,
	project: ProjectConfig,
	getSourceFile: MoveSourceReader,
	dryRun: boolean
): Promise<void> {
	const source = normalizePath(result.movedFile.from);
	const target = normalizePath(result.movedFile.to);
	const movedRefs = graph.imports.get(source) ?? [];
	graph.imports.delete(source);
	graph.imports.set(
		target,
		movedRefs.map((reference) => ({ ...reference, sourceFile: target }))
	);

	for (const references of graph.imports.values()) {
		for (const reference of references) {
			if (normalizePath(reference.sourceFile) === source) {
				reference.sourceFile = target;
			}
			if (normalizePath(reference.resolvedPath) === source) {
				reference.resolvedPath = target;
			}
		}
	}
	for (const update of result.updatedReferences) {
		const references = graph.imports.get(normalizePath(update.file)) ?? [];
		const reference = references.find(
			(candidate) =>
				candidate.line === update.line &&
				candidate.specifier === update.oldSpecifier
		);
		if (reference) {
			reference.specifier = update.newSpecifier;
		}
	}

	if (graph.barrelFiles.delete(source)) {
		graph.barrelFiles.add(target);
	}
	const movedBarrelExports = graph.barrelReExports.get(source);
	graph.barrelReExports.delete(source);
	if (movedBarrelExports) {
		graph.barrelReExports.set(target, movedBarrelExports);
	}
	for (const [barrel, exports] of graph.barrelReExports) {
		graph.barrelReExports.set(
			barrel,
			exports.map((exported) =>
				normalizePath(exported) === source ? target : exported
			)
		);
	}

	if (!dryRun) {
		const changedFiles = new Set([
			target,
			...result.updatedReferences.map(({ file }) => normalizePath(file)),
		]);
		for (const file of changedFiles) {
			const sourceFile = await getSourceFile(file);
			if (!sourceFile) {
				continue;
			}
			graph.imports.set(file, scanModuleReferences(sourceFile, project));
			const barrelExports = scanBarrelExports(sourceFile, project);
			if (barrelExports.length > 0) {
				graph.barrelFiles.add(file);
				graph.barrelReExports.set(
					file,
					barrelExports.map(({ resolvedPath }) => normalizePath(resolvedPath))
				);
			} else {
				graph.barrelFiles.delete(file);
				graph.barrelReExports.delete(file);
			}
		}
	}

	graph.importedBy.clear();
	for (const references of graph.imports.values()) {
		for (const reference of references) {
			const resolved = normalizePath(reference.resolvedPath);
			const importers = graph.importedBy.get(resolved) ?? [];
			importers.push(reference);
			graph.importedBy.set(resolved, importers);
		}
	}
}
