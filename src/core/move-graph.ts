import type ts from "typescript";
import type { ModuleReference } from "../types/graph.ts";
import type { MoveResult } from "../types/move.ts";
import type { ProjectConfig } from "../types.ts";
import { TS_JS_VUE_EXTENSIONS } from "./constants.ts";
import { type DependencyGraph, detachGraphFromCache } from "./graph.ts";
import {
	createResolutionContext,
	normalizePath,
	type ResolutionContext,
} from "./resolver.ts";
import {
	scanBarrelExports,
	scanExports,
	scanModuleReferences,
} from "./scanner.ts";

export type MoveSourceReader = (
	file: string
) => Promise<ts.SourceFile | undefined>;

interface FileUpdate {
	references: ModuleReference[];
	barrels: string[];
	metadata:
		| {
				exports: ReturnType<typeof scanExports>;
				compilerOptions: ts.CompilerOptions;
		  }
		| undefined;
}

/** One session owns the graph and a file-order index, never a second graph. */
export class MoveGraphUpdater {
	private readonly graph: DependencyGraph;
	private readonly project: ProjectConfig;
	private readonly getSourceFile: MoveSourceReader;
	private readonly fileOrder = new Map<string, number>();
	private nextOrder = 0;

	constructor(
		graph: DependencyGraph,
		project: ProjectConfig,
		getSourceFile: MoveSourceReader
	) {
		this.graph = graph;
		this.project = project;
		this.getSourceFile = getSourceFile;
		for (const file of graph.imports.keys()) {
			this.fileOrder.set(file, this.nextOrder++);
		}
	}

	/** Prepare syntax first, then replace only affected forward/reverse/barrel entries. */
	async update(
		result: MoveResult,
		resolution = createResolutionContext(this.project)
	): Promise<void> {
		if (!result.success) {
			return;
		}
		const source = normalizePath(result.movedFile.from);
		const target = normalizePath(result.movedFile.to);
		const files = new Set([target]);
		for (const { sourceFile } of this.graph.importedBy.get(source) ?? []) {
			files.add(sourceFile === source ? target : sourceFile);
		}
		for (const { file } of [...result.edits, ...result.updatedReferences]) {
			if (TS_JS_VUE_EXTENSIONS.test(file)) {
				const normalized = normalizePath(file);
				files.add(normalized === source ? target : normalized);
			}
		}
		const updates = new Map<string, FileUpdate>();
		for (const file of files) {
			updates.set(file, await this.scan(file, source, target, resolution));
		}

		// All fallible reads finish before any graph or cache state changes.
		detachGraphFromCache(this.project, this.graph);
		const removed = new Map<string, Set<ModuleReference>>();
		for (const file of new Set([source, ...files])) {
			for (const reference of this.graph.imports.get(file) ?? []) {
				const destination = normalizePath(reference.resolvedPath);
				const references =
					removed.get(destination) ?? new Set<ModuleReference>();
				references.add(reference);
				removed.set(destination, references);
			}
		}
		const reverseUpdates = new Map<string, ModuleReference[]>();
		for (const [destination, references] of removed) {
			reverseUpdates.set(
				destination,
				(this.graph.importedBy.get(destination) ?? []).filter(
					(reference) => !references.has(reference)
				)
			);
		}
		this.removeSource(source);
		for (const [file, update] of updates) {
			this.publishFile(file, update);
			for (const reference of update.references) {
				const destination = normalizePath(reference.resolvedPath);
				let incoming = reverseUpdates.get(destination);
				if (!incoming) {
					incoming = [...(this.graph.importedBy.get(destination) ?? [])];
					reverseUpdates.set(destination, incoming);
				}
				incoming.push(reference);
			}
		}
		for (const [destination, incoming] of reverseUpdates) {
			if (incoming.length === 0) {
				this.graph.importedBy.delete(destination);
			} else {
				incoming.sort(this.compareReferences);
				this.graph.importedBy.set(destination, incoming);
			}
		}
	}

	private async scan(
		file: string,
		source: string,
		target: string,
		resolution: ResolutionContext
	): Promise<FileUpdate> {
		const previous = file === target ? source : file;
		const metadata = this.graph.sourceMetadata?.get(previous);
		const syntax = await this.getSourceFile(file);
		if (syntax) {
			return {
				references: scanModuleReferences(syntax, this.project, resolution),
				barrels: scanBarrelExports(syntax, this.project, resolution).map(
					({ resolvedPath }) => normalizePath(resolvedPath)
				),
				metadata: this.graph.sourceMetadata
					? {
							exports: scanExports(syntax),
							compilerOptions:
								metadata?.compilerOptions ?? this.project.compilerOptions,
						}
					: undefined,
			};
		}
		return {
			references: (this.graph.imports.get(previous) ?? []).map((reference) => ({
				...reference,
				sourceFile: file,
				resolvedPath:
					normalizePath(reference.resolvedPath) === source
						? target
						: reference.resolvedPath,
			})),
			barrels: (this.graph.barrelReExports.get(previous) ?? []).map(
				(exported) => (exported === source ? target : exported)
			),
			metadata,
		};
	}

	private removeSource(source: string): void {
		this.graph.imports.delete(source);
		this.graph.barrelFiles.delete(source);
		this.graph.barrelReExports.delete(source);
		this.graph.sourceMetadata?.delete(source);
		this.fileOrder.delete(source);
	}

	private publishFile(file: string, update: FileUpdate): void {
		this.graph.imports.set(file, update.references);
		if (!this.fileOrder.has(file)) {
			this.fileOrder.set(file, this.nextOrder++);
		}
		if (update.barrels.length > 0) {
			this.graph.barrelFiles.add(file);
			this.graph.barrelReExports.set(file, update.barrels);
		} else {
			this.graph.barrelFiles.delete(file);
			this.graph.barrelReExports.delete(file);
		}
		if (update.metadata) {
			this.graph.sourceMetadata?.set(file, update.metadata);
		}
	}

	private readonly compareReferences = (
		left: ModuleReference,
		right: ModuleReference
	): number =>
		(this.fileOrder.get(left.sourceFile) ?? 0) -
			(this.fileOrder.get(right.sourceFile) ?? 0) ||
		left.line - right.line ||
		left.column - right.column;
}
