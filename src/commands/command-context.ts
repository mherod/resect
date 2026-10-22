import { logger } from "../cli-logger.ts";
import {
	type ProjectContext,
	type ProjectContextOptions,
	setupProjectContext,
} from "../core/project-context.ts";
import type { ProjectConfig } from "../types.ts";
import type { ExtensionPolicy } from "./option-domains.ts";

export type {
	ProjectContext as CommandContext,
	ProjectContextOptions as SetupCommandContextOptions,
	ProjectGraphMode as CommandGraphMode,
	ProjectWorkspaceMode as CommandWorkspaceMode,
	WorkspaceProjectErrorMode,
} from "../core/project-context.ts";

/** Compatibility adapter; command-owned rendering and guards stay in callers. */
export const setupCommandContext = async (
	options: ProjectContextOptions
): Promise<ProjectContext | null> => setupProjectContext(options);

/**
 * Warn when `--extensions=explicit` will emit specifiers the project's own
 * compiler rejects (#175).
 *
 * `explicit` exists for loaders that need fully-specified ESM paths, but a
 * `.ts` specifier is a hard `tsc` error (TS5097) unless
 * `allowImportingTsExtensions` is set. The move/alias verify gate already
 * catches that afterwards and reports the diagnostics; warning up front turns a
 * post-hoc typecheck failure into an actionable message before any file is
 * written. Reads the parsed compiler options, so an `extends` chain that sets
 * the flag is honoured — unlike a raw tsconfig read.
 */
export function warnIfExplicitExtensionsUnsupported(
	project: ProjectConfig,
	extensions: ExtensionPolicy | undefined
): void {
	if (extensions !== "explicit") {
		return;
	}
	if (project.compilerOptions.allowImportingTsExtensions === true) {
		return;
	}
	logger.warn(
		"Warning: --extensions=explicit emits file extensions in rewritten specifiers, but this project does not set 'allowImportingTsExtensions'."
	);
	logger.warn(
		"         tsc will report TS5097 for those imports. Enable the option, or use --extensions=preserve."
	);
}
