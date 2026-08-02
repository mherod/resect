import path from "node:path";
import ts from "typescript";
import { logger } from "../cli-logger.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import { removeExtension } from "../core/constants.ts";
import { ensureCleanWorktree } from "../core/git.ts";
import {
	createProgram,
	loadProject,
	resolveTsConfig,
} from "../core/project.ts";
import { calculateRelativeSpecifier } from "../core/resolver.ts";
import {
	createFileContentsRollbackStrategy,
	createRollbackCheckpoint,
} from "../core/rollback.ts";
import { parseSourceFile } from "../core/source-file.ts";
import { applyTextChanges, type TextChange } from "../core/text-changes.ts";
import { runTypeCheckDetailed } from "../core/verify.ts";
import { getRuntime } from "../runtime/index.ts";
import type { MutatingCommandOptions } from "../types.ts";

/**
 * `extract-component` — pull a JSX/TSX subtree into its own typed module.
 *
 * This is slice 1 of the epic (#107): the command scaffold plus selector
 * resolution. It is **read-only / dry-run only** — it locates the target JSX
 * node and reports it. Free-variable/hook classification (#108), Props-interface
 * + component codegen (#109), and the call-site rewrite + verify/rollback (#110)
 * land in later slices. No files are written here.
 */
export interface ExtractComponentOptions extends MutatingCommandOptions {
	/** Path to the source file containing the JSX to extract */
	file: string;
	/**
	 * Which JSX node to extract. Two forms:
	 * - line range: `L<start>-<end>` or `<start>-<end>` (1-based, inclusive)
	 * - element/component name: a JSX tag name (e.g. `Card`, `div`)
	 */
	selector: string;
	/** Destination module the extracted component will eventually be written to */
	newFile: string;
	/** Emit the report as JSON instead of human-readable text */
	json?: boolean;
}

export type JsxNodeKind = "element" | "self-closing" | "fragment";

/** The JSX node a selector resolved to. Char offsets are 0-based; lines 1-based. */
export interface LocatedJsxNode {
	kind: JsxNodeKind;
	/** Tag name for elements/self-closing elements; `null` for fragments */
	tagName: string | null;
	start: number;
	end: number;
	startLine: number;
	endLine: number;
}

export interface ExtractComponentReport {
	file: string;
	selector: string;
	newFile: string;
	located: LocatedJsxNode;
}

type ParsedSelector =
	| { type: "range"; start: number; end: number }
	| { type: "name"; name: string };

const LINE_RANGE_PATTERN = /^L?(\d+)-(\d+)$/;

/**
 * Parse a selector string into a structured form. A `L12-30`/`12-30` shape is a
 * line range; anything else is treated as a JSX tag/component name.
 */
export function parseSelector(selector: string): ParsedSelector {
	const trimmed = selector.trim();
	if (trimmed.length === 0) {
		throw new Error("Selector must not be empty");
	}
	const rangeMatch = trimmed.match(LINE_RANGE_PATTERN);
	if (rangeMatch) {
		const start = Number(rangeMatch[1]);
		const end = Number(rangeMatch[2]);
		if (start < 1 || end < 1) {
			throw new Error(
				`Line range must use 1-based line numbers: "${selector}"`
			);
		}
		if (start > end) {
			throw new Error(
				`Line range start must not exceed end: "${selector}" (${start} > ${end})`
			);
		}
		return { type: "range", start, end };
	}
	return { type: "name", name: trimmed };
}

function isJsxNode(
	node: ts.Node
): node is ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment {
	return (
		ts.isJsxElement(node) ||
		ts.isJsxSelfClosingElement(node) ||
		ts.isJsxFragment(node)
	);
}

function collectJsxNodes(
	sourceFile: ts.SourceFile
): Array<ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment> {
	const nodes: Array<
		ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment
	> = [];
	const visit = (node: ts.Node): void => {
		if (isJsxNode(node)) {
			nodes.push(node);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return nodes;
}

function jsxTagName(
	node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
	sourceFile: ts.SourceFile
): string | null {
	if (ts.isJsxElement(node)) {
		return node.openingElement.tagName.getText(sourceFile);
	}
	if (ts.isJsxSelfClosingElement(node)) {
		return node.tagName.getText(sourceFile);
	}
	return null;
}

function jsxNodeKind(
	node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment
): JsxNodeKind {
	if (ts.isJsxElement(node)) {
		return "element";
	}
	if (ts.isJsxSelfClosingElement(node)) {
		return "self-closing";
	}
	return "fragment";
}

function toLocatedNode(
	node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
	sourceFile: ts.SourceFile
): LocatedJsxNode {
	const start = node.getStart(sourceFile);
	const end = node.getEnd();
	const kind: JsxNodeKind = jsxNodeKind(node);
	return {
		kind,
		tagName: jsxTagName(node, sourceFile),
		start,
		end,
		startLine: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
		endLine: sourceFile.getLineAndCharacterOfPosition(end).line + 1,
	};
}

function describeCandidate(node: LocatedJsxNode): string {
	const label =
		node.kind === "fragment" ? "<>…</>" : `<${node.tagName ?? "?"}>`;
	return `${label} (lines ${node.startLine}-${node.endLine})`;
}

/**
 * Resolve a selector to exactly one JSX node in `sourceFile`.
 *
 * Throws a descriptive error when nothing matches or when the selector is
 * ambiguous (more than one top-level match). Shared by the CLI command and the
 * MCP tool so selection behaves identically across entry points.
 */
export function locateJsxNode(
	sourceFile: ts.SourceFile,
	selector: string
): LocatedJsxNode {
	const parsed = parseSelector(selector);
	const jsxNodes = collectJsxNodes(sourceFile);
	if (jsxNodes.length === 0) {
		throw new Error("No JSX elements found in file");
	}

	if (parsed.type === "name") {
		const matches = jsxNodes.filter(
			(node) => jsxTagName(node, sourceFile) === parsed.name
		);
		return pickSingleMatch(
			matches.map((node) => toLocatedNode(node, sourceFile)),
			selector,
			`No JSX element named "${parsed.name}" found`
		);
	}

	// Line-range selector: keep JSX nodes fully contained in [start, end], then
	// drop any nested inside another contained node so only the outermost
	// subtree(s) remain.
	const contained = jsxNodes
		.map((node) => toLocatedNode(node, sourceFile))
		.filter(
			(node) => node.startLine >= parsed.start && node.endLine <= parsed.end
		);
	const topLevel = contained.filter(
		(node) =>
			!contained.some(
				(other) =>
					other !== node && other.start <= node.start && other.end >= node.end
			)
	);
	return pickSingleMatch(
		topLevel,
		selector,
		`No JSX element fully contained in lines ${parsed.start}-${parsed.end}`
	);
}

function pickSingleMatch(
	matches: LocatedJsxNode[],
	selector: string,
	emptyMessage: string
): LocatedJsxNode {
	const [first, second] = matches;
	if (!first) {
		throw new Error(emptyMessage);
	}
	if (second) {
		const list = matches.map((m) => `  - ${describeCandidate(m)}`).join("\n");
		throw new Error(
			`Selector "${selector}" is ambiguous — ${matches.length} matches:\n${list}\nNarrow it with a line range (e.g. L${first.startLine}-${first.endLine}).`
		);
	}
	return first;
}

/**
 * Parse `filePath`, resolve `selector`, and produce the dry-run report. Pure
 * compute seam reused by both the CLI command and the MCP tool.
 */
export function locateExtractComponentTarget(
	filePath: string,
	selector: string,
	newFile: string
): ExtractComponentReport {
	if (newFile.trim().length === 0) {
		throw new Error("Destination <new-file> must not be empty");
	}
	const sourceFile = parseSourceFile(filePath);
	if (!sourceFile) {
		throw new Error(`Could not parse file: ${filePath}`);
	}
	const located = locateJsxNode(sourceFile, selector);
	return { file: filePath, selector, newFile, located };
}

// ── Free-variable collection + classification (#108) ──────────────────

/** A free identifier that becomes a prop on the extracted component. */
export interface PropCandidate {
	/** Identifier name as it appears in the subtree. */
	name: string;
	/** Resolved type string, suitable for Props-interface codegen (#109). */
	type: string;
}

/**
 * A free identifier whose value derives from a React hook call in the parent
 * component body. Lifting it into a child detaches it from the hook and changes
 * behavior, so it cannot be passed as a plain prop.
 */
export interface UnliftableHook {
	/** Identifier name as it appears in the subtree. */
	name: string;
	/** The hook the value derives from, e.g. `useState`. */
	derivedFrom: string;
}

/**
 * Classification report for the free variables of a target JSX subtree.
 * `blocked` is the default policy: extraction is refused while unliftable hook
 * values are referenced, so the offending hooks surface instead of being
 * silently misclassified as props.
 */
export interface FreeVariableReport {
	propCandidates: PropCandidate[];
	unliftableHooks: UnliftableHook[];
	blocked: boolean;
}

const HOOK_NAME_PATTERN = /^use[A-Z]/;

type FunctionLike =
	| ts.FunctionDeclaration
	| ts.FunctionExpression
	| ts.ArrowFunction
	| ts.MethodDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node)
	);
}

/** Nearest function-like ancestor of `node` — the component owning the JSX. */
function enclosingFunction(node: ts.Node): ts.Node | undefined {
	return ts.findAncestor(node.parent, isFunctionLike) ?? undefined;
}

function isWithinSpan(
	node: ts.Node,
	sourceFile: ts.SourceFile,
	start: number,
	end: number
): boolean {
	const nodeStart = node.getStart(sourceFile);
	const nodeEnd = node.getEnd();
	return nodeStart >= start && nodeEnd <= end;
}

/**
 * If `declaration` is (or sits inside) a variable declaration whose initializer
 * is a `use*` hook call, return the hook name; otherwise `null`. Covers both
 * `const value = useMemo(...)` and destructured `const [v, setV] = useState(...)`.
 */
function hookOrigin(declaration: ts.Node): string | null {
	// Climb from the binding (BindingElement / pattern) to its VariableDeclaration,
	// bailing out ("quit") the moment we leave binding-pattern territory so an
	// unrelated outer variable declaration is never mistaken for the origin.
	const variableDeclaration = ts.findAncestor(declaration, (node) => {
		if (ts.isVariableDeclaration(node)) {
			return true;
		}
		const isBindingNode =
			node === declaration ||
			ts.isBindingElement(node) ||
			ts.isObjectBindingPattern(node) ||
			ts.isArrayBindingPattern(node);
		return isBindingNode ? false : "quit";
	});
	if (!(variableDeclaration && ts.isVariableDeclaration(variableDeclaration))) {
		return null;
	}
	const { initializer } = variableDeclaration;
	if (
		initializer &&
		ts.isCallExpression(initializer) &&
		ts.isIdentifier(initializer.expression) &&
		HOOK_NAME_PATTERN.test(initializer.expression.text)
	) {
		return initializer.expression.text;
	}
	return null;
}

/**
 * Identifiers that are member/attribute/property *names* (not value
 * references) never resolve to a free scope variable — exclude them so a
 * property access like `user.name` doesn't surface `name` as a prop.
 */
function isReferencePosition(node: ts.Identifier, parent: ts.Node): boolean {
	if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
		return false;
	}
	if (ts.isQualifiedName(parent) && parent.right === node) {
		return false;
	}
	if (ts.isJsxAttribute(parent) && parent.name === node) {
		return false;
	}
	if (ts.isPropertyAssignment(parent) && parent.name === node) {
		return false;
	}
	return true;
}

/**
 * Collect and classify the free variables of `jsxNode` using the type-checker
 * (symbol identity, never name matching — so shadowing resolves correctly).
 *
 * A free identifier is one whose declaring symbol lives in the *owning
 * component function* but *outside* the extracted subtree:
 * - declared inside the subtree → bound (e.g. a `.map` callback param), skipped.
 * - declared at module scope / via import → available in the new module, skipped.
 * - declared in the owner but outside the subtree → free local → classified as a
 *   prop candidate, or an unliftable hook when its value derives from a hook call.
 */
export function classifyFreeVariables(
	jsxNode: ts.Node,
	sourceFile: ts.SourceFile,
	checker: ts.TypeChecker
): FreeVariableReport {
	const owner = enclosingFunction(jsxNode);
	const subtreeStart = jsxNode.getStart(sourceFile);
	const subtreeEnd = jsxNode.getEnd();
	const ownerStart = owner?.getStart(sourceFile) ?? 0;
	const ownerEnd = owner?.getEnd() ?? 0;

	const propCandidates: PropCandidate[] = [];
	const unliftableHooks: UnliftableHook[] = [];
	const seen = new Set<ts.Symbol>();

	const visit = (node: ts.Node, parent: ts.Node): void => {
		if (ts.isIdentifier(node) && isReferencePosition(node, parent)) {
			const symbol = checker.getSymbolAtLocation(node);
			const declaration = symbol?.getDeclarations()?.[0];
			if (symbol && declaration && !seen.has(symbol)) {
				const declInSubtree = isWithinSpan(
					declaration,
					sourceFile,
					subtreeStart,
					subtreeEnd
				);
				const declInOwner =
					owner !== undefined &&
					isWithinSpan(declaration, sourceFile, ownerStart, ownerEnd);
				if (!declInSubtree && declInOwner) {
					seen.add(symbol);
					const hook = hookOrigin(declaration);
					if (hook) {
						unliftableHooks.push({ name: node.text, derivedFrom: hook });
					} else {
						const type = checker.typeToString(
							checker.getTypeOfSymbolAtLocation(symbol, node)
						);
						propCandidates.push({ name: node.text, type });
					}
				}
			}
		}
		ts.forEachChild(node, (child) => {
			visit(child, node);
		});
	};
	ts.forEachChild(jsxNode, (child) => {
		visit(child, jsxNode);
	});

	return {
		propCandidates,
		unliftableHooks,
		blocked: unliftableHooks.length > 0,
	};
}

/**
 * Resolve a selector to the concrete `ts` JSX node (not just its offsets) within
 * `sourceFile`. Reuses {@link locateJsxNode} for selection + ambiguity handling,
 * then matches the located span back to the AST node so the checker-based
 * analysis can walk it.
 */
export function resolveJsxTsNode(
	sourceFile: ts.SourceFile,
	selector: string
): ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment {
	const located = locateJsxNode(sourceFile, selector);
	const match = collectJsxNodes(sourceFile).find(
		(node) =>
			node.getStart(sourceFile) === located.start &&
			node.getEnd() === located.end
	);
	if (!match) {
		throw new Error("Could not resolve located JSX node back to the AST");
	}
	return match;
}

/**
 * Locate the target JSX node, build the shared program/checker in a single
 * `createProgram` pass (mirroring `analyze`), and classify its free variables.
 * Read-only: parses + type-checks, writes nothing.
 */
export function analyzeExtractComponentFreeVariables(
	options: ExtractComponentOptions
): FreeVariableReport {
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
	const jsxNode = resolveJsxTsNode(sourceFile, options.selector);
	return classifyFreeVariables(jsxNode, sourceFile, program.getTypeChecker());
}

// ── Props-interface + component codegen (#109) ────────────────────────

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

// ── Write + call-site rewrite + verify/rollback (#110) ────────────────

/** A single file write planned by the extraction. */
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

	await ensureCleanWorktree(path.dirname(absolutePath), force, dryRun);

	const rollback = await createRollbackCheckpoint(
		createFileContentsRollbackStrategy(plan.writes.map((write) => write.file))
	);

	const before = await runTypeCheckDetailed(project);
	await mapConcurrent(plan.writes, async (write) =>
		rt.fs.writeFile(write.file, write.content)
	);
	const modifiedFiles = plan.writes.map((write) => write.file).sort();
	const after = await runTypeCheckDetailed(project);

	const errorsBefore = before.errors;
	const newErrors = after.errors.filter(
		(error) => !errorsBefore.includes(error)
	);
	const verificationIncomplete = before.incomplete || after.incomplete;
	const typecheck: ExtractComponentTypecheck = {
		errorsBefore,
		errorsAfter: after.errors,
		newErrors,
		verificationIncomplete,
	};

	if (newErrors.length > 0 || verificationIncomplete) {
		await rollback.restore();
		return {
			...planned,
			success: false,
			modifiedFiles,
			rolledBack: true,
			errors: verificationIncomplete
				? ["Type checking did not complete after extract-component."]
				: newErrors,
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

/**
 * CLI entry point. Mutates by default (writes the new module + rewrites the
 * call site, gated by the dirty-worktree guard and a closing tsc check that
 * rolls back on regression). `--dry-run` previews the locate + classify +
 * codegen report without writing. Exits non-zero on failure, conflict, or block.
 */
export async function extractComponentCommand(
	options: ExtractComponentOptions
): Promise<void> {
	if (options.dryRun) {
		printExtractComponentDryRun(options);
		return;
	}

	let result: ExtractComponentApplyResult;
	try {
		result = await executeExtractComponent(options);
	} catch (error) {
		logger.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}

	if (options.json) {
		logger.info(JSON.stringify(result, null, 2));
	} else {
		printExtractComponentResult(result);
	}
	if (!result.success) {
		process.exit(1);
	}
}

function printExtractComponentResult(
	result: ExtractComponentApplyResult
): void {
	logger.info("\n🧩 extract-component");
	logger.info(`   Component: ${result.componentName}`);
	logger.info(`   New file:  ${result.newFile}`);
	if (result.blocked || result.conflict) {
		logger.error(`⛔ ${result.errors.join(" ")}`);
		return;
	}
	if (result.rolledBack) {
		logger.error(
			`❌ Extraction introduced ${result.errors.length} new type error(s) — all writes rolled back:`
		);
		for (const error of result.errors.slice(0, 10)) {
			logger.error(`   ${error}`);
		}
		return;
	}
	logger.info(`   Import:    ${result.importSpecifier}`);
	logger.info(`   Call site: ${result.callSite}`);
	logger.info(`✅ Wrote ${result.modifiedFiles.length} file(s):`);
	for (const file of result.modifiedFiles) {
		logger.info(`   ${file}`);
	}
}

function printExtractComponentDryRun(options: ExtractComponentOptions): void {
	const { file, selector, newFile, json } = options;
	const absolutePath = path.resolve(file);

	let report: ExtractComponentReport;
	try {
		report = locateExtractComponentTarget(absolutePath, selector, newFile);
	} catch (error) {
		logger.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}

	// Free-variable classification (#108) and codegen (#109) require the
	// type-checker, so they only run when the file resolves to a tsconfig
	// project. Degrade gracefully when it doesn't — the locate report is still
	// useful on its own. Codegen is suppressed when extraction is blocked by
	// unliftable hooks.
	let classification: FreeVariableReport | null = null;
	let classificationError: string | null = null;
	let codegen: ComponentCodegenResult | null = null;
	try {
		codegen = buildExtractComponentModule(options);
		classification = analyzeExtractComponentFreeVariables(options);
	} catch (error) {
		classificationError =
			error instanceof Error ? error.message : String(error);
	}
	const generatedModule =
		classification && !classification.blocked
			? (codegen?.moduleText ?? null)
			: null;

	if (json) {
		logger.info(
			JSON.stringify({ ...report, classification, generatedModule }, null, 2)
		);
		return;
	}

	const { located } = report;
	logger.info(
		"\n🧩 extract-component (dry-run — slices 1-3: locate + classify + codegen)"
	);
	logger.info(`   File:     ${report.file}`);
	logger.info(`   Selector: ${report.selector}`);
	logger.info(`   New file: ${report.newFile}`);
	logger.empty();
	logger.info("📍 Target JSX node:");
	logger.info(`   ${describeCandidate(located)}`);
	logger.info(`   kind: ${located.kind}`);
	logger.info(`   span: chars ${located.start}-${located.end}`);
	logger.empty();
	printClassification(classification, classificationError);
	if (generatedModule) {
		logger.info(`🛠️  Generated module (${report.newFile}):`);
		logger.info(generatedModule);
		logger.empty();
	}
	logger.info(
		"Read-only: no files written. The call-site rewrite + tsc verify/rollback (#110) follows."
	);
}

function printClassification(
	classification: FreeVariableReport | null,
	error: string | null
): void {
	if (!classification) {
		logger.info(`🔍 Free-variable analysis skipped: ${error ?? "unavailable"}`);
		logger.empty();
		return;
	}

	const { propCandidates, unliftableHooks, blocked } = classification;
	logger.info("🔍 Free-variable classification:");
	if (propCandidates.length === 0) {
		logger.info("   Prop candidates: none");
	} else {
		logger.info("   Prop candidates:");
		for (const prop of propCandidates) {
			logger.info(`     - ${prop.name}: ${prop.type}`);
		}
	}
	if (unliftableHooks.length > 0) {
		logger.info("   Unliftable hooks (block extraction):");
		for (const hook of unliftableHooks) {
			logger.info(`     - ${hook.name} (from ${hook.derivedFrom})`);
		}
	}
	logger.info(
		blocked
			? "   ⛔ Extraction blocked: subtree references hook-derived values."
			: "   ✅ Extraction safe: no unliftable hooks referenced."
	);
	logger.empty();
}
