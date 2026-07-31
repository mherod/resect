/**
 * Represents a text change to be applied to a source file
 */
export interface TextChange {
	/** Start position in the source text */
	start: number;
	/** End position in the source text */
	end: number;
	/** New text to insert at this position */
	newText: string;
}

/**
 * A serializable edit produced by a mutating command preview.
 *
 * `start` and `end` address the original file content. Replacing that span's
 * `oldText` with `newText` reproduces the command's planned file content.
 */
export interface StructuredEdit extends TextChange {
	/** File whose original content the offsets address */
	file: string;
	/** One-based, non-enumerable line metadata used for unified diff rendering */
	line: number;
	/** Original text replaced by this edit */
	oldText: string;
}

export interface SerializedEdit {
	file: string;
	start: number;
	end: number;
	oldText: string;
	newText: string;
}

const lineStartAt = (content: string, position: number): number => {
	if (position <= 0) {
		return 0;
	}
	const previousNewline = content.lastIndexOf("\n", position - 1);
	return previousNewline + 1;
};

const lineEndAt = (content: string, position: number): number => {
	const nextNewline = content.indexOf("\n", position);
	return nextNewline === -1 ? content.length : nextNewline + 1;
};

const countLines = (content: string): number => {
	if (content.length === 0) {
		return 0;
	}
	const newlineCount = content.match(/\n/g)?.length ?? 0;
	return content.endsWith("\n") ? newlineCount : newlineCount + 1;
};

const prefixDiffLines = (prefix: "-" | "+", content: string): string[] => {
	if (content.length === 0) {
		return [];
	}
	const hasFinalNewline = content.endsWith("\n");
	const lines = content.split("\n");
	if (hasFinalNewline) {
		lines.pop();
	}
	const result = lines.map((line) => `${prefix}${line}`);
	if (!hasFinalNewline) {
		result.push("\\ No newline at end of file");
	}
	return result;
};

/**
 * Build one line-aligned structured edit from complete before/after content.
 *
 * The edit is intentionally expanded to line boundaries: it remains directly
 * applicable by character offset while also carrying enough information to
 * render a valid unified-diff hunk without retaining either complete file.
 */
export function createStructuredEdit(
	file: string,
	before: string,
	after: string
): StructuredEdit | undefined {
	if (before === after) {
		return undefined;
	}

	const sharedLength = Math.min(before.length, after.length);
	let commonPrefixLength = 0;
	while (
		commonPrefixLength < sharedLength &&
		before[commonPrefixLength] === after[commonPrefixLength]
	) {
		commonPrefixLength += 1;
	}

	let commonSuffixLength = 0;
	while (
		commonSuffixLength < sharedLength - commonPrefixLength &&
		before[before.length - commonSuffixLength - 1] ===
			after[after.length - commonSuffixLength - 1]
	) {
		commonSuffixLength += 1;
	}

	const start = lineStartAt(before, commonPrefixLength);
	const beforeChangeEnd = before.length - commonSuffixLength;
	const afterChangeEnd = after.length - commonSuffixLength;
	const expandedEnd = lineEndAt(before, beforeChangeEnd);
	const suffixExpansion = expandedEnd - beforeChangeEnd;
	const afterEnd = afterChangeEnd + suffixExpansion;

	const edit: Omit<StructuredEdit, "line"> = {
		file,
		start,
		end: expandedEnd,
		oldText: before.slice(start, expandedEnd),
		newText: after.slice(start, afterEnd),
	};
	Object.defineProperty(edit, "line", {
		value: countLines(before.slice(0, start)) + 1,
		enumerable: false,
	});
	return edit as StructuredEdit;
}

/**
 * Apply structured preview edits to original file content.
 *
 * A stale or mismatched preview is rejected instead of silently replacing a
 * different span.
 */
export function applyStructuredEdits(
	content: string,
	edits: readonly StructuredEdit[]
): string {
	for (const edit of edits) {
		if (content.slice(edit.start, edit.end) !== edit.oldText) {
			throw new Error(
				`Structured edit for ${edit.file} does not match the original content at ${edit.start}-${edit.end}`
			);
		}
	}
	return applyTextChanges(content, edits);
}

/**
 * Render serializable edits as unified-diff file headers and hunks.
 */
export function formatUnifiedDiff(
	edits: readonly StructuredEdit[],
	mapFile: (file: string) => string = (file) => file
): string {
	const hunks: string[] = [];
	for (const edit of edits) {
		const file = mapFile(edit.file);
		const oldLineCount = countLines(edit.oldText);
		const newLineCount = countLines(edit.newText);
		hunks.push(
			`--- a/${file}`,
			`+++ b/${file}`,
			`@@ -${edit.line},${oldLineCount} +${edit.line},${newLineCount} @@`,
			...prefixDiffLines("-", edit.oldText),
			...prefixDiffLines("+", edit.newText)
		);
	}
	return hunks.join("\n");
}

/** Convert internal preview edits to the stable public JSON/MCP schema. */
export function serializeStructuredEdits(
	edits: readonly StructuredEdit[],
	mapFile: (file: string) => string = (file) => file
): SerializedEdit[] {
	return edits.map(({ file, start, end, oldText, newText }) => ({
		file: mapFile(file),
		start,
		end,
		oldText,
		newText,
	}));
}

/**
 * Apply text changes to source content.
 * Changes are sorted in reverse order and applied from end to start
 * to preserve position accuracy.
 *
 * @param content - The original source content
 * @param changes - Array of text changes to apply
 * @returns The modified content with all changes applied
 */
export function applyTextChanges(
	content: string,
	changes: readonly TextChange[]
): string {
	if (changes.length === 0) {
		return content;
	}

	// Sort changes by position descending to maintain accurate positions
	const sorted = [...changes].sort((a, b) => b.start - a.start);

	let result = content;
	for (const change of sorted) {
		result =
			result.slice(0, change.start) + change.newText + result.slice(change.end);
	}

	return result;
}

/**
 * Deduplicate changes by position (same start-end range)
 *
 * @param changes - Array of text changes that may contain duplicates
 * @returns Array with duplicate positions removed (keeps first occurrence)
 */
export function deduplicateChanges(changes: TextChange[]): TextChange[] {
	const seen = new Set<string>();
	return changes.filter((change) => {
		const key = `${change.start}-${change.end}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}
