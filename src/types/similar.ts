export type DeclarationKind = "function" | "type" | "interface";

export interface FunctionInfo {
	/** Absolute path to the file */
	file: string;
	/** Function name */
	name: string;
	/** Declaration kind: function, type alias, or interface */
	kind: DeclarationKind;
	/** Line number where the function starts */
	line: number;
	/** Column number */
	column: number;
	/** Normalized body text for comparison */
	normalizedBody: string;
	/** Number of tokens in the normalized body */
	tokenCount: number;
	/** Length of the original (pre-normalization) body text */
	bodyLength: number;
	/** Number of lines in the original function body */
	bodyLines: number;
	/** Whether the function body contains a compile-time directive */
	hasDirective: boolean;
	/** Semantic content tokens: uppercase identifiers and string literal values from the original body */
	contentTokens: string[];
	/** Whether the function body is a thin wrapper (single return + call expression) */
	isWrapper: boolean;
	/** Whether the function is a type predicate (return type `value is SomeType`) */
	isTypeGuard: boolean;
	/** For interfaces: names from `extends` clauses (e.g. `["BaseOptions"]`) */
	extendsNames: string[];
	/** For interfaces/types: property and type-reference names used in the body */
	memberNames: string[];
}

export type SimilarityBucket = "exact" | "high" | "medium";

export interface SimilarityGroup {
	/** Similarity level */
	bucket: SimilarityBucket;
	/** Similarity score (0–1) */
	score: number;
	/** Functions in this group */
	functions: FunctionInfo[];
}

export interface SimilarityReport {
	/** All groups of similar functions, ranked by score descending */
	groups: SimilarityGroup[];
	/** Total functions scanned */
	totalFunctions: number;
	/** Total files scanned */
	totalFiles: number;
	/** Non-blocking notices, e.g. non-source files excluded from analysis (#202). */
	warnings?: string[];
}
