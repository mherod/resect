import ts from "typescript";
import { parseSourceFile } from "../core/source-file.ts";
import type { MutatingCommandOptions } from "../types.ts";

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

export function describeCandidate(node: LocatedJsxNode): string {
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
