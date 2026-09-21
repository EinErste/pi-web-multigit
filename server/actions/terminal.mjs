/**
 * The PTY actions: open a shell in a repository, feed it input, resize it, close it.
 */

export function createTerminalActions(ctx) {
	const {
		reply,
		termAttach,
		termClear,
		termClose,
		termDetach,
		termInput,
		termOpen,
		termPush,
		termResize,
		termSync,
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
		const entry = termClose(from, payload); // ownership is checked there, not here
		reply(from, { action: "multi-git:data", kind: "term-close", ok: true, reqId, exited: !!entry });
		// Host-style: report the exit ourselves instead of waiting for the PTY's onExit, which Windows
		// node-pty may not fire after a failed kill(). The entry is passed along so the push reaches the
		// client that was driving that shell — not whichever one happens to hold the pane now.
		if (entry) termPush("term-exit", { repo: String(payload.repo ?? ""), exitCode: null }, entry);
		return;
	}

	/** What a (re)mounting client renders: the retained window, and whether a shell is behind it. */
	async function onTermAttach(payload, from, reqId) {
		reply(from, { action: "multi-git:data", kind: "term-attach", ok: true, reqId, ...termAttach(from, payload) });
		return;
	}

	/** Cursor handshake: the replay landed, so stream from there — and hand back what arrived during it. */
	async function onTermSync(payload, from, reqId) {
		reply(from, { action: "multi-git:data", kind: "term-sync", ok: true, reqId, ...termSync(from, payload) });
		return;
	}

	/** Unmount: keep the shell running and release the seat so the next client can adopt it. */
	async function onTermDetach(payload, from, reqId) {
		reply(from, { action: "multi-git:data", kind: "term-detach", ok: true, reqId, ...termDetach(from, payload) });
		return;
	}

	/** The strip's clear button: forget the retained output too, so a remount cannot resurrect it. */
	async function onTermClear(payload, from, reqId) {
		reply(from, { action: "multi-git:data", kind: "term-clear", ok: true, reqId, ...termClear(from, payload) });
		return;
	}


	return {
		"multi-git:term-attach": onTermAttach,
		"multi-git:term-clear": onTermClear,
		"multi-git:term-close": onTermClose,
		"multi-git:term-detach": onTermDetach,
		"multi-git:term-input": onTermInput,
		"multi-git:term-open": onTermOpen,
		"multi-git:term-resize": onTermResize,
		"multi-git:term-sync": onTermSync,
	};
}
