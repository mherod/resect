import type { DependencyGraph } from "../core/graph.ts";
import { refreshMoveGraph } from "../core/move-graph.ts";
import { normalizePath } from "../core/resolver.ts";
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
	private readonly successfulMoves: { source: string; target: string }[] = [];

	constructor(
		project: ProjectConfig,
		graph: DependencyGraph,
		dryRun: boolean,
		executeMove = moveModule
	) {
		this.project = project;
		this.dryRun = dryRun;
		this.executeMove = executeMove;
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
		const destinations = new Map(
			this.successfulMoves.map(({ source, target }) => [source, target])
		);
		let translated = normalizePath(file);
		const visited = new Set<string>();
		while (destinations.has(translated) && !visited.has(translated)) {
			visited.add(translated);
			translated = destinations.get(translated) as string;
		}
		return translated;
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
		this.successfulMoves.push({ source, target });
		if (this.dryRun) {
			await this.advancePreview(result, source, target);
		}
		await refreshMoveGraph(
			this.context.graph,
			result,
			this.project,
			this.getSourceFile,
			this.dryRun
		);
	}

	private async advancePreview(
		result: MoveResult,
		source: string,
		target: string
	): Promise<void> {
		this.overlay.set(target, await this.readFile(source));
		const editsByFile = new Map<string, StructuredEdit[]>();
		for (const edit of result.edits) {
			const file = normalizePath(edit.file);
			const edits = editsByFile.get(file) ?? [];
			edits.push(edit);
			editsByFile.set(file, edits);
		}
		for (const [file, edits] of editsByFile) {
			this.overlay.set(
				file,
				applyStructuredEdits(await this.readFile(file), edits)
			);
		}
		this.overlay.set(source, null);
	}
}
