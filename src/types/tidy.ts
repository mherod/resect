import type { StructuredEdit } from "../core/text-changes.ts";
import type { DeclarationKind, SimilarityBucket } from "./similar.ts";

type TidySchemaVersion = "1-experimental";

export interface TidyOptions {
	directory: string;
	project?: string;
	workspace?: boolean;
	verbose?: boolean;
	json?: boolean;
	experimental?: boolean;
	scope?: string;
	out?: string;
	fix?: boolean;
	dryRun?: boolean;
	fixCategories?: TidyFixCategory[];
	aliasPrefer?: "alias" | "relative" | "shortest";
	force?: boolean;
	journal?: boolean;
	maxChanges?: number;
	fanOutThreshold?: number;
	fanInThreshold?: number;
	exportThreshold?: number;
}

export type TidyFixCategory =
	| "dead-exports"
	| "alias-normalisation"
	| "file-moves"
	| "mock-cleanup"
	| "case-renames"
	| "layout-relocations";

export interface TidyAppliedFix {
	category: TidyFixCategory;
	file: string;
	mutationKind:
		| "de-export"
		| "alias-normalise"
		| "mock-cleanup"
		| "case-rename"
		| "move";
	target: string;
	wasRolledBack: boolean;
}

export interface TypecheckDelta {
	errorsBefore: number;
	errorsAfter: number;
	newErrors: string[];
	fixedCount: number;
	verificationIncomplete: boolean;
	incompleteReason?: string[];
}

export interface TidyUnusedFinding {
	kind: "unused";
	sourceFile: string;
	name: string;
	line: number;
	exportKind: string;
	isType: boolean;
	internalUsage: boolean;
	internalRefCount: number;
}

export interface TidySimilarMember {
	sourceFile: string;
	name: string;
	kind: DeclarationKind;
	line: number;
}

export interface TidySimilarFinding {
	kind: "similar";
	sourceFile: string;
	groupIndex: number;
	bucket: SimilarityBucket;
	score: number;
	members: TidySimilarMember[];
}

interface TidyAuditCycleFinding {
	kind: "audit-cycle";
	sourceFile: string;
	files: string[];
}

interface TidyAuditMetricFinding {
	kind: "audit-fan-out" | "audit-fan-in" | "audit-export-surface";
	sourceFile: string;
	value: number;
	threshold: number;
	instability: number;
}

export type TidyAuditFinding = TidyAuditCycleFinding | TidyAuditMetricFinding;

export type TidyFinding =
	| TidyUnusedFinding
	| TidySimilarFinding
	| TidyAuditFinding;

export interface TidyReport {
	schemaVersion: TidySchemaVersion;
	directory: string;
	scope: string | null;
	generatedAt: string;
	findings: {
		unused: TidyUnusedFinding[];
		similar: TidySimilarFinding[];
		audit: TidyAuditFinding[];
	};
	/** Exact text edits planned for the selected fix categories */
	edits: StructuredEdit[];
	applied: TidyAppliedFix[];
	typecheckDelta: TypecheckDelta | null;
	journalEntryId?: string;
	summary: {
		totalFindings: number;
		filesTouched: number;
		categories: {
			unused: number;
			similar: number;
			audit: number;
		};
		scanned: {
			unusedFiles: number;
			similarFiles: number;
			auditFiles: number;
		};
	};
}
