#!/usr/bin/env node
/**
 * End-to-end HTTP check for the standalone server.
 *
 *   node standalone/test.mjs [workspace]
 *
 * The pi-web-ui plugin reaches its server through pi-web-ui's own message channel, so `standalone/host.mjs`
 * and `standalone/server.mjs` are the only parts a browser would exercise differently. This drives them
 * directly: routing, content types, the traversal guard, the action families, the correlation ids, and
 * prefs surviving a round trip through `storage.json` (the same file the pi-web-ui plugin reads).
 *
 * Read-only against the workspace: it writes only to the plugin's own gitignored `storage.json` and restores it.
 */
import { readFileSync } from "node:fs";

import { startMultigitServer } from "./server.mjs";
import { finish } from "./exit.mjs";

const ROOT = process.argv[2] ?? process.env.MULTIGIT_ROOT ?? process.cwd();

let failures = 0;
let checks = 0;
function ok(label, condition, detail) {
	checks += 1;
	if (condition) {
		console.log(`  ok   ${label}`);
		return true;
	}
	failures += 1;
	console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
	return false;
}

/**
 * Every module reachable from `/client/entry.mjs` through relative imports, fetched as the browser would
 * fetch it. One record per module, so a failure names the file and not the bundle.
 */
async function walkClientModules() {
	const seen = new Map();
	const queue = ["/client/entry.mjs"];
	while (queue.length) {
		const path = queue.shift();
		if (seen.has(path)) continue;
		const res = await fetch(new URL(path, server.url));
		const type = res.headers.get("content-type") ?? "";
		const body = await res.text();
		seen.set(path, {
			path,
			ok: res.status === 200 && type.startsWith("text/javascript"),
			detail: `status ${res.status} ${type}`,
		});
		for (const match of body.matchAll(/from\s+"(\.[^"]+)"/g)) {
			const resolved = new URL(match[1], new URL(path, server.url));
			queue.push(resolved.pathname);
		}
	}
	return [...seen.values()];
}

const server = await startMultigitServer({ root: ROOT, port: 0 });

const get = (path) => fetch(new URL(path, server.url));
const post = (action, body) =>
	fetch(new URL(`/api/${encodeURIComponent(action)}`, server.url), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action, ...body }),
	});

try {
	console.log(`\nmulti-git standalone · ${server.url} · root ${server.root}\n`);

	/* ---- health and statics ---- */
	const health = await (await get("/health")).json();
	ok("health reports the bound port", health.ok === true && health.port === server.port, JSON.stringify(health));

	const page = await get("/");
	ok("/ serves the view", page.status === 200 && (await page.text()).includes("multi-git-root"));

	const entry = await get("/client/entry.mjs");
	ok(
		"/client serves .mjs as text/javascript",
		entry.status === 200 && entry.headers.get("content-type").startsWith("text/javascript"),
		entry.headers.get("content-type"),
	);

	const theme = await get("/theme.css");
	ok("/theme.css is CSS", theme.status === 200 && theme.headers.get("content-type").startsWith("text/css"));

	const ctxModule = await get("/multi-git-ctx.mjs");
	ok("/multi-git-ctx.mjs is JavaScript", ctxModule.status === 200 && ctxModule.headers.get("content-type").startsWith("text/javascript"));

	// The whole bundle, not its entry alone: a module the page never gets fails only in a browser
	// console, which is the failure this server exists to avoid.
	const modules = await walkClientModules();
	ok(
		`all ${modules.length} client modules are served as JavaScript`,
		modules.every((m) => m.ok),
		modules.filter((m) => !m.ok).map((m) => `${m.path}: ${m.detail}`).join(", "),
	);

	ok("no-store on the client bundle", entry.headers.get("cache-control") === "no-store");

	/* ---- the traversal guard ---- */
	ok("plain ../ is refused", (await get("/client/../index.mjs")).status === 404);
	const escaped = await get("/client/%2e%2e%2findex.mjs");
	ok("encoded ../ is refused", escaped.status === 403, `status ${escaped.status}`);

	/* ---- scan ---- */
	const scan = await (await post("multi-git:scan", { reqId: 1 })).json();
	ok("scan replies as multi-git:data", scan.action === "multi-git:data" && scan.kind === "repos");
	ok("scan found repositories", Array.isArray(scan.repos) && scan.repos.length > 0, `${scan.repos?.length} repos`);
	ok("scan echoes the project directory", scan.cwd === server.root, scan.cwd);
	ok("scan carries prefs and a server version", !!scan.prefs && !!scan.serverVersion, scan.serverVersion);
	ok(
		"every repository carries a branch and a path",
		(scan.repos ?? []).every((r) => typeof r.path === "string" && typeof r.branch === "string"),
	);

	const repos = scan.repos ?? [];
	const first = repos[0]?.path;

	/* ---- one repository's stats, diff and log ---- */
	const stats = await (await post("multi-git:stats", { reqId: 2, repo: first })).json();
	ok("stats resolves", stats.ok === true && stats.kind === "stats", stats.error);
	ok("stats reports per-file counts", !!stats.stats && typeof stats.stats === "object");

	const log = await (await post("multi-git:log", { reqId: 3, repo: first })).json();
	ok("log resolves", log.ok === true && log.kind === "log", log.error);
	ok("log returns commits", (log.history?.length ?? 0) > 0, `${log.history?.length} commits`);

	/* ---- the path guard inside one repository ---- */
	const escape = await (await post("multi-git:showfile", { reqId: 4, repo: first, path: "../../NOT-A-REAL-FILE" })).json();
	ok("a path escaping the repository is refused", escape.ok === false, JSON.stringify(escape).slice(0, 120));

	/* ---- errors, not hangs ---- */
	const unknown = await (await post("multi-git:nope", { reqId: 5 })).json();
	ok("an unknown action reports an error", unknown.ok === false && /unknown/i.test(unknown.error ?? ""), JSON.stringify(unknown).slice(0, 120));

	const unknownRepo = await (await post("multi-git:stats", { reqId: 6, repo: "Z:\\nope" })).json();
	ok("an unknown repository reports an error", unknownRepo.ok === false, JSON.stringify(unknownRepo).slice(0, 120));

	const badBody = await fetch(new URL("/api/multi-git:scan", server.url), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{not json",
	});
	ok("a malformed body is a 400, not a hang", badBody.status === 400);

	const foreignAction = await fetch(new URL("/api/other-plugin:thing", server.url), { method: "POST", body: "{}" });
	ok("a foreign action namespace is refused", foreignAction.status === 400);

	/* ---- correlation: a reply comes back for the id the caller used ----
	 *
	 * `client/bridge.mjs` numbers its requests from 1 on every page load and matches replies against
	 * that number. A server correlating by its own counter agrees only while the two happen to be in step:
	 * a refreshed page (client back to 1, server still counting) gets nothing back and sits empty until
	 * its timeout. These cases are the difference. */
	const scanWith = async (body) =>
		(
			await fetch(new URL("/api/multi-git:scan", server.url), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			})
		).json();

	const reused = await scanWith({ action: "multi-git:scan", reqId: 1 });
	ok("a re-used reqId still gets its reply (the reload case)", reused.ok === true && reused.reqId === 1, String(reused.reqId));

	const arbitrary = await scanWith({ action: "multi-git:scan", reqId: 4242 });
	ok("an id unrelated to the server's own counter is echoed", arbitrary.ok === true && arbitrary.reqId === 4242, String(arbitrary.reqId));

	const noId = await scanWith({ action: "multi-git:scan" });
	ok("a caller that supplies no id still gets an answer", noId.ok === true && noId.kind === "repos", JSON.stringify(noId).slice(0, 120));

	// The URL decides the action: a body cannot retarget the request or forge its own id.
	const overridden = await fetch(new URL("/api/multi-git:scan", server.url), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action: "multi-git:log", reqId: "forged" }),
	}).then((r) => r.json());
	ok("the body cannot retarget the action", overridden.kind === "repos", overridden.kind);
	ok("the body cannot forge the correlation id", overridden.reqId === "forged", String(overridden.reqId));

	/* ---- the terminal is a pi-web-ui feature only ---- */
	const term = await (await post("multi-git:term-open", { reqId: 7, repo: first, cols: 80, rows: 24 })).json();
	ok("a terminal request is refused here", term.ok === false, JSON.stringify(term).slice(0, 120));

	/* ---- prefs round trip ---- */
	const prefs = await (await post("multi-git:prefs", { reqId: 9, hideClean: true, sort: "name" })).json();
	ok("prefs writes are acknowledged", prefs.ok === true && prefs.kind === "repos", prefs.error);
	ok("prefs echo the new value", prefs.prefs?.hideClean === true, JSON.stringify(prefs.prefs?.hideClean));

	// A scan within the coalescing window (1.5s) is served from the last result, so wait past it: the
	// point here is that the stored pref is picked up by a real rescan, not that the cache is bypassed.
	await new Promise((r) => setTimeout(r, 1_600));
	const rescan = await (await post("multi-git:scan", { reqId: 10 })).json();
	ok("prefs survive a scan", rescan.prefs?.hideClean === true, JSON.stringify(rescan.prefs?.hideClean));

	const onDisk = JSON.parse(readFileSync(server.stateFile, "utf8"));
	ok("prefs reached storage.json", onDisk.hideClean === true, JSON.stringify(onDisk).slice(0, 120));

	// Leave the shared state as it was found: the pi-web-ui plugin reads this same file.
	await post("multi-git:prefs", { reqId: 11, hideClean: scan.prefs?.hideClean ?? false });
} finally {
	await server.close();
}

finish({ checks, failures });