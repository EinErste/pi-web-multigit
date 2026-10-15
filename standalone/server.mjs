/**
 * multi-git standalone server — the pi-web-ui plugin, served over plain HTTP.
 *
 * The plugin is not forked here. `standalone/host.mjs` satisfies the host interface that
 * `../index.mjs` was written against, so the plugin's own discovery, git plumbing, parsers and view
 * actions run unchanged; this file adds two things the pi-web-ui host used to provide:
 *
 *   1. transport — the plugin's replies travel over `host.sendTo`, which we turn into the HTTP
 *      response body of `POST /api/multi-git:<action>`;
 *   2. static serving — `/` and `/client/*`, so `client/entry.mjs` loads from the same directory the
 *      plugin ships.
 *
 * The terminal is pi-web-ui-only: it is fed by `host.broadcast` over a socket, which a
 * request/response server cannot carry, so this server does not implement it.
 *
 * The client is untouched: `standalone/public/index.html` hands `entry.mjs` a `ctx` whose `send` is
 * `fetch`.
 *
 * Read-only, loopback-only, no npm dependencies.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createStandaloneHost } from "./host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, "..");
const CLIENT_DIR = join(PLUGIN_DIR, "client");
const PUBLIC_DIR = join(HERE, "public");

/** Long enough for a cold scan of a dozen repositories on a network drive. */
const REQUEST_TIMEOUT_MS = 120_000;

/** A JSON body bigger than this is not one of our requests. */
const BODY_MAX_BYTES = 1024 * 1024;

const MIME = new Map([
	[".html", "text/html; charset=utf-8"],
	[".mjs", "text/javascript; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".css", "text/css; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".map", "application/json; charset=utf-8"],
	[".svg", "image/svg+xml"],
	[".ico", "image/x-icon"],
	[".png", "image/png"],
	[".woff2", "font/woff2"],
]);

function contentTypeFor(path) {
	const dot = path.lastIndexOf(".");
	return (dot >= 0 && MIME.get(path.slice(dot).toLowerCase())) || "application/octet-stream";
}

/**
 * Resolve a request path inside a served directory. Both `/client/*` and the public assets are
 * reachable by URL, so `..` has to die here rather than at the filesystem.
 */
function safeJoin(baseDir, urlPath) {
	let clean;
	try {
		clean = String(urlPath ?? "").split("?")[0].split("#")[0];
		clean = decodeURIComponent(clean);
	} catch {
		return null; // malformed percent-encoding
	}
	const abs = resolve(baseDir, `.${clean.replace(/\\/g, "/").startsWith("/") ? clean.replace(/\\/g, "/") : `/${clean}`}`);
	const rel = relative(baseDir, abs);
	if (rel.startsWith("..") || isAbsolute(rel)) return null;
	return abs;
}

async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > BODY_MAX_BYTES) throw new Error("Request body too large");
		chunks.push(chunk);
	}
	if (!chunks.length) return {};
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (!text) return {};
	const parsed = JSON.parse(text);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Body must be a JSON object");
	return parsed;
}

/**
 * Start the dashboard. `port: 0` (the default) lets the OS pick a free one, which is what the pi
 * extension wants: session-scoped, one server, no port collisions with anything else.
 */
export async function startMultigitServer({
	root,
	port = 0,
	hostname = "127.0.0.1",
	// Deliberately the plugin root: that is where pi-web-ui keeps `storage.json`, so the standalone view
	// opens on the same favourites, order, pivot and folded segments you left it in beside the browser UI.
	dataDir = PLUGIN_DIR,
	settings = {},
	logger = console,
} = {}) {
	if (!root || typeof root !== "string") throw new Error("startMultigitServer needs a workspace root");
	const workspaceRoot = resolve(root);

	// The plugin module, loaded exactly as the pi-web-ui host loads it.
	const { default: plugin } = await import(new URL("../index.mjs", import.meta.url).href);
	if (!plugin || typeof plugin.activate !== "function") {
		throw new Error("standalone: ../index.mjs did not export a plugin with activate(host)");
	}

	const pending = new Map();
	let seq = 0;

	const { host, deliver, stateFile } = createStandaloneHost({
		root: workspaceRoot,
		dataDir,
		settings,
		logger,
		onReply: (msg) => {
			const settle = pending.get(msg?.reqId);
			if (!settle) return; // a reply for a request that already timed out
			pending.delete(msg.reqId);
			clearTimeout(settle.timer);
			settle.resolve(msg);
		},
	});

	await plugin.activate(host);

	/**
	 * One plugin action → its reply, matched by the correlation id of the *request*.
	 *
	 * Two separate numbering schemes meet here and neither can be trusted as a key:
	 *
	 *   - `client/bridge.mjs` numbers its requests from 1 and matches replies against that number, and it
	 *     starts over at 1 on every page load — after a refresh its ids overlap the ones it used before;
	 *   - two pages open at once both count 1, 2, 3…, so the same id can belong to two live requests.
	 *
	 * Correlating on the caller's number therefore drops or misdelivers replies (a refreshed page stays
	 * empty until its 60s timeout; one page can be handed the other's payload). So the plugin is given an id
	 * this server never reuses, and the caller's own id is put back on the reply it receives. The plugin
	 * itself only has to echo the id it was handed, exactly as it does under pi-web-ui.
	 */
	async function dispatch(action, extra = {}) {
		// A number, not a string: the plugin only preserves a numeric `reqId` on its reply, and the reply is
		// matched back to this request by that id. Keys are unique for the lifetime of the server.
		const key = ++seq;
		const callerReqId = extra?.reqId;

		const answer = new Promise((resolveReply) => {
			const timer = setTimeout(() => {
				if (pending.get(key)?.resolve === resolveReply) pending.delete(key);
				resolveReply({ action: `${prefix(action)}:data`, ok: false, kind: "error", error: "Request timed out" });
			}, REQUEST_TIMEOUT_MS);
			if (typeof timer.unref === "function") timer.unref();
			pending.set(key, { resolve: resolveReply, timer });
		});

		// `action` and `reqId` come last, so a body can neither redirect the request nor forge its id.
		await deliver({ ...extra, action, reqId: key }, "http");
		const reply = await answer;

		// Hand back the id the caller used: it is the only one the client knows how to match on.
		if (callerReqId === undefined || reply?.reqId !== key) return reply;
		return { ...reply, reqId: callerReqId };
	}

	const prefix = (action) => String(action).split(":")[0] || "multi-git";

	const send = (res, status, body, type = "application/json; charset=utf-8") => {
		res.writeHead(status, {
			"content-type": type,
			"cache-control": "no-store", // the client bundle is edited in place; a cached entry.mjs would lie
			"x-content-type-options": "nosniff",
		});
		res.end(body);
	};

	const sendJson = (res, status, value) => send(res, status, JSON.stringify(value));

	async function serveFile(res, path) {
		let body;
		try {
			body = await readFile(path);
		} catch {
			sendJson(res, 404, { ok: false, error: `Not found: ${path}` });
			return;
		}
		send(res, 200, body, contentTypeFor(path));
	}

	const server = createServer(async (req, res) => {
		try {
			const pathname = decodeURIComponent(String(req.url ?? "/").split("?")[0]);

			if (req.method === "GET" || req.method === "HEAD") {
				if (pathname === "/health") {
					sendJson(res, 200, { ok: true, plugin: "multi-git", root: workspaceRoot, port: address()?.port ?? port });
					return;
				}

				// The plugin's client bundle, which `/` imports as `/client/entry.mjs`.
				if (pathname.startsWith("/client/")) {
					const abs = safeJoin(CLIENT_DIR, pathname.slice("/client".length));
					if (!abs) {
						sendJson(res, 403, { ok: false, error: "Path escapes the plugin directory" });
						return;
					}
					await serveFile(res, abs);
					return;
				}

				if (pathname === "/favicon.ico") {
					send(res, 204, "");
					return;
				}

				// Everything else is a page asset: `public/` *is* the document root, so `theme.css` and
				// `multi-git-ctx.mjs` answer at the paths index.html imports them from.
				const abs = safeJoin(PUBLIC_DIR, pathname === "/" ? "/index.html" : pathname);
				if (!abs) {
					sendJson(res, 403, { ok: false, error: "Path escapes the asset directory" });
					return;
				}
				await serveFile(res, abs);
				return;
			}

			if (req.method === "POST" && pathname.startsWith("/api/")) {

				const action = decodeURIComponent(pathname.slice("/api/".length));
				if (!action.startsWith("multi-git:")) {
					sendJson(res, 400, { ok: false, error: `Not a multi-git action: ${action}` });
					return;
				}
				let body;
				try {
					body = await readBody(req);
				} catch (err) {
					sendJson(res, 400, { action: `${prefix(action)}:data`, ok: false, kind: "error", error: err?.message ?? String(err) });
					return;
				}
				sendJson(res, 200, await dispatch(action, body));
				return;
			}

			sendJson(res, 405, { ok: false, error: `${req.method} not allowed on ${pathname}` });
		} catch (err) {
			logger.warn?.(`multi-git: ${err?.stack ?? err}`);
			if (!res.headersSent) sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
			else res.end();
		}
	});

	const address = () => server.address();

	await new Promise((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(port, hostname, resolveListen);
	});

	const bound = address();
	const actualPort = typeof bound === "object" && bound ? bound.port : port;
	const boundHost = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
	const url = `http://${boundHost}:${actualPort}/`;

	let closed = false;
	async function close() {
		if (closed) return;
		closed = true;
		for (const [, settle] of pending) {
			clearTimeout(settle.timer);
			settle.resolve({ ok: false, kind: "error", error: "Server is shutting down" });
		}
		pending.clear();
		// `server.close()` only stops accepting; it waits for existing connections, and an idle
		// keep-alive socket from an open browser tab is one of those. Without this, shutting the server
		// down waits out the keep-alive timeout, and the sockets are still being torn down when the
		// process exits — on Windows that trips a libuv assertion instead of a clean exit.
		const closing = new Promise((resolveClose) => server.close(() => resolveClose()));
		server.closeAllConnections?.();
		await closing;
	}

	return { url, port: actualPort, root: workspaceRoot, stateFile, server, close };
}