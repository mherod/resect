import path from "node:path";
import { logger } from "../cli-logger.ts";
import { getIndexedFileExports } from "../core/export-index.ts";
import { discoverProject } from "../core/tsconfig-discovery.ts";
import {
	discoverWorkspace,
	filterToWorkspaceBoundary,
} from "../core/workspace.ts";
import type { ExportInfo } from "../types/analysis.ts";
import type { ReadOnlyCommandOptions } from "../types/commands.ts";

export interface FindOptions extends ReadOnlyCommandOptions {
	query: string;
	project: string;
	type?: "file" | "export" | "all";
	onlyRelatedTo?: string;
}

export interface FindResult {
	files: FileMatch[];
	exports: ExportMatch[];
}

export interface FileMatch {
	path: string;
	relativePath: string;
	filename: string;
}

export interface ExportMatch {
	file: string;
	relativePath: string;
	export: ExportInfo;
}

/**
 * Serialize a search result to the stable JSON report shape (#141).
 *
 * Shared by the CLI `--json` branch and the MCP `find` tool so both surfaces
 * emit one model rather than maintaining separate payloads.
 */
export function findReportToJson(
	query: string,
	result: FindResult
): {
	query: string;
	files: string[];
	exports: Array<{
		name: string;
		file: string;
		line: number;
		isType: boolean;
		kind: ExportInfo["type"];
	}>;
} {
	return {
		query,
		files: result.files.map((file) => file.relativePath),
		exports: result.exports.map((match) => ({
			name: match.export.name,
			file: match.relativePath,
			line: match.export.line,
			isType: match.export.isType,
			kind: match.export.type,
		})),
	};
}

export async function findCommand(options: FindOptions): Promise<void> {
	const {
		query,
		project,
		type = "all",
		verbose,
		workspace = false,
		onlyRelatedTo,
		json,
	} = options;
	const absoluteProject = path.resolve(project);
	// In JSON mode stdout carries exactly one document, so every human line is
	// suppressed rather than interleaved (#141, stdout purity from #149).
	const emit = (result: FindResult): void => {
		if (json) {
			logger.json(findReportToJson(query, result));
			return;
		}
		printResults(result, absoluteProject, verbose);
	};

	if (workspace) {
		const wsInfo = await discoverWorkspace(absoluteProject);
		if (!wsInfo || wsInfo.packages.length === 0) {
			logger.error("No workspace packages found.");
			process.exit(1);
		}

		// Guard: reject if project path is outside workspace root
		if (
			filterToWorkspaceBoundary([absoluteProject], wsInfo.root).length === 0
		) {
			logger.error(`Project path is outside workspace root: ${wsInfo.root}`);
			process.exit(1);
		}

		if (!json) {
			logger.info(
				`\n🔍 Searching for "${query}" across ${wsInfo.packages.length} workspace package(s)\n`
			);
		}

		const { mapConcurrent } = await import("../core/concurrency.ts");
		const pkgDiscoveries = await mapConcurrent(
			wsInfo.packages,
			async (pkg) => {
				const scanDir = pkg.srcDir ? path.join(pkg.path, pkg.srcDir) : pkg.path;
				return discoverProject(scanDir);
			},
			{ onError: () => ({ fileOwnership: new Map() }) }
		);
		const allFiles = new Map<string, unknown>();
		for (const discovery of pkgDiscoveries) {
			for (const [filePath, owner] of discovery.fileOwnership) {
				allFiles.set(filePath, owner);
			}
		}

		// Filter to workspace boundary
		const boundedPaths = filterToWorkspaceBoundary(
			Array.from(allFiles.keys()),
			wsInfo.root
		);
		const boundedFiles = new Map<string, unknown>();
		for (const fp of boundedPaths) {
			boundedFiles.set(fp, allFiles.get(fp));
		}

		let filesToSearch = boundedFiles;
		if (onlyRelatedTo) {
			const { matchesRelatedPath } = await import("../core/similarity.ts");
			filesToSearch = new Map(
				[...boundedFiles].filter(([fp]) =>
					matchesRelatedPath(fp, onlyRelatedTo)
				)
			);
		}
		const result = search(query, filesToSearch, absoluteProject, type);
		emit(result);
		return;
	}

	if (!json) {
		logger.info(`\n🔍 Searching for "${query}" in ${absoluteProject}\n`);
	}

	const discovery = discoverProject(absoluteProject);

	if (discovery.configs.length === 0) {
		logger.error("No tsconfig.json files found in project.");
		process.exit(1);
	}

	let filesToSearch: Map<string, unknown> = discovery.fileOwnership;
	if (onlyRelatedTo) {
		const { matchesRelatedPath } = await import("../core/similarity.ts");
		filesToSearch = new Map(
			[...discovery.fileOwnership].filter(([fp]) =>
				matchesRelatedPath(fp, onlyRelatedTo)
			)
		);
	}
	const result = search(query, filesToSearch, absoluteProject, type);

	emit(result);
}

export function search(
	query: string,
	fileOwnership: Map<string, unknown>,
	baseDir: string,
	type: "file" | "export" | "all"
): FindResult {
	const files: FileMatch[] = [];
	const exports: ExportMatch[] = [];
	const queryLower = query.toLowerCase();
	const allFiles = Array.from(fileOwnership.keys());

	// Search files by name
	if (type === "file" || type === "all") {
		for (const filePath of allFiles) {
			const filename = path.basename(filePath);
			const filenameWithoutExt = filename.replace(/\.[^.]+$/, "");

			if (
				filename.toLowerCase().includes(queryLower) ||
				filenameWithoutExt.toLowerCase() === queryLower
			) {
				files.push({
					path: filePath,
					relativePath: path.relative(baseDir, filePath),
					filename,
				});
			}
		}
	}

	// Search exports by name
	if (type === "export" || type === "all") {
		for (const filePath of allFiles) {
			// Only scan TypeScript/JavaScript files
			if (!/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(filePath)) {
				continue;
			}

			try {
				const fileExports = getIndexedFileExports(filePath);

				for (const exp of fileExports) {
					if (exp.name.toLowerCase().includes(queryLower)) {
						exports.push({
							file: filePath,
							relativePath: path.relative(baseDir, filePath),
							export: exp,
						});
					}
				}
			} catch {
				// Skip files that can't be parsed
			}
		}
	}

	// Sort results: exact matches first, then alphabetically
	files.sort((a, b) => {
		const aExact =
			a.filename.toLowerCase().replace(/\.[^.]+$/, "") === queryLower;
		const bExact =
			b.filename.toLowerCase().replace(/\.[^.]+$/, "") === queryLower;
		if (aExact && !bExact) {
			return -1;
		}
		if (!aExact && bExact) {
			return 1;
		}
		return a.relativePath.localeCompare(b.relativePath);
	});

	exports.sort((a, b) => {
		const aExact = a.export.name.toLowerCase() === queryLower;
		const bExact = b.export.name.toLowerCase() === queryLower;
		if (aExact && !bExact) {
			return -1;
		}
		if (!aExact && bExact) {
			return 1;
		}
		return a.export.name.localeCompare(b.export.name);
	});

	return { files, exports };
}

function printResults(
	result: FindResult,
	baseDir: string,
	verbose?: boolean
): void {
	const { files, exports } = result;
	const totalResults = files.length + exports.length;

	if (totalResults === 0) {
		logger.info("No matches found.\n");
		return;
	}

	// Files
	if (files.length > 0) {
		logger.info(`📁 Files (${files.length}):`);
		for (const file of files) {
			logger.info(`   ${file.relativePath}`);
		}
		logger.empty();
	}

	// Exports
	if (exports.length > 0) {
		logger.info(`📤 Exports (${exports.length}):`);

		// Group by file for cleaner output
		const byFile = new Map<string, ExportMatch[]>();
		for (const exp of exports) {
			const existing = byFile.get(exp.relativePath) ?? [];
			existing.push(exp);
			byFile.set(exp.relativePath, existing);
		}

		for (const [relativePath, fileExports] of byFile) {
			logger.info(`   ${relativePath}`);
			for (const exp of fileExports) {
				const typeMarker = exp.export.isType ? " (type)" : "";
				const defaultMarker = exp.export.type === "default" ? " [default]" : "";
				logger.info(
					`      • ${exp.export.name}${typeMarker}${defaultMarker} (line ${exp.export.line})`
				);
			}
		}
		logger.empty();
	}

	logger.info(`Found ${totalResults} result(s).\n`);

	const firstFile = files[0];
	if (verbose && firstFile) {
		logger.info("💡 To analyze a file, run:");
		logger.info(`   bun src/cli.ts analyze ${firstFile.path} -p ${baseDir}\n`);
	}
}
