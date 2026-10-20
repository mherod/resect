import ts from "typescript";
import type { DeclarationKind, FunctionInfo } from "../types/similar.ts";
import {
	countTokens,
	extractAllIdentifiers,
	extractContentTokens,
	normalizeBody,
} from "./similarity-algorithms.ts";

const MIN_TOKEN_COUNT = 8;
const MIN_TYPE_TOKEN_COUNT = 6;
const DIRECTIVE_PATTERN =
	/["']use (cache|cache:\s*\w+|server|client|strict)["']\s*;?/;

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
	tokenCount: number,
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
		tokenCount,
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
			const tokenCount = countTokens(normalized);
			if (tokenCount >= MIN_TOKEN_COUNT) {
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
						tokenCount,
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
					const tokenCount = countTokens(normalized);
					if (tokenCount >= MIN_TOKEN_COUNT) {
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
								tokenCount,
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
			const tokenCount = countTokens(normalized);
			if (tokenCount >= MIN_TYPE_TOKEN_COUNT) {
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
						tokenCount,
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
			const tokenCount = countTokens(normalized);
			if (tokenCount >= MIN_TYPE_TOKEN_COUNT) {
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
						tokenCount,
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

/** Missing/unreadable files retain the existing empty-result policy. */
export async function collectFileFunctions(
	filePath: string
): Promise<FunctionInfo[]> {
	try {
		const content = await Bun.file(filePath).text();
		// Collection walks children and passes source explicitly for text/positions;
		// parent links and the extra traversal needed to populate them are unused.
		const source = ts.createSourceFile(
			filePath,
			content,
			ts.ScriptTarget.Latest,
			false
		);
		return collectFunctions(source, filePath);
	} catch {
		return [];
	}
}
