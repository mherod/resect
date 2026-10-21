import path from "node:path";
import type ts from "typescript";
import { fileMtimeMs } from "./path-utils.ts";
import { normalizePath } from "./resolver.ts";

/** Missing resolution probes are stable until a candidate or directory appears. */
export function resolutionInputsUnchanged(
	inputs: Map<string, number>
): boolean {
	for (const [file, previous] of inputs) {
		if (!Object.is(fileMtimeMs(file), previous)) {
			return false;
		}
	}
	return true;
}

/** Track manifests and directory membership without retaining resolver caches. */
export function trackResolutionInputs<T extends ts.ModuleResolutionHost>(
	host: T,
	inputs: Map<string, number>
): T {
	const watch = (file: string) => {
		const normalized = normalizePath(file);
		if (!inputs.has(normalized)) {
			inputs.set(normalized, fileMtimeMs(normalized));
		}
	};
	return {
		...host,
		fileExists(file: string) {
			watch(path.dirname(file));
			return host.fileExists(file);
		},
		readFile(file: string) {
			watch(file);
			watch(path.dirname(file));
			return host.readFile(file);
		},
		directoryExists: host.directoryExists
			? (directory: string) => {
					watch(directory);
					return host.directoryExists?.(directory) ?? false;
				}
			: undefined,
		realpath: host.realpath
			? (file: string) => {
					watch(path.dirname(file));
					return host.realpath?.(file) ?? file;
				}
			: undefined,
	};
}
