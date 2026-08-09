/**
 * Shared options for read-only commands (find, analyze, discover, audit).
 */
export interface ReadOnlyCommandOptions {
	/** Enable detailed per-file logging */
	verbose?: boolean;
	/** Path to project directory or tsconfig.json */
	project?: string;
	/** Scan across all workspace packages */
	workspace?: boolean;
	/**
	 * Emit exactly one machine-readable report to stdout instead of the human
	 * report. Shared by every read-only reporting command (#141) rather than
	 * redeclared per command.
	 */
	json?: boolean;
}

/**
 * Shared options for commands that write source files.
 * All mutating commands (move, rename, alias, extract-common) extend this.
 */
export interface MutatingCommandOptions {
	/** Preview changes without modifying files */
	dryRun?: boolean;
	/** Allow writes even when the git worktree has uncommitted changes */
	force?: boolean;
	/** Enable detailed per-file logging */
	verbose?: boolean;
	/** Path to project directory or tsconfig.json */
	project?: string;
	/** Scan across all workspace packages */
	workspace?: boolean;
	/** Persist a reversible operation record in .resect/history.json */
	journal?: boolean;
}
