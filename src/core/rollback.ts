import path from "node:path";
import { getRuntime } from "../runtime/index.ts";
import { mapConcurrent } from "./concurrency.ts";
import { type MoveRename, rollbackFiles, rollbackMoves } from "./git.ts";

/**
 * A composable rollback strategy. Snapshot data is deliberately separate from
 * restoration so a future undo journal can persist the same plain data.
 */
export interface RollbackStrategy<Snapshot> {
	snapshot(): Promise<Snapshot>;
	restore(snapshot: Snapshot): Promise<void>;
}

export interface RollbackCheckpoint<Snapshot> {
	readonly snapshot: Snapshot;
	restore(): Promise<void>;
}

export async function createRollbackCheckpoint<Snapshot>(
	strategy: RollbackStrategy<Snapshot>
): Promise<RollbackCheckpoint<Snapshot>> {
	const snapshot = await strategy.snapshot();
	return {
		snapshot,
		async restore() {
			await strategy.restore(snapshot);
		},
	};
}

export async function tryRestoreRollback(
	checkpoint: RollbackCheckpoint<unknown>
): Promise<boolean> {
	try {
		await checkpoint.restore();
		return true;
	} catch {
		return false;
	}
}

export interface GitFilesRollbackSnapshot {
	rootDir: string;
	files: string[];
}

export function createGitFilesRollbackStrategy(
	rootDir: string,
	files: Iterable<string>
): RollbackStrategy<GitFilesRollbackSnapshot> {
	return {
		async snapshot() {
			const relativeFiles = Array.from(files, (file) =>
				path.isAbsolute(file) ? path.relative(rootDir, file) : file
			);
			return {
				rootDir,
				files: [...new Set(relativeFiles)],
			};
		},
		async restore(snapshot) {
			await rollbackFiles(snapshot.rootDir, snapshot.files);
		},
	};
}

export interface MoveRollbackSnapshot {
	projectRoot: string;
	renames: MoveRename[];
	importerFiles: string[];
}

export function createMoveRollbackStrategy(
	projectRoot: string,
	renames: Iterable<MoveRename>,
	importerFiles: Iterable<string>
): RollbackStrategy<MoveRollbackSnapshot> {
	return {
		async snapshot() {
			return {
				projectRoot,
				renames: Array.from(renames, (rename) => ({ ...rename })),
				importerFiles: [...new Set(importerFiles)],
			};
		},
		async restore(snapshot) {
			await rollbackMoves(
				snapshot.projectRoot,
				snapshot.renames,
				snapshot.importerFiles
			);
		},
	};
}

export interface FileContentSnapshot {
	file: string;
	existed: boolean;
	original: string | null;
}

export function createFileContentsRollbackStrategy(
	files: Iterable<string>
): RollbackStrategy<FileContentSnapshot[]> {
	const uniqueFiles = [...new Set(files)];
	return {
		async snapshot() {
			const rt = getRuntime();
			return mapConcurrent(uniqueFiles, async (file) => {
				const existed = await rt.fs.exists(file);
				return {
					file,
					existed,
					original: existed ? await rt.fs.readFile(file) : null,
				};
			});
		},
		async restore(snapshot) {
			const rt = getRuntime();
			await mapConcurrent(snapshot, async (fileSnapshot) => {
				if (fileSnapshot.existed && fileSnapshot.original !== null) {
					await rt.fs.writeFile(fileSnapshot.file, fileSnapshot.original);
				} else if (await rt.fs.exists(fileSnapshot.file)) {
					await rt.fs.deleteFile(fileSnapshot.file);
				}
			});
		},
	};
}
