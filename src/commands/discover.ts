import path from "node:path";
import { logger } from "../cli-logger.ts";
import {
	loadResectConfig,
	type ResectConfigDefaults,
	resolveResectConfig,
} from "../core/project-config.ts";
import {
	discoverProject,
	type ProjectDiscovery,
	type TsConfigInfo,
} from "../core/tsconfig-discovery.ts";
import {
	discoverWorkspace,
	filterToWorkspaceBoundary,
} from "../core/workspace.ts";
import type { ReadOnlyCommandOptions } from "../types/commands.ts";

export interface DiscoverOptions extends ReadOnlyCommandOptions {
	directory: string;
	onlyRelatedTo?: string;
}

/**
 * Serialize a project discovery to the stable JSON report shape (#141).
 *
 * Shared by the CLI `--json` branch and the MCP `discover` tool so both
 * surfaces emit one model rather than maintaining separate payloads.
 */
export function discoveryReportToJson(
	discovery: ProjectDiscovery,
	baseDir: string
): Record<string, unknown> {
	return {
		rootConfig: discovery.rootConfig
			? path.relative(baseDir, discovery.rootConfig.path)
			: null,
		totalFiles: discovery.fileOwnership.size,
		configs: discovery.configs.map((config) => ({
			path: path.relative(baseDir, config.path),
			rootDir: path.relative(baseDir, config.rootDir) || ".",
			isSolution: config.isSolution,
			fileCount: config.files.length,
			extends: config.extends ? path.relative(baseDir, config.extends) : null,
			references: config.references.length,
			pathAliases: Object.fromEntries(config.pathAliases),
		})),
	};
}

export async function discoverCommand(options: DiscoverOptions): Promise<void> {
	const {
		directory,
		verbose,
		workspace = false,
		onlyRelatedTo,
		json,
	} = options;
	const absoluteDir = path.resolve(directory);
	// The resect-config banner is human output on stdout, so JSON mode skips it
	// to keep stdout to exactly one document (#141).
	if (!json) {
		await printResectConfig(absoluteDir);
	}

	if (workspace) {
		const wsInfo = await discoverWorkspace(absoluteDir);
		if (!wsInfo || wsInfo.packages.length === 0) {
			logger.error("No workspace packages found.");
			process.exit(1);
		}

		// Guard: reject if directory is outside workspace root
		if (filterToWorkspaceBoundary([absoluteDir], wsInfo.root).length === 0) {
			logger.error(`Directory is outside workspace root: ${wsInfo.root}`);
			process.exit(1);
		}

		if (!json) {
			logger.info(
				`\n🔍 Discovering tsconfig files across ${wsInfo.packages.length} workspace package(s)\n`
			);
		}

		const { mapConcurrent } = await import("../core/concurrency.ts");
		interface PkgDiscovery {
			pkg: (typeof wsInfo.packages)[number];
			discovery: ProjectDiscovery | null;
		}
		const pkgDiscoveries = await mapConcurrent<
			(typeof wsInfo.packages)[number],
			PkgDiscovery
		>(
			wsInfo.packages,
			async (pkg) => {
				const scanDir = pkg.srcDir ? path.join(pkg.path, pkg.srcDir) : pkg.path;
				return { pkg, discovery: discoverProject(scanDir) };
			},
			{ onError: (pkg) => ({ pkg, discovery: null }) }
		);
		if (json) {
			logger.json({
				workspaceRoot: path.relative(absoluteDir, wsInfo.root) || ".",
				packages: pkgDiscoveries
					.filter((entry) => entry.discovery !== null)
					.map(({ pkg, discovery }) => ({
						name: pkg.name,
						path: path.relative(absoluteDir, pkg.path),
						...discoveryReportToJson(
							discovery as ProjectDiscovery,
							absoluteDir
						),
					})),
			});
			return;
		}

		for (const { pkg, discovery } of pkgDiscoveries) {
			if (!discovery) {
				continue;
			}
			logger.info(`📦 ${pkg.name} (${path.relative(absoluteDir, pkg.path)})`);
			if (onlyRelatedTo) {
				const { matchesRelatedPath } = await import("../core/similarity.ts");
				const filtered = new Map(
					[...discovery.fileOwnership].filter(([fp]) =>
						matchesRelatedPath(fp, onlyRelatedTo)
					)
				);
				printDiscovery(
					{ ...discovery, fileOwnership: filtered },
					absoluteDir,
					verbose
				);
			} else {
				printDiscovery(discovery, absoluteDir, verbose);
			}
		}
		return;
	}

	if (!json) {
		logger.info(`\n🔍 Discovering tsconfig files in ${absoluteDir}\n`);
	}

	const discovery = discoverProject(absoluteDir);

	if (json) {
		logger.json(discoveryReportToJson(discovery, absoluteDir));
		return;
	}

	if (onlyRelatedTo) {
		const { matchesRelatedPath } = await import("../core/similarity.ts");
		const filtered = new Map(
			[...discovery.fileOwnership].filter(([fp]) =>
				matchesRelatedPath(fp, onlyRelatedTo)
			)
		);
		printDiscovery(
			{ ...discovery, fileOwnership: filtered },
			absoluteDir,
			verbose
		);
	} else {
		printDiscovery(discovery, absoluteDir, verbose);
	}
}

async function printResectConfig(baseDir: string): Promise<void> {
	const loaded = await loadResectConfig(baseDir);
	if (!loaded) {
		logger.info("⚙️  Resect config: none (built-in defaults)\n");
		return;
	}

	const relativePath =
		path.relative(baseDir, loaded.path) || path.basename(loaded.path);
	logger.info(`⚙️  Resect config: ${relativePath}`);
	logger.info(
		`   Global: ${formatResectDefaults(resolveResectConfig(loaded, ""))}`
	);

	const commands = Object.keys(loaded.config.commands ?? {}).sort();
	for (const command of commands) {
		logger.info(
			`   ${command}: ${formatResectDefaults(resolveResectConfig(loaded, command))}`
		);
	}
	logger.empty();
}

function formatResectDefaults(defaults: ResectConfigDefaults): string {
	return [
		`prefer=${defaults.prefer ?? "<built-in>"}`,
		`ignore=${defaults.ignore ?? "<built-in>"}`,
		`verify=${defaults.verify ?? "<built-in>"}`,
		`transformConfigPath=${defaults.transformConfigPath ?? "<built-in>"}`,
	].join(", ");
}

function printDiscovery(
	discovery: ProjectDiscovery,
	baseDir: string,
	verbose?: boolean
): void {
	const { configs, fileOwnership, rootConfig } = discovery;

	if (configs.length === 0) {
		logger.info("   No tsconfig.json files found.\n");
		return;
	}

	// Summary
	logger.info(`📦 Found ${configs.length} tsconfig file(s)\n`);

	// Root/solution config
	if (rootConfig) {
		const relativePath = path.relative(baseDir, rootConfig.path);
		logger.info(`🏠 Root config: ${relativePath}`);
		if (rootConfig.isSolution) {
			logger.info("   (solution-style with project references)");
		}
		logger.empty();
	}

	// List each config
	for (const config of configs) {
		printConfigInfo(config, baseDir, verbose);
	}

	// File ownership stats
	const totalFiles = fileOwnership.size;
	logger.info(`\n📊 Total files tracked: ${totalFiles}`);

	if (verbose) {
		// Group files by owning config
		const filesByConfig = new Map<string, string[]>();
		for (const [file, config] of fileOwnership) {
			const existing = filesByConfig.get(config.path) ?? [];
			existing.push(file);
			filesByConfig.set(config.path, existing);
		}

		logger.info("\n📁 Files by config:");
		for (const [configPath, files] of filesByConfig) {
			const relativePath = path.relative(baseDir, configPath);
			logger.info(`\n   ${relativePath} (${files.length} files)`);
			if (files.length <= 10) {
				for (const file of files) {
					logger.info(`      ${path.relative(baseDir, file)}`);
				}
			} else {
				// Show first 5 and last 5
				for (const file of files.slice(0, 5)) {
					logger.info(`      ${path.relative(baseDir, file)}`);
				}
				logger.info(`      ... ${files.length - 10} more ...`);
				for (const file of files.slice(-5)) {
					logger.info(`      ${path.relative(baseDir, file)}`);
				}
			}
		}
	}

	logger.empty();
}

function printConfigInfo(
	config: TsConfigInfo,
	baseDir: string,
	verbose?: boolean
): void {
	const relativePath = path.relative(baseDir, config.path);

	logger.info(`📄 ${relativePath}`);
	logger.info(`   Root: ${path.relative(baseDir, config.rootDir) || "."}`);

	if (config.isSolution) {
		logger.info("   Type: Solution (project references only)");
	} else {
		logger.info(`   Files: ${config.files.length}`);
	}

	if (config.extends) {
		const extendsRel = path.relative(baseDir, config.extends);
		logger.info(`   Extends: ${extendsRel}`);
	}

	if (config.references.length > 0) {
		logger.info(`   References: ${config.references.length}`);
		if (verbose) {
			for (const ref of config.references) {
				const refRel = path.relative(baseDir, ref.path);
				logger.info(`      → ${refRel}`);
			}
		}
	}

	if (verbose) {
		if (config.include.length > 0) {
			logger.info(`   Include: ${config.include.join(", ")}`);
		}
		if (config.exclude.length > 0) {
			logger.info(`   Exclude: ${config.exclude.join(", ")}`);
		}

		// Path aliases
		if (config.pathAliases.size > 0) {
			logger.info("   Path aliases:");
			for (const [alias, paths] of config.pathAliases) {
				logger.info(`      ${alias} → ${paths.join(", ")}`);
			}
		}
	}

	logger.empty();
}
