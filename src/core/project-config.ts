import path from "node:path";
import { getRuntime } from "../runtime/index.ts";
import {
	loadConfigModule,
	unwrapDefaultConfigModule,
} from "./config-module.ts";

const PREFER_VALUES = new Set(["alias", "relative", "shortest"]);
const DEFAULT_KEYS = new Set([
	"prefer",
	"ignore",
	"verify",
	"transformConfigPath",
]);
const ROOT_KEYS = new Set([...DEFAULT_KEYS, "commands"]);

export const RESECT_CONFIG_CANDIDATES = [
	"resect.config.ts",
	".resect/config.json",
] as const;

export type ProjectPreferStrategy = "alias" | "relative" | "shortest";

export interface ResectConfigDefaults {
	prefer?: ProjectPreferStrategy;
	ignore?: string;
	verify?: boolean;
	transformConfigPath?: string;
}

export interface ResectProjectConfig extends ResectConfigDefaults {
	commands?: Record<string, ResectConfigDefaults>;
}

export interface LoadedResectConfig {
	config: ResectProjectConfig;
	path: string;
	rootDir: string;
}

export interface ResolvedResectConfig extends ResectConfigDefaults {
	configPath?: string;
	rootDir?: string;
}

export async function loadResectConfig(
	startDirectory = process.cwd()
): Promise<LoadedResectConfig | null> {
	const found = await findResectConfig(startDirectory);
	if (!found) {
		return null;
	}

	let raw: unknown;
	if (found.path.endsWith(".json")) {
		const source = await getRuntime().fs.readFile(found.path);
		try {
			raw = JSON.parse(source);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to parse resect config ${found.path}: ${detail}`);
		}
	} else {
		raw = unwrapDefaultConfigModule(
			await loadConfigModule(found.path, "resect config")
		);
	}

	return {
		config: validateResectConfig(raw, found.path),
		path: found.path,
		rootDir: found.rootDir,
	};
}

export function resolveResectConfig(
	loaded: LoadedResectConfig | null,
	command: string
): ResolvedResectConfig {
	if (!loaded) {
		return {};
	}
	const globalDefaults = pickDefaults(loaded.config);
	const commandDefaults = loaded.config.commands?.[command] ?? {};
	const merged = { ...globalDefaults, ...commandDefaults };
	return {
		...merged,
		...(merged.transformConfigPath
			? {
					transformConfigPath: path.resolve(
						loaded.rootDir,
						merged.transformConfigPath
					),
				}
			: {}),
		configPath: loaded.path,
		rootDir: loaded.rootDir,
	};
}

export function validateResectConfig(
	raw: unknown,
	source: string
): ResectProjectConfig {
	const config = validateDefaults(raw, source, ROOT_KEYS);
	const rawCommands = (raw as Record<string, unknown>).commands;
	if (rawCommands === undefined) {
		return config;
	}
	if (!isPlainObject(rawCommands)) {
		throw new Error(
			`Invalid resect config ${source}: "commands" must be an object.`
		);
	}

	const commands: Record<string, ResectConfigDefaults> = {};
	for (const [command, defaults] of Object.entries(rawCommands)) {
		if (command.length === 0) {
			throw new Error(
				`Invalid resect config ${source}: command names must be non-empty.`
			);
		}
		commands[command] = validateDefaults(
			defaults,
			`${source} commands.${command}`,
			DEFAULT_KEYS
		);
	}
	return { ...config, commands };
}

async function findResectConfig(
	startDirectory: string
): Promise<{ path: string; rootDir: string } | null> {
	return findResectConfigFrom(path.resolve(startDirectory));
}

async function findResectConfigFrom(
	directory: string
): Promise<{ path: string; rootDir: string } | null> {
	const rt = getRuntime();
	for (const candidate of RESECT_CONFIG_CANDIDATES) {
		const candidatePath = path.join(directory, candidate);
		if (await rt.fs.exists(candidatePath)) {
			return { path: candidatePath, rootDir: directory };
		}
	}
	const parent = path.dirname(directory);
	return parent === directory ? null : findResectConfigFrom(parent);
}

function validateDefaults(
	raw: unknown,
	source: string,
	allowedKeys: ReadonlySet<string>
): ResectConfigDefaults {
	if (!isPlainObject(raw)) {
		throw new Error(`Invalid resect config ${source}: expected an object.`);
	}
	for (const key of Object.keys(raw)) {
		if (!allowedKeys.has(key)) {
			throw new Error(
				`Invalid resect config ${source}: unknown option "${key}".`
			);
		}
	}

	const result: ResectConfigDefaults = {};
	if (raw.prefer !== undefined) {
		if (typeof raw.prefer !== "string" || !PREFER_VALUES.has(raw.prefer)) {
			throw new Error(
				`Invalid resect config ${source}: "prefer" must be "alias", "relative", or "shortest".`
			);
		}
		result.prefer = raw.prefer as ProjectPreferStrategy;
	}
	if (raw.ignore !== undefined) {
		if (typeof raw.ignore !== "string" || raw.ignore.length === 0) {
			throw new Error(
				`Invalid resect config ${source}: "ignore" must be a non-empty glob string.`
			);
		}
		result.ignore = raw.ignore;
	}
	if (raw.verify !== undefined) {
		if (typeof raw.verify !== "boolean") {
			throw new Error(
				`Invalid resect config ${source}: "verify" must be a boolean.`
			);
		}
		result.verify = raw.verify;
	}
	if (raw.transformConfigPath !== undefined) {
		if (
			typeof raw.transformConfigPath !== "string" ||
			raw.transformConfigPath.length === 0
		) {
			throw new Error(
				`Invalid resect config ${source}: "transformConfigPath" must be a non-empty string.`
			);
		}
		result.transformConfigPath = raw.transformConfigPath;
	}
	return result;
}

function pickDefaults(config: ResectProjectConfig): ResectConfigDefaults {
	const { prefer, ignore, verify, transformConfigPath } = config;
	return {
		...(prefer === undefined ? {} : { prefer }),
		...(ignore === undefined ? {} : { ignore }),
		...(verify === undefined ? {} : { verify }),
		...(transformConfigPath === undefined ? {} : { transformConfigPath }),
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
