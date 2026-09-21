/**
 * multi-git — multi-repository Git overview (pi-web-ui UI plugin, READ-ONLY).
 *
 * Why it exists: the host source-control panel is single-repo by design — it runs
 * git in one directory only (`server/files-service.ts` → `getActiveCwd()`, i.e. the
 * conversation cwd). A workspace that holds many independent repos has no `.git` at
 * its root, so `git status` fails there and the panel always shows
 * "Current directory is not a Git repository". This plugin discovers every repo
 * below the workspace root and reports branch / ahead-behind / changed files for
 * each of them, plus per-file diffs, commit history, branches, stashes, a workspace
 * timeline and cross-repo code search on demand.
 *
 * Implementation notes:
 * - Node built-ins only. git runs through `execFile("git", [...args])` — an argv
 *   array, never a shell — mirroring the host's own scm module (core.quotepath=false,
 *   timeout, maxBuffer, windowsHide).
 * - git runs through `execFile("git", [...args])` — an argv array, never a shell —
 *   mirroring the host's own scm module (core.quotepath=false, timeout, maxBuffer
 *   windowsHide). It never writes to a repository: only status/diff/log/show/
 *   ls-files/grep/for-each-ref/stash list/stash show/branch/worktree list/submodule
 *   status and similar read-only commands are executed.
 * - The terminal strip is the single write-side exception: a REAL full PTY shell
 *   (node-pty, loaded from the host's own node_modules — the same library the host's
 *   terminal tab uses), pinned to the selected repo's directory. Running vim/top/ssh
 *   etc. works, exactly like the host terminal. Only the shell can write to the repo;
 *   everything else in the plugin stays read-only.
 * - Only the `ui` capability is declared; the host API surface used is the UI channel
 *   (onMessage/sendTo/broadcast) plus settings and storage. Discovery and git work are
 *   done by this plugin's own server-side code, which is trusted Node code by design.
 * - Every inbound message is answered to its sender (clients match on reqId) and every
 *   failure becomes a structured `ok:false` reply instead of an exception thrown into
 *   the host's message dispatch.
 */

import { basename, dirname, join, resolve } from "node:path";
import { stat, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DEFAULT_AUTO_REFRESH_SEC, GIT_CONCURRENCY, discover, insideRepoReal, mapLimit, pathKey } from "./server/git.mjs";
import { GROUP_MODES, SORT_MODES, normPattern, normPatternMap, normStrings, normTermHeight, normWidths, numOr, prefsPayload } from "./server/prefs.mjs";
import { ensureLocalNodePty, loadNodePty } from "./server/pty.mjs";
import { createTerminalPool } from "./server/terminal-pool.mjs";
import { repoSummary, resolveOptions } from "./server/repos.mjs";
import { stopRegexWorker } from "./server/regex-match.mjs";

import { createSearchActions } from "./server/actions/search.mjs";
import { createTerminalActions } from "./server/actions/terminal.mjs";
import { createViewActions } from "./server/actions/views.mjs";
import { createWriteActions } from "./server/actions/write.mjs";
import { definePlugin } from "./sdk/index.mjs";


/** The plugin's own version, read from manifest.json: a hard-coded copy went stale (the ready log said
 * 0.8.1 while the manifest said 0.10.0). It travels with every scan reply as `serverVersion`; no client gates
 * on it — a server too old for term-attach/term-sync answers with an unknown-request error and the strip
 * falls back to a plain term-open — so it is there for whoever needs to notice a stale running server. */
function loadPluginVersion() {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		return JSON.parse(readFileSync(join(here, "manifest.json"), "utf8")).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

const SERVER_VERSION = loadPluginVersion();
/** Reuse a scan result for this long instead of re-running git (multi-tab / re-attach). */
const SCAN_COALESCE_MS = 1_500;

const SEARCH_MAX_TOTAL = 500;
const SEARCH_MAX_PER_REPO = 200;
const SEARCH_MAX_PER_FILE = 50;
const SEARCH_QUERY_MAX = 200;
const SEARCH_PICKAXE_LIMIT = 40;
const SYNC_LOG_LIMIT = 50;
const TIMELINE_DEFAULT_DAYS = 7;
const TIMELINE_PER_REPO = 30;
const TIMELINE_MAX_ENTRIES = 200;


/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* parsers (same conventions as the host's server/scm.ts, reimplemented
   here so this plugin stays independent of internal paths)            */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* options                                                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* scan                                                                */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* fetch, branch overview, blame, compare, dependency-pin matrix        */
/* ------------------------------------------------------------------ */


/** `${property}` / `${project.version}` → a concrete version, or null when it cannot be resolved here. */


/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

export default definePlugin({
	activate(host) {
		/** Repos from the last scan: pathKey → real path (also the request allowlist). */
		// Boxed, not bare `let`: the action modules read and reassign these, and a destructured copy would
		// leave one holder writing to a value nobody reads. `inflight`/`generation` stay plain — only the scan
		// code below touches them.
		const known = { value: new Map() };
		const lastScan = { value: null }; // { key, at, payload }
		let inflight = null; // { key, promise }
		const fetching = { value: null }; // in-flight `git fetch` sweep (one at a time)
		const pulling = { value: null }; // in-flight `pull` sweep (one at a time)
		/**
		 * Bumped whenever the scan *root* or its options change. A scan that started under an
		 * older generation finishes against the previous project, so it must not publish its
		 * repo allowlist (`known`) or its coalescing entry — otherwise a project switch
		 * mid-scan leaves the new project answering with the old project's repositories.
		 */
		let generation = 0;

		const reply = (from, payload) => {
			try {
				if (from) host.sendTo(from, payload);
				else host.broadcast(payload);
			} catch (err) {
				host.log("warn", "reply failed", err?.message ?? String(err));
			}
		};

		function resolveRepo(rawPath) {
			const real = known.value.get(pathKey(rawPath));
			if (!real) throw new Error("Unknown repository — refresh the scan first");
			return real;
		}

		async function runScan() {
			const opts = resolveOptions(host);
			// One root: the project directory. Scanning never walks upward — if the project *is* a
			// single repository, that one repo is the honest answer (the built-in pane covers it).
			const cwd = resolve(String(host.cwd ?? process.cwd()));
			const key = JSON.stringify([cwd, opts.depth, opts.maxRepos, [...opts.skip].sort()]);
			const at = Date.now();
			const myGen = generation;

			if (inflight && inflight.key === key) return inflight.promise;
			if (lastScan.value && lastScan.value.key === key && at - lastScan.value.at < SCAN_COALESCE_MS) return lastScan.value.payload;

			const promise = (async () => {
				const state = { found: [], dirsVisited: 0, truncated: false };
				await discover(cwd, opts, state);

				const summaries = await mapLimit(state.found, GIT_CONCURRENCY, (entry) => repoSummary(entry));

				const byPath = new Map();
				for (const s of summaries) byPath.set(pathKey(s.path), s.path);
				if (myGen === generation) known.value = byPath;

				const payload = {
					action: "multi-git:data",
					kind: "repos",
					ok: true,
					serverVersion: SERVER_VERSION,
					cwd,
					repos: summaries,
					scannedAt: at,
					truncated: state.truncated,
					dirsVisited: state.dirsVisited,
					prefs: prefsPayload(opts),
				};
				if (myGen === generation) lastScan.value = { key, at, payload };
				return payload;
			})();

			inflight = { key, promise };
			try {
				return await promise;
			} finally {
				if (inflight?.promise === promise) inflight = null;
			}
		}

		/* ---------------- full terminal (PTY bridge) ---------------- */
		let ptyMod = null;
		try {
			ptyMod = loadNodePty();
		} catch (err) {
			/**
			 * The host's own copy is the fast path (same ConPTY machinery) but it is not a documented
			 * contract; host.ensureDeps is. Off the activation path on purpose — a first install
			 * compiles native code, and until it lands the strip says "cannot start a shell".
			 */
			host.log("warn", "no host node-pty — trying a plugin-local install", err?.message ?? String(err));
			void ensureLocalNodePty(host).then((mod) => {
				if (!mod) return;
				ptyMod = mod;
				host.log("info", "node-pty (plugin-local) ready — the terminal strip is available");
			});
		}
		/**
		 * The terminal pool itself lives in server/terminal-pool.mjs — it is per-activation state, and the
		 * entry only wires it up. `getPty` is read lazily: a plugin-local node-pty install can still land
		 * after activation, and the strip has to start working when it does.
		 */
		const terminal = createTerminalPool({ getPty: () => ptyMod, host, resolveRepo });

		// The action handlers, grouped by concern. They receive the per-message values as arguments and the
		// activation state through ctx, so the dispatch below is a lookup rather than a chain of comparisons.
		const actionTable = new Map([
			...Object.entries(
				createViewActions({ SYNC_LOG_LIMIT, TIMELINE_DEFAULT_DAYS, TIMELINE_MAX_ENTRIES, TIMELINE_PER_REPO, basename, insideRepo: insideRepoReal, known, reply, resolveRepo }),
			),
			...Object.entries(createSearchActions({ SEARCH_MAX_PER_FILE, SEARCH_MAX_PER_REPO, SEARCH_MAX_TOTAL, SEARCH_PICKAXE_LIMIT, SEARCH_QUERY_MAX, basename, known, reply })),
			...Object.entries(createTerminalActions({ reply, ...terminal })),
			...Object.entries(createWriteActions({ basename, fetching, join, known, lastScan, pulling, reply, resolveRepo, stat, unlink })),
		]);

		const offMessage = host.onMessage(async (raw, from) => {
			const payload = raw && typeof raw === "object" ? raw : {};
			const action = String(payload.action ?? "");
			const reqId = typeof payload.reqId === "number" ? payload.reqId : undefined;
			if (!action.startsWith("multi-git:")) return;

			try {
				if (action === "multi-git:scan") {
					const data = await runScan();
					reply(from, { ...data, reqId });
					return;
				}

				if (action === "multi-git:prefs") {
					// The two lightweight view toggles, persisted in <pluginDir>/storage.json.
					if (typeof payload.hideClean === "boolean") host.storage.set("hideClean", payload.hideClean);
					if (Number.isFinite(Number(payload.autoRefreshSec))) {
						host.storage.set("autoRefreshSec", numOr(payload.autoRefreshSec, DEFAULT_AUTO_REFRESH_SEC, 0, 600));
					}
					if (typeof payload.termVisible === "boolean") host.storage.set("termVisible", payload.termVisible);
					const newWidths = normWidths(payload.widths);
					if (newWidths) host.storage.set("widths", newWidths);
					// The terminal strip's top edge is draggable, so its height is view state too. `null`
					// (double-click reset) is stored as "no override" rather than as a number.
					if ("termHeight" in payload) host.storage.set("termHeight", normTermHeight(payload.termHeight));
					if (SORT_MODES.includes(payload.sort)) host.storage.set("sort", payload.sort);
					if (GROUP_MODES.includes(payload.group)) host.storage.set("group", payload.group);
					if (Array.isArray(payload.collapsed)) host.storage.set("collapsed", normStrings(payload.collapsed));
					if (typeof payload.branchGroupPattern === "string") host.storage.set("branchGroupPattern", normPattern(payload.branchGroupPattern));
					if (payload.branchGroups && typeof payload.branchGroups === "object") host.storage.set("branchGroups", normPatternMap(payload.branchGroups));
					/**
					 * None of these change what a scan finds, so the last scan result is reused instead of
					 * rescanning. A rescan per toggle also meant two quick toggles could overlap, and their
					 * replies could arrive out of order — the stale one then re-applied an older folded set,
					 * which looked like the toggle "doubling" and snapping back.
					 */
					const base = lastScan.value?.payload ?? (await runScan());
					reply(from, { ...base, prefs: prefsPayload(resolveOptions(host)), reqId });
					return;
				}



				/**
				 * Repo-wide history, or scoped to a revision / path:
				 *   { repo }                  → `git log --all --graph`
				 *   { repo, rev }             → `git log <rev>`
				 *   { repo, path }            → `git log --follow -- <path>`
				 *   { repo, rev, path }       → `git log --follow <rev> -- <path>`
				 */










				/**
				 * Fetch every scanned repo (or one) and report what actually changed. This is the only
				 * way the ahead/behind column can be trusted: without it they are as old as the last
				 * manual fetch. `--prune` drops refs whose upstream branch is gone.
				 */

				/**
				 * Pull every repo (or one): fetch, then fast-forward only. `--ff-only` via an explicit
				 * `merge --ff-only` (not `git pull --ff-only`) so the user's pull.rebase setting cannot turn
				 * a bulk action into a rebase, and a diverged branch is reported instead of merged.
				 * Repositories mid-operation or holding an index.lock are skipped, never touched.
				 */

				/**
				 * Discard the local changes of ONE file: `git restore --source=HEAD --staged --worktree`
				 * for tracked paths, delete for untracked/added ones — the latter only when the client
				 * explicitly asked for it (`allowUntracked`), because that cannot be undone by git.
				 */


				/** Cross-repo branch picture: what every repo has, tracks, still has to push, could delete. */

				/** Line-by-line authorship for one file (`git blame`), for onboarding and archaeology. */

				/**
				 * Compare two revisions: `base..head` commits, `base...head` (merge-base) changes, because
				 * that is what "what did this branch add" means in practice.
				 */

				const handler = actionTable.get(action);
				if (handler) {
					await handler(payload, from, reqId);
					return;
				}

				reply(from, { action: "multi-git:data", kind: "error", ok: false, reqId, error: `Unknown request: ${action}` });
			} catch (err) {
				const kindByAction = {
					"multi-git:stats": "stats",
					"multi-git:diff": "diff",
					"multi-git:log": "log",
					"multi-git:commit": "commit",
					"multi-git:showfile": "showfile",
					"multi-git:search": "search",
					"multi-git:branches": "branches",
					"multi-git:sync": "sync",
					"multi-git:stashes": "stashes",
					"multi-git:stashshow": "stashshow",
					"multi-git:timeline": "timeline",
					"multi-git:fetch": "fetch",
					"multi-git:pull": "pull",
					"multi-git:revert": "revert",
					"multi-git:branches-all": "branches-all",
					"multi-git:blame": "blame",
					"multi-git:compare": "compare",
					"multi-git:term-attach": "term-attach",
					"multi-git:term-clear": "term-clear",
					"multi-git:term-close": "term-close",
					"multi-git:term-detach": "term-detach",
					"multi-git:term-input": "term-input",
					"multi-git:term-open": "term-open",
					"multi-git:term-resize": "term-resize",
					"multi-git:term-sync": "term-sync",
				};
				reply(from, {
					action: "multi-git:data",
					kind: kindByAction[action] ?? "error",
					ok: false,
					reqId,
					repo: typeof payload.repo === "string" ? payload.repo : undefined,
					path: typeof payload.path === "string" ? payload.path : undefined,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		});

		const offCwd = host.onCwdChange(() => {
			// Switching projects switches the scan root: drop caches and let open views rescan.
			known.value = new Map();
			generation++; // a scan still in flight belongs to the previous project
			terminal.killEveryTerminal("cwd-changed"); // every shell's cwd belongs to the old workspace
			lastScan.value = null;
			host.broadcast({ action: "multi-git:cwd", cwd: host.cwd });
		});

		host.log("info", "multi-git ready", { cwd: host.cwd, version: SERVER_VERSION });

		return () => {
			offMessage();
			offCwd();
			terminal.killEveryTerminal("deactivate");
			void stopRegexWorker();
		};
	},
});
