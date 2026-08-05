/**
 * Pure algorithm primitives for similarity detection.
 * No I/O, no async, no TypeScript Compiler API — fully unit-testable in isolation.
 */

const JS_KEYWORDS = new Set([
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"default",
	"delete",
	"do",
	"else",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"let",
	"new",
	"null",
	"return",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"undefined",
	"var",
	"void",
	"while",
	"with",
	"yield",
	"async",
	"await",
	"of",
	"from",
	"as",
	"type",
	"interface",
	"enum",
	"implements",
	"declare",
	"abstract",
	"readonly",
	"override",
]);

/**
 * Extract all non-keyword identifier tokens from a body text.
 *
 * Unlike `extractContentTokens`, this captures every identifier including
 * camelCase property names — useful for type/interface bodies where field
 * names are the primary differentiator between structurally similar shapes.
 * For example, `{ _seconds: number }` and `{ seconds: number }` normalise to
 * the same shape, but this function produces `["_seconds", "number"]` vs
 * `["seconds", "number"]`, giving a lower content similarity score.
 */
export function extractAllIdentifiers(bodyText: string): string[] {
	let s = bodyText.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
	const tokens: string[] = [];
	// Keep string and template literal VALUES as tokens. A type alias body is
	// the right-hand side only, so a string-literal union carries no identifiers
	// at all — dropping its literals leaves an empty fingerprint, and two empty
	// fingerprints are indistinguishable from two identical ones. The literals
	// are the domain content for these declarations.
	for (const m of s.matchAll(
		/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g
	)) {
		tokens.push(m[0].slice(1, -1));
	}
	// Remove literals before extracting identifiers so quoted text is not
	// re-matched as an identifier.
	s = s
		.replace(/`(?:[^`\\]|\\.)*`/g, " ")
		.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, " ");
	for (const m of s.matchAll(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g)) {
		if (!JS_KEYWORDS.has(m[0])) {
			tokens.push(m[0]);
		}
	}
	return tokens;
}

/**
 * Extract semantic content tokens from a function body: uppercase identifiers
 * (constants, types, enum members) and string literal values. These carry
 * domain-specific meaning that normalization strips away.
 *
 * Used to detect structural coincidences: two functions with identical
 * normalized bodies but different content tokens are unlikely to be genuine
 * duplicates (e.g. `KEBAB_CASE_REGEX.test(s)` vs `HOOK_NAMING_REGEX.test(s)`).
 */
export function extractContentTokens(bodyText: string): string[] {
	// Remove comments
	let s = bodyText.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

	const tokens: string[] = [];

	// Extract string and template literal values (strip surrounding quotes)
	for (const m of s.matchAll(
		/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g
	)) {
		tokens.push(m[0].slice(1, -1));
	}

	// Remove literals before extracting identifiers to avoid matching quoted text
	s = s
		.replace(/`(?:[^`\\]|\\.)*`/g, " ")
		.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, " ");

	// Extract identifiers starting with an uppercase letter (constants, types,
	// enum members — these carry semantic intent unlike local camelCase vars)
	for (const m of s.matchAll(/\b[A-Z][a-zA-Z0-9_$]*\b/g)) {
		tokens.push(m[0]);
	}

	// Extract camelCase identifiers in call positions (followed by `(`).
	// These are function/method call targets that carry semantic meaning —
	// e.g. `runBashHook(...)` vs `runFileEditHook(...)` should produce
	// different content tokens even though normalization replaces both with $I.
	for (const m of s.matchAll(/\b([a-z][a-zA-Z0-9_$]*)\s*\(/g)) {
		if (m[1] && !JS_KEYWORDS.has(m[1])) {
			tokens.push(m[1]);
		}
	}

	return tokens;
}

/**
 * Normalize a function body text by replacing identifiers, string literals,
 * and numeric literals with stable placeholders. Structural tokens (keywords,
 * punctuation) are preserved so that the shape of the body is captured.
 */
export function normalizeBody(text: string): string {
	// Remove line comments
	let s = text.replace(/\/\/[^\n]*/g, "");
	// Remove block comments
	s = s.replace(/\/\*[\s\S]*?\*\//g, "");
	// Replace template literals (before string literals to avoid overlap)
	s = s.replace(/`(?:[^`\\]|\\.)*`/g, "$S");
	// Replace string literals
	s = s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "$S");
	// Replace numeric literals (must come before identifier replacement)
	s = s.replace(/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, "$N");
	// Replace non-keyword identifiers with $I.
	// The lookbehind (?<!\$) prevents re-replacing the S/N in already-placed $S/$N.
	s = s.replace(/(?<!\$)\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g, (match) =>
		JS_KEYWORDS.has(match) ? match : "$I"
	);
	// Collapse whitespace
	s = s.replace(/\s+/g, " ").trim();
	return s;
}

/**
 * Tokenize a normalized body into individual tokens.
 * Handles placeholders ($I, $S, $N), keywords/identifiers, and punctuation.
 */
export function tokenize(normalized: string): string[] {
	return (
		normalized.match(/\$[ISN]|[a-zA-Z_$][a-zA-Z0-9_$]*|\d+|[^\s\w$]/g) ?? []
	);
}

/**
 * Build bigrams (adjacent token pairs) from a token array.
 * Captures local ordering so that functions with the same token vocabulary
 * but different structure produce different bigram sets.
 */
export function tokenBigrams(tokens: string[]): string[] {
	const bigrams: string[] = [];
	for (let i = 0; i < tokens.length - 1; i++) {
		bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
	}
	return bigrams;
}

/**
 * Compute Jaccard similarity between two string arrays using set intersection.
 * Returns 1.0 for two empty inputs (treat as identical).
 */
export function jaccardSimilarity(a: string[], b: string[]): number {
	if (a.length === 0 && b.length === 0) {
		return 1;
	}
	const setA = new Set(a);
	const setB = new Set(b);
	let intersection = 0;
	for (const token of setA) {
		if (setB.has(token)) {
			intersection++;
		}
	}
	const union = setA.size + setB.size - intersection;
	return union === 0 ? 1 : intersection / union;
}

/**
 * Split a camelCase or PascalCase identifier into lowercase tokens.
 * E.g., "makeTempDir" → ["make", "temp", "dir"],
 *       "XMLParser" → ["xml", "parser"].
 */
export function camelCaseTokenize(name: string): string[] {
	return name
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[\s_]+/)
		.filter(Boolean);
}

/**
 * Compute name similarity between two function names using Jaccard on
 * camelCase tokens. Returns 1.0 for identical names, 0.0 for completely
 * different names.
 */
export function nameSimilarity(a: string, b: string): number {
	if (a === b) {
		return 1;
	}
	const tokensA = camelCaseTokenize(a);
	const tokensB = camelCaseTokenize(b);
	return jaccardSimilarity(tokensA, tokensB);
}
