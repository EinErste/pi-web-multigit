/**
 * `/multigit` — open the multi-repo Git overview in a browser, from any pi session.
 * `/multigit:start` is the same command, spelled out against `/multigit:stop`.
 *
 * The scan root is the **session's working directory** — the same project directory the pi-web-ui
 * plugin scans (`host.cwd`), and the only root either host uses. An explicit path is accepted as a
 * *one-off*: it is opened and never remembered, because a stored root would be a second source of truth
 * next to the directory you are actually in, and an empty repository list reads as "this project has no
 * repositories" rather than as "you pointed me at the wrong tree".
 *
 * `/multigit:stop` stops the server without touching which directory was opened.
 *
 * This file lives *in* the repository it launches (`extensions/multigit.ts`), which is what makes the
 * repository a pi package: `package.json` declares `pi.extensions`, so pi loads the launcher from the
 * checkout wherever it lives, and `standalone/` next to it is the server. There is one copy of the code,
 * shared with the pi-web-ui plugin through a junction (see `standalone/link-pi-web-ui.mjs`).
 *
 * The server runs **in this process**, on a random loopback port, and is closed by `session_shutdown`.
 * Nothing starts in the factory — pi loads extensions in contexts that never open a session.
 *
 * The overview never talks to a model; it reads git and shows what it found. It writes to a repository
 * only through the three deliberate git actions (Fetch, Pull, per-file Rollback).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The repository that owns `standalone/`.
 *
 * Resolved from this file's own location first (`extensions/multigit.ts` → its parent): wherever the
 * checkout lives, the launcher sits one directory below the server it starts, so a second clone works without
 * editing anything. The fixed locations follow, for an explicit override or an older layout.
 */
function pluginCandidates(): string[] {
	// An override *replaces* the search: a wrong MULTIGIT_PLUGIN_DIR has to fail loudly, not be silently
	// ignored while you test a different checkout than the one you named.
	if (process.env.MULTIGIT_PLUGIN_DIR) return [process.env.MULTIGIT_PLUGIN_DIR];

	const out: string[] = [];
	try {
		// jiti provides import.meta.url; guarded anyway, so a loader without it cannot break /multigit.
		out.push(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
	} catch {
		/* no import.meta.url under this loader: fall through to the fixed locations */
	}
	out.push(
		join(homedir(), ".pi", "agent", "extensions", "pi-web-multigit"),
		join(homedir(), ".pi-web", "plugins", "pi-web-multigit"),
	);
	return out;
}

interface MultigitServer {
	url: string;
	port: number;
	root: string;
	close(): Promise<void>;
}

interface MultigitServerModule {
	startMultigitServer(options: { root: string; port?: number }): Promise<MultigitServer>;
}

interface OpenModule {
	openInBrowser(url: string): Promise<boolean>;
}

/**
 * The live server, held off the module scope so a `/reload` can find — and close — the one the previous
 * extension runtime started. A reload replaces the runtime without running its shutdown handlers, and an orphaned
 * socket would stay bound for the life of the process.
 */
const STATE = Symbol.for("pi.multigit.server");
type MultigitState = { server: MultigitServer | null; open: OpenModule["openInBrowser"] | null };
const globalState = globalThis as { [STATE]?: MultigitState };
const state: MultigitState = globalState[STATE] ?? { server: null, open: null };
globalState[STATE] = state;

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function findPluginDir(): string | null {
	for (const candidate of pluginCandidates()) {
		if (isFile(join(candidate, "standalone", "server.mjs"))) return candidate;
	}
	return null;
}

function requirePluginDir(ctx: ExtensionCommandContext): string | null {
	const dir = findPluginDir();
	if (dir) return dir;
	ctx.ui.notify(
		`multigit: the multi-git checkout was not found. Looked in:\n  ${pluginCandidates().join("\n  ")}\nSet MULTIGIT_PLUGIN_DIR to its directory.`,
		"error",
	);
	return null;
}

/* ------------------------------------------------------------------ */
/* path completion                                                     */
/* ------------------------------------------------------------------ */

/** Complete a partially typed directory path so `/multigit F:\Jo<Tab>` lands on a project directory. */
function completePaths(prefix: string): { value: string; label: string }[] {
	const raw = String(prefix ?? "");
	const cut = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
	const dirPart = cut >= 0 ? raw.slice(0, cut + 1) : "";
	const fragment = (cut >= 0 ? raw.slice(cut + 1) : raw).toLowerCase();
	const base = dirPart ? resolve(dirPart) : process.cwd();

	let entries;
	try {
		entries = readdirSync(base, { withFileTypes: true });
	} catch {
		return [];
	}

	return entries
		.filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(fragment))
		.slice(0, 20)
		.map((entry) => ({ value: dirPart + entry.name, label: entry.name }));
}

/* ------------------------------------------------------------------ */
/* activation                                                          */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI): void {
	// A server left by a previous runtime (a `/reload`) is this session's to clean up.
	if (state.server) {
		const stale = state.server;
		state.server = null;
		void stale.close().catch(() => {});
	}

	pi.registerCommand("multigit", {
		description:
			"Open the multi-repo Git overview (branches, changes, diffs, history) for the current project directory; pass a path to open that one instead, once",
		getArgumentCompletions: (prefix: string) => completePaths(prefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await openOverview(args?.trim() ?? "", ctx);
		},
	});

	// `/multigit:start` spells out the opposite of `/multigit:stop`, which is worth having when the
	// server is down and you want to be sure what you are starting.
	pi.registerCommand("multigit:start", {
		description: "Start the multi-repo Git overview for the current project directory (the same as /multigit)",
		getArgumentCompletions: (prefix: string) => completePaths(prefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await openOverview(args?.trim() ?? "", ctx);
		},
	});

	pi.registerCommand("multigit:stop", {
		description: "Stop the overview server /multigit started — the open browser tab stops working",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			await stopOverview(ctx);
		},
	});

	pi.on("session_shutdown", async () => {
		const server = state.server;
		state.server = null;
		await server?.close().catch(() => {});
	});
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

/**
 * Stop the server, keeping nothing else. Stopping is deliberately separate from the scan root:
 * the root is the directory you asked for, the server is a process, and conflating them would make
 * `/multigit:stop` silently forget where you were.
 */
async function stopOverview(ctx: ExtensionCommandContext): Promise<void> {
	const server = state.server;
	if (!server) {
		ctx.ui.notify("multigit: nothing is running — /multigit starts it", "info");
		return;
	}
	state.server = null;
	try {
		await server.close();
	} catch (err) {
		ctx.ui.notify(`multigit: stopped, but closing it reported — ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}
	ctx.ui.notify(`multi-git stopped  ${server.url}\nroot        ${server.root}`, "info");
}

async function openOverview(arg: string, ctx: ExtensionCommandContext): Promise<void> {
	const pluginDir = requirePluginDir(ctx);
	if (!pluginDir) return;

	// The session's working directory unless an explicit one-off was given. Never remembered: the cwd is
	// already the answer, and a stored root could silently disagree with the project pi is actually in.
	const root = arg ? resolve(ctx.cwd, arg) : resolve(ctx.cwd);
	if (!isDir(root)) {
		ctx.ui.notify(`multigit: no such directory: ${root}`, "error");
		return;
	}

	try {
		// One server per session, so a second `/multigit` looks at the open tab rather than rebinding —
		// unless the working directory has moved since, which this server cannot serve.
		if (state.server && state.server.root !== root) {
			const previous = state.server;
			state.server = null;
			await previous.close().catch(() => {});
		}

		if (!state.server) {
			const [serverModule, openModule] = await Promise.all([
				import(pathToFileURL(join(pluginDir, "standalone", "server.mjs")).href) as Promise<MultigitServerModule>,
				import(pathToFileURL(join(pluginDir, "standalone", "open.mjs")).href) as Promise<OpenModule>,
			]);
			state.server = await serverModule.startMultigitServer({ root, port: 0 });
			state.open = openModule.openInBrowser;
		}

		const server = state.server;
		const opened = await state.open?.(server.url);

		const lines = [`multi-git  ${server.url}`, `root       ${server.root}   (${arg ? "from the argument, not remembered" : "the project directory"})`];
		if (!opened) lines.push("(open the URL above — no browser launcher was started)");
		ctx.ui.notify(lines.join("\n"), "info");
	} catch (err) {
		ctx.ui.notify(`multigit: could not start the overview — ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}