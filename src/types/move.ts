import type { TransformRule } from "./transform.ts";

export interface MoveOperation {
	sourcePath: string;
	targetPath: string;
	dryRun: boolean;
}

export interface MoveResult {
	success: boolean;
	movedFile: { from: string; to: string };
	updatedReferences: UpdatedReference[];
	errors: MoveError[];
	/**
	 * Dependency entries added to the destination package.json on a
	 * cross-package move (issue #118). Absent/empty for same-package moves.
	 */
	dependencyChanges?: DependencyChange[];
	/**
	 * Restricted dependencies a cross-package move would have pulled into the
	 * destination, blocked by its `restrictedDependencies` policy (issue #120).
	 * Present when a violation was found — the move halts (no write, no file
	 * move) unless `--force`, in which case it lists the overridden violations.
	 */
	restrictedViolations?: RestrictedDependencyViolation[];
	/**
	 * Declarative transform rules loaded from `--transform <config>` that were in
	 * effect for this move (epic #103, slice A). Present only when a config was
	 * supplied. This slice surfaces the loaded rules for observability and for
	 * the #103 B rewrite visitor to consume; no rewrite is applied yet.
	 */
	transformRules?: TransformRule[];
}

/**
 * A restricted dependency a cross-package move would have added to the
 * destination package, blocked by the destination's `restrictedDependencies`
 * policy (issue #120 — restricted-dependency guardrail).
 */
export interface RestrictedDependencyViolation {
	/** Restricted package name, e.g. "react-dom". */
	name: string;
	/** Destination package declaring the restriction. */
	destinationPackage: string;
	/** Absolute path to the destination package.json declaring the policy. */
	packageJsonPath: string;
}

export interface UpdatedReference {
	file: string;
	line: number;
	oldSpecifier: string;
	newSpecifier: string;
}

export interface MoveError {
	file: string;
	message: string;
	recoverable: boolean;
}

/** Which dependency map an entry belongs to. */
export type DependencyField = "dependencies" | "peerDependencies";

/**
 * A dependency entry added to a destination package.json during a
 * cross-package move (issue #118).
 */
export interface DependencyChange {
	/** Absolute path to the destination package.json being updated. */
	packageJsonPath: string;
	/** Package name, e.g. "lodash" or "@scope/core". */
	name: string;
	/** Semver range copied from the source package. */
	version: string;
	/** Destination map the entry lands in (mirrors the source's placement). */
	field: DependencyField;
}
