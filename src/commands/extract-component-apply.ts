import path from "node:path";
import ts from "typescript";
import { mapConcurrent } from "../core/concurrency.ts";
import { removeExtension } from "../core/constants.ts";
import { checkRollbackSafeWorktree } from "../core/git.ts";
import { runMutation } from "../core/mutation-pipeline.ts";
import {
	createProgram,
	loadProject,
	resolveTsConfig,
} from "../core/project.ts";
import { calculateRelativeSpecifier } from "../core/resolver.ts";
import {
	createFileContentsRollbackStrategy,
	createRollbackCheckpoint,
	type RollbackCheckpoint,
} from "../core/rollback.ts";
import { applyTextChanges, type TextChange } from "../core/text-changes.ts";
import { getRuntime } from "../runtime/index.ts";
import {
	classifyFreeVariables,
	type FreeVariableReport,
	type PropCandidate,
	type UnliftableHook,
} from "./extract-component-analyze.ts";
import {
	type ExtractComponentOptions,
	resolveJsxTsNode,
} from "./extract-component-locate.ts";

/** Names derived deterministically from the destination module's basename. */
export interface ComponentNames {
	componentName: string;
	interfaceName: string;
}

/** Result of generating the extracted component's module text. */
export interface ComponentCodegenResult extends ComponentNames {
	props: PropCandidate[];
	moduleText: string;
}

const NON_WORD_PATTERN = /[^a-zA-Z0-9]+/;
const CAMEL_BOUNDARY_PATTERN = /(?<=[a-z0-9])(?=[A-Z])/;

/**
 * Convert an arbitrary basename to PascalCase: split on non-word characters and
 * camelCase boundaries, then capitalize each token. `user-card` → `UserCard`,
 * `panel.view` → `PanelView`, `fooBar` → `FooBar`.
 */
export function toPascalCase(raw: string): string {
	const tokens = raw
		.split(NON_WORD_PATTERN)
		.flatMap((part) => part.split(CAMEL_BOUNDARY_PATTERN))
		.filter((token) => token.length > 0);
	const pascal = tokens
		.map((token) => token.charAt(0).toUpperCase() + token.slice(1))
		.join("");
	return pascal.length > 0 ? pascal : "Component";
}

/** Derive `<Name>` and `<Name>Props` from a destination file path. */
export function componentNamesFromNewFile(newFile: string): ComponentNames {
	const base = removeExtension(path.basename(newFile));
	const componentName = toPascalCase(base);
	return { componentName, interfaceName: `${componentName}Props` };
}

/**
 * Re-indent a verbatim JSX source span so it nests cleanly inside the generated
 * component's `return (` block. The span's first line starts at the opening `<`
 * (leading trivia is excluded by `getStart`); subsequent lines keep their
 * relative nesting after the common leading indentation is stripped and
 * `baseIndent` re-applied. Tab-based, matching the project's Biome config.
 */
export function reindentJsx(raw: string, baseIndent: string): string {
	const lines = raw.split("\n");
	const [firstLine, ...rest] = lines;
	const nonEmptyRest = rest.filter((line) => line.trim().length > 0);
	const minIndent =
		nonEmptyRest.length === 0
			? 0
			: Math.min(
					...nonEmptyRest.map(
						(line) => line.length - line.replace(/^[\t ]+/, "").length
					)
				);
	const body = rest.map((line) =>
		line.trim().length === 0 ? "" : `${baseIndent}${line.slice(minIndent)}`
	);
	return [`${baseIndent}${firstLine?.trimStart() ?? ""}`, ...body].join("\n");
}

/**
 * Render `interface <Name>Props { ... }`, or `null` when there are no props —
 * an empty interface trips Biome's no-empty-interface rule, so the zero-prop
 * component omits both the interface and the destructured parameter.
 */
export function renderPropsInterface(
	interfaceName: string,
	props: PropCandidate[]
): string | null {
	if (props.length === 0) {
		return null;
	}
	const members = props
		.map((prop) => `\t${prop.name}: ${prop.type};`)
		.join("\n");
	return `interface ${interfaceName} {\n${members}\n}`;
}

function importDeclarationOf(node: ts.Node): ts.ImportDeclaration | undefined {
	const found = ts.findAncestor(node, ts.isImportDeclaration);
	return found && ts.isImportDeclaration(found) ? found : undefined;
}

interface ModuleImports {
	defaults: Set<string>;
	namespaces: Set<string>;
	named: Map<string, string>;
}

function emptyModuleImports(): ModuleImports {
	return { defaults: new Set(), namespaces: new Set(), named: new Map() };
}

/**
 * Re-emit the module-level imports the extracted JSX still needs. Walks the
 * subtree, resolves each identifier by symbol, and reconstructs the import
 * statement(s) for any binding that resolves to an `import` in the source file
 * (components, helpers, React). Grouped per module, deterministically ordered.
 */
export function collectJsxImports(
	jsxNode: ts.Node,
	checker: ts.TypeChecker
): string[] {
	const byModule = new Map<string, ModuleImports>();
	const seen = new Set<ts.Symbol>();

	const record = (declaration: ts.Node, localName: string): void => {
		const importDecl = importDeclarationOf(declaration);
		if (!(importDecl && ts.isStringLiteral(importDecl.moduleSpecifier))) {
			return;
		}
		const moduleName = importDecl.moduleSpecifier.text;
		const entry = byModule.get(moduleName) ?? emptyModuleImports();
		if (ts.isNamespaceImport(declaration)) {
			entry.namespaces.add(localName);
		} else if (ts.isImportClause(declaration)) {
			entry.defaults.add(localName);
		} else if (ts.isImportSpecifier(declaration)) {
			const imported = declaration.propertyName?.text ?? declaration.name.text;
			entry.named.set(imported, localName);
		}
		byModule.set(moduleName, entry);
	};

	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node)) {
			const symbol = checker.getSymbolAtLocation(node);
			const declaration = symbol?.getDeclarations()?.[0];
			if (
				symbol &&
				declaration &&
				!seen.has(symbol) &&
				(ts.isImportSpecifier(declaration) ||
					ts.isImportClause(declaration) ||
					ts.isNamespaceImport(declaration))
			) {
				seen.add(symbol);
				record(declaration, node.text);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(jsxNode);

	const statements: string[] = [];
	for (const moduleName of [...byModule.keys()].sort()) {
		const entry = byModule.get(moduleName);
		if (!entry) {
			continue;
		}
		for (const namespace of [...entry.namespaces].sort()) {
			statements.push(`import * as ${namespace} from "${moduleName}";`);
		}
		const clauses: string[] = [];
		for (const def of [...entry.defaults].sort()) {
			clauses.push(def);
		}
		if (entry.named.size > 0) {
			const named = [...entry.named.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([imported, local]) =>
					imported === local ? imported : `${imported} as ${local}`
				)
				.join(", ");
			clauses.push(`{ ${named} }`);
		}
		if (clauses.length > 0) {
			statements.push(`import ${clauses.join(", ")} from "${moduleName}";`);
		}
	}
	return statements;
}

/**
 * Generate the extracted component's module text from a classified JSX node.
 * Emits collected imports, an optional `Props` interface, and a typed function
 * component whose body re-emits the JSX verbatim from its source span. Does not
 * write to disk or rewrite the call site (#110).
 */
export function generateComponentModule(params: {
	jsxNode: ts.Node;
	sourceFile: ts.SourceFile;
	checker: ts.TypeChecker;
	classification: FreeVariableReport;
	newFile: string;
}): ComponentCodegenResult {
	const { jsxNode, sourceFile, checker, classification, newFile } = params;
	const { componentName, interfaceName } = componentNamesFromNewFile(newFile);
	const props = classification.propCandidates;

	const imports = collectJsxImports(jsxNode, checker);
	const propsInterface = renderPropsInterface(interfaceName, props);
	const jsxText = sourceFile.text.slice(
		jsxNode.getStart(sourceFile),
		jsxNode.getEnd()
	);
	const body = reindentJsx(jsxText, "\t\t");

	const signature =
		props.length === 0
			? `export function ${componentName}() {`
			: `export function ${componentName}({ ${props
					.map((prop) => prop.name)
					.join(", ")} }: ${interfaceName}) {`;
	const component = `${signature}\n\treturn (\n${body}\n\t);\n}`;

	const sections = [
		imports.length > 0 ? imports.join("\n") : null,
		propsInterface,
		component,
	].filter((section): section is string => section !== null);

	return {
		componentName,
		interfaceName,
		props,
		moduleText: `${sections.join("\n\n")}\n`,
	};
}

/**
 * Locate the target JSX node, build the shared program/checker, classify the
 * free variables, and generate the extracted component module text. Read-only:
 * returns the module text in memory; writing + call-site rewrite land in #110.
 */
export function buildExtractComponentModule(
	options: ExtractComponentOptions
): ComponentCodegenResult {
	const absolutePath = path.resolve(options.file);
	const tsconfigPath = resolveTsConfig(
		options.project,
		path.dirname(absolutePath)
	);
	if (!tsconfigPath) {
		throw new Error("Could not find tsconfig.json");
	}
	const project = loadProject(tsconfigPath, absolutePath);
	const program = createProgram(project, [absolutePath]);
	const sourceFile = program.getSourceFile(absolutePath);
	if (!sourceFile) {
		throw new Error(`Could not parse file: ${absolutePath}`);
	}
	const checker = program.getTypeChecker();
	const jsxNode = resolveJsxTsNode(sourceFile, options.selector);
	const classification = classifyFreeVariables(jsxNode, sourceFile, checker);
	return generateComponentModule({
		jsxNode,
		sourceFile,
		checker,
		classification,
		newFile: options.newFile,
	});
}

export interface ExtractComponentWrite {
	/** Absolute path of the file. */
	file: string;
	/** `create` for the new module, `modify` for the rewritten original. */
	kind: "create" | "modify";
	/** Full new contents of the file. */
	content: string;
}

/** Before/after tsc diagnostic delta for an applied extraction. */
export interface ExtractComponentTypecheck {
	errorsBefore: string[];
	errorsAfter: string[];
	newErrors: string[];
	verificationIncomplete: boolean;
}

/** Result of writing + rewriting (or planning, under dry-run) an extraction. */
export interface ExtractComponentApplyResult {
	dryRun: boolean;
	success: boolean;
	/** True when unliftable hooks prevented extraction; nothing was written. */
	blocked: boolean;
	unliftableHooks: UnliftableHook[];
	/** A call-site name/binding or destination-exists conflict, when one aborted the write. */
	conflict: string | null;
	componentName: string;
	/** Absolute destination path of the generated module. */
	newFile: string;
	/** Relative specifier inserted into the original file's import. */
	importSpecifier: string;
	/** The `<NewComponent … />` element that replaced the extracted span. */
	callSite: string;
	/** Planned writes — populated even on dry-run / conflict so callers can preview. */
	writes: ExtractComponentWrite[];
	/** Files actually written (empty on dry-run, conflict, block, or rollback). */
	modifiedFiles: string[];
	rolledBack: boolean;
	errors: string[];
	typecheck?: ExtractComponentTypecheck;
}

/** True when `decl`'s import clause binds `name` (default, namespace, or named). */
function importClauseBindsName(
	decl: ts.ImportDeclaration,
	name: string
): boolean {
	const clause = decl.importClause;
	if (!clause) {
		return false;
	}
	if (clause.name?.text === name) {
		return true;
	}
	const bindings = clause.namedBindings;
	if (!bindings) {
		return false;
	}
	if (ts.isNamespaceImport(bindings)) {
		return bindings.name.text === name;
	}
	return bindings.elements.some((element) => element.name.text === name);
}

/**
 * Whether `sourceFile` already declares `name` at the top level — an import
 * binding or a variable/function/class/type/interface/enum declaration. Mirrors
 * the `hasLocalBinding()` conflict checks in `move`/`rename`: the inserted
 * component import would collide with any existing binding of the same name.
 */
function fileDeclaresName(sourceFile: ts.SourceFile, name: string): boolean {
	for (const statement of sourceFile.statements) {
		if (
			ts.isImportDeclaration(statement) &&
			importClauseBindsName(statement, name)
		) {
			return true;
		}
		if (
			(ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isEnumDeclaration(statement)) &&
			statement.name?.text === name
		) {
			return true;
		}
		if (
			ts.isVariableStatement(statement) &&
			statement.declarationList.declarations.some(
				(declaration) =>
					ts.isIdentifier(declaration.name) && declaration.name.text === name
			)
		) {
			return true;
		}
	}
	return false;
}

/** Build the `<NewComponent propA={propA} … />` element for the call site. */
function buildJsxCallSite(
	componentName: string,
	props: PropCandidate[]
): string {
	if (props.length === 0) {
		return `<${componentName} />`;
	}
	const attrs = props.map((prop) => `${prop.name}={${prop.name}}`).join(" ");
	return `<${componentName} ${attrs} />`;
}

/**
 * Plan the two text edits an extraction makes to the original file — inserting
 * the component import after the last existing import (or at the top), and
 * replacing the extracted JSX span with the new element — plus the new module
 * write. Pure: computes contents from the parsed source, writes nothing.
 */
export function planExtractComponentWrites(params: {
	sourceFile: ts.SourceFile;
	jsxNode: ts.Node;
	codegen: ComponentCodegenResult;
	originalFile: string;
	newFile: string;
}): {
	writes: ExtractComponentWrite[];
	importSpecifier: string;
	callSite: string;
	conflict: string | null;
} {
	const { sourceFile, jsxNode, codegen, originalFile, newFile } = params;
	const { componentName, props } = codegen;

	const conflict = fileDeclaresName(sourceFile, componentName)
		? `Call-site conflict: "${componentName}" is already declared or imported in ${path.basename(originalFile)}.`
		: null;

	const importSpecifier = calculateRelativeSpecifier(originalFile, newFile);
	const callSite = buildJsxCallSite(componentName, props);
	const importStatement = `import { ${componentName} } from "${importSpecifier}";`;

	const importDecls = sourceFile.statements.filter(ts.isImportDeclaration);
	const lastImport = importDecls.at(-1);
	const importChange: TextChange = lastImport
		? {
				start: lastImport.getEnd(),
				end: lastImport.getEnd(),
				newText: `\n${importStatement}`,
			}
		: { start: 0, end: 0, newText: `${importStatement}\n` };
	const jsxChange: TextChange = {
		start: jsxNode.getStart(sourceFile),
		end: jsxNode.getEnd(),
		newText: callSite,
	};

	const rewrittenOriginal = applyTextChanges(sourceFile.text, [
		importChange,
		jsxChange,
	]);

	return {
		writes: [
			{ file: newFile, kind: "create", content: codegen.moduleText },
			{ file: originalFile, kind: "modify", content: rewrittenOriginal },
		],
		importSpecifier,
		callSite,
		conflict,
	};
}

/**
 * Apply an extraction end-to-end: locate + classify + codegen, then write the
 * new module and rewrite the original call site, guarded by the dirty-worktree
 * check, call-site conflict detection, and a closing `tsc --noEmit` gate that
 * rolls every write back on any new type error or incomplete verification.
 *
 * Blocks (writing nothing) when the subtree references unliftable hook values.
 * Honors `dryRun` (plan only) and `force` (override the worktree + conflict
 * guards). Mirrors the apply/verify/rollback contract of `mock-cleanup`/`move`.
 */
export async function executeExtractComponent(
	options: ExtractComponentOptions
): Promise<ExtractComponentApplyResult> {
	const dryRun = options.dryRun ?? false;
	const force = options.force ?? false;
	const absolutePath = path.resolve(options.file);
	const newFileAbs = path.resolve(options.newFile);

	const tsconfigPath = resolveTsConfig(
		options.project,
		path.dirname(absolutePath)
	);
	if (!tsconfigPath) {
		throw new Error("Could not find tsconfig.json");
	}
	const project = loadProject(tsconfigPath, absolutePath);
	const program = createProgram(project, [absolutePath]);
	const sourceFile = program.getSourceFile(absolutePath);
	if (!sourceFile) {
		throw new Error(`Could not parse file: ${absolutePath}`);
	}
	const checker = program.getTypeChecker();
	const jsxNode = resolveJsxTsNode(sourceFile, options.selector);
	const classification = classifyFreeVariables(jsxNode, sourceFile, checker);
	const { componentName } = componentNamesFromNewFile(options.newFile);

	const base = {
		dryRun,
		componentName,
		newFile: newFileAbs,
		unliftableHooks: classification.unliftableHooks,
		modifiedFiles: [] as string[],
		rolledBack: false,
	};

	if (classification.blocked) {
		const hooks = classification.unliftableHooks
			.map((hook) => `${hook.name} (from ${hook.derivedFrom})`)
			.join(", ");
		return {
			...base,
			blocked: true,
			success: false,
			conflict: null,
			importSpecifier: "",
			callSite: "",
			writes: [],
			errors: [
				`Extraction blocked: subtree references hook-derived value(s): ${hooks}. Nothing written.`,
			],
		};
	}

	const codegen = generateComponentModule({
		jsxNode,
		sourceFile,
		checker,
		classification,
		newFile: options.newFile,
	});
	const plan = planExtractComponentWrites({
		sourceFile,
		jsxNode,
		codegen,
		originalFile: absolutePath,
		newFile: newFileAbs,
	});

	const rt = getRuntime();
	let conflict = plan.conflict;
	if (!(conflict || force) && (await rt.fs.exists(newFileAbs))) {
		conflict = `Destination file already exists: ${options.newFile}. Rerun with --force to overwrite.`;
	}
	if (conflict && !force) {
		return {
			...base,
			blocked: false,
			success: false,
			conflict,
			importSpecifier: plan.importSpecifier,
			callSite: plan.callSite,
			writes: plan.writes,
			errors: [conflict],
		};
	}

	const planned = {
		...base,
		blocked: false,
		conflict,
		importSpecifier: plan.importSpecifier,
		callSite: plan.callSite,
		writes: plan.writes,
	};

	if (dryRun) {
		return { ...planned, success: true, errors: [] };
	}

	const guard = await checkRollbackSafeWorktree(path.dirname(absolutePath), {
		force,
		dryRun,
	});
	if (guard.blocked) {
		return {
			...planned,
			success: false,
			modifiedFiles: [],
			errors: [
				"Error: working tree has uncommitted changes. Commit or stash your changes first, or rerun with --force to proceed anyway.",
			],
		};
	}

	const modifiedFiles = plan.writes.map((write) => write.file).sort();
	// The in-memory checkpoint must be taken right before the writes (there is
	// no committed git state to restore to for a brand-new file); captured here
	// and read back by rollbackStrategy once verification runs.
	let checkpoint: RollbackCheckpoint<unknown> | undefined;
	const outcome = await runMutation<void>(
		{
			apply: async () => {
				checkpoint = await createRollbackCheckpoint(
					createFileContentsRollbackStrategy(modifiedFiles)
				);
				await mapConcurrent(plan.writes, async (write) =>
					rt.fs.writeFile(write.file, write.content)
				);
			},
			dryRun: false,
			force,
			guardDir: path.dirname(absolutePath),
			journalEnabled: false,
			operation: "extract-component",
			project,
			rollbackStrategy: async () => {
				if (!checkpoint) {
					return false;
				}
				await checkpoint.restore();
				return true;
			},
			verify: "rollback",
		},
		{ checkRollbackSafeWorktree: async () => Promise.resolve(guard) }
	);

	const delta = outcome.delta;
	const typecheck: ExtractComponentTypecheck | undefined = delta
		? {
				errorsBefore: delta.errorsBefore,
				errorsAfter: delta.errorsAfter,
				newErrors: delta.newErrors,
				verificationIncomplete: delta.verificationIncomplete,
			}
		: undefined;

	if (delta && !delta.success) {
		return {
			...planned,
			success: false,
			modifiedFiles,
			rolledBack: outcome.rolledBack,
			errors: delta.verificationIncomplete
				? ["Type checking did not complete after extract-component."]
				: delta.newErrors,
			typecheck,
		};
	}

	return {
		...planned,
		success: true,
		modifiedFiles,
		errors: [],
		typecheck,
	};
}
