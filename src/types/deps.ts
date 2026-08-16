import type { SerializedEdit } from "../core/text-changes.ts";

export const DEPENDENCY_SECTIONS = [
	"dependencies",
	"peerDependencies",
	"optionalDependencies",
	"devDependencies",
] as const;

export type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];

export interface ConsumerDependencyContract {
	name: string;
	section?: DependencySection;
	specifier?: string;
	includeWorkspaceClosure?: boolean;
}

export type ConsumerDependencyContractInput =
	| string
	| ConsumerDependencyContract;

export type DependencyRequirementKind = "contract" | "workspace-closure";

export interface DependencyRequirementReason {
	kind: DependencyRequirementKind;
	chain: string[];
}

export interface DependencyContractPolicy {
	packageName: string;
	manifestPath: string;
	consumerDependencies: ConsumerDependencyContract[];
}

export interface DependencyContractRequirement {
	consumerName: string;
	manifestPath: string;
	dependencyName: string;
	section: DependencySection;
	specifier: string;
	requiredBy: string[];
	reasons: DependencyRequirementReason[];
}

export interface DependencyContractChange
	extends DependencyContractRequirement {
	type: "add" | "align" | "move";
	fromSection: DependencySection | null;
	fromSpecifier: string | null;
}

export interface DependencyContractConflictRequirement {
	requiredBy: string;
	section: DependencySection;
	specifier: string;
	reason: DependencyRequirementReason;
}

export interface DependencyContractConflict {
	consumerName: string;
	manifestPath: string;
	dependencyName: string;
	requirements: DependencyContractConflictRequirement[];
}

export type DependencyContractIssueCode =
	| "duplicate-package-name"
	| "invalid-policy"
	| "invalid-policy-entry"
	| "invalid-turbo-config"
	| "missing-provider-dependency"
	| "workspace-closure-target-not-workspace";

export interface DependencyContractIssue {
	code: DependencyContractIssueCode;
	packageName: string;
	manifestPath: string;
	message: string;
}

export interface TurboDependencyChange {
	consumerName: string;
	dependencyName: string;
	taskName: string;
	turboDependency: string;
	turboPath: string;
}

export interface DependencyContractSummary {
	packages: number;
	policies: number;
	requirements: number;
	changes: number;
	conflicts: number;
	issues: number;
	taskChanges: number;
}

export interface DependencyContractReport {
	schemaVersion: "1";
	workspaceRoot: string;
	workspaceType: "pnpm" | "yarn" | "npm" | "unknown";
	policies: DependencyContractPolicy[];
	requirements: DependencyContractRequirement[];
	changes: DependencyContractChange[];
	conflicts: DependencyContractConflict[];
	issues: DependencyContractIssue[];
	taskChanges: TurboDependencyChange[];
	summary: DependencyContractSummary;
}

export interface DepsApplyResult {
	success: boolean;
	dryRun: boolean;
	applied: boolean;
	report: DependencyContractReport;
	edits: SerializedEdit[];
	modifiedFiles: string[];
	lockfileUpdated: boolean;
	lockfileCommand?: string[];
	verificationReport?: DependencyContractReport;
	/**
	 * True when the dirty-worktree guard refused to apply fixes. Reported
	 * rather than exited so the `deps` MCP tool cannot kill its server (#228);
	 * the CLI renderer turns this into the non-zero exit it always had.
	 */
	worktreeBlocked?: boolean;
	/** Whether the worktree had uncommitted changes, independent of `force`. */
	worktreeDirty?: boolean;
}
