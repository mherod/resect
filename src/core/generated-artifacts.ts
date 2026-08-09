import path from "node:path";
import ts from "typescript";
import type { ModuleReference } from "../types/graph.ts";
import type { DependencyGraph } from "./graph.ts";
import { isWithinPath } from "./path-utils.ts";
import { normalizePath } from "./resolver.ts";

const NEXT_CONFIG_FILENAMES = [
	"next.config.ts",
	"next.config.mts",
	"next.config.cts",
	"next.config.js",
	"next.config.mjs",
	"next.config.cjs",
] as const;

export interface FrameworkGeneratedArtifact {
	file: string;
	framework: "next";
	generatedDirectory: string;
	tsconfigPath: string;
}

export interface FrameworkGeneratedArtifactClassifier {
	classify(file: string): FrameworkGeneratedArtifact | undefined;
}

interface NextGeneratedBoundary {
	generatedDirectory: string;
	tsconfigPath: string;
	typeDirectories: string[];
}

const propertyName = (name: ts.PropertyName): string | undefined => {
	if (
		ts.isIdentifier(name) ||
		ts.isStringLiteral(name) ||
		ts.isNumericLiteral(name)
	) {
		return name.text;
	}
	return undefined;
};

const variableInitializers = (
	sourceFile: ts.SourceFile
): Map<string, ts.Expression> => {
	const initializers = new Map<string, ts.Expression>();
	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) {
			continue;
		}
		for (const declaration of statement.declarationList.declarations) {
			if (ts.isIdentifier(declaration.name) && declaration.initializer) {
				initializers.set(declaration.name.text, declaration.initializer);
			}
		}
	}
	return initializers;
};

const unwrapConfigObject = (
	expression: ts.Expression,
	initializers: Map<string, ts.Expression>,
	seen = new Set<string>()
): ts.ObjectLiteralExpression | undefined => {
	if (ts.isObjectLiteralExpression(expression)) {
		return expression;
	}
	if (
		ts.isParenthesizedExpression(expression) ||
		ts.isAsExpression(expression) ||
		ts.isSatisfiesExpression(expression) ||
		ts.isTypeAssertionExpression(expression)
	) {
		return unwrapConfigObject(expression.expression, initializers, seen);
	}
	if (ts.isCallExpression(expression)) {
		const firstArgument = expression.arguments[0];
		return firstArgument
			? unwrapConfigObject(firstArgument, initializers, seen)
			: undefined;
	}
	if (!ts.isIdentifier(expression) || seen.has(expression.text)) {
		return undefined;
	}
	const initializer = initializers.get(expression.text);
	if (!initializer) {
		return undefined;
	}
	seen.add(expression.text);
	return unwrapConfigObject(initializer, initializers, seen);
};

const isModuleExports = (expression: ts.Expression): boolean =>
	ts.isPropertyAccessExpression(expression) &&
	ts.isIdentifier(expression.expression) &&
	expression.expression.text === "module" &&
	expression.name.text === "exports";

const exportedConfigObject = (
	sourceFile: ts.SourceFile
): ts.ObjectLiteralExpression | undefined => {
	const initializers = variableInitializers(sourceFile);
	for (const statement of sourceFile.statements) {
		if (ts.isExportAssignment(statement)) {
			const config = unwrapConfigObject(statement.expression, initializers);
			if (config) {
				return config;
			}
		}
		if (
			ts.isExpressionStatement(statement) &&
			ts.isBinaryExpression(statement.expression) &&
			statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			isModuleExports(statement.expression.left)
		) {
			const config = unwrapConfigObject(
				statement.expression.right,
				initializers
			);
			if (config) {
				return config;
			}
		}
	}
	return undefined;
};

const staticDistDir = (
	sourceText: string,
	configPath: string
): string | null => {
	const sourceFile = ts.createSourceFile(
		configPath,
		sourceText,
		ts.ScriptTarget.Latest,
		true
	);
	const config = exportedConfigObject(sourceFile);
	if (!config) {
		return null;
	}
	const property = config.properties.find(
		(candidate): candidate is ts.PropertyAssignment =>
			ts.isPropertyAssignment(candidate) &&
			propertyName(candidate.name) === "distDir"
	);
	if (!property) {
		return null;
	}
	const initializer = property.initializer;
	return ts.isStringLiteral(initializer) ||
		ts.isNoSubstitutionTemplateLiteral(initializer)
		? initializer.text
		: null;
};

const configuredNextDistDir = async (
	projectRoot: string
): Promise<string | null> => {
	for (const filename of NEXT_CONFIG_FILENAMES) {
		const configPath = path.join(projectRoot, filename);
		const configFile = Bun.file(configPath);
		if (!(await configFile.exists())) {
			continue;
		}
		try {
			return staticDistDir(await configFile.text(), configPath);
		} catch {
			return null;
		}
	}
	return null;
};

const nextBoundary = (
	generatedDirectory: string,
	tsconfigPath: string
): NextGeneratedBoundary => ({
	generatedDirectory: normalizePath(generatedDirectory),
	tsconfigPath: normalizePath(tsconfigPath),
	typeDirectories: [
		normalizePath(path.join(generatedDirectory, "types")),
		normalizePath(path.join(generatedDirectory, "dev", "types")),
	],
});

/**
 * Build a non-executing classifier for framework-owned TypeScript artifacts.
 *
 * Next's default `.next` directory is always recognized. A custom `distDir`
 * is read only when it is a static string in the exported config object; the
 * config module is parsed as TypeScript and never imported or executed.
 */
export async function createFrameworkGeneratedArtifactClassifier(
	tsconfigPaths: readonly string[]
): Promise<FrameworkGeneratedArtifactClassifier> {
	const boundaries: NextGeneratedBoundary[] = [];
	const seen = new Set<string>();
	for (const inputConfigPath of tsconfigPaths) {
		const tsconfigPath = normalizePath(path.resolve(inputConfigPath));
		if (seen.has(tsconfigPath)) {
			continue;
		}
		seen.add(tsconfigPath);
		const projectRoot = path.dirname(tsconfigPath);
		boundaries.push(
			nextBoundary(path.join(projectRoot, ".next"), tsconfigPath)
		);

		const configured = await configuredNextDistDir(projectRoot);
		if (!configured) {
			continue;
		}
		const generatedDirectory = normalizePath(
			path.resolve(projectRoot, configured)
		);
		if (
			isWithinPath(projectRoot, generatedDirectory) &&
			generatedDirectory !== normalizePath(path.join(projectRoot, ".next"))
		) {
			boundaries.push(nextBoundary(generatedDirectory, tsconfigPath));
		}
	}

	boundaries.sort(
		(a, b) => b.generatedDirectory.length - a.generatedDirectory.length
	);
	return {
		classify(file: string): FrameworkGeneratedArtifact | undefined {
			const normalizedFile = normalizePath(path.resolve(file));
			const boundary = boundaries.find((candidate) =>
				candidate.typeDirectories.some((directory) =>
					isWithinPath(directory, normalizedFile)
				)
			);
			return boundary
				? {
						file: normalizedFile,
						framework: "next",
						generatedDirectory: boundary.generatedDirectory,
						tsconfigPath: boundary.tsconfigPath,
					}
				: undefined;
		},
	};
}

export function generatedArtifactWarning(count: number): string {
	return `Excluded ${count} framework-generated TypeScript file(s) from analysis.`;
}

/**
 * Any classifier that can judge a file excludable and return a record keyed by
 * its path. Generic so one graph pruner serves both framework-generated source
 * (#190) and non-source build output (#202) rather than two parallel walks.
 */
export interface ExcludableFileClassifier<T extends { file: string }> {
	classify(file: string): T | undefined;
}

/**
 * Remove excluded nodes from both sides of a dependency graph.
 *
 * Prunes every position a file can occupy — import source, import target,
 * `importedBy`, skipped files, barrel files, and barrel re-export targets — so
 * an excluded file cannot survive as a dangling edge and inflate another file's
 * fan-in.
 */
export function excludeClassifiedFiles<T extends { file: string }>(
	graph: DependencyGraph,
	classifier: ExcludableFileClassifier<T>
): {
	graph: DependencyGraph;
	excludedFiles: T[];
} {
	const excludedByFile = new Map<string, T>();
	const classify = (file: string): T | undefined => {
		const artifact = classifier.classify(file);
		if (artifact) {
			excludedByFile.set(artifact.file, artifact);
		}
		return artifact;
	};
	const imports = new Map<string, ModuleReference[]>();
	const importedBy = new Map<string, ModuleReference[]>();

	for (const [file, refs] of graph.imports) {
		if (classify(file)) {
			continue;
		}
		const retained = refs.filter((ref) => !classify(ref.resolvedPath));
		imports.set(file, retained);
		for (const ref of retained) {
			const target = normalizePath(ref.resolvedPath);
			const existing = importedBy.get(target) ?? [];
			existing.push(ref);
			importedBy.set(target, existing);
		}
	}
	for (const file of graph.importedBy.keys()) {
		classify(file);
	}

	const barrelReExports = new Map<string, string[]>();
	for (const [file, reExports] of graph.barrelReExports) {
		if (classify(file)) {
			continue;
		}
		barrelReExports.set(
			file,
			reExports.filter((target) => !classify(target))
		);
	}

	return {
		graph: {
			...graph,
			imports,
			importedBy,
			skippedFiles: graph.skippedFiles.filter((file) => !classify(file)),
			barrelFiles: new Set(
				[...graph.barrelFiles].filter((file) => !classify(file))
			),
			barrelReExports,
		},
		excludedFiles: [...excludedByFile.values()].sort((a, b) =>
			a.file.localeCompare(b.file)
		),
	};
}

/**
 * Remove framework-generated nodes from both sides of a dependency graph.
 *
 * Thin naming wrapper over {@link excludeClassifiedFiles}; kept so existing
 * callers and their tests read in framework terms.
 */
export function excludeFrameworkGeneratedArtifacts(
	graph: DependencyGraph,
	classifier: FrameworkGeneratedArtifactClassifier
): {
	graph: DependencyGraph;
	excludedGeneratedFiles: FrameworkGeneratedArtifact[];
} {
	const { graph: pruned, excludedFiles } = excludeClassifiedFiles(
		graph,
		classifier
	);
	return { graph: pruned, excludedGeneratedFiles: excludedFiles };
}
