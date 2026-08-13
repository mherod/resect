import path from "node:path";
import { loadProject, resolveTsConfig } from "../core/project.ts";
import { discoverWorkspace } from "../core/workspace.ts";
import type { MoveResult } from "../types/move.ts";
import { moveModule } from "./move.ts";

export async function moveInFixture(
	dir: string,
	source: string,
	target: string,
	dryRun = false,
	force = false
): Promise<MoveResult> {
	const absSource = path.join(dir, source);
	const tsconfigPath = resolveTsConfig(dir, path.dirname(absSource));
	if (!tsconfigPath) {
		throw new Error("tsconfig not found");
	}
	const project = loadProject(tsconfigPath, absSource);
	const workspace = (await discoverWorkspace(dir)) ?? undefined;
	return moveModule(
		absSource,
		path.join(dir, target),
		project,
		dryRun,
		false,
		workspace,
		force
	);
}
