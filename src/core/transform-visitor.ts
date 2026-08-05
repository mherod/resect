/**
 * AST node-replacement visitor for `move --transform` (#103 B).
 *
 * Given the declarative `TransformRule[]` loaded by #103 A, this walks the moved
 * file's AST and swaps configured accessor expressions (e.g.
 * `import.meta.env.VITE_API_URL` → `process.env.NEXT_PUBLIC_API_URL`) for their
 * targets. Edits are positional `TextChange`s applied via `applyTextChanges()` —
 * never an AST reserialize — so surrounding layout and business logic are
 * untouched (matching the `alias` command's safety model).
 *
 * Matching is by exact normalised source text on property/element access nodes:
 * a rule's `from` only equals the one node whose full accessor text matches, so
 * a longer enclosing access (`…X.foo`) and a shorter inner access (`import.meta`)
 * never collide, and ranges never overlap. Import normalization of rewritten
 * refs + `tsc` verify/rollback are out of scope here — they land in #103 C.
 */

import ts from "typescript";
import type { TransformRewrite, TransformRule } from "../types/transform.ts";
import { createSourceFileFromText } from "./source-file.ts";
import {
	applyTextChanges,
	deduplicateChanges,
	type TextChange,
} from "./text-changes.ts";
import { normalizeTransformAccessor } from "./transform-config.ts";

/**
 * A node whose source text can represent a dotted accessor we may rewrite. We
 * deliberately restrict to property/element access expressions: a declarative
 * `from` like `import.meta.env.X` always parses with one of these at its root,
 * and excluding bare identifiers avoids rewriting unrelated declaration names.
 */
function isRewritableAccessor(node: ts.Node): boolean {
	return (
		ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
	);
}

/**
 * Compute the positional rewrites for `rules` against a parsed source file.
 * Returns deduped `TextChange`s plus a `TransformRewrite[]` describing each match
 * for reporting (line numbers are 1-based). Pure — performs no I/O.
 */
export function planTransformRewrites(
	sourceFile: ts.SourceFile,
	rules: TransformRule[]
): { changes: TextChange[]; rewrites: TransformRewrite[] } {
	const changes: TextChange[] = [];
	const rewrites: TransformRewrite[] = [];
	if (rules.length === 0) {
		return { changes, rewrites };
	}

	const ruleByFrom = new Map<string, TransformRule>();
	for (const rule of rules) {
		ruleByFrom.set(normalizeTransformAccessor(rule.from), rule);
	}

	const visit = (node: ts.Node): void => {
		if (isRewritableAccessor(node)) {
			const rule = ruleByFrom.get(
				normalizeTransformAccessor(node.getText(sourceFile))
			);
			if (rule) {
				const start = node.getStart(sourceFile);
				changes.push({ start, end: node.getEnd(), newText: rule.to });
				const { line } = sourceFile.getLineAndCharacterOfPosition(start);
				rewrites.push({
					from: rule.from,
					to: rule.to,
					line: line + 1,
					file: sourceFile.fileName,
				});
				// A matched accessor is replaced whole; its children are subsumed.
				return;
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);

	return { changes: deduplicateChanges(changes), rewrites };
}

/**
 * Apply `rules` to `content`, returning the rewritten text and the rewrites
 * performed. When no rule matches (or `rules` is empty) the original `content`
 * is returned unchanged — a move with no matching accessor is byte-for-byte
 * identical to today.
 */
export function applyTransformRules(
	content: string,
	fileName: string,
	rules: TransformRule[]
): { content: string; rewrites: TransformRewrite[] } {
	if (rules.length === 0) {
		return { content, rewrites: [] };
	}
	const sourceFile = createSourceFileFromText(fileName, content);
	const { changes, rewrites } = planTransformRewrites(sourceFile, rules);
	if (changes.length === 0) {
		return { content, rewrites };
	}
	return { content: applyTextChanges(content, changes), rewrites };
}
