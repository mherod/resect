import path from "node:path";
import ts from "typescript";
import type { DependencyGraph } from "../core/graph.ts";
import { MoveGraphUpdater } from "../core/move-graph.ts";
import { createResolutionContext, normalizePath } from "../core/resolver.ts";
import { createSourceFileFromText } from "../core/source-file.ts";
import {
	applyStructuredEdits,
	type StructuredEdit,
} from "../core/text-changes.ts";
import type { WorkspaceInfo } from "../core/workspace.ts";
import { getRuntime } from "../runtime/index.ts";
import type { MoveResult } from "../types/move.ts";
import type { TransformRule } from "../types/transform.ts";
import type { ProjectConfig } from "../types.ts";
import { moveModule } from "./move-apply.ts";
import type { MoveModuleContext } from "./move-module-plan.ts";
import type { ExtensionPolicy, PreferStrategy } from "./option-domains.ts";

interface SessionMoveOptions {
	verbose?: boolean;
	workspace?: WorkspaceInfo;
	force?: boolean;
	transformRules?: TransformRule[];
	prefer?: PreferStrategy;
	extensions?: ExtensionPolicy;
}

/** In-process state shared by sequential plans, applications and previews. */
export class MoveSession {
	readonly context: MoveModuleContext;
	private readonly project: ProjectConfig;
	private readonly dryRun: boolean;
	private readonly executeMove: typeof moveModule;
	private readonly overlay = new Map<string, string | null>();
	private readonly virtualDirectories = new Set<string>();
	private readonly originalPaths = new Map<string, { currentPath: string }>();
	private readonly activePaths = new Map<string, { currentPath: string }>();
	private readonly graphUpdater: MoveGraphUpdater;

	constructor(
		project: ProjectConfig,
		graph: DependencyGraph,
		dryRun: boolean,
		executeMove = moveModule
	) {
		this.project = project;
		this.dryRun = dryRun;
		this.executeMove = executeMove;
		this.graphUpdater = new MoveGraphUpdater(
			graph,
			project,
			this.getSourceFile
		);
		this.context = {
			graph,
			readFile: this.readFile,
			exists: this.exists,
			getSourceFile: this.getSourceFile,
		};
	}

	/** The compatibility wrapper completes planning/application before state advances. */
	async move(
		source: string,
		target: string,
		options: SessionMoveOptions = {}
	): Promise<MoveResult> {
		const result = await this.executeMove(
			source,
			target,
			this.project,
			this.dryRun,
			options.verbose ?? false,
			options.workspace,
			options.force ?? false,
			options.transformRules ?? [],
			options.prefer,
			options.extensions,
			this.context
		);
		if (result.success) {
			await this.advance(result);
		}
		return result;
	}

	readonly translateBeforeFile = (file: string): string => {
		const normalized = normalizePath(file);
		return this.originalPaths.get(normalized)?.currentPath ?? normalized;
	};

	private readonly resolutionHost: ts.ModuleResolutionHost = {
		...ts.sys,
		fileExists: (file) => {
			const normalized = normalizePath(file);
			return this.overlay.has(normalized)
				? this.overlay.get(normalized) !== null
				: ts.sys.fileExists(file);
		},
		readFile: (file) => {
			const normalized = normalizePath(file);
			return this.overlay.has(normalized)
				? (this.overlay.get(normalized) ?? undefined)
				: ts.sys.readFile(file);
		},
		directoryExists: (directory) =>
			this.virtualDirectories.has(normalizePath(directory)) ||
			ts.sys.directoryExists(directory),
		realpath: (file) =>
			this.overlay.has(normalizePath(file)) ||
			this.virtualDirectories.has(normalizePath(file))
				? file
				: (ts.sys.realpath?.(file) ?? file),
	};

	private readonly readFile = async (file: string): Promise<string> => {
		const normalized = normalizePath(file);
		if (this.overlay.has(normalized)) {
			const content = this.overlay.get(normalized);
			if (content === null || content === undefined) {
				throw new Error(`File does not exist: ${file}`);
			}
			return content;
		}
		return getRuntime().fs.readFile(file);
	};

	private readonly exists = async (file: string): Promise<boolean> => {
		const normalized = normalizePath(file);
		return this.overlay.has(normalized)
			? this.overlay.get(normalized) !== null
			: getRuntime().fs.exists(file);
	};

	private readonly getSourceFile: MoveModuleContext["getSourceFile"] = async (
		file
	) => {
		return (await this.exists(file))
			? createSourceFileFromText(file, await this.readFile(file))
			: undefined;
	};

	private async advance(result: MoveResult): Promise<void> {
		const source = normalizePath(result.movedFile.from);
		const target = normalizePath(result.movedFile.to);
		const previous = new Map<string, string | null | undefined>();
		const addedDirectories = new Set<string>();
		if (this.dryRun) {
			for (const [file, content] of await this.previewChanges(
				result,
				source,
				target
			)) {
				previous.set(file, this.overlay.get(file));
				this.overlay.set(file, content);
				if (content !== null) {
					this.addVirtualDirectories(file, addedDirectories);
				}
			}
		}
		try {
			await this.graphUpdater.update(
				result,
				createResolutionContext(this.project, this.resolutionHost)
			);
		} catch (error) {
			for (const [file, content] of previous) {
				if (content === undefined) {
					this.overlay.delete(file);
				} else {
					this.overlay.set(file, content);
				}
			}
			for (const directory of addedDirectories) {
				this.virtualDirectories.delete(directory);
			}
			throw error;
		}
		const identity = this.activePaths.get(source) ?? { currentPath: source };
		identity.currentPath = target;
		if (!this.originalPaths.has(source)) {
			this.originalPaths.set(source, identity);
		}
		this.activePaths.delete(source);
		this.activePaths.set(target, identity);
	}

	private addVirtualDirectories(file: string, added: Set<string>): void {
		let directory = normalizePath(path.dirname(file));
		while (!this.virtualDirectories.has(directory)) {
			this.virtualDirectories.add(directory);
			added.add(directory);
			const parent = normalizePath(path.dirname(directory));
			if (parent === directory) {
				break;
			}
			directory = parent;
		}
	}

	private async previewChanges(
		result: MoveResult,
		source: string,
		target: string
	): Promise<Map<string, string | null>> {
		const changes = new Map<string, string | null>([
			[target, await this.readFile(source)],
		]);
		const editsByFile = new Map<string, StructuredEdit[]>();
		for (const edit of result.edits) {
			const file = normalizePath(edit.file);
			const edits = editsByFile.get(file) ?? [];
			edits.push(edit);
			editsByFile.set(file, edits);
		}
		for (const [file, edits] of editsByFile) {
			changes.set(
				file,
				applyStructuredEdits(
					changes.get(file) ?? (await this.readFile(file)),
					edits
				)
			);
		}
		changes.set(source, null);
		return changes;
	}
}
