import { dlopen, FFIType, ptr } from "bun:ffi";

// Darwin's native rusage peak includes worker VMs. This diagnostic is opt-in;
// acceptance still uses the parent's resourceUsage() after process exit.
const native =
	process.platform === "darwin"
		? dlopen("/usr/lib/libSystem.B.dylib", {
				getrusage: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
			})
		: undefined;
const usage = new BigInt64Array(18);
const sample = () => {
	const nativePeakRssBytes =
		native?.symbols.getrusage(0, ptr(usage)) === 0 ? Number(usage[4]) : null;
	process.stderr.write(
		`${JSON.stringify({ benchmarkMemory: true, time: Date.now(), nativePeakRssBytes, ...process.memoryUsage() })}\n`
	);
};
sample();
setInterval(sample, 1000).unref();
process.on("beforeExit", sample);
