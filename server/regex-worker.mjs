/**
 * Worker half of regex-match.mjs: compile the client's pattern once, test it against the file names of
 * one repository, report the hits. Deliberately tiny — everything that can hang happens here, where it
 * can be abandoned (worker.terminate()) without taking the host's event loop with it.
 */
import { parentPort } from "node:worker_threads";

parentPort?.on("message", ({ id, query, flags, paths }) => {
	let re = null;
	try {
		re = new RegExp(query, flags);
	} catch (err) {
		// The server validates the pattern before it gets here; this is the belt to that braces.
		parentPort.postMessage({ id, error: `Invalid regular expression: ${err?.message ?? String(err)}` });
		return;
	}
	const hits = [];
	for (const p of paths) if (re.test(p)) hits.push(p);
	parentPort.postMessage({ id, hits });
});