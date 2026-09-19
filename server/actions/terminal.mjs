/**
 * The PTY actions: open a shell in a repository, feed it input, resize it, close it.
 */

export function createTerminalActions(ctx) {
	const {
		reply,
		termClose,
		termInput,
		termOpen,
		termPush,
		termResize,
	} = ctx;

	async function onTermOpen(payload, from, reqId) {
		const info = termOpen(from, payload);
		reply(from, { action: "multi-git:data", kind: "term-open", ok: true, reqId, ...info });
		return;
	}

	async function onTermInput(payload, from, reqId) {
		termInput(from, payload);
		reply(from, { action: "multi-git:data", kind: "term-input", ok: true, reqId, repo: payload.repo });
		return;
	}

	async function onTermResize(payload, from, reqId) {
		termResize(from, payload);
		reply(from, { action: "multi-git:data", kind: "term-resize", ok: true, reqId, repo: payload.repo });
		return;
	}

	async function onTermClose(payload, from, reqId) {
		const wasOpen = termClose(from); // ownership is checked there, not here
		reply(from, { action: "multi-git:data", kind: "term-close", ok: true, reqId, exited: wasOpen });
		// Host-style: report the exit ourselves instead of waiting for the PTY's
		// onExit, which Windows node-pty may not fire after a failed kill().
		if (wasOpen) termPush("term-exit", { repo: String(payload.repo ?? ""), exitCode: null });
		return;
	}


	return {
		"multi-git:term-open": onTermOpen,
		"multi-git:term-input": onTermInput,
		"multi-git:term-resize": onTermResize,
		"multi-git:term-close": onTermClose,
	};
}
