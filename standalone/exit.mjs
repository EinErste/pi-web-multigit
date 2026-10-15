/**
 * The exit path every check in this directory shares.
 *
 * `process.exit()` is deliberately not used, and the reason is worth writing down: it tears the process
 * down while undici is still closing the keep-alive sockets its `fetch` calls created. On Windows libuv
 * asserts (`!(handle->flags & UV_HANDLE_CLOSING)` in `src/win/async.c`) and the run ends with exit 127 —
 * a suite that printed "30/30 checks passed" and still failed. Setting `process.exitCode` and letting
 * Node drain exits cleanly, and the server's `close()` calls `closeAllConnections()` so nothing is left
 * holding the loop.
 *
 * The watchdog is diagnostic only: an unref'd timer fires only while something *else* is keeping the
 * loop alive, so it reports a stuck socket without ever being the reason the process stays up.
 */

export function finish({ checks, failures }) {
	console.log(`\n${checks - failures}/${checks} checks passed\n`);
	process.exitCode = failures ? 1 : 0;
	setTimeout(() => {
		// Name what is still open: "a socket" is a guess, `getActiveResourcesInfo()` is the answer.
		const active = process.getActiveResourcesInfo?.() ?? [];
		const counts = active.reduce((acc, name) => acc.set(name, (acc.get(name) ?? 0) + 1), new Map());
		const summary = [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(", ");
		console.log(`… still draining after 20s — still active: ${summary || "(nothing reported)"}`);
	}, 20_000).unref?.();
}