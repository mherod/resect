import path from "node:path";
import ts from "typescript";
import {
	createProgram,
	loadProject,
	resolveTsConfig,
} from "../core/project.ts";
import {
	type ExtractComponentOptions,
	resolveJsxTsNode,
} from "./extract-component-locate.ts";

/** A free identifier that becomes a prop on the extracted component. */
export interface PropCandidate {
	/** Identifier name as it appears in the subtree. */
	name: string;
	/** Resolved type string, suitable for Props-interface codegen. */
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
