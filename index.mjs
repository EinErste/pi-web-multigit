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

import { DEFAULT_AUTO_REFRESH_SEC, GIT_CONCURRENCY, discover, firstLine, insideRepoReal, mapLimit, pathKey } from "./server/git.mjs";
import { GROUP_MODES, SORT_MODES, normPattern, normPatternMap, normStrings, normWidths, numOr, prefsPayload } from "./server/prefs.mjs";
import { TERM_FLUSH_MS, TERM_MAX_COLS, TERM_MAX_INPUT, TERM_MAX_OUTPUT, TERM_MAX_ROWS, clampDim, loadNodePty, resolveShell } from "./server/pty.mjs";
import { repoSummary, resolveOptions } from "./server/repos.mjs";
import { stopRegexWorker } from "./server/regex-match.mjs";

import { createSearchActions } from "./server/actions/search.mjs";
import { createTerminalActions } from "./server/actions/terminal.mjs";
import { createViewActions } from "./server/actions/views.mjs";
import { createWriteActions } from "./server/actions/write.mjs";
import { definePlugin } from "./sdk/index.mjs";


/** The plugin's own version, read from manifest.json: a hard-coded copy went stale (the ready log said
 * 0.8.1 while the manifest said 0.10.0), and the client uses it to notice a stale running server. */
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
			host.log("warn", "terminal unavailable", err?.message ?? String(err));
		}
		const term = { pty: null, repo: null, clientId: null, seq: 0, outBuf: "", flushTimer: null };

		function termPush(kind, extra) {
			try {
				const payload = { action: "multi-git:data", kind, ...extra };
				if (term.clientId) host.sendTo(term.clientId, payload);
				else host.broadcast(payload);
			} catch (err) {
				host.log("warn", "terminal push failed", err?.message ?? String(err));
			}
		}

		function termFlush() {
			if (term.flushTimer) {
				clearTimeout(term.flushTimer);
				term.flushTimer = null;
			}
			const chunk = term.outBuf;
			term.outBuf = "";
			if (chunk && term.repo) termPush("term-data", { repo: term.repo, data: chunk.slice(-TERM_MAX_OUTPUT) });
		}

		function killTerminal(reason) {
			term.seq++;
			if (term.flushTimer) {
				clearTimeout(term.flushTimer);
				term.flushTimer = null;
			}
			term.outBuf = "";
			const pty = term.pty;
			const repo = term.repo;
			term.pty = null;
			// NB: clientId is intentionally kept — the closing client still needs the
			// term-exit push; it is overwritten on the next open.
			if (pty) {
				try {
					pty.kill();
				} catch (err) {
					// Windows node-pty sometimes reports AttachConsole failure here; the host's
					// terminal manager hits the same and treats it as benign.
					host.log("debug", "pty kill reported", err?.message ?? String(err));
				}
				// Hard stop the shell so no ConPTY agent lingers after a failed kill().
				if (typeof pty.pid === "number") {
					try {
						process.kill(pty.pid);
					} catch {
						/* already gone */
					}
				}
				host.log("info", "terminal closed", { repo, reason });
				return true;
			}
			return false;
		}

		const termOpen = (from, payload) => {
			const repo = resolveRepo(payload.repo);
			const cols = clampDim(payload.cols, 80, TERM_MAX_COLS);
			const rows = clampDim(payload.rows, 24, TERM_MAX_ROWS);
			if (!ptyMod) throw new Error("node-pty is unavailable — cannot start a shell");
			let pty;
			try {
				const { shell, args } = resolveShell();
				pty = ptyMod.spawn(shell, args, {
					name: "xterm-256color",
					cols,
					rows,
					cwd: repo,
					// TERM + LANG parity with the host's own terminal (dist/server/terminals.js → shellEnv).
					env: (() => {
						const env = { ...process.env, TERM: "xterm-256color" };
						if (!env.LANG && !env.LC_ALL) env.LANG = "en_US.UTF-8";
						return env;
					})(),
				});
			} catch (err) {
				throw new Error(`Failed to start a shell here: ${firstLine(err)}`);
			}
			// Only now retire the previous shell: a failed spawn must not kill a working one.
			killTerminal("replaced");
			const my = ++term.seq;
			term.pty = pty;
			term.repo = repo;
			term.clientId = from;
			pty.onData((data) => {
				if (term.seq !== my || term.pty !== pty) return;
				term.outBuf += data;
				if (!term.flushTimer) term.flushTimer = setTimeout(termFlush, TERM_FLUSH_MS);
			});
			pty.onExit(({ exitCode }) => {
				if (term.seq !== my || term.pty !== pty) return;
				termPush("term-exit", { repo, exitCode: typeof exitCode === "number" ? exitCode : null });
				killTerminal("exited");
			});
			return { repo, cols, rows, shell: basename(resolveShell().shell) };
		};

		/**
		 * The PTY belongs to the client that opened it. `term.clientId` was recorded from the start but never
		 * checked, so a second client (another tab, or anyone else the server admits) could type into the
		 * shell someone else opened — silently, since input replies are fire-and-forget on the client side.
		 * Re-opening still takes the terminal over: that kills the previous shell visibly, which is a
		 * deliberate act, unlike injected keystrokes. An anonymous socket has no id on either side, so its
		 * own terminal still matches.
		 */
		function assertTermOwner(from, what) {
			if (term.pty && term.clientId !== from) throw new Error(`The terminal in this repository belongs to another client — ${what} refused`);
		}

		const termInput = (from, payload) => {
			const pty = term.pty;
			if (!pty) throw new Error("No terminal is running");
			if (pathKey(String(payload.repo ?? "")) !== pathKey(term.repo)) throw new Error("Terminal is running in a different repository");
			assertTermOwner(from, "input");
			const data = typeof payload.data === "string" ? payload.data : "";
			if (!data) return;
			if (data.length > TERM_MAX_INPUT) throw new Error("Terminal input exceeds 64KB");
			pty.write(data);
		};

		const termResize = (from, payload) => {
			const pty = term.pty;
			if (!pty) throw new Error("No terminal is running");
			if (pathKey(String(payload.repo ?? "")) !== pathKey(term.repo)) throw new Error("Terminal is running in a different repository");
			assertTermOwner(from, "resize");
			const cols = clampDim(payload.cols, 80, TERM_MAX_COLS);
			const rows = clampDim(payload.rows, 24, TERM_MAX_ROWS);
			try {
				pty.resize(cols, rows);
			} catch (err) {
				host.log("warn", "pty resize failed", err?.message ?? String(err));
			}
		};

		const termClose = (from) => {
			assertTermOwner(from, "close");
			return killTerminal("user");
		};

		// The action handlers, grouped by concern. They receive the per-message values as arguments and the
		// activation state through ctx, so the dispatch below is a lookup rather than a chain of comparisons.
		const actionTable = new Map([
			...Object.entries(
				createViewActions({ SYNC_LOG_LIMIT, TIMELINE_DEFAULT_DAYS, TIMELINE_MAX_ENTRIES, TIMELINE_PER_REPO, basename, insideRepo: insideRepoReal, known, reply, resolveRepo }),
			),
			...Object.entries(createSearchActions({ SEARCH_MAX_PER_FILE, SEARCH_MAX_PER_REPO, SEARCH_MAX_TOTAL, SEARCH_PICKAXE_LIMIT, SEARCH_QUERY_MAX, basename, known, reply })),
			...Object.entries(createTerminalActions({ reply, termClose, termInput, termOpen, termPush, termResize })),
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
					"multi-git:term-open": "term-open",
					"multi-git:term-input": "term-input",
					"multi-git:term-resize": "term-resize",
					"multi-git:term-close": "term-close",
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
			killTerminal("cwd-changed");
			lastScan.value = null;
			host.broadcast({ action: "multi-git:cwd", cwd: host.cwd });
		});

		host.log("info", "multi-git ready", { cwd: host.cwd, version: SERVER_VERSION });

		return () => {
			offMessage();
			offCwd();
			killTerminal("deactivate");
			void stopRegexWorker();
		};
	},
});
