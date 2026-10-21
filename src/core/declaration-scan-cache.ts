import type { FunctionInfo, SimilarityGroup } from "../types/similar.ts";
import { mtimesUnchanged } from "./path-utils.ts";

export interface DeclarationScanResult {
	functions: FunctionInfo[];
	totalFiles: number;
}

const MAX_SCAN_CACHE_BYTES = 128 * 1024 * 1024;

interface ScanSnapshot {
	token: object;
	files: string[];
	mtimes: Map<string, number>;
	data: string;
	bytes: number;
	totalFiles: number;
	totalFunctions: number;
	declarationFiles: string[];
	groups?: { key: string; data: string };
}

/** One bounded, immutable scan snapshot. Callers always receive fresh records. */
export class DeclarationScanCache {
	private entry?: ScanSnapshot;
	private readonly owners = new WeakMap<FunctionInfo[], object>();
	private readonly scans = new WeakMap<DeclarationScanResult, object>();
	private readonly byteLimit: number;

	constructor(byteLimit = MAX_SCAN_CACHE_BYTES) {
		this.byteLimit = byteLimit;
	}

	get(files: readonly string[]): DeclarationScanResult | undefined {
		const entry = this.entry;
		if (!entry) {
			return undefined;
		}
		if (
			files.length !== entry.files.length ||
			files.some((file, index) => file !== entry.files[index]) ||
			!mtimesUnchanged(entry.mtimes)
		) {
			this.entry = undefined;
			return undefined;
		}
		let data: string | undefined = entry.data;
		let functions: FunctionInfo[] | undefined;
		const token = entry.token;
		const owners = this.owners;
		const result: DeclarationScanResult = {
			totalFiles: entry.totalFiles,
			get functions() {
				if (!functions) {
					functions = (JSON.parse(data ?? "") as DeclarationScanResult)
						.functions;
					data = undefined;
					owners.set(functions, token);
				}
				return functions;
			},
		};
		this.scans.set(result, token);
		return result;
	}

	/** Metadata lets a repeated report avoid materializing every declaration. */
	getSummary(
		result: DeclarationScanResult,
		groupKey?: string
	):
		| {
				files: readonly string[];
				totalFunctions: number;
		  }
		| undefined {
		const entry = this.entry;
		return entry &&
			this.scans.get(result) === entry.token &&
			(groupKey === undefined || entry.groups?.key === groupKey)
			? {
					files: [...entry.declarationFiles],
					totalFunctions: entry.totalFunctions,
				}
			: undefined;
	}

	getScanGroups(
		result: DeclarationScanResult,
		key: string
	): SimilarityGroup[] | undefined {
		const entry = this.entry;
		if (
			entry &&
			this.scans.get(result) === entry.token &&
			entry.groups?.key === key
		) {
			return JSON.parse(entry.groups.data) as SimilarityGroup[];
		}
		return undefined;
	}

	set(
		files: readonly string[],
		mtimes: Map<string, number>,
		result: DeclarationScanResult
	): void {
		this.entry = undefined;
		const metadataBytes = files.reduce(
			(total, file) => total + file.length * 2 + 128,
			0
		);
		if (metadataBytes > this.byteLimit) {
			return;
		}
		const data = JSON.stringify(result);
		const declarationFiles = [
			...new Set(result.functions.map((fn) => fn.file)),
		];
		const bytes =
			metadataBytes +
			data.length * 2 +
			declarationFiles.reduce((sum, file) => sum + file.length * 2 + 32, 0);
		if (bytes <= this.byteLimit) {
			this.entry = {
				token: {},
				files: [...files],
				mtimes: new Map(mtimes),
				data,
				bytes,
				totalFiles: result.totalFiles,
				totalFunctions: result.functions.length,
				declarationFiles,
			};
			this.owners.set(result.functions, this.entry.token);
			this.scans.set(result, this.entry.token);
		}
	}

	getGroups(
		functions: FunctionInfo[],
		key: string
	): SimilarityGroup[] | undefined {
		const entry = this.entry;
		if (
			entry &&
			this.owners.get(functions) === entry.token &&
			entry.groups?.key === key
		) {
			return JSON.parse(entry.groups.data) as SimilarityGroup[];
		}
		return undefined;
	}

	setGroups(
		functions: FunctionInfo[],
		key: string,
		groups: SimilarityGroup[]
	): void {
		const owner = this.entry;
		if (!owner || this.owners.get(functions) !== owner.token) {
			return;
		}
		owner.groups = undefined;
		const data = JSON.stringify(groups);
		if (owner.bytes + (key.length + data.length) * 2 <= this.byteLimit) {
			owner.groups = { key, data };
		}
	}
}

export const declarationScanCache = new DeclarationScanCache();
