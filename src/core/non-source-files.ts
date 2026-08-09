import path from "node:path";
import type { ProjectConfig } from "../types.ts";
import { partitionGitignored } from "./git.ts";

/**
 * Non-source file detection (#202).
 *
 * resect analyses source. When a project's tsconfig sweeps in build output —
 * easily done, since TypeScript includes everything under the config directory
 * when `include` is absent — every analysis silently reports on files the
 * operator cannot act on. Auditing this repository with its default tsconfig put
 * six bundler chunks in the top eight most-depended-upon modules.
 *
 * The decisive signal is Git: a file excluded from version control is not
 * source. The corroborating signals below never change *whether* a file is
 * excluded — they explain *why*, so the warning can name a cause the operator
 * can fix rather than only a count.
 */

/** Why a file was judged non-source. Ordered most to least specific. */
export type NonSourceReason =
	| "tsconfig-out-dir"
	| "build-output"
	| "dependency"
	| "git-ignored";

export interface NonSourceFile {
	file: string;
	reason: NonSourceReason;
	/** The ignored ancestor directory the file sits under, when it has one. */
	directory: string;
}

export interface NonSourceClassifier {
	classify(file: string): NonSourceFile | undefined;
	/** Every file this classifier would exclude, in input order. */
	readonly excluded: readonly NonSourceFile[];
}

/** A bundler chunk: `index-18kf52eq.js` beside `index.js`. */
const HASHED_CHUNK_PATTERN = /-[a-z0-9]{8,}\.(?:js|mjs|cjs|d\.ts)$/;

const DEPENDENCY_SEGMENT = "node_modules";

function containsSegment(file: string, segment: string): boolean {
	return file.split(path.sep).includes(segment);
}

/**
 * Resolve the configured emit directories for a project, if any. A file under
 * `outDir` or `declarationDir` is output by definition, which is the most
 * specific explanation available.
 */
function emitDirectories(project: ProjectConfig | undefined): string[] {
	if (!project) {
		return [];
	}
	const { outDir, declarationDir } = project.compilerOptions;
	return [outDir, declarationDir]
		.filter((value): value is string => typeof value === "string")
		.map((value) => path.resolve(project.rootDir, value));
}

function attributeReason(
	file: string,
	emitDirs: readonly string[]
): NonSourceReason {
	if (containsSegment(file, DEPENDENCY_SEGMENT)) {
		return "dependency";
	}
	for (const dir of emitDirs) {
		if (file.startsWith(`${dir}${path.sep}`)) {
			return "tsconfig-out-dir";
		}
	}
	if (HASHED_CHUNK_PATTERN.test(path.basename(file))) {
		return "build-output";
	}
	return "git-ignored";
}

/**
 * The ignored directory a file sits under, relative to the scan root. Used so
 * the warning can say "dist/" rather than list 317 paths.
 */
function ignoredDirectoryOf(file: string, scanRoot: string): string {
	const relative = path.relative(scanRoot, file);
	const [first] = relative.split(path.sep);
	return first && first !== ".." ? first : path.dirname(relative);
}

/**
 * Build a classifier over the files Git ignores.
 *
 * Asynchronous because it consults Git once for the whole set; the returned
 * classifier is synchronous so it can be threaded into the pure report builders
 * exactly as `FrameworkGeneratedArtifactClassifier` already is.
 *
 * Returns a classifier that excludes nothing when Git cannot answer — outside a
 * repository, without git installed, or when the operator explicitly targeted an
 * ignored directory. Analysis must never lose files to an inconclusive probe.
 */
export async function createNonSourceClassifier(
	files: readonly string[],
	scanRoot: string,
	project?: ProjectConfig
): Promise<NonSourceClassifier> {
	const { ignored } = await partitionGitignored([...files], scanRoot);
	const emitDirs = emitDirectories(project);
	const byFile = new Map<string, NonSourceFile>();

	for (const file of ignored) {
		byFile.set(file, {
			file,
			reason: attributeReason(file, emitDirs),
			directory: ignoredDirectoryOf(file, scanRoot),
		});
	}

	return {
		classify: (file: string) => byFile.get(file),
		excluded: [...byFile.values()],
	};
}

const REASON_PHRASES: Record<NonSourceReason, string> = {
	"tsconfig-out-dir": "the configured TypeScript output directory",
	"build-output": "build output",
	dependency: "installed dependencies",
	"git-ignored": "git-ignored files",
};

/**
 * Human-readable summary of what was excluded and why.
 *
 * Names the dominant directory and reason rather than a bare count: knowing the
 * files were build output under `dist/` is what tells an operator their tsconfig
 * scope is wrong, where "excluded 317 files" does not.
 */
export function nonSourceWarning(excluded: readonly NonSourceFile[]): string {
	if (excluded.length === 0) {
		return "";
	}
	const byDirectory = new Map<string, NonSourceFile[]>();
	for (const entry of excluded) {
		const group = byDirectory.get(entry.directory) ?? [];
		group.push(entry);
		byDirectory.set(entry.directory, group);
	}
	const [dominantDirectory, dominantFiles] = [...byDirectory.entries()].sort(
		(a, b) => b[1].length - a[1].length
	)[0] ?? ["", []];
	const reason = dominantFiles[0]?.reason ?? "git-ignored";
	const suffix =
		byDirectory.size > 1
			? ` and ${byDirectory.size - 1} other location(s)`
			: "";
	return `Excluded ${excluded.length} non-source file(s) from analysis: ${REASON_PHRASES[reason]} under ${dominantDirectory}/${suffix}. Re-run with --include-ignored to analyse them.`;
}
