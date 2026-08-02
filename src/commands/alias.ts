import path from "node:path";
import { logger } from "../cli-logger.ts";
import ts from "../core/ast-utils.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import { diffDiagnostics } from "../core/diagnostics.ts";
import { ensureCleanWorktree } from "../core/git.ts";
import { createProgram, loadProject } from "../core/project.ts";
import {
	calculateRelativeSpecifier,
	findAliasForPath,
	isRelativeImport,
	normalizePath,
	resolveModuleSpecifier,
} from "../core/resolver.ts";
import {
	createGitFilesRollbackStrategy,
	createRollbackCheckpoint,
} from "../core/rollback.ts";
import { scanModuleReferences } from "../core/scanner.ts";
import {
	createSourceFileFromText,
	withSourceFile,
} from "../core/source-file.ts";
import {
	applyStructuredEdits,
	applyTextChanges,
	createStructuredEdit,
	deduplicateChanges,
	formatUnifiedDiff,
	type StructuredEdit,
	serializeStructuredEdits,
} from "../core/text-changes.ts";
import { specifierEditsToTextChanges } from "../core/updater.ts";
import {
	printVerificationResults,
	runTypeCheckDetailed,
	type VerificationResult,
	verifyTypeChecking,
} from "../core/verify.ts";
import {
	discoverWorkspace,
	filterToWorkspaceBoundary,
} from "../core/workspace.ts";
import { getRuntime } from "../runtime/index.ts";
import type { ModuleReference } from "../types/graph.ts";
import type { UpdatedReference } from "../types/move.ts";
import type { MutatingCommandOptions, ProjectConfig } from "../types.ts";
import { setupCommandContext } from "./command-context.ts";

export interface AliasOptions extends MutatingCommandOptions {
	target: string;
	prefer?: "alias" | "relative" | "shortest";
	renameSpecifiers?: string[];
	json?: boolean;
	verify?: boolean;
}

export interface AliasResult {
	filesProcessed: number;
	importsUpdated: number;
	/** Exact per-file text edits planned by a dry run */
	edits?: StructuredEdit[];
	changes: AliasChange[];
	conflicts: AliasConflict[];
	/**
	 * Importers that reach a renamed module through a different specifier form
	 * (e.g. a relative `./error` vs the aliased `@scope/error`) but could not be
	 * rewritten automatically because the `to` specifier is relative and would
	 * resolve differently from their directory. Surfaced so a module redirect is
	 * never silently incomplete (issue #113).
	 */
	missedEquivalents?: MissedEquivalent[];
}

export interface AliasChange extends UpdatedReference {
	strategy: string;
}

interface AliasConflict extends AliasChange {
	reason: string;
}

export interface MissedEquivalent {
	file: string;
	line: number;
	specifier: string;
	from: string;
	to: string;
}

interface SpecifierRename {
	from: string;
	to: string;
}

interface ResolvedReference {
	ref: ModuleReference;
	resolvedPath: string | null;
}

const ALIAS_WRITE_CONCURRENCY = 4;
const RENAME_SPECIFIER_STRATEGY = "rename-specifier";

export async function aliasCommand(options: AliasOptions): Promise<void> {
	const {
		target,
		prefer,
		renameSpecifiers,
		dryRun = false,
		force = false,
		json = false,
		verbose = false,
		verify = true,
		project: projectArg,
		workspace = false,
	} = options;

	const absoluteTarget = path.resolve(target);
	let specifierRenames: SpecifierRename[];
	try {
		specifierRenames = parseSpecifierRenames(renameSpecifiers ?? []);
	} catch (error) {
		logger.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
	const isRenameMode = specifierRenames.length > 0;

	// Guard: refuse to mutate a dirty worktree unless --force
	await ensureCleanWorktree(absoluteTarget, force, dryRun);

	if (isRenameMode) {
		if (workspace) {
			logger.error("--workspace is not supported with --rename-specifier");
			process.exit(1);
		}
		await aliasRenameSpecifierCommand({
			absoluteTarget,
			dryRun,
			specifierRenames,
			projectArg,
			json,
			verbose,
			verify,
		});
		return;
	}

	if (!prefer) {
		logger.error("Error: alias requires --prefer option");
		process.exit(1);
	}

	// Workspace mode: normalize imports across all packages
	if (workspace) {
		const wsDir = projectArg ? path.resolve(projectArg) : absoluteTarget;
		const wsInfo = await discoverWorkspace(wsDir);
		if (!wsInfo || wsInfo.packages.length === 0) {
			logger.error("No workspace packages found.");
			process.exit(1);
		}

		if (!json) {
			logger.info(
				`\n${dryRun ? "🔍 Dry run:" : "🔧"} Normalizing imports across ${wsInfo.packages.length} workspace package(s)...`
			);
			logger.info(`   Strategy: ${prefer}\n`);
		}

		const { mapConcurrent } = await import("../core/concurrency.ts");
		const eligiblePkgs = wsInfo.packages.filter((pkg) => pkg.tsconfigPath);
		const pkgResults = await mapConcurrent(
			eligiblePkgs,
			async (pkg) => {
				const pkgProject = loadProject(pkg.tsconfigPath as string);
				const pkgDir = pkg.srcDir ? path.join(pkg.path, pkg.srcDir) : pkg.path;
				const pkgResult = normalizeImports(pkgDir, prefer, pkgProject);
				const bounded = pkgResult.changes.filter(
					(c) => filterToWorkspaceBoundary([c.file], wsInfo.root).length > 0
				);
				return { changes: bounded, filesProcessed: pkgResult.filesProcessed };
			},
			{
				onError: (pkg) => {
					if (verbose) {
						logger.warn(`   Skipping ${pkg.name}: failed to load project`);
					}
					return { changes: [] as AliasChange[], filesProcessed: 0 };
				},
			}
		);
		const allChanges = pkgResults.flatMap((r) => r.changes);
		const totalFiles = pkgResults.reduce((s, r) => s + r.filesProcessed, 0);

		const result: AliasResult = {
			filesProcessed: totalFiles,
			importsUpdated: allChanges.length,
			changes: allChanges,
			conflicts: [],
		};

		if (result.changes.length === 0) {
			if (json) {
				printAliasResultJson(result, wsInfo.root);
			} else {
				logger.info(
					"✨ No changes needed. All imports already follow the preferred style.\n"
				);
			}
			return;
		}

		if (dryRun) {
			result.edits = await planAliasEdits(result.changes);
			if (json) {
				printAliasResultJson(result, wsInfo.root);
			} else {
				printResults(result, dryRun, verbose, wsInfo.root);
			}
		} else {
			await applyChanges(result.changes);
			if (json) {
				printAliasResultJson(result, wsInfo.root);
			} else {
				printResults(result, dryRun, verbose, wsInfo.root);
			}
		}
		return;
	}

	const context = await setupCommandContext({
		project: projectArg,
		searchPath: absoluteTarget,
	});
	if (!context) {
		logger.error("Could not find tsconfig.json");
		process.exit(1);
	}
	const { project } = context;

	if (!json) {
		logger.info(`\n${dryRun ? "🔍 Dry run:" : "🔧"} Normalizing imports...`);
		logger.info(`   Target: ${absoluteTarget}`);
		logger.info(`   Strategy: ${prefer}`);
		if (verify) {
			logger.info("   Verification: enabled");
		}
		logger.empty();
	}

	const result = normalizeImports(absoluteTarget, prefer, project);

	if (result.changes.length === 0) {
		if (json) {
			printAliasResultJson(result, project.rootDir);
		} else {
			logger.info(
				"✨ No changes needed. All imports already follow the preferred style.\n"
			);
		}
		return;
	}

	// Apply changes with optional verification
	if (dryRun) {
		result.edits = await planAliasEdits(result.changes);
		if (json) {
			printAliasResultJson(result, project.rootDir);
		} else {
			printResults(result, dryRun, verbose, project.rootDir);
		}
	} else if (verify) {
		const verifyResult = await verifyTypeChecking(
			project,
			() => {
				// No snapshot needed
			},
			async () => applyChanges(result.changes)
		);

		if (json) {
			printAliasResultJson(result, project.rootDir, verifyResult);
		} else {
			printResults(result, dryRun, verbose, project.rootDir);
			logger.empty();
			printVerificationResults(verifyResult);
		}

		if (!verifyResult.success) {
			logger.error(
				"\n⚠️  Type checking failed. Changes were applied but introduced errors."
			);
			process.exit(1);
		}
	} else {
		await applyChanges(result.changes);
		if (json) {
			printAliasResultJson(result, project.rootDir);
		} else {
			printResults(result, dryRun, verbose, project.rootDir);
		}
	}
}

async function aliasRenameSpecifierCommand(options: {
	absoluteTarget: string;
	dryRun: boolean;
	json: boolean;
	specifierRenames: SpecifierRename[];
	projectArg?: string;
	verbose: boolean;
	verify: boolean;
}): Promise<void> {
	const context = await setupCommandContext({
		project: options.projectArg,
		searchPath: options.absoluteTarget,
	});
	if (!context) {
		logger.error("Could not find tsconfig.json");
		process.exit(1);
	}
	const { project } = context;
	if (!options.json) {
		logger.info(
			`\n${options.dryRun ? "🔍 Dry run:" : "🔧"} Renaming import specifiers...`
		);
		logger.info(`   Target: ${options.absoluteTarget}`);
		for (const rename of options.specifierRenames) {
			logger.info(`   ${rename.from} → ${rename.to}`);
		}
		if (options.verify) {
			logger.info("   Verification: enabled");
		}
		logger.empty();
	}

	const result = renameImportSpecifiers(
		options.absoluteTarget,
		options.specifierRenames,
		project
	);

	if (result.changes.length === 0 && result.conflicts.length === 0) {
		if (result.missedEquivalents && result.missedEquivalents.length > 0) {
			if (options.json) {
				printAliasResultJson(result, project.rootDir);
			} else {
				printMissedEquivalents(result.missedEquivalents, project.rootDir);
			}
			return;
		}
		if (options.json) {
			printAliasResultJson(result, project.rootDir);
		} else {
			logger.info("✨ No changes needed. No matching specifiers found.\n");
		}
		return;
	}

	if (result.conflicts.length > 0) {
		if (options.json) {
			printAliasResultJson(result, project.rootDir);
		} else {
			printResults(result, true, true, project.rootDir);
		}
		logger.error(
			"Specifier rename has conflicts. No files were changed; resolve the listed imports and retry."
		);
		process.exit(1);
	}

	if (options.dryRun) {
		result.edits = await planAliasEdits(result.changes);
		if (options.json) {
			printAliasResultJson(result, project.rootDir);
		} else {
			printResults(result, true, options.verbose, project.rootDir);
		}
		return;
	}

	if (options.verify) {
		const verifyResult = await applyChangesWithVerification(
			result.changes,
			project
		);
		if (options.json) {
			printAliasResultJson(result, project.rootDir, verifyResult);
		} else {
			printResults(result, false, options.verbose, project.rootDir);
			logger.empty();
			printVerificationResults(verifyResult);
		}

		if (!verifyResult.success) {
			logger.error(
				"\nType checking failed. Specifier rename changes were rolled back."
			);
			process.exit(1);
		}
		return;
	}

	await applyChanges(result.changes);
	if (options.json) {
		printAliasResultJson(result, project.rootDir);
	} else {
		printResults(result, false, options.verbose, project.rootDir);
	}
}

export function parseSpecifierRenames(
	values: readonly string[]
): SpecifierRename[] {
	const renames: SpecifierRename[] = [];
	const seen = new Map<string, string>();
	for (const value of values) {
		const separatorIndex = value.indexOf("=");
		if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
			throw new Error(
				`Invalid --rename-specifier "${value}". Expected "<from>=<to>".`
			);
		}
		const from = value.slice(0, separatorIndex);
		const to = value.slice(separatorIndex + 1);
		if (from === to) {
			throw new Error(
				`Invalid --rename-specifier "${value}". Source and target specifiers must differ.`
			);
		}
		const previous = seen.get(from);
		if (previous && previous !== to) {
			throw new Error(
				`Conflicting --rename-specifier values for "${from}": "${previous}" and "${to}".`
			);
		}
		if (previous === to) {
			continue;
		}
		seen.set(from, to);
		renames.push({ from, to });
	}
	return renames;
}

export function normalizeImports(
	target: string,
	prefer: "alias" | "relative" | "shortest",
	project: ProjectConfig
): AliasResult {
	const changes: AliasChange[] = [];
	const skipped: AliasChange[] = [];
	const filesToProcess = getFilesToProcess(target, project);
	const program = createProgram(project, filesToProcess);

	for (const file of filesToProcess) {
		const references = getFileReferences(file, program, project);

		// Build a set of existing specifiers and their bindings in this file
		const existingSpecifiers = buildSpecifierBindingMap(references);

		for (const ref of references) {
			// Skip external packages (node_modules, built-in modules)
			if (
				!ref.resolvedPath.includes(project.rootDir) ||
				ref.resolvedPath.includes("node_modules")
			) {
				continue;
			}

			const newSpecifier = calculatePreferredSpecifier(
				file,
				ref.resolvedPath,
				prefer,
				project,
				ref.specifier
			);

			if (newSpecifier && newSpecifier !== ref.specifier) {
				// Check for duplicate specifier conflict: would the new specifier
				// collide with an existing import that has overlapping bindings?
				if (
					hasSpecifierConflict(existingSpecifiers, ref, newSpecifier, "overlap")
				) {
					skipped.push({
						file,
						line: ref.line,
						oldSpecifier: ref.specifier,
						newSpecifier,
						strategy: prefer,
					});
					continue;
				}

				changes.push({
					file,
					line: ref.line,
					oldSpecifier: ref.specifier,
					newSpecifier,
					strategy: prefer,
				});
			}
		}
	}

	if (skipped.length > 0) {
		logger.info(
			`⚠️  Skipped ${skipped.length} import(s) to avoid binding conflicts:`
		);
		for (const change of skipped) {
			const relativePath = path.relative(project.rootDir, change.file);
			logger.info(
				`   ${relativePath}:${change.line}: "${change.oldSpecifier}" → "${change.newSpecifier}" would duplicate a binding`
			);
		}
		logger.empty();
	}

	return {
		filesProcessed: filesToProcess.length,
		importsUpdated: changes.length,
		changes,
		conflicts: [],
	};
}

export function renameImportSpecifiers(
	target: string,
	renames: readonly SpecifierRename[],
	project: ProjectConfig
): AliasResult {
	const changes: AliasChange[] = [];
	const conflicts: AliasConflict[] = [];
	const missedEquivalents: MissedEquivalent[] = [];
	const filesToProcess = getFilesToProcess(target, project);
	const program = createProgram(project, filesToProcess);
	const renameByFrom = new Map(
		renames.map((rename) => [rename.from, rename.to])
	);

	// Resolve every literal specifier up front so we can also rewrite importers
	// that reach the same module through a different specifier form (issue #113).
	// The raw scan is intentional: scanModuleReferences drops unresolvable
	// specifiers, but exact-string rename must still catch those.
	const fileReferences = new Map<string, ResolvedReference[]>();
	const targetPathsByFrom = new Map<string, Set<string>>();

	const recordTarget = (from: string, resolvedPath: string) => {
		const paths = targetPathsByFrom.get(from) ?? new Set<string>();
		paths.add(normalizePath(resolvedPath));
		targetPathsByFrom.set(from, paths);
	};

	for (const file of filesToProcess) {
		const resolved = getRawFileReferences(file, program).map((ref) => {
			const result = resolveModuleSpecifier(ref.specifier, file, project);
			return {
				ref,
				resolvedPath: result.kind === "resolved" ? result.path : null,
			};
		});
		fileReferences.set(file, resolved);
		for (const { ref, resolvedPath } of resolved) {
			if (resolvedPath && renameByFrom.has(ref.specifier)) {
				recordTarget(ref.specifier, resolvedPath);
			}
		}
	}

	// A non-relative `from` resolves identically from any file, so anchor-resolve
	// it once to learn its canonical target even when no importer used that exact
	// spelling. Relative `from` is anchor-dependent and stays exact-match only.
	const anchor =
		filesToProcess[0] ?? path.join(project.rootDir, "__resect_anchor__.ts");
	for (const { from } of renames) {
		if (isRelativeImport(from)) {
			continue;
		}
		const result = resolveModuleSpecifier(from, anchor, project);
		if (result.kind === "resolved") {
			recordTarget(from, result.path);
		}
	}

	for (const file of filesToProcess) {
		const resolved = fileReferences.get(file) ?? [];
		const existingSpecifiers = buildSpecifierBindingMap(
			resolved.map((entry) => entry.ref)
		);

		const record = (ref: ModuleReference, newSpecifier: string) => {
			const change: AliasChange = {
				file,
				line: ref.line,
				oldSpecifier: ref.specifier,
				newSpecifier,
				strategy: RENAME_SPECIFIER_STRATEGY,
			};
			if (
				hasSpecifierConflict(existingSpecifiers, ref, newSpecifier, "duplicate")
			) {
				conflicts.push({
					...change,
					reason: `rewriting would create a duplicate "${newSpecifier}" specifier in the same file`,
				});
				return;
			}
			changes.push(change);
		};

		for (const { ref, resolvedPath } of resolved) {
			// 1. Exact specifier match — original behavior, catches every spelling
			//    including unresolvable specifiers.
			const exactTarget = renameByFrom.get(ref.specifier);
			if (exactTarget) {
				record(ref, exactTarget);
				continue;
			}

			// 2. Equivalent-form match — a different specifier that resolves to the
			//    same module a `from` points at. Completing the redirect here means
			//    deleting the old module afterwards no longer orphans these
			//    importers, which was the silent breakage in issue #113.
			if (!resolvedPath) {
				continue;
			}
			const normalizedRefPath = normalizePath(resolvedPath);
			for (const [from, to] of renameByFrom) {
				if (from === ref.specifier || ref.specifier === to) {
					continue;
				}
				if (!targetPathsByFrom.get(from)?.has(normalizedRefPath)) {
					continue;
				}
				// A relative `to` would resolve differently from this importer's
				// directory, so it cannot be applied blindly — surface it instead of
				// silently skipping or producing a broken rewrite.
				if (isRelativeImport(to)) {
					missedEquivalents.push({
						file,
						line: ref.line,
						specifier: ref.specifier,
						from,
						to,
					});
				} else {
					record(ref, to);
				}
				break;
			}
		}
	}

	return {
		filesProcessed: filesToProcess.length,
		importsUpdated: changes.length,
		changes,
		conflicts,
		missedEquivalents,
	};
}

export async function applyChangesWithVerification(
	changes: AliasChange[],
	project: ProjectConfig
): Promise<VerificationResult> {
	const rollback = await createRollbackCheckpoint(
		createGitFilesRollbackStrategy(
			project.rootDir,
			changes.map((change) => change.file)
		)
	);
	const before = await runTypeCheckDetailed(project);
	await applyChanges(changes);
	const after = await runTypeCheckDetailed(project);
	const errorsBefore = before.errors;
	const errorsAfter = after.errors;
	// Compare by normalized diagnostic identity, not raw string equality, so a
	// pre-existing error whose line/col shifted isn't misreported as new (#128).
	const { newErrors, fixedErrors } = diffDiagnostics(errorsBefore, errorsAfter);
	const verificationIncomplete = before.incomplete || after.incomplete;
	const result: VerificationResult = {
		success: newErrors.length === 0 && !verificationIncomplete,
		errorsBefore,
		errorsAfter,
		newErrors,
		fixedErrors,
		verificationIncomplete,
	};

	if (!result.success) {
		await rollback.restore();
	}

	return result;
}

export async function applyChanges(changes: AliasChange[]): Promise<void> {
	const edits = await planAliasEdits(changes);
	const rt = getRuntime();
	await mapConcurrent(
		edits,
		async (edit) => {
			const content = await rt.fs.readFile(edit.file);
			await rt.fs.writeFile(edit.file, applyStructuredEdits(content, [edit]));
		},
		{ concurrency: ALIAS_WRITE_CONCURRENCY }
	);
}

/**
 * Resolve semantic import changes into exact, serializable file edits.
 *
 * Both dry-run output and the write path consume this plan so applying a
 * preview verbatim has the same effect as running the command.
 */
export async function planAliasEdits(
	changes: readonly AliasChange[]
): Promise<StructuredEdit[]> {
	// Group changes by file
	const byFile = new Map<string, AliasChange[]>();
	for (const change of changes) {
		const existing = byFile.get(change.file) ?? [];
		existing.push(change);
		byFile.set(change.file, existing);
	}

	const rt = getRuntime();
	const edits = await mapConcurrent(
		[...byFile],
		async ([filePath, fileChanges]) => {
			let content: string;
			try {
				content = await rt.fs.readFile(filePath);
			} catch {
				return undefined;
			}

			// Parse the file to find precise specifier locations via AST
			const sourceFile = createSourceFileFromText(filePath, content);
			const textChanges = specifierEditsToTextChanges(
				sourceFile,
				fileChanges
			).map((pair) => pair.change);

			if (textChanges.length > 0) {
				const unique = deduplicateChanges(textChanges);
				const newContent = applyTextChanges(content, unique);
				return createStructuredEdit(filePath, content, newContent);
			}
			return undefined;
		},
		{ concurrency: ALIAS_WRITE_CONCURRENCY }
	);
	return edits.filter((edit): edit is StructuredEdit => edit !== undefined);
}

function getFilesToProcess(target: string, project: ProjectConfig): string[] {
	if (ts.sys.fileExists(target)) {
		return [target];
	}

	if (ts.sys.directoryExists(target)) {
		return project.files.filter((f) => f.startsWith(target));
	}

	return [];
}

function getFileReferences(
	filePath: string,
	program: ts.Program,
	project: ProjectConfig
): ModuleReference[] {
	return withSourceFile(
		program,
		filePath,
		(sourceFile) => scanModuleReferences(sourceFile, project),
		[]
	);
}

function getRawFileReferences(
	filePath: string,
	program: ts.Program
): ModuleReference[] {
	const sourceFile = program.getSourceFile(filePath);
	return sourceFile ? collectRawModuleReferences(sourceFile) : [];
}

function collectRawModuleReferences(
	sourceFile: ts.SourceFile
): ModuleReference[] {
	const references: ModuleReference[] = [];
	const addReference = (
		node: ts.Node,
		specifier: string,
		type: ModuleReference["type"],
		bindings: ModuleReference["bindings"],
		isTypeOnly: boolean
	) => {
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(
			node.getStart(sourceFile)
		);
		references.push({
			sourceFile: sourceFile.fileName,
			specifier,
			resolvedPath: "",
			type,
			line: line + 1,
			column: character + 1,
			bindings,
			isTypeOnly,
		});
	};

	function visit(node: ts.Node) {
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const { type, bindings, isTypeOnly } = getImportReferenceShape(node);
			addReference(
				node,
				node.moduleSpecifier.text,
				type,
				bindings.length > 0 ? bindings : undefined,
				isTypeOnly
			);
		} else if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const { type, bindings, isTypeOnly } = getExportReferenceShape(node);
			addReference(
				node,
				node.moduleSpecifier.text,
				type,
				bindings.length > 0 ? bindings : undefined,
				isTypeOnly
			);
		} else if (ts.isCallExpression(node)) {
			const type = getCallReferenceType(node);
			const arg = node.arguments[0];
			if (type && arg && ts.isStringLiteral(arg)) {
				addReference(node, arg.text, type, undefined, false);
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return references;
}

function getImportReferenceShape(node: ts.ImportDeclaration): {
	type: ModuleReference["type"];
	bindings: NonNullable<ModuleReference["bindings"]>;
	isTypeOnly: boolean;
} {
	const isTypeOnly = node.importClause?.isTypeOnly ?? false;
	const bindings: NonNullable<ModuleReference["bindings"]> = [];
	let type: ModuleReference["type"] = "import";

	if (!node.importClause) {
		type = "import-side-effect";
	} else if (node.importClause.namedBindings) {
		if (ts.isNamespaceImport(node.importClause.namedBindings)) {
			type = "import-namespace";
			bindings.push({
				name: node.importClause.namedBindings.name.text,
				isType: isTypeOnly,
			});
		} else {
			type = "import-named";
			for (const element of node.importClause.namedBindings.elements) {
				bindings.push({
					name: element.propertyName?.text ?? element.name.text,
					alias: element.propertyName ? element.name.text : undefined,
					isType: element.isTypeOnly || isTypeOnly,
				});
			}
		}
	}

	if (node.importClause?.name) {
		bindings.unshift({
			name: "default",
			alias: node.importClause.name.text,
			isType: isTypeOnly,
		});
	}

	return { type, bindings, isTypeOnly };
}

function getExportReferenceShape(node: ts.ExportDeclaration): {
	type: ModuleReference["type"];
	bindings: NonNullable<ModuleReference["bindings"]>;
	isTypeOnly: boolean;
} {
	const isTypeOnly = node.isTypeOnly;
	const bindings: NonNullable<ModuleReference["bindings"]> = [];
	let type: ModuleReference["type"] = "export-all";

	if (node.exportClause) {
		if (ts.isNamespaceExport(node.exportClause)) {
			type = "export-all-as";
			bindings.push({ name: node.exportClause.name.text, isType: isTypeOnly });
		} else {
			type = "export-from";
			for (const element of node.exportClause.elements) {
				bindings.push({
					name: element.propertyName?.text ?? element.name.text,
					alias: element.propertyName ? element.name.text : undefined,
					isType: element.isTypeOnly || isTypeOnly,
				});
			}
		}
	}

	return { type, bindings, isTypeOnly };
}

function getCallReferenceType(
	node: ts.CallExpression
): ModuleReference["type"] | null {
	if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
		return "import-dynamic";
	}
	if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
		return "require";
	}
	if (ts.isPropertyAccessExpression(node.expression)) {
		const { expression, name } = node.expression;
		if (
			name.text === "resolve" &&
			ts.isIdentifier(expression) &&
			expression.text === "require"
		) {
			return "require-resolve";
		}
		if (
			name.text === "mock" &&
			ts.isIdentifier(expression) &&
			["jest", "vi", "vitest"].includes(expression.text)
		) {
			return "jest-mock";
		}
		if (
			name.text === "module" &&
			ts.isIdentifier(expression) &&
			expression.text === "mock"
		) {
			return "jest-mock";
		}
	}
	return null;
}

function buildSpecifierBindingMap(
	references: readonly ModuleReference[]
): Map<string, Set<string>> {
	const existingSpecifiers = new Map<string, Set<string>>();
	for (const ref of references) {
		const bindings = existingSpecifiers.get(ref.specifier) ?? new Set<string>();
		for (const binding of ref.bindings ?? []) {
			bindings.add(binding.alias ?? binding.name);
		}
		existingSpecifiers.set(ref.specifier, bindings);
	}
	return existingSpecifiers;
}

function hasSpecifierConflict(
	existingSpecifiers: Map<string, Set<string>>,
	ref: ModuleReference,
	newSpecifier: string,
	mode: "duplicate" | "overlap"
): boolean {
	const existingBindings = existingSpecifiers.get(newSpecifier);
	if (!existingBindings) {
		return false;
	}
	if (mode === "duplicate") {
		return true;
	}
	return (ref.bindings ?? []).some((binding) =>
		existingBindings.has(binding.alias ?? binding.name)
	);
}

function calculatePreferredSpecifier(
	fromFile: string,
	toFile: string,
	prefer: "alias" | "relative" | "shortest",
	project: ProjectConfig,
	oldSpecifier?: string
): string | null {
	const relativeSpecifier = calculateRelativeSpecifier(
		fromFile,
		toFile,
		oldSpecifier
	);
	const aliasSpecifier = findAliasForPath(toFile, project);

	if (prefer === "relative") {
		return relativeSpecifier;
	}

	if (prefer === "alias") {
		return aliasSpecifier ?? relativeSpecifier;
	}

	// prefer is narrowed to "shortest" here (relative/alias handled above).
	if (!aliasSpecifier) {
		return relativeSpecifier;
	}
	return relativeSpecifier.length <= aliasSpecifier.length
		? relativeSpecifier
		: aliasSpecifier;
}

function printAliasResultJson(
	result: AliasResult,
	projectRoot: string,
	typecheck?: VerificationResult
): void {
	logger.info(
		JSON.stringify(
			{
				...result,
				edits: serializeStructuredEdits(result.edits ?? [], (file) =>
					path.relative(projectRoot, file)
				),
				changes: result.changes.map((change) => ({
					...change,
					file: path.relative(projectRoot, change.file),
				})),
				conflicts: result.conflicts.map((conflict) => ({
					...conflict,
					file: path.relative(projectRoot, conflict.file),
				})),
				missedEquivalents: (result.missedEquivalents ?? []).map((missed) => ({
					...missed,
					file: path.relative(projectRoot, missed.file),
				})),
				typecheck,
			},
			null,
			2
		)
	);
}

function printResults(
	result: AliasResult,
	dryRun: boolean,
	verbose: boolean,
	projectRoot?: string
): void {
	const pathBase = projectRoot ?? process.cwd();
	logger.info(
		`${dryRun ? "📋 Would update" : "✅ Updated"} ${result.importsUpdated} import(s) in ${result.filesProcessed} file(s)\n`
	);

	if (verbose || dryRun) {
		// Group changes by file
		const byFile = new Map<string, AliasChange[]>();
		for (const change of result.changes) {
			const existing = byFile.get(change.file) ?? [];
			existing.push(change);
			byFile.set(change.file, existing);
		}

		for (const [file, changes] of byFile) {
			const relativePath = path.relative(pathBase, file);
			logger.info(`📄 ${relativePath}`);
			for (const change of changes) {
				logger.info(`   Line ${change.line}:`);
				logger.info(`      - ${change.oldSpecifier}`);
				logger.info(`      + ${change.newSpecifier}`);
			}
			logger.empty();
		}
	}

	if (dryRun && result.edits && result.edits.length > 0) {
		logger.info(
			formatUnifiedDiff(result.edits, (file) => path.relative(pathBase, file))
		);
		logger.empty();
	}

	if (result.conflicts.length > 0) {
		logger.error(
			`⚠️  Skipped ${result.conflicts.length} import(s) to avoid specifier conflicts:`
		);
		for (const conflict of result.conflicts) {
			const relativePath = path.relative(pathBase, conflict.file);
			logger.error(
				`   ${relativePath}:${conflict.line}: "${conflict.oldSpecifier}" → "${conflict.newSpecifier}" ${conflict.reason}`
			);
		}
		logger.empty();
	}

	if (result.missedEquivalents && result.missedEquivalents.length > 0) {
		printMissedEquivalents(result.missedEquivalents, pathBase);
	}

	if (!dryRun) {
		logger.info("✨ Import normalization complete.\n");
	}
}

/**
 * Warn about importers that reach a renamed module through a different specifier
 * form but were not rewritten because the target specifier is relative. Without
 * this, deleting the old module after a redirect would silently orphan them
 * (issue #113).
 */
function printMissedEquivalents(
	missed: readonly MissedEquivalent[],
	pathBase: string
): void {
	logger.warn(
		`⚠️  ${missed.length} importer(s) resolve to a renamed module via a different specifier but were not rewritten (relative target cannot be applied across directories):`
	);
	for (const item of missed) {
		const relativePath = path.relative(pathBase, item.file);
		logger.warn(
			`   ${relativePath}:${item.line}: "${item.specifier}" also resolves to "${item.from}" — rerun scoped to this file with --rename-specifier "${item.specifier}=<target>" to redirect it`
		);
	}
	logger.empty();
}
