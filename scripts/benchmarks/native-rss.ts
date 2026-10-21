import { dlopen, FFIType, ptr } from "bun:ffi";

// Bun's own memory/resource counters can understate Darwin RSS. Read the
// kernel's RUSAGE_SELF directly, excluding waited-for subprocesses.
const native =
	process.platform === "darwin" || process.platform === "linux"
		? dlopen(
				process.platform === "darwin"
					? "/usr/lib/libSystem.B.dylib"
					: "libc.so.6",
				{
					getrusage: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
				}
			)
		: undefined;
const usage = new BigInt64Array(18);

export function nativePeakRssBytes(): number | null {
	if (native?.symbols.getrusage(0, ptr(usage)) !== 0) {
		return null;
	}
	return Number(usage[4]) * (process.platform === "darwin" ? 1 : 1024);
}
