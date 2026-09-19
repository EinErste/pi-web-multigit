/**
 * File-name regex matching, isolated in a worker thread.
 *
 * The pattern is the client's, and a regex engine cannot be interrupted: `(x+x+)+y` against a
 * 30-character path burns over 100 seconds *inside one `test()` call*. On the server's own thread that
 * freezes every conversation and browser tab the host is serving, so the match runs in a worker with a
 * deadline — a pattern that blows the deadline is reported as an error instead of stalling the host,
 * and the worker is torn down because it is stuck by definition.
 *
 * Literal matching needs none of this (`String.includes` is linear), so only regex mode pays for the
 * extra hop. Nothing here is shared with git: git's own regex work already runs in a child process
 * with its own timeout.
 */
import { Worker } from "node:worker_threads";

/** One pattern over one repository's file list must finish inside this. */
export const REGEX_MATCH_TIMEOUT_MS = 3_000;

const WORKER_URL = new URL("./regex-worker.mjs", import.meta.url);

let worker = null;
let seq = 0;
/** request id → { resolve, reject } for the searches in flight. */
const waiting = new Map();

/** A worker is only the current one if it is still `worker`: a torn-down worker's exit must not
 *  disturb the successor that was started while it was dying. */
function failAll(w, err) {
	if (worker !== w) return;
	const pending = [...waiting.values()];
	waiting.clear();
	worker = null;
	for (const entry of pending) entry.reject(err);
}

function ensureWorker() {
	if (worker) return worker;
	const w = new Worker(WORKER_URL);
	w.on("message", (msg) => {
		const entry = waiting.get(msg?.id);
		if (!entry) return;
		waiting.delete(msg.id);
		if (msg.error) entry.reject(new Error(msg.error));
		else entry.resolve(msg.hits ?? []);
	});
	w.on("error", (err) => failAll(w, err instanceof Error ? err : new Error(String(err))));
	w.on("exit", (code) => failAll(w, new Error(`regex worker exited (${code})`)));
	// A finished search must not be the reason the host process cannot exit.
	w.unref?.();
	worker = w;
	return w;
}

async function killWorker() {
	const w = worker;
	worker = null;
	if (w) await w.terminate().catch(() => {});
}

/** Paths from `paths` matching the regex `query`. Rejects when the pattern exceeds the deadline. */
export function matchRegexInWorker(query, flags, paths) {
	return new Promise((resolve, reject) => {
		let w;
		try {
			w = ensureWorker();
		} catch (err) {
			reject(err);
			return;
		}
		const id = ++seq;
		const timer = setTimeout(() => {
			waiting.delete(id);
			void killWorker();
			reject(new Error(`Pattern took longer than ${REGEX_MATCH_TIMEOUT_MS}ms to evaluate — simplify it`));
		}, REGEX_MATCH_TIMEOUT_MS);
		waiting.set(id, {
			resolve: (hits) => {
				clearTimeout(timer);
				resolve(hits);
			},
			reject: (err) => {
				clearTimeout(timer);
				reject(err);
			},
		});
		w.postMessage({ id, query, flags, paths });
	});
}

/** Terminate the worker (plugin deactivate); the next search starts a fresh one. */
export async function stopRegexWorker() {
	const w = worker;
	worker = null;
	const pending = [...waiting.values()];
	waiting.clear();
	for (const entry of pending) entry.reject(new Error("regex worker stopped"));
	if (w) await w.terminate().catch(() => {});
}