import path from "node:path";
import ts from "typescript";
import { logger } from "../cli-logger.ts";
import { hasExportModifier } from "../core/ast-utils.ts";
import {
	hasAppRouterRootSegment,
	isFrameworkConventionFile,
	isSharedModuleRoot,
} from "../core/framework-conventions.ts";
import {
	buildProjectGraphs,
	mergeDependencyGraphs,
	withGraphSourceFile,
} from "../core/graph.ts";
import { isWithinPath, toRelativePath } from "../core/path-utils.ts";
import { resolveTsConfig } from "../core/project.ts";
import { normalizePath } from "../core/resolver.ts";
import { scanExports } from "../core/scanner.ts";
import { withSourceFile } from "../core/source-file.ts";
import { isTestFile } from "../core/test-files.ts";
import type {
	BasenameCollision,
	ExportConflict,
	MisplacedFile,
	OrganiseOptions,
	OrganiseReport,
	SignatureInfo,
} from "../types/organise.ts";

const ORGANISE_SCHEMA_VERSION = "1" as const;

function computePathLCA(dirs: string[]): string {
	if (dirs.length === 0) {
		return "";
	}
	const first = dirs[0];
	if (dirs.length === 1 || !first) {
		return first ?? "";
	}
	const parts = dirs.map((d) => d.split(path.sep));
	const firstParts = parts[0] ?? [];
	const minLen = Math.min(...parts.map((p) => p.length));
	let lca = "";
	for (let i = 0; i < minLen; i++) {
		if (parts.every((p) => p[i] === firstParts[i])) {
			lca = firstParts.slice(0, i + 1).join(path.sep);
		} else {
			break;
		}
	}
	return lca;
}

function signatureFromFunction(
	sourceFile: ts.SourceFile,
	node:
		| ts.FunctionDeclaration
		| ts.ArrowFunction
		| ts.FunctionExpression
		| ts.MethodDeclaration
): string {
	const params = node.parameters
		.map((p) => {
			const nameText = ts.isIdentifier(p.name) ? p.name.text : "_";
			const optional = p.questionToken ? "?" : "";
			const typeText = p.type
				? `: ${sourceFile.text.slice(p.type.getStart(sourceFile), p.type.getEnd())}`
				: "";
			return `${nameText}${optional}${typeText}`;
		})
		.join(", ");
	const returnTypeText = node.type
		? `: ${sourceFile.text.slice(node.type.getStart(sourceFile), node.type.getEnd())}`
		: "";
	return `(${params})${returnTypeText}`;
}

function getExportSignatureText(
	sourceFile: ts.SourceFile,
	exportName: string
): string | null {
	for (const statement of sourceFile.statements) {
		if (
			ts.isFunctionDeclaration(statement) &&
			statement.name?.text === exportName &&
			hasExportModifier(statement)
		) {
			return signatureFromFunction(sourceFile, statement);
		}

		if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
			for (const decl of statement.declarationList.declarations) {
				if (
					ts.isIdentifier(decl.name) &&
					decl.name.text === exportName &&
					decl.initializer &&
					(ts.isArrowFunction(decl.initializer) ||
						ts.isFunctionExpression(decl.initializer))
				) {
					return signatureFromFunction(sourceFile, decl.initializer);
				}
			}
		}

		if (
			ts.isClassDeclaration(statement) &&
			statement.name?.text === exportName &&
			hasExportModifier(statement)
		) {
			const ctor = statement.members.find(ts.isConstructorDeclaration);
			if (ctor) {
				return `class(${ctor.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : "_")).join(", ")})`;
			}
			return "class()";
		}

		if (
			ts.isTypeAliasDeclaration(statement) &&
			statement.name.text === exportName &&
			hasExportModifier(statement)
		) {
			return `type=${sourceFile.text.slice(statement.type.getStart(sourceFile), statement.type.getEnd())}`;
		}

		if (
			ts.isInterfaceDeclaration(statement) &&
			statement.name.text === exportName &&
			hasExportModifier(statement)
		) {
			const memberNames = statement.members
				.flatMap((m) =>
					m.name && ts.isIdentifier(m.name) ? [m.name.text] : []
				)
				.join(",");
			return `interface{${memberNames}}`;
		}
	}
	return null;
}

function detectMisplacedFiles(
	graph: ReturnType<typeof mergeDependencyGraphs>,
	absoluteDir: string,
	ignorePattern: InstanceType<typeof Bun.Glob> | null
): MisplacedFile[] {
	const results: MisplacedFile[] = [];

	for (const [file, importers] of graph.importedBy) {
		if (!isWithinPath(absoluteDir, file)) {
			continue;
		}
		if (isTestFile(file)) {
			continue;
		}
		if (graph.barrelFiles.has(file)) {
			continue;
		}

		const relFile = toRelativePath(absoluteDir, file);
		if (
			ignorePattern?.match(relFile) ||
			ignorePattern?.match(path.basename(file))
		) {
			continue;
		}

		if (importers.length === 0) {
			continue;
		}

		const importerDirSet = new Set<string>();
		for (const ref of importers) {
			if (!isWithinPath(absoluteDir, ref.sourceFile)) {
				continue;
			}
			if (isTestFile(ref.sourceFile)) {
				continue;
			}
			importerDirSet.add(path.dirname(ref.sourceFile));
		}

		if (importerDirSet.size === 0) {
			continue;
		}

		const importerDirs = [...importerDirSet];
		const lca = computePathLCA(importerDirs);
		if (!lca) {
			continue;
		}

		const fileDir = path.dirname(file);

		// Skip if the file already lives inside the importer cluster area
		if (isWithinPath(lca, file)) {
			continue;
		}
		// Skip if the LCA is the project root (too broad — would suggest unrelated moves)
		if (lca === absoluteDir) {
			continue;
		}

		const basename = path.basename(file);
		const suggestedPath = path.join(lca, basename);
		// Skip if the suggestion is the same file
		if (normalizePath(suggestedPath) === normalizePath(file)) {
			continue;
		}

		// Importer clustering alone is not enough evidence to cross an
		// architectural boundary. A shared module whose consumers happen to sit
		// in one feature today is not misplaced — it is shared, and tomorrow's
		// second consumer would have to move it straight back.
		if (isSharedModuleRoot(relFile)) {
			continue;
		}
		// Likewise, do not pull a module from outside a framework route tree into
		// one. Route trees are owned by the framework's routing semantics, not by
		// whichever segment currently imports the module.
		if (hasAppRouterRootSegment(lca) && !hasAppRouterRootSegment(fileDir)) {
			continue;
		}

		results.push({
			file: relFile,
			absolutePath: file,
			currentDir: toRelativePath(absoluteDir, fileDir),
			importerDirs: importerDirs
				.map((d) => toRelativePath(absoluteDir, d))
				.sort(),
			suggestedDir: toRelativePath(absoluteDir, lca),
			suggestedPath: toRelativePath(absoluteDir, suggestedPath),
			importerCount: importers.length,
			evidence: `all ${importers.length} importer(s) cluster under ${toRelativePath(absoluteDir, lca)}; the module is outside that cluster, outside a shared root, and the destination is not a framework route tree`,
		});
	}

	return results.sort((a, b) => a.file.localeCompare(b.file));
}

function detectBasenameCollisions(
	graph: ReturnType<typeof mergeDependencyGraphs>,
	absoluteDir: string,
	ignorePattern: InstanceType<typeof Bun.Glob> | null
): BasenameCollision[] {
	// Build basename → [file paths] map
	const basenameMap = new Map<string, string[]>();
	for (const file of graph.imports.keys()) {
		if (!isWithinPath(absoluteDir, file)) {
			continue;
		}
		if (isTestFile(file)) {
			continue;
		}
		// Framework convention files repeat by design — one page.tsx or route.ts
		// per route segment — and their exports legitimately differ segment to
		// segment. Grouping them by basename reports the convention itself as a
		// collision. Convention-named files outside a route tree stay eligible.
		if (isFrameworkConventionFile(file)) {
			continue;
		}

		const relFile = toRelativePath(absoluteDir, file);
		if (
			ignorePattern?.match(relFile) ||
			ignorePattern?.match(path.basename(file))
		) {
			continue;
		}

		const bn = path.basename(file, path.extname(file));
		const existing = basenameMap.get(bn) ?? [];
		existing.push(file);
		basenameMap.set(bn, existing);
	}

	const results: BasenameCollision[] = [];

	for (const [basename, files] of basenameMap) {
		if (files.length < 2) {
			continue;
		}

		// Build export-name → [{ file, signature }] for each file
		const exportSignatures = new Map<string, SignatureInfo[]>();

		for (const file of files) {
			const exports =
				withGraphSourceFile(graph, file, scanExports, null) ??
				withSourceFile(file, scanExports, null);
			if (!exports) {
				continue;
			}

			for (const exp of exports) {
				if (exp.type === "default") {
					continue;
				}
				const sig =
					withGraphSourceFile(
						graph,
						file,
						(sf) => getExportSignatureText(sf, exp.name),
						null
					) ??
					withSourceFile(
						file,
						(sf) => getExportSignatureText(sf, exp.name),
						null
					);

				if (sig === null) {
					continue;
				}

				const existing = exportSignatures.get(exp.name) ?? [];
				existing.push({
					file: toRelativePath(absoluteDir, file),
					signature: sig,
				});
				exportSignatures.set(exp.name, existing);
			}
		}

		const conflictingExports: ExportConflict[] = [];
		for (const [name, sigs] of exportSignatures) {
			if (sigs.length < 2) {
				continue;
			}
			// Check if signatures diverge
			const uniqueSigs = new Set(sigs.map((s) => s.signature));
			if (uniqueSigs.size > 1) {
				conflictingExports.push({ name, signatures: sigs });
			}
		}

		if (conflictingExports.length > 0) {
			results.push({
				basename,
				files: files.map((f) => toRelativePath(absoluteDir, f)).sort(),
				conflictingExports: conflictingExports.sort((a, b) =>
					a.name.localeCompare(b.name)
				),
			});
		}
	}

	return results.sort((a, b) => a.basename.localeCompare(b.basename));
}

export async function buildOrganiseReport(
	options: OrganiseOptions
): Promise<OrganiseReport> {
	const absoluteDir = path.resolve(options.directory);
	const tsconfigPath = resolveTsConfig(options.project, absoluteDir);
	if (!tsconfigPath) {
		throw new Error(`Could not find tsconfig.json for ${absoluteDir}`);
	}

	const graphs = await buildProjectGraphs(tsconfigPath);
	const graph = mergeDependencyGraphs(graphs.map((g) => g.graph));

	const ignorePattern = options.ignore ? new Bun.Glob(options.ignore) : null;

	const misplacedFiles = detectMisplacedFiles(
		graph,
		absoluteDir,
		ignorePattern
	);
	const basenameCollisions = detectBasenameCollisions(
		graph,
		absoluteDir,
		ignorePattern
	);

	const scannedFiles = [...graph.imports.keys()].filter((f) =>
		isWithinPath(absoluteDir, f)
	).length;

	return {
		schemaVersion: ORGANISE_SCHEMA_VERSION,
		directory: absoluteDir,
		generatedAt: new Date().toISOString(),
		misplacedFiles,
		basenameCollisions,
		summary: {
			totalMisplaced: misplacedFiles.length,
			totalCollisions: basenameCollisions.length,
			scannedFiles,
		},
	};
}

export async function organiseCommand(options: OrganiseOptions): Promise<void> {
	const report = await buildOrganiseReport(options);

	if (options.json) {
		logger.info(JSON.stringify(report, null, 2));
		return;
	}

	const rel = (p: string) => toRelativePath(process.cwd(), p);

	if (
		report.misplacedFiles.length === 0 &&
		report.basenameCollisions.length === 0
	) {
		logger.info(`No organisation issues found in ${rel(report.directory)}`);
		logger.info(
			`  Scanned ${report.summary.scannedFiles} file${report.summary.scannedFiles === 1 ? "" : "s"}`
		);
		return;
	}

	if (report.misplacedFiles.length > 0) {
		logger.info(
			`\nMisplaced files (${report.misplacedFiles.length}):\n${"─".repeat(50)}`
		);
		for (const f of report.misplacedFiles) {
			logger.info(`  ${f.file}`);
			logger.info(
				`    importers: ${f.importerDirs.join(", ")} (${f.importerCount} total)`
			);
			logger.info(`    suggested: ${f.suggestedPath}`);
			logger.info(`    fix:       resect move ${f.file} ${f.suggestedPath}`);
		}
	}

	if (report.basenameCollisions.length > 0) {
		logger.info(
			`\nBasename collisions (${report.basenameCollisions.length}):\n${"─".repeat(50)}`
		);
		for (const collision of report.basenameCollisions) {
			logger.info(`  ${collision.basename} — ${collision.files.join(", ")}`);
			for (const exp of collision.conflictingExports) {
				logger.info(`    export "${exp.name}" has divergent signatures:`);
				for (const sig of exp.signatures) {
					logger.info(`      ${sig.file}: ${sig.signature}`);
				}
			}
		}
	}

	logger.info(
		`\nSummary: ${report.summary.totalMisplaced} misplaced, ${report.summary.totalCollisions} basename collision${report.summary.totalCollisions === 1 ? "" : "s"} — ${report.summary.scannedFiles} files scanned`
	);
}
