import { dlopen, FFIType, ptr } from "bun:ffi";
import { nativePeakRssBytes } from "./native-rss.ts";

// Darwin's native rusage peak includes worker VMs. This diagnostic is opt-in;
// acceptance still uses the parent's resourceUsage() after process exit.
// PROC_PIDTASKINFO from Darwin's sys/proc_info.h: six uint64_t fields
// followed by twelve int32_t fields. The second uint64_t is resident bytes.
const taskInfo = new BigUint64Array(12);
const processInfo =
	process.platform === "darwin"
		? dlopen("/usr/lib/libproc.dylib", {
				proc_pidinfo: {
					args: [
						FFIType.i32,
						FFIType.i32,
						FFIType.u64,
						FFIType.ptr,
						FFIType.i32,
					],
					returns: FFIType.i32,
				},
			})
		: undefined;
const sample = () => {
	const nativeCurrentRssBytes =
		processInfo?.symbols.proc_pidinfo(
			process.pid,
			4,
			0,
			ptr(taskInfo),
			taskInfo.byteLength
		) === taskInfo.byteLength
			? Number(taskInfo[1])
			: null;
	process.stderr.write(
		`${JSON.stringify({ benchmarkMemory: true, time: Date.now(), nativePeakRssBytes: nativePeakRssBytes(), nativeCurrentRssBytes, ...process.memoryUsage() })}\n`
	);
};
sample();
setInterval(sample, 1000).unref();
process.on("beforeExit", sample);
