import path from "node:path";
import { logger, printCommandResult } from "../cli-logger.ts";
import ts from "../core/ast-utils.ts";
import { checkAllConflicts } from "../core/conflict-detection.ts";
import {
	compareDeclarations,
	describeComparison,
} from "../core/duplicate-detection.ts";
import {
	ensureCleanWorktree,
	ensureRollbackSafeWorktree,
	type RollbackSafety,
} from "../core/git.ts";
import { buildDependencyGraph, findAllReferences } from "../core/graph.ts";
import {
	completeOperationJournal,
	prepareOperationJournal,
} from "../core/journal.ts";
import { createProgram } from "../core/project.ts";
import { normalizePath } from "../core/resolver.ts";
import {
	createGitFilesRollbackStrategy,
	createRollbackCheckpoint,
	tryRestoreRollback,
} from "../core/rollback.ts";
import { getNameNode, hasExportModifier } from "../core/scanner.ts";
import { parentOf } from "../core/source-file.ts";
import {
	applyTextChanges,
	createStructuredEdit,
	deduplicateChanges,
	type StructuredEdit,
	serializeStructuredEdits,
	type TextChange,
} from "../core/text-changes.ts";
import {
	printVerificationResults,
	runWithTypecheckGuard,
	type VerificationResult,
} from "../core/verify.ts";
import { getRuntime } from "../runtime/index.ts";
import type { ModuleReference } from "../types/graph.ts";
import type { UpdatedReference } from "../types/move.ts";
import type { MutatingCommandOptions, ProjectConfig } from "../types.ts";
import { setupCommandContext } from "./command-context.ts";

export interface RenameOptions extends MutatingCommandOptions {
	file: string;
	oldName: string;
	newName: string;
	json?: boolean;
	verify?: boolean;
}

export interface RenameResult {
	success: boolean;
	renamedSymbol: { file: string; oldName: string; newName: string };
	edits: StructuredEdit[];
	updatedReferences: UpdatedReference[];
	errors: { file: string; message: string }[];
}

export async function renameCommand(options: RenameOptions): Promise<void> {
	const {
		file,
		oldName,
		newName,
		dryRun = false,
		force = false,
		json = false,
		verbose = false,
		project: projectArg,
		workspace = false,
		verify = true,
		journal = false,
	} = options;

	const absolutePath = path.resolve(file);

	const rollbackSafety = verify
		? await ensureRollbackSafeWorktree(path.dirname(absolutePath), {
				force,
				dryRun,
				operation: "rename",
			})
		: undefined;
	if (!rollbackSafety) {
		await ensureCleanWorktree(path.dirname(absolutePath), force, dryRun);
	}

	const context = await setupCommandContext({
		project: projectArg,
		searchPath: path.dirname(absolutePath),
		targetFile: absolutePath,
		workspace: workspace ? "projects" : "none",
	});
	if (!context) {
		logger.error("Could not find tsconfig.json");
		process.exit(1);
	}
	const { extraProjects, project } = context;
	const journalContext = await prepareOperationJournal(
		project.rootDir,
		journal && !dryRun
	);
	if (!json && verbose && extraProjects.length > 0) {
		logger.info(
			`Workspace: scanning ${extraProjects.length} additional package(s)`
		);
	}

	if (!json) {
		logger.info(`\n${dryRun ? "🔍 Dry run:" : "🚀"} Renaming symbol...`);
		logger.info(`   File: ${absolutePath}`);
		logger.info(`   ${oldName} → ${newName}\n`);
	}

	const runRename = async () =>
		renameSymbol(
			absolutePath,
			oldName,
			newName,
			project,
			dryRun,
			json ? false : verbose,
			extraProjects,
			force
		);
	const { result, delta } =
		verify && !dryRun
			? await runWithTypecheckGuard(project, runRename)
			: { result: await runRename(), delta: undefined };
	let rolledBack = false;
	if (delta) {
		delta.worktreeDirtyRollbackDisabled =
			rollbackSafety?.worktreeDirtyRollbackDisabled ?? false;
		if (result.success && !delta.success && rollbackSafety?.rollbackEnabled) {
			rolledBack = await rollbackRenameChanges(project, result);
		}
		delta.rolledBack = rolledBack;
	}
	const success = result.success && (delta?.success ?? true);
	const journalEntry =
		success && !dryRun
			? await completeOperationJournal(journalContext, {
					args: {
						file: path.relative(project.rootDir, absolutePath),
						newName,
						oldName,
					},
					command: "rename",
				})
			: null;

	if (json) {
		const root = project.rootDir;
		logger.info(
			JSON.stringify(
				{
					...result,
					success,
					rolledBack,
					worktreeDirtyRollbackDisabled:
						rollbackSafety?.worktreeDirtyRollbackDisabled ?? false,
					renamedSymbol: {
						...result.renamedSymbol,
						file: path.relative(root, result.renamedSymbol.file),
					},
					edits: serializeStructuredEdits(result.edits, (editFile) =>
						path.relative(root, editFile)
					),
					updatedReferences: result.updatedReferences.map((reference) => ({
						...reference,
						file: path.relative(root, reference.file),
					})),
					errors: result.errors.map((error) => ({
						...error,
						file: path.relative(root, error.file),
					})),
					typecheck: delta,
					journalEntryId: journalEntry?.id,
				},
				null,
				2
			)
		);
	} else {
		printCommandResult(
			{
				...result,
				success,
				updatedReferences: rolledBack ? [] : result.updatedReferences,
			},
			"rename",
			"Renamed",
			dryRun,
			verbose,
			project.rootDir
		);
		if (journalEntry) {
			logger.info(`Journaled operation ${journalEntry.id}`);
		}
	}

	if (delta && !json) {
		printVerificationResults(delta);
	}
	if (delta && !delta.success) {
		logger.error(renameVerificationFailureMessage(delta, rollbackSafety));
	}

	if (!success) {
		process.exit(1);
	}
}

export async function rollbackRenameChanges(
	project: ProjectConfig,
	result: RenameResult
): Promise<boolean> {
	const checkpoint = await createRollbackCheckpoint(
		createGitFilesRollbackStrategy(
			project.rootDir,
			result.edits.map((edit) => edit.file)
		)
	);
	return tryRestoreRollback(checkpoint);
}

function renameVerificationFailureMessage(
	delta: VerificationResult,
	rollbackSafety: RollbackSafety | undefined
): string {
	if (delta.rolledBack) {
		return "Rename verification failed; changes were rolled back.";
	}
	if (rollbackSafety?.worktreeDirtyRollbackDisabled) {
		return "Rename verification failed; changes remain applied because rollback was disabled (--force on dirty tree).";
	}
	return "Rename verification failed and automatic rollback could not restore the changed files.";
}

export async function renameSymbol(
	filePath: string,
	oldName: string,
	newName: string,
	project: ProjectConfig,
	dryRun: boolean,
	verbose: boolean,
	extraProjects: ProjectConfig[] = [],
	force = false
): Promise<RenameResult> {
	const errors: { file: string; message: string }[] = [];
	const edits: StructuredEdit[] = [];
	const updatedReferences: UpdatedReference[] = [];
	const rt = getRuntime();

	// Validate file exists
	if (!(await rt.fs.exists(filePath))) {
		return {
			success: false,
			renamedSymbol: { file: filePath, oldName, newName },
			edits: [],
			updatedReferences: [],
			errors: [{ file: filePath, message: "File does not exist" }],
		};
	}

	// Build dependency graph
	if (verbose) {
		logger.info("Building dependency graph...");
	}
	const graph = await buildDependencyGraph(project);

	// Find all files that import from this file
	const references = findAllReferences(filePath, graph);

	// Also find references from workspace packages
	for (const extraProject of extraProjects) {
		try {
			const extraGraph = await buildDependencyGraph(extraProject);
			const extraRefs = findAllReferences(filePath, extraGraph);
			references.push(...extraRefs);
		} catch {
			// Skip packages that fail to build graph
		}
	}
	if (verbose) {
		logger.info(`Found ${references.length} references to check`);
	}

	// Create program for parsing — reuse the graph's program when available
	// (buildDependencyGraph sets it for project-loaded graphs; fallback covers
	// test-constructed graphs that bypass it).
	const program = graph.program ?? createProgram(project);
	const checker = program.getTypeChecker();

	// First, rename the export in the source file
	const sourceAst = program.getSourceFile(filePath);
	if (!sourceAst) {
		return {
			success: false,
			renamedSymbol: { file: filePath, oldName, newName },
			edits: [],
			updatedReferences: [],
			errors: [{ file: filePath, message: "Could not parse source file" }],
		};
	}

	// Check if the export exists
	const exportInfo = findExport(sourceAst, oldName);
	if (!exportInfo) {
		return {
			success: false,
			renamedSymbol: { file: filePath, oldName, newName },
			edits: [],
			updatedReferences: [],
			errors: [{ file: filePath, message: `Export "${oldName}" not found` }],
		};
	}

	// Check for all conflicts (export name + binding) in a single call
	const importingFiles: Array<{
		sourceFile: ts.SourceFile;
		specifier: string;
		bindings: Array<{ name: string; alias?: string }>;
	}> = [];
	for (const ref of references) {
		if (normalizePath(ref.sourceFile) === normalizePath(filePath)) {
			continue;
		}
		if (!ref.bindings) {
			continue;
		}
		const hasUnaliasedImport = ref.bindings.some(
			(b) => b.name === oldName && !b.alias
		);
		if (!hasUnaliasedImport) {
			continue;
		}
		const importingAst = program.getSourceFile(ref.sourceFile);
		if (!importingAst) {
			continue;
		}
		importingFiles.push({
			sourceFile: importingAst,
			specifier: ref.specifier,
			bindings: ref.bindings.map((b) => ({ name: b.name, alias: b.alias })),
		});
	}

	const conflictResult = checkAllConflicts({
		exportNames: [newName],
		targetSourceFile: sourceAst,
		importingFiles,
		skipImportedName: oldName,
	});

	if (conflictResult.hasConflict) {
		// Enrich each conflict with a duplicate-similarity verdict. When the
		// target name already exists as a declaration in the source file, compare
		// it against the declaration being renamed so the user learns whether the
		// existing one is essentially a duplicate. The conflict blocks unless
		// --force.
		const conflicts = conflictResult.conflicts.map((c) => {
			let detail = "";
			if (normalizePath(c.file) === normalizePath(sourceAst.fileName)) {
				detail = describeComparison(
					compareDeclarations(sourceAst, oldName, sourceAst, c.name)
				);
			}
			const location = c.line ? ` at ${c.line}:${c.column}` : "";
			return {
				file: c.file,
				message: `"${c.name}" already exists${location}${detail} — rename would cause a conflict`,
			};
		});

		if (force) {
			for (const c of conflicts) {
				logger.warn(`⚠️  Proceeding past conflict (--force): ${c.message}`);
			}
		} else {
			return {
				success: false,
				renamedSymbol: { file: filePath, oldName, newName },
				edits: [],
				updatedReferences: [],
				errors: conflicts.map((c) => ({
					...c,
					message: `${c.message}. Re-run with --force to proceed.`,
				})),
			};
		}
	}

	// Rename in source file
	const renamedSymbol = getRenamedSymbol(sourceAst, checker, exportInfo);
	const sourceResult = renameInSourceFile(sourceAst, oldName, newName, {
		checker,
		renamedSymbol: renamedSymbol ?? undefined,
	});
	if (sourceResult.changes.length > 0) {
		const edit = createStructuredEdit(
			filePath,
			sourceAst.text,
			sourceResult.newContent
		);
		if (edit) {
			edits.push(edit);
		}
		updatedReferences.push(
			...sourceResult.updates.map((u) => ({ ...u, file: filePath }))
		);
		if (!dryRun) {
			await rt.fs.writeFile(filePath, sourceResult.newContent);
		}
	}

	// Group references by file
	const refsByFile = new Map<string, ModuleReference[]>();
	for (const ref of references) {
		if (normalizePath(ref.sourceFile) === normalizePath(filePath)) {
			continue;
		}
		const existing = refsByFile.get(ref.sourceFile) ?? [];
		existing.push(ref);
		refsByFile.set(ref.sourceFile, existing);
	}

	// Update each importing file
	for (const [importingFile, fileRefs] of refsByFile) {
		try {
			const fileAst = program.getSourceFile(importingFile);
			if (!fileAst) {
				errors.push({ file: importingFile, message: "Could not parse file" });
				continue;
			}

			const result = updateImportReferences(
				fileAst,
				fileRefs,
				oldName,
				newName
			);
			if (result.updates.length > 0) {
				const edit = createStructuredEdit(
					importingFile,
					fileAst.text,
					result.newContent
				);
				if (edit) {
					edits.push(edit);
				}
				updatedReferences.push(
					...result.updates.map((u) => ({ ...u, file: importingFile }))
				);
				if (!dryRun) {
					await rt.fs.writeFile(importingFile, result.newContent);
				}
			}
		} catch (error) {
			errors.push({
				file: importingFile,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		success: errors.length === 0,
		renamedSymbol: { file: filePath, oldName, newName },
		edits,
		updatedReferences,
		errors,
	};
}

interface ExportLocation {
	type: "declaration" | "named-export" | "default";
	node: ts.Node;
	line: number;
}

function getRenamedSymbol(
	_sourceFile: ts.SourceFile,
	checker: ts.TypeChecker,
	location: ExportLocation
): ts.Symbol | null {
	if (location.type === "declaration") {
		const nameNode = getNameNode(location.node);
		if (nameNode) {
			return checker.getSymbolAtLocation(nameNode) ?? null;
		}
		return null;
	}

	if (location.type === "default") {
		const nameNode = getNameNode(location.node);
		if (nameNode) {
			return checker.getSymbolAtLocation(nameNode) ?? null;
		}
		return null;
	}

	// named-export: export { foo } / export { foo as Bar }
	// Prefer the local name (propertyName when present, else name).
	if (ts.isExportSpecifier(location.node)) {
		const localId = location.node.propertyName ?? location.node.name;
		return checker.getSymbolAtLocation(localId) ?? null;
	}

	// Fallback — keep behavior unchanged if we can't resolve a symbol
	return null;
}

function findExport(
	sourceFile: ts.SourceFile,
	name: string
): ExportLocation | null {
	let result: ExportLocation | null = null;

	function visit(node: ts.Node) {
		if (result) {
			return;
		}

		// export class/function/const Name
		if (hasExportModifier(node)) {
			const nameNode = getNameNode(node);
			if (nameNode?.text === name) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile)
				);
				result = { type: "declaration", node, line: line + 1 };
				return;
			}
		}

		// export { Name }
		if (
			ts.isExportDeclaration(node) &&
			!node.moduleSpecifier &&
			node.exportClause &&
			ts.isNamedExports(node.exportClause)
		) {
			for (const element of node.exportClause.elements) {
				// Check the exported name (element.name), not the local name (element.propertyName)
				if (element.name.text === name) {
					const { line } = sourceFile.getLineAndCharacterOfPosition(
						node.getStart(sourceFile)
					);
					result = { type: "named-export", node: element, line: line + 1 };
					return;
				}
			}
		}

		// export default Name or export = Name
		if (ts.isExportAssignment(node)) {
			if (!node.isExportEquals && name === "default") {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile)
				);
				result = { type: "default", node, line: line + 1 };
				return;
			}
			// Match by the identifier in the expression.
			if (getNameNode(node)?.text === name) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile)
				);
				result = { type: "default", node, line: line + 1 };
				return;
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return result;
}

export function renameInSourceFile(
	sourceFile: ts.SourceFile,
	oldName: string,
	newName: string,
	options?: {
		checker?: ts.TypeChecker;
		renamedSymbol?: ts.Symbol;
	}
): {
	newContent: string;
	changes: TextChange[];
	updates: Omit<UpdatedReference, "file">[];
} {
	const changes: TextChange[] = [];
	const updates: Omit<UpdatedReference, "file">[] = [];
	const checker = options?.checker;
	const renamedSymbol = options?.renamedSymbol;

	// Returns true if a binding pattern (parameter name, destructuring) introduces `name`
	function bindingContainsName(binding: ts.BindingName): boolean {
		if (ts.isIdentifier(binding)) {
			return binding.text === oldName;
		}
		if (
			ts.isObjectBindingPattern(binding) ||
			ts.isArrayBindingPattern(binding)
		) {
			return binding.elements.some(
				(el) => !ts.isOmittedExpression(el) && bindingContainsName(el.name)
			);
		}
		return false;
	}

	// Returns true if this identifier is declaring a new (inner-scope) binding,
	// rather than referencing the exported symbol.
	function isDeclaringIdentifier(node: ts.Identifier): boolean {
		const parent = parentOf(node);
		if (!parent) {
			return false;
		}
		if (ts.isParameter(parent) && parent.name === node) {
			return true;
		}
		if (ts.isVariableDeclaration(parent) && parent.name === node) {
			return true;
		}
		if (ts.isBindingElement(parent) && parent.name === node) {
			return true;
		}
		if (ts.isFunctionDeclaration(parent) && parent.name === node) {
			return true;
		}
		if (ts.isClassDeclaration(parent) && parent.name === node) {
			return true;
		}
		return false;
	}

	// Returns true if a function-like node introduces a parameter that shadows oldName.
	function nodeIntroducesShadow(node: ts.Node): boolean {
		if (
			ts.isFunctionDeclaration(node) ||
			ts.isFunctionExpression(node) ||
			ts.isArrowFunction(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isConstructorDeclaration(node) ||
			ts.isGetAccessorDeclaration(node) ||
			ts.isSetAccessorDeclaration(node)
		) {
			return (node as ts.FunctionLikeDeclaration).parameters.some((p) =>
				bindingContainsName(p.name)
			);
		}
		return false;
	}

	function visit(node: ts.Node, isShadowed = false) {
		// Inside a scope where oldName is shadowed — skip all renames, recurse only
		if (isShadowed) {
			ts.forEachChild(node, (child) => {
				visit(child, true);
			});
			return;
		}

		// Rename in declaration: export class OldName / export function oldName / export const oldName
		if (hasExportModifier(node)) {
			const nameNode = getNameNode(node);
			if (nameNode?.text === oldName) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile)
				);
				changes.push({
					start: nameNode.getStart(sourceFile),
					end: nameNode.getEnd(),
					newText: newName,
				});
				updates.push({
					line: line + 1,
					oldSpecifier: oldName,
					newSpecifier: newName,
				});
			}
		}

		// Rename in export { oldName } or export { oldName as alias }
		if (
			ts.isExportDeclaration(node) &&
			!node.moduleSpecifier &&
			node.exportClause &&
			ts.isNamedExports(node.exportClause)
		) {
			for (const element of node.exportClause.elements) {
				// If there's a propertyName, that's the local name, and name is the exported name
				// export { localName as exportedName }
				// If no propertyName, name is both local and exported
				const exportedName = element.name.text;

				if (exportedName === oldName) {
					const { line } = sourceFile.getLineAndCharacterOfPosition(
						element.getStart(sourceFile)
					);
					changes.push({
						start: element.name.getStart(sourceFile),
						end: element.name.getEnd(),
						newText: newName,
					});
					updates.push({
						line: line + 1,
						oldSpecifier: oldName,
						newSpecifier: newName,
					});
				}
			}
		}

		// Rename identifier in export default/export-equals assignments.
		const exportAssignmentName = ts.isExportAssignment(node)
			? getNameNode(node)
			: null;
		if (exportAssignmentName?.text === oldName) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			changes.push({
				start: exportAssignmentName.getStart(sourceFile),
				end: exportAssignmentName.getEnd(),
				newText: newName,
			});
			updates.push({
				line: line + 1,
				oldSpecifier: oldName,
				newSpecifier: newName,
			});
		}

		// Also rename usages within the file itself.
		//
		// When a TypeChecker + symbol is provided, use symbol identity to ensure we only
		// rename true references to the exported symbol (avoids false positives).
		// Fallback to the existing heuristic when no checker is available (unit tests,
		// standalone SourceFile parsing).
		if (ts.isIdentifier(node) && node.text === oldName) {
			if (checker && renamedSymbol) {
				let symbolAtNode = checker.getSymbolAtLocation(node);

				// Shorthand property assignments (`{ foo }`) are represented as a property,
				// but semantically refer to the value symbol of `foo`.
				if (
					symbolAtNode !== renamedSymbol &&
					ts.isShorthandPropertyAssignment(node.parent) &&
					node.parent.name === node
				) {
					symbolAtNode =
						checker.getShorthandAssignmentValueSymbol(node.parent) ??
						symbolAtNode;
				}

				if (symbolAtNode !== renamedSymbol) {
					ts.forEachChild(node, (child) => {
						visit(child, false);
					});
					return;
				}
			} else {
				// Heuristic fallback (best-effort without binder)
				const parent = parentOf(node);
				// Skip if this is a property access (obj.oldName)
				if (
					parent &&
					ts.isPropertyAccessExpression(parent) &&
					parent.name === node
				) {
					// This is accessing a property, not our symbol
					return;
				}
				// Skip import/export specifiers (handled separately)
				if (
					parent &&
					(ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent))
				) {
					return;
				}
				// Skip if this identifier is declaring a new binding in an inner scope
				// (parameter name, variable declaration, destructuring element, inner function/class name)
				if (isDeclaringIdentifier(node)) {
					return;
				}
			}

			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			changes.push({
				start: node.getStart(sourceFile),
				end: node.getEnd(),
				newText: newName,
			});
			updates.push({
				line: line + 1,
				oldSpecifier: oldName,
				newSpecifier: newName,
			});
		}

		// Propagate shadow into function scopes whose parameters introduce a new binding for oldName
		const childIsShadowed = nodeIntroducesShadow(node);
		ts.forEachChild(node, (child) => {
			visit(child, childIsShadowed);
		});
	}

	visit(sourceFile);

	// Deduplicate changes by position
	const uniqueChanges = deduplicateChanges(changes);

	// Apply changes using shared utility
	const newContent = applyTextChanges(sourceFile.text, uniqueChanges);

	return { newContent, changes: uniqueChanges, updates };
}

/**
 * Update import/re-export references for a renamed symbol.
 * Accepts pre-filtered ModuleReference[] scoped to the target file,
 * mirroring the pattern used by updateFileReferences in updater.ts.
 */
function updateImportReferences(
	sourceFile: ts.SourceFile,
	references: ModuleReference[],
	oldName: string,
	newName: string
): { newContent: string; updates: Omit<UpdatedReference, "file">[] } {
	const changes: TextChange[] = [];
	const updates: Omit<UpdatedReference, "file">[] = [];

	// Build a set of (specifier, line) pairs from the pre-filtered references
	const refKeys = new Set(
		references.map((ref) => `${ref.specifier}:${ref.line}`)
	);

	function visit(node: ts.Node) {
		// Handle: import { oldName } from './target'
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			if (!refKeys.has(`${node.moduleSpecifier.text}:${line + 1}`)) {
				ts.forEachChild(node, visit);
				return;
			}

			const importClause = node.importClause;
			if (
				importClause?.namedBindings &&
				ts.isNamedImports(importClause.namedBindings)
			) {
				for (const element of importClause.namedBindings.elements) {
					const importedName = element.propertyName?.text ?? element.name.text;

					if (importedName === oldName) {
						if (element.propertyName) {
							// import { oldName as alias } → import { newName as alias }
							changes.push({
								start: element.propertyName.getStart(sourceFile),
								end: element.propertyName.getEnd(),
								newText: newName,
							});
						} else {
							// import { oldName } → import { newName as oldName }
							// Preserves the local binding name so usage sites don't break
							changes.push({
								start: element.name.getStart(sourceFile),
								end: element.name.getEnd(),
								newText: `${newName} as ${oldName}`,
							});
						}

						updates.push({
							line: line + 1,
							oldSpecifier: oldName,
							newSpecifier: newName,
						});
					}
				}
			}
		}

		// Handle namespace re-exports: export * as oldName from './target'
		if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			if (!refKeys.has(`${node.moduleSpecifier.text}:${line + 1}`)) {
				ts.forEachChild(node, visit);
				return;
			}

			if (
				node.exportClause &&
				ts.isNamespaceExport(node.exportClause) &&
				node.exportClause.name.text === oldName
			) {
				changes.push({
					start: node.exportClause.name.getStart(sourceFile),
					end: node.exportClause.name.getEnd(),
					newText: newName,
				});
				updates.push({
					line: line + 1,
					oldSpecifier: oldName,
					newSpecifier: newName,
				});
			}

			// Handle named re-exports: export { oldName } from './target'
			if (node.exportClause && ts.isNamedExports(node.exportClause)) {
				for (const element of node.exportClause.elements) {
					const importedName = element.propertyName?.text ?? element.name.text;

					if (importedName === oldName) {
						if (element.propertyName) {
							// export { oldName as alias } → export { newName as alias }
							changes.push({
								start: element.propertyName.getStart(sourceFile),
								end: element.propertyName.getEnd(),
								newText: newName,
							});
						} else {
							// export { oldName } → export { newName as oldName }
							// Preserves the public export name for downstream consumers
							changes.push({
								start: element.name.getStart(sourceFile),
								end: element.name.getEnd(),
								newText: `${newName} as ${oldName}`,
							});
						}

						updates.push({
							line: line + 1,
							oldSpecifier: oldName,
							newSpecifier: newName,
						});
					}
				}
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);

	const newContent = applyTextChanges(sourceFile.text, changes);
	return { newContent, updates };
}
