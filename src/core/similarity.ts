import path from "node:path";
import ts from "typescript";
import type {
	DeclarationKind,
	FunctionInfo,
	SimilarityBucket,
	SimilarityGroup,
	SimilarityReport,
} from "../types/similar.ts";
import { TS_JS_VUE_EXTENSIONS } from "./constants.ts";
import { resolveTsConfig } from "./project.ts";
import {
	extractAllIdentifiers,
	extractContentTokens,
	jaccardSimilarity,
	nameSimilarity,
	normalizeBody,
	tokenBigrams,
	tokenize,
} from "./similarity-algorithms.ts";
import { discoverProject } from "./tsconfig-discovery.ts";

/** Minimum token count for a function body to be included */
const MIN_TOKEN_COUNT = 8;

/** Minimum token count for a type alias or interface body to be included */
const MIN_TYPE_TOKEN_COUNT = 6;
/**
 * Content-similarity stand-in when at least one declaration yields no semantic
 * fingerprint. Neutral rather than 1, so structural identity alone cannot reach
 * an exact score on the strength of missing evidence.
 */
const UNKNOWN_CONTENT_EVIDENCE = 0.5;

/** True for the declaration kinds whose content tokens come from a type body. */
function isTypeOrInterface(kind: FunctionInfo["kind"]): boolean {
	return kind === "type" || kind === "interface";
}

/** Compile-time directives that prevent function consolidation */
const DIRECTIVE_PATTERN =
	/["']use (cache|cache:\s*\w+|server|client|strict)["']\s*;?/;

function scoreToBucket(score: number): SimilarityBucket | null {
	if (score >= 0.999) {
		return "exact";
	}
	if (score >= 0.85) {
		return "high";
	}
	if (score >= 0.7) {
		return "medium";
	}
	return null;
}

/**
 * Detect if a function block body is a thin wrapper: exactly one statement
 * that is a return with a call expression (e.g. `return otherFn(a, b)`).
 */
function isWrapperBody(body: ts.Block): boolean {
	const statements = body.statements;
	if (statements.length !== 1) {
		return false;
	}
	const stmt = statements[0];
	if (!stmt) {
		return false;
	}
	// return someFunc(...)
	if (ts.isReturnStatement(stmt) && stmt.expression) {
		return ts.isCallExpression(stmt.expression);
	}
	// Bare expression statement: someFunc(...)
	if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
		return true;
	}
	return false;
}

/**
 * Build a FunctionInfo entry from a normalized body text and metadata.
 */
function makeFunctionInfo(
	filePath: string,
	name: string,
	kind: DeclarationKind,
	line: number,
	character: number,
	bodyText: string,
	normalized: string,
	tokens: string[],
	hasDirective: boolean,
	isWrapper: boolean,
	isTypeGuard: boolean,
	extendsNames: string[] = [],
	memberNames: string[] = []
): FunctionInfo {
	// For type/interface declarations, use all non-keyword identifiers (including
	// camelCase property names) as content tokens. This prevents structurally
	// identical shapes with different field names (e.g. `_seconds` vs `seconds`)
	// from scoring as exact duplicates when their property names differ.
	// For functions, keep the original uppercase-only + string-literal tokens.
	const contentTokens =
		kind === "type" || kind === "interface"
			? extractAllIdentifiers(bodyText)
			: extractContentTokens(bodyText);
	return {
		file: filePath,
		name,
		kind,
		line,
		column: character,
		normalizedBody: normalized,
		tokenCount: tokens.length,
		bodyLength: bodyText.length,
		bodyLines: bodyText.split("\n").length,
		hasDirective,
		contentTokens,
		isWrapper,
		isTypeGuard,
		extendsNames,
		memberNames,
	};
}

/**
 * Collect all top-level function declarations, named const arrow/function
 * expressions, type aliases, and interfaces from a source file.
 */
export function collectFunctions(
	sourceFile: ts.SourceFile,
	filePath: string
): FunctionInfo[] {
	const functions: FunctionInfo[] = [];

	for (const stmt of sourceFile.statements) {
		// function foo() {} or export function foo() {}
		if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
			const bodyText = stmt.body.getText(sourceFile);
			const normalized = normalizeBody(bodyText);
			const tokens = tokenize(normalized);
			if (tokens.length >= MIN_TOKEN_COUNT) {
				const { line, character } = sourceFile.getLineAndCharacterOfPosition(
					stmt.getStart(sourceFile)
				);
				functions.push(
					makeFunctionInfo(
						filePath,
						stmt.name.text,
						"function",
						line + 1,
						character,
						bodyText,
						normalized,
						tokens,
						DIRECTIVE_PATTERN.test(bodyText),
						isWrapperBody(stmt.body),
						stmt.type != null && ts.isTypePredicateNode(stmt.type)
					)
				);
			}
		}
		// const foo = () => { ... } or const foo = function() { ... }
		else if (ts.isVariableStatement(stmt)) {
			for (const decl of stmt.declarationList.declarations) {
				if (!(ts.isIdentifier(decl.name) && decl.initializer)) {
					continue;
				}
				const init = decl.initializer;
				if (
					(ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
					ts.isBlock(init.body)
				) {
					const bodyText = init.body.getText(sourceFile);
					const normalized = normalizeBody(bodyText);
					const tokens = tokenize(normalized);
					if (tokens.length >= MIN_TOKEN_COUNT) {
						const { line, character } =
							sourceFile.getLineAndCharacterOfPosition(
								stmt.getStart(sourceFile)
							);
						functions.push(
							makeFunctionInfo(
								filePath,
								decl.name.text,
								"function",
								line + 1,
								character,
								bodyText,
								normalized,
								tokens,
								DIRECTIVE_PATTERN.test(bodyText),
								isWrapperBody(init.body),
								init.type != null && ts.isTypePredicateNode(init.type)
							)
						);
					}
				}
			}
		}
		// type Foo = ... or export type Foo = ...
		else if (ts.isTypeAliasDeclaration(stmt)) {
			const bodyText = stmt.type.getText(sourceFile);
			const normalized = normalizeBody(bodyText);
			const tokens = tokenize(normalized);
			if (tokens.length >= MIN_TYPE_TOKEN_COUNT) {
				const { line, character } = sourceFile.getLineAndCharacterOfPosition(
					stmt.getStart(sourceFile)
				);
				functions.push(
					makeFunctionInfo(
						filePath,
						stmt.name.text,
						"type",
						line + 1,
						character,
						bodyText,
						normalized,
						tokens,
						false,
						false,
						false
					)
				);
			}
		}
		// interface Foo { ... } or export interface Foo extends Bar { ... }
		else if (ts.isInterfaceDeclaration(stmt)) {
			// Body spans from heritage clauses (if any) through the closing brace
			const heritageClauses = stmt.heritageClauses;
			const bodyStart =
				heritageClauses?.[0]?.getStart(sourceFile) ?? stmt.members.pos;
			const bodyText = sourceFile.text.slice(bodyStart, stmt.end).trim();
			const normalized = normalizeBody(bodyText);
			const tokens = tokenize(normalized);
			if (tokens.length >= MIN_TYPE_TOKEN_COUNT) {
				const { line, character } = sourceFile.getLineAndCharacterOfPosition(
					stmt.getStart(sourceFile)
				);
				// Extract extends clause names
				const extendsNames: string[] = [];
				if (heritageClauses) {
					for (const clause of heritageClauses) {
						for (const type of clause.types) {
							if (ts.isIdentifier(type.expression)) {
								extendsNames.push(type.expression.text);
							}
						}
					}
				}
				// Extract member property names and type reference names
				const memberNames: string[] = [];
				for (const member of stmt.members) {
					if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
						memberNames.push(member.name.text);
					}
					// Capture type references used in member types (e.g. SimilarityGroup[])
					if (ts.isPropertySignature(member) && member.type) {
						ts.forEachChild(member.type, function visit(node: ts.Node) {
							if (
								ts.isTypeReferenceNode(node) &&
								ts.isIdentifier(node.typeName)
							) {
								memberNames.push(node.typeName.text);
							}
							ts.forEachChild(node, visit);
						});
					}
				}
				functions.push(
					makeFunctionInfo(
						filePath,
						stmt.name.text,
						"interface",
						line + 1,
						character,
						bodyText,
						normalized,
						tokens,
						false,
						false,
						false,
						extendsNames,
						memberNames
					)
				);
			}
		}
	}

	return functions;
}

/**
 * Group a list of functions by similarity score above the given threshold.
 * Uses exact normalized-body comparison for "exact" bucket and Jaccard
 * similarity for "high" and "medium" buckets.
 *
 * Each function appears in at most one group (greedy assignment).
 */
/**
 * Check if a file path matches a related-path pattern.
 * Supports: exact file path, directory prefix, and glob patterns with *.
 */
export function matchesRelatedPath(filePath: string, pattern: string): boolean {
	const absFile = path.resolve(filePath);
	const absPattern = path.resolve(pattern);

	// Exact file match
	if (absFile === absPattern) {
		return true;
	}

	// Directory prefix match (pattern is a folder path)
	if (absFile.startsWith(`${absPattern}/`)) {
		return true;
	}

	// Glob pattern (contains * or ?)
	if (pattern.includes("*") || pattern.includes("?")) {
		const glob = new Bun.Glob(pattern);
		// Match against both absolute and the original relative path
		return glob.match(filePath) || glob.match(absFile);
	}

	return false;
}

export interface SimilarityFilterOptions {
	threshold?: number;
	nameThreshold?: number;
	sameNameOnly?: boolean;
	/** Discard groups where every function lives in the same file */
	skipSameFile?: boolean;
	/** Only include groups containing at least one function from a matching path */
	onlyRelatedTo?: string;
	/** Exclude functions with fewer body lines than this threshold */
	minLines?: number;
	/** Exclude functions containing compile-time directives */
	skipDirectives?: boolean;
	/** Exclude thin wrapper functions (single return + call expression) */
	skipWrappers?: boolean;
	/** Only include declarations of these kinds (default: all kinds) */
	kinds?: DeclarationKind[];
}

export function findSimilarGroups(
	functions: FunctionInfo[],
	thresholdOrOptions: number | SimilarityFilterOptions = 0.8
): SimilarityGroup[] {
	const opts =
		typeof thresholdOrOptions === "number"
			? { threshold: thresholdOrOptions }
			: thresholdOrOptions;
	const threshold = opts.threshold ?? 0.8;
	const nameThresholdValue = opts.nameThreshold;
	const sameNameOnly = opts.sameNameOnly ?? false;

	// Pre-filter: exclude functions below minimum line count or with directives
	let candidates = functions;
	if (opts.minLines !== undefined) {
		candidates = candidates.filter(
			(f) => f.bodyLines >= (opts.minLines as number)
		);
	}
	if (opts.skipDirectives) {
		candidates = candidates.filter((f) => !f.hasDirective);
	}
	if (opts.skipWrappers) {
		candidates = candidates.filter((f) => !f.isWrapper);
	}
	if (opts.kinds && opts.kinds.length > 0) {
		const kindSet = new Set(opts.kinds);
		candidates = candidates.filter((f) => kindSet.has(f.kind));
	}

	// Precompute token artifacts for all candidates to avoid redundant
	// tokenization and bigram generation inside the O(n^2) pairwise loop.
	const preTokens: string[][] = [];
	const preBigrams: string[][] = [];
	for (const fn of candidates) {
		const tokens = tokenize(fn.normalizedBody);
		preTokens.push(tokens);
		preBigrams.push(tokenBigrams(tokens));
	}

	const groups: SimilarityGroup[] = [];
	const assigned = new Set<number>();

	for (let i = 0; i < candidates.length; i++) {
		if (assigned.has(i)) {
			continue;
		}

		const fnI = candidates[i];
		if (!fnI) {
			continue;
		}
		const tokensI = preTokens[i];
		const bigramsI = preBigrams[i];
		const group: FunctionInfo[] = [fnI];
		let minScore = 1.0;

		for (let j = i + 1; j < candidates.length; j++) {
			if (assigned.has(j)) {
				continue;
			}

			const fnJ = candidates[j];
			if (!fnJ) {
				continue;
			}

			// Apply name filtering early — skip before expensive score
			// computation so that differently-named functions are never
			// candidates for grouping when sameNameOnly is active.
			if (sameNameOnly && fnI.name !== fnJ.name) {
				continue;
			}
			if (
				nameThresholdValue !== undefined &&
				nameSimilarity(fnI.name, fnJ.name) < nameThresholdValue
			) {
				continue;
			}

			// Skip cross-file type guard pairs — type predicates (`value is T`) are
			// intrinsically tied to the type they guard. Two guards that call the same
			// helper (e.g. `hasNumericProps(v, "fieldA", "fieldB")`) are structurally
			// similar only because they share an implementation pattern, not because
			// they are candidates for consolidation.
			if (fnI.file !== fnJ.file && fnI.isTypeGuard && fnJ.isTypeGuard) {
				continue;
			}

			// Skip interface pairs that share a common extends base — they are
			// already consolidated via inheritance, not candidates for extraction.
			// e.g. MoveOptions extends MutatingCommandOptions and
			//      RenameOptions extends MutatingCommandOptions.
			// Also skip pairs where both extend different bases — the similarity
			// comes from inherited fields, not from the interfaces themselves.
			if (fnI.extendsNames.length > 0 && fnJ.extendsNames.length > 0) {
				continue;
			}

			// Skip composed type pairs — when one interface references the other
			// by name in its members (e.g. SimilarityReport has a field of type
			// SimilarityGroup[]), they are parent/child, not duplicates.
			if (
				fnI.memberNames.includes(fnJ.name) ||
				fnJ.memberNames.includes(fnI.name)
			) {
				continue;
			}

			// Skip if original body sizes are very different — avoids false
			// positives where normalization collapses large and small functions
			// to the same token set (e.g. a 40-line template vs a 1-liner).
			const sizeRatio =
				Math.min(fnI.bodyLength, fnJ.bodyLength) /
				Math.max(fnI.bodyLength, fnJ.bodyLength);
			if (sizeRatio < 0.5) {
				continue;
			}

			// Skip if token counts differ significantly — Jaccard on sets
			// ignores frequency, so functions with the same unique tokens but
			// different lengths (e.g. a.has(b) vs a.b.has(c(d))) get a
			// misleading 1.0 score.
			const tokensJ = preTokens[j];
			const tokenRatio =
				Math.min(tokensI?.length ?? 0, tokensJ?.length ?? 0) /
				Math.max(tokensI?.length ?? 1, tokensJ?.length ?? 1);
			if (tokenRatio < 0.75) {
				continue;
			}

			let score: number;
			if (fnI.normalizedBody === fnJ.normalizedBody) {
				// Exact structural match — blend with content token similarity to detect
				// semantic false positives. Content tokens now include uppercase
				// identifiers, string literals, AND camelCase function call targets,
				// so wrappers calling different functions (e.g. runBashHook vs
				// runFileEditHook) produce different content tokens and score < 1.0.
				// For a type or interface an empty fingerprint means no semantic
				// evidence was recoverable, not that the two declarations agree.
				// jaccardSimilarity() defines two empty sets as 1 — mathematically
				// standard, but here it turns absence of evidence into proof of
				// equivalence and promotes a structural coincidence to an exact
				// match. Score that unknown case as high-but-not-exact.
				//
				// Functions are deliberately excluded: an empty content fingerprint
				// is ordinary for a body with no literals, uppercase identifiers, or
				// call targets, and structural identity there is real evidence of
				// duplication. Penalising it would change existing wrapper and
				// same-file function behaviour.
				const isTypeLike =
					isTypeOrInterface(fnI.kind) && isTypeOrInterface(fnJ.kind);
				const hasFingerprints =
					fnI.contentTokens.length > 0 && fnJ.contentTokens.length > 0;
				score =
					isTypeLike && !hasFingerprints
						? 0.5 + 0.5 * UNKNOWN_CONTENT_EVIDENCE
						: 0.5 +
							0.5 * jaccardSimilarity(fnI.contentTokens, fnJ.contentTokens);
			} else {
				// Use precomputed bigrams to capture token ordering — plain set
				// Jaccard gives misleading 1.0 for functions with the same token
				// vocabulary but different structure.
				score = jaccardSimilarity(bigramsI ?? [], preBigrams[j] ?? []);

				// Penalise structural lookalikes whose semantic content is completely
				// disjoint. Zod literal unions, string-enum-like patterns, and config
				// schemas often share the same AST shape (same bigram distribution)
				// but carry entirely different string literal values or identifiers —
				// they are coincidental structural matches rather than true duplicates.
				// Only apply when both declarations carry meaningful content tokens
				// (≥2) so that empty-content declarations are not inadvertently
				// penalised.
				const contentI = fnI.contentTokens;
				const contentJ = fnJ.contentTokens;
				if (contentI.length >= 2 && contentJ.length >= 2) {
					const contentSim = jaccardSimilarity(contentI, contentJ);
					if (contentSim === 0) {
						// Completely disjoint — strong reduction to push below threshold
						score *= 0.65;
					} else if (contentSim < 0.2) {
						// Mostly disjoint — softer blend
						score = 0.85 * score + 0.15 * contentSim;
					}
				}
			}

			// Soft penalty for cross-file pairs with completely dissimilar names.
			// Pure structural similarity can be coincidental when unrelated functions
			// from different domains share the same shape (e.g. two object-mapper
			// functions that each map one struct to another). Blending in a name
			// signal reduces these false positives while leaving same-file pairs
			// and pairs with any shared name token unaffected.
			if (fnI.file !== fnJ.file && nameSimilarity(fnI.name, fnJ.name) < 0.1) {
				score *= 0.85;
			}

			// Penalise small interface pairs with low member name overlap.
			// Interfaces with ≤5 members that share generic field names (file, line,
			// name, etc.) produce inflated Jaccard scores from coincidental shape.
			// Blend in the member name similarity to reduce these false positives.
			if (
				fnI.kind === "interface" &&
				fnJ.kind === "interface" &&
				fnI.memberNames.length > 0 &&
				fnJ.memberNames.length > 0 &&
				fnI.memberNames.length <= 5 &&
				fnJ.memberNames.length <= 5
			) {
				const memberSim = jaccardSimilarity(fnI.memberNames, fnJ.memberNames);
				if (memberSim < 0.5) {
					score *= 0.7 + 0.3 * memberSim;
				}
			}

			if (score >= threshold) {
				group.push(fnJ);
				assigned.add(j);
				minScore = Math.min(minScore, score);
			}
		}

		if (group.length > 1) {
			assigned.add(i);
			const bucket = scoreToBucket(minScore);
			if (bucket) {
				groups.push({ bucket, score: minScore, functions: group });
			}
		}
	}

	// Sort by score descending (best matches first)
	groups.sort((a, b) => b.score - a.score);

	let filtered = groups;

	// Filter out same-file groups when requested
	if (opts.skipSameFile) {
		filtered = filtered.filter((g) => {
			const files = new Set(g.functions.map((f) => f.file));
			return files.size > 1;
		});
	}

	// Filter to groups related to a specific path/glob
	if (opts.onlyRelatedTo) {
		const pattern = opts.onlyRelatedTo;
		filtered = filtered.filter((g) =>
			g.functions.some((f) => matchesRelatedPath(f.file, pattern))
		);
	}

	return filtered;
}

/**
 * Walk up from `dir` to find the nearest ancestor directory that contains a
 * tsconfig.json. Returns `dir` itself if none is found (graceful fallback).
 */
function findProjectRoot(dir: string): string {
	const start = path.resolve(dir);
	let current = start;
	let parent = path.dirname(current);
	// Walk up until the filesystem root (where dirname(current) === current).
	while (parent !== current) {
		if (ts.sys.fileExists(path.join(current, "tsconfig.json"))) {
			return current;
		}
		current = parent;
		parent = path.dirname(current);
	}
	// Check the root itself, then fall back to the original directory.
	if (ts.sys.fileExists(path.join(current, "tsconfig.json"))) {
		return current;
	}
	return start;
}

/**
 * Collect functions from an array of file paths using bounded concurrency.
 */
export async function collectFunctionsFromFiles(filePaths: string[]): Promise<{
	functions: FunctionInfo[];
	totalFiles: number;
}> {
	const { mapConcurrent } = await import("./concurrency.ts");
	const results = await mapConcurrent(
		filePaths,
		async (filePath) => {
			const content = await Bun.file(filePath).text();
			const sourceFile = ts.createSourceFile(
				filePath,
				content,
				ts.ScriptTarget.Latest,
				true
			);
			return collectFunctions(sourceFile, filePath);
		},
		{ onError: () => [] as FunctionInfo[] }
	);

	return { functions: results.flat(), totalFiles: filePaths.length };
}

/**
 * Resolve an explicit `--project` argument to the directory owning its config.
 *
 * Routes through the shared `resolveTsConfig()` so `similar` accepts the same
 * config-file-or-directory forms as every other command, then requires the
 * result to exist. Without that check a bogus path silently degrades to its
 * parent directory, so an unreadable config produced a normal-looking report
 * instead of an error.
 */
function resolveExplicitProjectRoot(
	projectRoot: string,
	startDir: string
): string {
	const tsconfigPath = resolveTsConfig(projectRoot, startDir);
	if (!(tsconfigPath && ts.sys.fileExists(tsconfigPath))) {
		throw new Error(
			`Could not resolve a tsconfig.json from --project ${projectRoot}`
		);
	}
	return path.dirname(tsconfigPath);
}

/**
 * Scan all TypeScript/JavaScript files in a project directory and collect
 * top-level function declarations and named const function expressions.
 *
 * @param directory - Directory to scan (results are filtered to files under this path)
 * @param projectRoot - Optional explicit project root containing tsconfig.json.
 *   Accepts a tsconfig file path or a directory containing one, matching
 *   TypeScript's `--project` contract. When omitted, the nearest tsconfig.json
 *   ancestor of `directory` is used.
 */
export async function scanProjectFunctions(
	directory: string,
	projectRoot?: string
): Promise<{ functions: FunctionInfo[]; totalFiles: number }> {
	const absoluteDir = path.resolve(directory);
	let rootDir = findProjectRoot(absoluteDir);
	if (projectRoot) {
		rootDir = resolveExplicitProjectRoot(projectRoot, absoluteDir);
	}

	const discovery = discoverProject(rootDir);
	const allFiles = Array.from(discovery.fileOwnership.keys()).filter(
		(f) => TS_JS_VUE_EXTENSIONS.test(f) && f.startsWith(absoluteDir)
	);

	return collectFunctionsFromFiles(allFiles);
}

/**
 * Scan all TypeScript/JavaScript files across workspace packages and collect
 * top-level function declarations and named const function expressions.
 * Each package's tsconfig is used for file discovery when available, falling
 * back to directory-based discovery.
 */
export async function scanWorkspaceFunctions(directory: string): Promise<{
	functions: FunctionInfo[];
	totalFiles: number;
	packageCount: number;
}> {
	const { discoverWorkspace, filterToWorkspaceBoundary } = await import(
		"./workspace.ts"
	);
	const absDir = path.resolve(directory);
	const workspace = await discoverWorkspace(absDir);
	if (!workspace || workspace.packages.length === 0) {
		return { functions: [], totalFiles: 0, packageCount: 0 };
	}

	// Guard: reject if directory is outside workspace root
	if (filterToWorkspaceBoundary([absDir], workspace.root).length === 0) {
		return { functions: [], totalFiles: 0, packageCount: 0 };
	}

	const { mapConcurrent } = await import("./concurrency.ts");
	const pkgFiles = await mapConcurrent(
		workspace.packages,
		async (pkg) => {
			const scanDir = pkg.srcDir ? path.join(pkg.path, pkg.srcDir) : pkg.path;
			const discovery = discoverProject(scanDir);
			return Array.from(discovery.fileOwnership.keys()).filter((fp) =>
				TS_JS_VUE_EXTENSIONS.test(fp)
			);
		},
		{ onError: () => [] as string[] }
	);
	const seen = new Set<string>();
	const allFiles: string[] = [];
	for (const files of pkgFiles) {
		for (const filePath of files) {
			if (!seen.has(filePath)) {
				seen.add(filePath);
				allFiles.push(filePath);
			}
		}
	}

	const bounded = filterToWorkspaceBoundary(allFiles, workspace.root);
	const result = await collectFunctionsFromFiles(bounded);
	return { ...result, packageCount: workspace.packages.length };
}

/**
 * Run the full similarity analysis on a project directory.
 * When workspace is true, scans across all workspace packages.
 *
 * @param directory - Directory to scan
 * @param threshold - Similarity threshold (0–1, default 0.8)
 * @param projectRoot - Optional project root containing tsconfig.json
 * @param workspace - When true, scan across all workspace packages
 */
export interface SimilarityDiscoveryOptions extends SimilarityFilterOptions {
	directory: string;
	project?: string;
	workspace?: boolean;
}

export type AnalyzeSimilarityOptions = SimilarityDiscoveryOptions;

export async function analyzeSimilarity(
	directoryOrOpts: string | AnalyzeSimilarityOptions,
	threshold = 0.8,
	projectRoot?: string,
	workspace = false
): Promise<SimilarityReport & { packageCount?: number }> {
	const opts: AnalyzeSimilarityOptions =
		typeof directoryOrOpts === "string"
			? {
					directory: directoryOrOpts,
					threshold,
					project: projectRoot,
					workspace,
				}
			: directoryOrOpts;
	const dir = opts.directory;
	const th = opts.threshold ?? threshold;
	const pr = opts.project ?? projectRoot;
	const ws = opts.workspace ?? workspace;
	const filterOpts: SimilarityFilterOptions = {
		threshold: th,
		nameThreshold: opts.nameThreshold,
		sameNameOnly: opts.sameNameOnly,
		skipSameFile: opts.skipSameFile,
		onlyRelatedTo: opts.onlyRelatedTo,
		minLines: opts.minLines,
		skipDirectives: opts.skipDirectives,
		skipWrappers: opts.skipWrappers,
		kinds: opts.kinds,
	};

	if (ws) {
		const result = await scanWorkspaceFunctions(dir);
		const groups = findSimilarGroups(result.functions, filterOpts);
		return {
			groups,
			totalFunctions: result.functions.length,
			totalFiles: result.totalFiles,
			packageCount: result.packageCount,
		};
	}

	const { functions, totalFiles } = await scanProjectFunctions(dir, pr);
	const groups = findSimilarGroups(functions, filterOpts);
	return { groups, totalFunctions: functions.length, totalFiles };
}
