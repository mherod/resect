import { deflateRawSync, inflateRawSync } from "node:zlib";
import type {
	FunctionInfo,
	SimilarityGroup,
	SimilarityReport,
} from "../types/similar.ts";
import { mtimesUnchanged } from "./path-utils.ts";

export interface DeclarationScanResult {
	functions: FunctionInfo[];
	totalFiles: number;
}

const MAX_SCAN_CACHE_BYTES = 128 * 1024 * 1024;
const CACHE_COMPRESSION_LEVEL = 1;

interface ScanSnapshot {
	token: object;
	files: string[];
	mtimes: Map<string, number>;
	data: Uint8Array;
	bytes: number;
	totalFiles: number;
	totalFunctions: number;
	declarationFiles: string[];
	groups?: { key: string; data: Uint8Array };
}

interface ReportSnapshot {
	files: string[];
	mtimes: Map<string, number>;
	key: string;
	data: Uint8Array;
	declarationFiles: string[];
	excludedKey: string;
}

function decodeSnapshot<T>(data: Uint8Array): T {
	return JSON.parse(inflateRawSync(data).toString("utf8")) as T;
}

/** One bounded, immutable scan snapshot. Callers always receive fresh records. */
export class DeclarationScanCache {
	private entry?: ScanSnapshot;
	private reportEntry?: ReportSnapshot;
	private readonly owners = new WeakMap<FunctionInfo[], object>();
	private readonly scans = new WeakMap<DeclarationScanResult, object>();
	private readonly byteLimit: number;

	constructor(byteLimit = MAX_SCAN_CACHE_BYTES) {
		this.byteLimit = byteLimit;
	}

	getReport(files: readonly string[], key: string) {
		const entry = this.reportEntry;
		if (!entry) {
			return undefined;
		}
		if (
			entry.key !== key ||
			files.length !== entry.files.length ||
			files.some((file, index) => file !== entry.files[index]) ||
			!mtimesUnchanged(entry.mtimes)
		) {
			this.reportEntry = undefined;
			return undefined;
		}
		const data = entry.data;
		return {
			declarationFiles: [...entry.declarationFiles],
			excludedKey: entry.excludedKey,
			get report(): SimilarityReport {
				return decodeSnapshot<SimilarityReport>(data);
			},
		};
	}

	setReport(
		files: readonly string[],
		mtimes: Map<string, number>,
		key: string,
		result: {
			report: SimilarityReport;
			declarationFiles: string[];
			excludedKey: string;
		}
	): void {
		// Report and declaration snapshots share one budget, never two caches.
		this.entry = undefined;
		this.reportEntry = undefined;
		const metadataBytes =
			files.reduce((sum, file) => sum + file.length * 2 + 128, 0) +
			result.declarationFiles.reduce(
				(sum, file) => sum + file.length * 2 + 32,
				0
			) +
			(key.length + result.excludedKey.length) * 2;
		if (metadataBytes > this.byteLimit) {
			return;
		}
		const data = JSON.stringify(result.report);
		if (metadataBytes + data.length * 2 > this.byteLimit) {
			return;
		}
		this.reportEntry = {
			files: [...files],
			mtimes: new Map(mtimes),
			key,
			data: deflateRawSync(data, { level: CACHE_COMPRESSION_LEVEL }),
			declarationFiles: [...result.declarationFiles],
			excludedKey: result.excludedKey,
		};
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
		let data: Uint8Array | undefined = entry.data;
		let functions: FunctionInfo[] | undefined;
		const token = entry.token;
		const owners = this.owners;
		const result: DeclarationScanResult = {
			totalFiles: entry.totalFiles,
			get functions() {
				if (!functions) {
					if (!data) {
						throw new Error("Declaration snapshot has no encoded data");
					}
					functions = decodeSnapshot<DeclarationScanResult>(data).functions;
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
			return decodeSnapshot<SimilarityGroup[]>(entry.groups.data);
		}
		return undefined;
	}

	set(
		files: readonly string[],
		mtimes: Map<string, number>,
		result: DeclarationScanResult
	): void {
		this.entry = undefined;
		this.reportEntry = undefined;
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
				// Retain compressed bytes, but keep the original decoded-size
				// admission budget so highly compressible inputs cannot widen it.
				data: deflateRawSync(data, { level: CACHE_COMPRESSION_LEVEL }),
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
			return decodeSnapshot<SimilarityGroup[]>(entry.groups.data);
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
			owner.groups = {
				key,
				data: deflateRawSync(data, { level: CACHE_COMPRESSION_LEVEL }),
			};
		}
	}
}

export const declarationScanCache = new DeclarationScanCache();
