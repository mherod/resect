/**
 * Shared MCP prose for descriptor migrations (A2, then B/D1/D2).
 * Keep divergent shipped text as separate entries; unifying it is a product change.
 */
export const MCP_DESCRIPTIONS = {
	directory: {
		scan: "Absolute or cwd-relative path to the project directory to scan",
		// discover, workspace, deps and extract-common have distinct scopes.
		discover:
			"Absolute or cwd-relative path to the directory to scan for tsconfig.json files (usually the repo root)",
		workspace:
			"Absolute or cwd-relative path to the workspace root (the directory containing pnpm-workspace.yaml or a package.json with a 'workspaces' field)",
		dependencies:
			"Absolute or cwd-relative path to a pnpm, Yarn, or npm workspace",
		refactor:
			"Absolute or cwd-relative path to the project directory to scan and refactor",
	},
	project: {
		directory:
			"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`",
		// find requires a project; analyze/analyze-impact recommend inferred ownership.
		required:
			"Absolute or cwd-relative path to the project root or a tsconfig.json; its tsconfig determines which files are in scope",
		analyzeFile:
			"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the file (recommended)",
		analyzeSource:
			"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the source file (recommended)",
		// affected, move, rename, inline, and auto-resolving tools preserve their variants.
		optional: "Optional path to the project root or tsconfig.json",
		sourceFile:
			"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the source file",
		file: "Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the file",
		barrelFile:
			"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the barrel file",
		auto: "Optional path to the project root or tsconfig.json. Omit to auto-resolve",
		// organise alone includes the terminal full stop.
		organise:
			"Optional path to the project root or tsconfig.json. Omit to auto-resolve.",
	},
	includeIgnored: {
		analysis:
			"Analyse git-ignored files too (#202). Off by default: a file excluded from version control is not source, so build output cannot distort the result. Set true only to deliberately analyse generated output",
		// naming talks about conventions, not dependency-analysis results.
		naming:
			"Analyse git-ignored files too (#202). Off by default: a gitignored build directory is not a naming convention anyone maintains. Set true only to deliberately analyse generated output",
	},
	verify: {
		diagnosticDelta:
			"Run `tsc --noEmit` before and after and return the diagnostic delta (default true). Ignored when dryRun=true",
		// move, mock-cleanup and undo each describe different verification behavior.
		move: "Run `tsc --noEmit` before and after the move and return the diagnostic delta (default true). Ignored when dryRun=true",
		rollback:
			"Run `tsc --noEmit` before and after and roll back on regression (default true). Ignored when dryRun=true",
		undo: "Run a TypeScript check after applying the undo (default true). Ignored when dryRun=true",
	},
	force: {
		guard: "Override the dirty-worktree guard (default false). Use with care",
		// move/inline retain the longer warning; hygiene/undo/repair variants differ.
		commitBoundary:
			"Override the dirty-worktree guard (default false). Use with care — the guard prevents data loss on a clean commit boundary",
		preview: "Override dirty-worktree guard when dryRun=false",
		tidy: "Allow mutation when the git worktree is dirty",
		naming:
			"Bypass the dirty-worktree guard when fix=true. Rollback is disabled when force=true on a dirty tree.",
		repairs: "Override the dirty-worktree guard when applying repairs",
		extraction:
			"Override the dirty-worktree guard and call-site conflict check when dryRun=false",
		undo: "Override unrelated or diverged-work safeguards (default false)",
	},
} as const;
