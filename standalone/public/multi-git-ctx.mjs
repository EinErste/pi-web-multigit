/**
 * The `ctx` the client view is mounted with, standalone.
 *
 * `client/entry.mjs` talks to its host through exactly two members — `send(message)` and
 * `onData(handler)` — which is all `client/bridge.mjs` ever used. Inside pi-web-ui those are a plugin
 * channel to the pi-web-ui server; here `send` is `fetch` against this server's `POST /api/<action>`,
 * and `onData` is a listener list fed by those replies.
 *
 * This lives in a module rather than inline in `index.html` on purpose: `standalone/mount-check.mjs`
 * imports it to drive the real client against the real server, so the shim that replaces the host is
 * exercised rather than assumed.
 */

/** The action prefix every reply carries, and the channel the client listens on. */
const PLUGIN_ID = "multi-git";

export function createHttpContext({ baseUrl = "", pluginId = PLUGIN_ID } = {}) {
	const listeners = new Set();
	// A baseUrl that already ends in `/` would otherwise build `//api/...`, which the server does not
	// route (it answers with the asset 404 and the view waits out its own timeout).
	const base = String(baseUrl).replace(/\/+$/, "");

	function deliver(payload) {
		// Copied before iterating: a handler is allowed to unsubscribe itself.
		for (const handler of [...listeners]) {
			try {
				handler(payload);
			} catch (err) {
				console.error("[multi-git] view handler threw", err);
			}
		}
	}

	return {
		async send(message) {
			const action = String(message?.action ?? "");
			try {
				const res = await fetch(`${base}/api/${encodeURIComponent(action)}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(message),
				});
				deliver(await res.json());
			} catch (err) {
				// A dead server has to read as a failed request: the client would otherwise wait out
				// its own timeout instead of showing the error.
				deliver({
					action: `${pluginId}:data`,
					reqId: message?.reqId,
					ok: false,
					kind: "error",
					error: `Local server unreachable: ${err?.message ?? err}`,
				});
			}
		},
		onData(handler) {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
	};
}