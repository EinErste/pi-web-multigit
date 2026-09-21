/**
 * The terminal pool: one live shell per repository, kept running while another repository holds the pane,
 * plus the retained output window that turns a returning pane into a catch-up instead of a replay.
 *
 * Split out of index.mjs so the pool lives next to the module that stores its windows
 * (server/terminal-log.mjs), the way the actions, prefs, repos, git and parsers already do. The plugin
 * entry keeps the action table and the activate/cwd wiring and nothing else about terminals.
 *
 * Every piece of state here belongs to ONE activation: `createTerminalPool` is called once per
 * `activate()`, so a second activation (the mock-host pool in the tests, a plugin reload) never shares a
 * shell or a window with the first.
 *
 * The entry passes three things in:
 *   getPty()    — read lazily, not at construction: node-pty is loaded on the activation path but a
 *                 plugin-local install can still land later, and the strip must start working then.
 *   host        — host.log / host.sendTo / host.broadcast / host settings (resolveOptions reads them).
 *   resolveRepo — the scan's allowlist lookup, so a shell can only ever start in a scanned repository.
 */

import { basename } from "node:path";

import { firstLine, pathKey } from "./git.mjs";
import { TERM_FLUSH_MS, TERM_MAX_COLS, TERM_MAX_INPUT, TERM_MAX_OUTPUT, TERM_MAX_ROWS, clampDim, resolveShell } from "./pty.mjs";
import { resolveOptions } from "./repos.mjs";
import { createTerminalHistory, createTerminalLog } from "./terminal-log.mjs";


/** The repository a message names, or null when it names none. `pathKey("")` is the server's own cwd, not
 *  "": resolving a message that names nothing against it let a repo-less term-detach release whichever shell
 *  happened to live there (and a repo-less close close it). */
function namedRepoKey(payload) {
	const repo = payload?.repo;
	return typeof repo === "string" && repo !== "" ? pathKey(repo) : null;
}

/**
 * Seat tokens: handed to the client every time it takes a seat (term-open / term-attach) and echoed back on
 * term-detach, so a detach can only ever free the seat its own attach took. A repository name alone cannot
 * tell a current detach from a superseded one for the SAME repository (A → B → A inside one round trip),
 * which is the race this closes. Module scope, not per activation: a token minted by a previous server must
 * never collide with a fresh one.
 */
let seatSeq = 0;

export function createTerminalPool({ getPty, host, resolveRepo }) {
	/**
	 * One live shell plus its retained output window. `cursor` is the absolute stream position the
	 * attached client has rendered; it stays null from open/attach until the client acknowledges the
	 * window it was given (term-sync). That is what makes a replayed window and live output arrive in
	 * order, exactly once — the host gets the same property from its read(id, cursor) offset.
	 *
	 * `at` is the last time this shell was used: it is what the pool evicts by.
	 */
	const newEntry = (repo) => ({ repo, pty: null, clientId: null, seq: 0, seat: 0, outBuf: "", flushTimer: null, log: createTerminalLog(), cursor: null, at: 0, exited: false });
	/** The shell the pane is attached to (null while the strip is closed). */
	let term = null;
	/**
	 * Shells that keep running while another repository is selected. The host keeps its terminals alive
	 * when you look elsewhere and replays their window on return; this is that, capped by the `termKeep`
	 * setting — when a new shell would exceed the cap, the least recently used parked one is closed and
	 * its output stays readable in `termHistory`.
	 */
	const pool = new Map();
	/** Output of shells that are gone, keyed by repository — the host keeps the same map for its own. */
	const termHistory = createTerminalHistory();

	/** Push to whoever drives `entry` (a parked shell has no client: its output just accumulates). */
	function termPush(kind, extra, entry = term) {
		try {
			const payload = { action: "multi-git:data", kind, ...extra };
			if (entry?.clientId) host.sendTo(entry.clientId, payload);
			else host.broadcast(payload);
		} catch (err) {
			host.log("warn", "terminal push failed", err?.message ?? String(err));
		}
	}

	/** Append to one shell's retained window, then stream only what its client has not seen. */
	function termFlush(entry = term) {
		if (!entry) return;
		if (entry.flushTimer) {
			clearTimeout(entry.flushTimer);
			entry.flushTimer = null;
		}
		const chunk = entry.outBuf;
		entry.outBuf = "";
		if (!chunk) return;
		entry.log.append(chunk);
		// A parked shell has no client in sync: its output only accumulates in the log, and the next
		// attach replays the window. Same for an attached client that is still replaying.
		if (!entry.repo || entry.cursor === null || !entry.clientId) return;
		const next = entry.log.since(entry.cursor);
		if (!next) {
			// The client fell further behind than the window holds: hand it the window again instead of
			// silently skipping the difference.
			entry.cursor = null;
			termPush("term-resync", { repo: entry.repo, ...entry.log.window() }, entry);
			return;
		}
		entry.cursor = next.cursor;
		// The cursor travels with the chunk: the pane keeps it as "what I have rendered", so a later
		// catch-up asks for the delta from there instead of being re-sent the whole window.
		if (next.data) termPush("term-data", { repo: entry.repo, data: next.data.slice(-TERM_MAX_OUTPUT), cursor: entry.cursor }, entry);
	}

	/** Close one shell (default: the attached one) and keep its window readable as history. */
	function killTerminal(reason, entry = term) {
		if (!entry) return false;
		entry.seq++;
		if (entry.flushTimer) {
			clearTimeout(entry.flushTimer);
			entry.flushTimer = null;
		}
		entry.outBuf = "";
		// Keep this shell's output readable after it is gone, like the host moves an exited terminal into
		// its history map. The next shell in the same repository inherits the window (see termOpen).
		if (entry.repo && entry.log.length) termHistory.set(pathKey(entry.repo), entry.log);
		entry.log = createTerminalLog();
		entry.cursor = null;
		const pty = entry.pty;
		const repo = entry.repo;
		entry.pty = null;
		// NB: clientId is intentionally kept — the closing client still needs the
		// term-exit push; it is overwritten on the next open.
		if (pty) {
			/**
			 * Release the HPC handle — but only once the child is gone. `pty.kill()` is ClosePseudoConsole,
			 * which blocks (and fails to release the conout transport: a worker MessagePort plus its socket
			 * pair) while the shell still owns the pipe. Measured: releasing it immediately left those
			 * handles behind for every shell ever closed, which is enough to keep the whole server's event
			 * loop alive. The host's terminal manager waits for EOF for the same reason.
			 */
			const release = () => {
				try {
					pty.kill();
				} catch (err) {
					// The host's terminal manager treats the same AttachConsole noise as benign.
					host.log("debug", "pty kill reported", err?.message ?? String(err));
				}
				/**
				 * Upstream residue, left alone on purpose: node-pty disposes its conout worker *after* the native
				 * ClosePseudoConsole call, so when that throws the worker thread and its socket pair stay behind
				 * (measured: one open/close cycle took the handle count from 5 to 8). Poking `pty._agent` here
				 * does not release them either, and it is private API — the host's own terminal manager spawns
				 * with the same options and behaves identically, so this plugin stays a faithful mirror rather
				 * than a fork of node-pty's internals.
				 */
			};
			if (process.platform === "win32") {
				// Killed before the HPC handle is released below: a shell still holding the pipe would stall
				// ClosePseudoConsole — the host's own terminal manager kills first for the same reason (#215).
				const pid = pty.pid;
				// Never TerminateProcess a pid that is already gone: Windows recycles pids, so killing a stale one
				// can take out an unrelated process. The host's killNative draws the same line — once the entry is
				// exited it goes straight to pty.kill() — and `entry.exited` is what records that for us.
				if (!entry.exited && typeof pid === "number") {
					// Asked to exit first, so bash still runs its cleanup hooks — then forced, like the host does.
					try {
						pty.write("\x03exit\r");
					} catch {
						/* already gone */
					}
					try {
						process.kill(pid); // TerminateProcess: never blocks, so the shell cannot hold the pipe
					} catch {
						/* already gone */
					}
				}
				let released = false;
				const once = () => {
					if (released) return;
					released = true;
					release();
				};
				// onExit is the natural moment; the timer covers the cases where Windows never fires it.
				// Unref'd on purpose: it must not keep the event loop alive on its own.
				try {
					pty.onExit(once);
				} catch {
					/* older node-pty has no onExit */
				}
				const fallback = setTimeout(once, 400);
				fallback.unref?.();
			} else {
				release();
			}
			host.log("info", "terminal closed", { repo, reason });
			return true;
		}
		return false;
	}

	/** How many live shells to keep: the manifest setting, already clamped by resolveOptions. */
	const keepLimit = () => resolveOptions(host).termKeep;

	/** Park an attached shell: it keeps running (and keeps filling its window) while another repo is used. */
	function park(entry) {
		if (!entry?.pty) return;
		entry.clientId = null; // nobody drives it now; the next attach replays its window
		entry.cursor = null;
		entry.at = Date.now();
		pool.set(pathKey(entry.repo), entry);
		// No trim here: parking does not change how many shells are live, and trimming at this point
		// would count this very entry twice (it is still the attached one until the caller clears it) —
		// which evicted one shell too many. The count only grows when a shell is spawned (termOpen).
	}

	/** Promote a parked shell back into the pane — the same process, not a new prompt. */
	function promote(entry, from) {
		pool.delete(pathKey(entry.repo));
		entry.clientId = from;
		entry.seat = ++seatSeq; // a fresh seat: only a detach carrying this one may free it
		entry.cursor = null; // the client acknowledges the window it renders (term-sync)
		entry.at = Date.now();
		return entry;
	}

	/**
	 * Keep at most `keep` live shells: the least recently used parked one is closed, and its window stays
	 * readable in `termHistory` so returning later still shows what it printed. The host caps its own live
	 * terminals the same way, just at a higher number.
	 */
	function trimPool(keep) {
		while (pool.size + (term?.pty ? 1 : 0) > keep) {
			let victimKey = null;
			let victimAt = Infinity;
			for (const [key, entry] of pool) {
				if (entry.at < victimAt) {
					victimAt = entry.at;
					victimKey = key;
				}
			}
			if (victimKey === null) break;
			const victim = pool.get(victimKey);
			pool.delete(victimKey);
			host.log("info", "terminal evicted (pool is full)", { repo: victim?.repo ?? "", keep });
			killTerminal("evicted", victim);
		}
	}

	/** Every live shell goes when the workspace changes or the plugin unloads. */
	function killEveryTerminal(reason) {
		for (const entry of pool.values()) killTerminal(reason, entry);
		pool.clear();
		if (term) {
			killTerminal(reason, term);
			term = null;
		}
	}

	const termOpen = (from, payload) => {
		const repo = resolveRepo(payload.repo);
		const cols = clampDim(payload.cols, 80, TERM_MAX_COLS);
		const rows = clampDim(payload.rows, 24, TERM_MAX_ROWS);
		const ptyMod = getPty();
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
		/**
		 * Only now retire the attached shell — and "retire" means park it, not kill it: shells in other
		 * repositories keep running (that is the point of the pool), so coming back finds a live shell and
		 * its window instead of a fresh prompt. A shell for THIS repository is replaced, not parked, because
		 * its window is inherited just below.
		 */
		const key = pathKey(repo);
		if (term) {
			if (pathKey(term.repo) === key) {
				// Someone else's open replaces the shell this client is driving: tell that client, the way the host
				// reports terminal_exit whenever a terminal it watches ends for a reason it did not cause (its own
				// in-place restart is silent — there the pane continues). Without this, its pane keeps claiming to
				// be alive while every keystroke of it is refused.
				if (term.clientId && term.clientId !== from) termPush("term-exit", { repo: term.repo, exitCode: null }, term);
				killTerminal("replaced", term);
			} else {
				park(term);
			}
			term = null;
		}
		const parkedHere = pool.get(key);
		if (parkedHere) {
			pool.delete(key);
			killTerminal("replaced", parkedHere);
		}
		// A shell for this repository inherits the window its predecessor left: the fresh xterm continues
		// where the old one stopped (the host's rebuild inherits the terminal's identity the same way).
		const inherited = termHistory.take(key);
		const entry = newEntry(repo);
		const my = ++entry.seq;
		entry.pty = pty;
		entry.clientId = from;
		entry.seat = ++seatSeq; // the token a later term-detach has to echo to free this seat
		/**
		 * The rebuilt shell continues its predecessor's cursor instead of starting a fresh one: the window is
		 * re-seeded at the position it was trimmed to, so `total` lands exactly where the old shell left it.
		 * Appending the text to a zero-based log rewound the absolute cursor for this repository, and a client
		 * still holding an older cursor — a second tab — was then handed bytes its pane already showed.
		 */
		if (inherited) {
			const win = inherited.window();
			entry.log = createTerminalLog(TERM_MAX_OUTPUT, win.offset);
			entry.log.append(win.data);
		}
		entry.cursor = null; // the client acknowledges the replayed window with term-sync
		entry.at = Date.now();
		term = entry;
		trimPool(keepLimit());
		pty.onData((data) => {
			if (entry.seq !== my || entry.pty !== pty) return;
			entry.outBuf += data;
			if (!entry.flushTimer) entry.flushTimer = setTimeout(() => termFlush(entry), TERM_FLUSH_MS);
		});
		pty.onExit(({ exitCode }) => {
			if (entry.seq !== my || entry.pty !== pty) return;
			termPush("term-exit", { repo, exitCode: typeof exitCode === "number" ? exitCode : null }, entry);
			pool.delete(key); // a shell that exited is no longer pooled
			entry.exited = true; // it is gone: killTerminal must not TerminateProcess a recycled pid
			killTerminal("exited", entry);
			if (term === entry) term = null;
		});
		const win = entry.log.window();
		return { repo, cols, rows, shell: basename(resolveShell().shell), seat: entry.seat, alive: true, exited: false, data: win.data, offset: win.offset, cursor: win.cursor };
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
		// A detached shell (clientId cleared by term-detach) can be adopted by whoever attaches next.
		if (term?.pty && term.clientId && term.clientId !== from) throw new Error(`The terminal in this repository belongs to another client — ${what} refused`);
	}

	const termInput = (from, payload) => {
		const pty = term?.pty;
		if (!pty) throw new Error("No terminal is running");
		if (namedRepoKey(payload) !== pathKey(term.repo)) throw new Error("Terminal is running in a different repository");
		assertTermOwner(from, "input");
		const data = typeof payload.data === "string" ? payload.data : "";
		if (!data) return;
		if (data.length > TERM_MAX_INPUT) throw new Error("Terminal input exceeds 64KB");
		pty.write(data);
	};

	const termResize = (from, payload) => {
		const pty = term?.pty;
		if (!pty) throw new Error("No terminal is running");
		if (namedRepoKey(payload) !== pathKey(term.repo)) throw new Error("Terminal is running in a different repository");
		assertTermOwner(from, "resize");
		const cols = clampDim(payload.cols, 80, TERM_MAX_COLS);
		const rows = clampDim(payload.rows, 24, TERM_MAX_ROWS);
		try {
			pty.resize(cols, rows);
		} catch (err) {
			host.log("warn", "pty resize failed", err?.message ?? String(err));
		}
	};

	const termClose = (from, payload) => {
		// With a pool a close names its repository: it must never close whichever shell holds the pane, and a
		// close that names none closes nothing — resolving an unnamed path lands on the server's own cwd.
		const key = namedRepoKey(payload);
		if (key === null) return null;
		const victim = term && key === pathKey(term.repo) ? term : pool.get(key);
		if (!victim?.pty) return null;
		if (victim === term) assertTermOwner(from, "close");
		else pool.delete(key); // a parked shell belongs to nobody, so anyone may close it
		killTerminal("user", victim);
		if (term === victim) term = null; // the pane holds no shell now; the next attach or open decides
		return victim; // the caller pushes term-exit to whoever was driving it
	};
	/**
	 * What a (re)mounting client should render: the retained window, plus whether a shell is behind it.
	 * A shell parked for this repository is promoted back into the pane (it never stopped running), and
	 * the shell being left behind is parked rather than killed. Adopting a live shell someone else is
	 * driving still requires a takeover, so the ownership rule is unchanged.
	 */
	const termAttach = (from, payload) => {
		const repo = String(payload.repo ?? "");
		const key = pathKey(repo);
		const attached = term && key === pathKey(term.repo) ? term : null;
		const parked = attached ? null : pool.get(key);
		if (attached) {
			assertTermOwner(from, "attach");
			attached.clientId = from;
			attached.seat = ++seatSeq; // a re-attach takes a fresh seat, so an older detach cannot free it
			attached.cursor = null; // nothing is streamed until term-sync confirms the replay landed
			attached.at = Date.now();
		} else if (parked?.pty) {
			if (term) park(term); // the shell we are leaving keeps running
			term = promote(parked, from);
		}
		// After a promotion the shell is the attached one, so re-read `term` rather than the pool — looking
		// the entry up in the pool again was reporting a live shell as dead.
		const live = attached ?? (term && key === pathKey(term.repo) ? term : null);
		const log = live?.pty ? live.log : termHistory.get(key);
		const win = log ? log.window() : { data: "", offset: 0, cursor: 0 };
		return { repo, alive: !!live?.pty, exited: !live?.pty && !!log, seat: live?.seat ?? null, data: win.data, offset: win.offset, cursor: win.cursor };
	};

	/**
	 * The client has rendered the window up to `cursor`; stream from there and never from before it.
	 * Bytes that arrived while it was replaying come back in this reply, so none are lost or doubled.
	 */
	const termSync = (from, payload) => {
		assertTermOwner(from, "sync");
		if (!term?.pty) throw new Error("No terminal is running");
		const repo = String(payload.repo ?? "");
		if (pathKey(repo) !== pathKey(term.repo)) throw new Error("Terminal is running in a different repository");
		const next = term.log.since(payload.cursor);
		if (!next) {
			// Older than the retained window: send the window again and re-anchor on its end.
			const win = term.log.window();
			term.cursor = win.cursor;
			return { repo, resync: true, ...win };
		}
		term.cursor = next.cursor;
		return { repo, resync: false, data: next.data, offset: next.cursor - next.data.length, cursor: next.cursor };
	};

	/** Give up the seat without killing the shell: the view is unmounting, the shell keeps running. */
	const termDetach = (from, payload) => {
		if (!term?.pty) return { alive: false, detached: false };
		/**
		 * Give up the seat only when this detach can prove it is about the shell that holds it: the seat token
		 * term-attach / term-open handed the client that took it, or — for a caller without a token — the
		 * repository it names. The token is what separates a current detach from a superseded one for the SAME
		 * repository (A → B → A inside one round trip), which a name alone cannot; and a detach that neither
		 * carries a token nor names a repository gives up nothing, instead of resolving "" against the server's
		 * cwd and releasing whichever shell happens to live there.
		 */
		const key = namedRepoKey(payload);
		const raw = payload?.seat;
		const seat = Number(raw);
		const hasSeat = raw !== null && raw !== undefined && raw !== "" && Number.isFinite(seat);
		const mine = hasSeat ? seat === term.seat : key !== null && key === pathKey(term.repo);
		if (!mine) return { alive: true, detached: false, repo: term.repo };
		assertTermOwner(from, "detach");
		term.clientId = null;
		term.cursor = null; // nobody is in sync now; the next attach replays the window
		return { alive: true, detached: true, repo: term.repo };
	};

	/** Forget the retained output for a repository: the strip's ✕ clears the history too. */
	const termClear = (from, payload) => {
		const repo = String(payload?.repo ?? "");
		const key = namedRepoKey(payload);
		// A clear that names no repository clears nothing: "the repository at the server's cwd" is not what an
		// unnamed path means.
		if (key === null) return { repo, cleared: false };
		if (term?.pty && key === pathKey(term.repo)) {
			assertTermOwner(from, "clear");
			term.log.clear();
		}
		termHistory.get(key)?.clear();
		return { repo, cleared: true };
	};

	return { killEveryTerminal, termAttach, termClear, termClose, termDetach, termInput, termOpen, termPush, termResize, termSync };
}