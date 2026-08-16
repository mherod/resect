import { describe, expect, test } from "bun:test";
import path from "node:path";

/**
 * Enforcement guard for the #221 refactor (closing phase, #228).
 *
 * Phases A–E migrated every mutating command onto `runMutation`, which is now
 * the single owner of the sequence: worktree guard -> journal prepare -> apply
 * (under the typecheck guard) -> rollback-or-journal-complete. That property is
 * only worth the migration if it cannot silently regress, so this test asserts
 * the invariant instead of trusting a one-time grep: the raw primitives have no
 * importers under `src/commands/` or `src/mcp-tools/` beyond a small, justified
 * allowlist.
 *
 * When this fails, the fix is almost always "route the new call site through
 * `runMutation`" — not "add an allowlist entry". Add an entry only when the
 * call site is a genuine dependency-injection seam whose default cannot be
 * reached from the MCP server, and say why in `reason`.
 *
 * Note on scope: `runWithWorkspaceTypecheckGuard` is deliberately NOT guarded.
 * It exists solely to be handed to `runMutation` as a DI override (alias's
 * workspace mode, undo's injectable typecheck seam), and unlike the symbols
 * below it composes no guard and no journal, so it cannot reintroduce the
 * ordering bug this refactor eliminated.
 */

const SRC_ROOT = path.resolve(import.meta.dir, "..");

/** Modules that define the mutation primitives the pipeline is meant to own. */
const PRIMITIVE_MODULE_BASENAMES = ["git.ts", "journal.ts", "verify.ts"];

/**
 * Symbols only `core/mutation-pipeline.ts` may compose. `ensureCleanWorktree`
 * and `ensureRollbackSafeWorktree` call `process.exit`, which would terminate
 * the `resect-mcp` server; the journal pair and the typecheck guard must stay
 * ordered relative to the guard, which is exactly what the pipeline encodes.
 */
const PIPELINE_OWNED_PRIMITIVES = [
	"ensureCleanWorktree",
	"ensureRollbackSafeWorktree",
	"prepareOperationJournal",
	"completeOperationJournal",
	"runWithTypecheckGuard",
	"verifyTypeChecking",
];

/** Repo-relative path -> the primitives it may import, with justification. */
const ALLOWLIST: Record<string, { primitives: string[]; reason: string }> = {
	"commands/move-batch.ts": {
		primitives: ["ensureRollbackSafeWorktree", "runWithTypecheckGuard"],
		reason:
			"Public MoveBatchDependencies injection seam (#225). These are the DEFAULT implementations of an injectable contract, not a hand-rolled sequence: move-batch adapts them into runMutation's own DI parameter, and moveBatchTool always overrides ensureRollbackSafeWorktree with a non-exiting variant, so the exiting default is unreachable from the MCP server. NOT fully clean: the library-exported moveBatch() still reaches that exiting default, so this exemption is temporary — tracked by #229, which removes it and empties this allowlist.",
	},
};

function parseNamedImports(source: string): Map<string, Set<string>> {
	const pattern =
		/import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g;
	const byModule = new Map<string, Set<string>>();
	let match = pattern.exec(source);
	while (match) {
		const [, clause = "", specifier = ""] = match;
		const names = byModule.get(specifier) ?? new Set<string>();
		for (const raw of clause.split(",")) {
			// `type Foo`, `Foo as Bar`, and plain `Foo` all reduce to the imported name.
			const imported = raw
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/)[0];
			if (imported) {
				names.add(imported.trim());
			}
		}
		byModule.set(specifier, names);
		match = pattern.exec(source);
	}
	return byModule;
}

/** Primitive names a file imports from `src/core/{git,journal,verify}.ts`. */
function primitiveImports(source: string): Set<string> {
	const found = new Set<string>();
	for (const [specifier, names] of parseNamedImports(source)) {
		const fromPrimitiveModule =
			specifier.includes("core/") &&
			PRIMITIVE_MODULE_BASENAMES.some((basename) =>
				specifier.endsWith(`/${basename}`)
			);
		if (!fromPrimitiveModule) {
			continue;
		}
		for (const name of names) {
			found.add(name);
		}
	}
	return found;
}

/** The single seam both the repo scan and the self-test below exercise. */
function findViolations(relativePath: string, source: string): string[] {
	const imported = primitiveImports(source);
	const allowed = new Set(ALLOWLIST[relativePath]?.primitives ?? []);
	return PIPELINE_OWNED_PRIMITIVES.filter(
		(primitive) => imported.has(primitive) && !allowed.has(primitive)
	).map((primitive) => `${relativePath} imports ${primitive}`);
}

async function surfaceFiles(): Promise<string[]> {
	const files: string[] = [];
	for (const directory of ["commands", "mcp-tools"]) {
		const glob = new Bun.Glob("**/*.ts");
		for await (const relative of glob.scan({
			cwd: path.join(SRC_ROOT, directory),
		})) {
			if (!relative.endsWith(".test.ts")) {
				files.push(`${directory}/${relative}`);
			}
		}
	}
	return files.sort();
}

describe("mutation pipeline is the only composer of mutation primitives", () => {
	// Proves the detector actually detects. Without this the repo scan could go
	// green because the parser silently matched nothing.
	test("detects a direct primitive import, and respects the allowlist", () => {
		const offending = [
			'import path from "node:path";',
			'import { ensureCleanWorktree, isWorktreeDirty } from "../core/git.ts";',
			'import {\n\tprepareOperationJournal,\n} from "../core/journal.ts";',
		].join("\n");

		expect(findViolations("commands/pretend.ts", offending)).toEqual([
			"commands/pretend.ts imports ensureCleanWorktree",
			"commands/pretend.ts imports prepareOperationJournal",
		]);

		// Non-guarded neighbours from the same modules must not trip it.
		expect(
			findViolations(
				"commands/pretend.ts",
				'import { checkRollbackSafeWorktree, isWorktreeDirty } from "../core/git.ts";'
			)
		).toEqual([]);

		// An allowlisted file is exempt only for the primitives it declares.
		expect(
			findViolations(
				"commands/move-batch.ts",
				'import { ensureRollbackSafeWorktree } from "../core/git.ts";'
			)
		).toEqual([]);
		expect(
			findViolations(
				"commands/move-batch.ts",
				'import { ensureCleanWorktree } from "../core/git.ts";'
			)
		).toEqual(["commands/move-batch.ts imports ensureCleanWorktree"]);
	});

	test("no command or MCP tool imports a pipeline-owned primitive", async () => {
		const files = await surfaceFiles();
		// Guard the guard: a glob that silently matched nothing would make this
		// test vacuously green.
		expect(files.length).toBeGreaterThan(20);

		const violations: string[] = [];
		for (const relative of files) {
			const source = await Bun.file(path.join(SRC_ROOT, relative)).text();
			violations.push(...findViolations(relative, source));
		}

		expect(violations).toEqual([]);
	});

	test("no MCP tool calls process.exit", async () => {
		// A stdio MCP server dies with the process. `#221` traced several bugs to
		// primitives that exit, so the tool layer must stay exit-free even as new
		// tools are added. Comments mentioning the hazard are allowed.
		const offenders: string[] = [];
		const glob = new Bun.Glob("**/*.ts");
		let scanned = 0;
		for await (const relative of glob.scan({
			cwd: path.join(SRC_ROOT, "mcp-tools"),
		})) {
			if (relative.endsWith(".test.ts")) {
				continue;
			}
			scanned += 1;
			const source = await Bun.file(
				path.join(SRC_ROOT, "mcp-tools", relative)
			).text();
			const code = source
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/(^|[^:])\/\/.*$/gm, "$1");
			if (code.includes("process.exit(")) {
				offenders.push(`mcp-tools/${relative}`);
			}
		}
		expect(scanned).toBeGreaterThan(2);
		expect(offenders).toEqual([]);
	});

	test("the pipeline itself still composes every primitive it owns", async () => {
		// The inverse assertion: if these moved out of the pipeline, the scan
		// above would pass for the wrong reason.
		const pipeline = await Bun.file(
			path.join(SRC_ROOT, "core/mutation-pipeline.ts")
		).text();
		for (const primitive of [
			"checkRollbackSafeWorktree",
			"prepareOperationJournal",
			"completeOperationJournal",
			"runWithTypecheckGuard",
		]) {
			expect(pipeline).toContain(primitive);
		}
	});

	test("every allowlist entry is still real and still needed", async () => {
		for (const [relative, entry] of Object.entries(ALLOWLIST)) {
			const file = Bun.file(path.join(SRC_ROOT, relative));
			expect(await file.exists()).toBe(true);
			const imported = primitiveImports(await file.text());
			// A stale exemption is worse than none: it silently re-opens the door.
			for (const primitive of entry.primitives) {
				expect(imported.has(primitive)).toBe(true);
			}
			expect(entry.reason.length).toBeGreaterThan(40);
		}
	});
});
