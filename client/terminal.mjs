/**
 * The embedded terminal: one xterm per repository (shown and hidden, never rebuilt), the cursor catch-up
 * that turns a repository switch into a delta instead of a replay, the attach → sync → spawn handshake
 * with the server's pooled shells, and the local helpers — resize fitting, the stale-server retry and the
 * hint that replaces an empty pane.
 */


export function createTerminal(deps) {
	const {
	PLUGIN_ID, // from module
	TERM_RETRY_MS, // from module
	_testSeam, // from module
	ctx, // from mount
	destroyed, // from mount
	request, // from mount
	shortName, // from mount
	state, // from mount
	termHint, // from mount
	termHost, // from mount
	termTitle, // from mount
	} = deps;

	let termOpenSeq = 0;
	let fitTimer = null;
	let termCssInjected = false;
const TERM_FONT = '"SF Mono","JetBrains Mono",ui-monospace,Menlo,Consolas,monospace';
const TERM_THEME = {
	background: "#101418",
	foreground: "#d8dee6",
	cursor: "#4f9cf6",
	cursorAccent: "#101418",
	selectionBackground: "#2b3d55",
	black: "#1c222b",
	red: "#e06c75",
	green: "#98c379",
	yellow: "#e5c07b",
	blue: "#61afef",
	magenta: "#c678dd",
	cyan: "#56b6c2",
	white: "#abb2bf",
	brightBlack: "#5c6370",
	brightRed: "#e06c75",
	brightGreen: "#98c379",
	brightYellow: "#e5c07b",
	brightBlue: "#61afef",
	brightMagenta: "#c678dd",
	brightCyan: "#56b6c2",
	brightWhite: "#f8f9fa",
};
/** Hint line under the strip: idle text, or why the shell is not running. */
const TERM_HINT_IDLE = "the shell starts when a repository is selected";

function injectTermCss() {
	if (termCssInjected || typeof fetch !== "function") return;
	const href = new URL("./vendor/xterm/xterm.css", import.meta.url).href;
	// Only an http(s) bundle has that stylesheet: the DOM-stub tests run from file:.
	if (!/^https?:/i.test(href)) return;
	termCssInjected = true; // set optimistically, cleared again if the fetch fails
	try {
		fetch(href)
			.then((r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return r.text();
			})
			.then((css) => {
				const s = document.createElement("style");
				s.textContent = css;
				document.head?.append(s);
			})
			.catch((err) => {
				// Cosmetic, but a silent one-shot failure would leave an unstyled xterm for the
				// whole mount with no way to notice — allow a retry on the next open.
				termCssInjected = false;
				console.warn(`[multi-git] terminal stylesheet failed to load: ${errText(err)}`);
			});
	} catch (err) {
		termCssInjected = false;
		console.warn(`[multi-git] terminal stylesheet failed to load: ${errText(err)}`);
	}
}
async function ensureTermClasses() {
	if (_testSeam.termClasses) return _testSeam.termClasses;
	if (!state.termClasses) {
		const [{ Terminal }, { FitAddon }] = await Promise.all([
			import("./vendor/xterm/xterm.mjs"),
			import("./vendor/xterm/addon-fit.mjs"),
		]);
		state.termClasses = { Terminal, FitAddon };
	}
	return state.termClasses;
}
function sendTermResize() {
	const t = state.termActive;
	if (!t || !state.termRepo) return;
	void request("term-resize", { repo: state.termRepo, cols: t.cols, rows: t.rows });
}
function fitTerm() {
	clearTimeout(fitTimer);
	fitTimer = setTimeout(() => {
		const fit = state.termFit;
		if (!fit) return;
		try {
			fit.fit();
			sendTermResize();
		} catch {
			/* hidden or detached — retried on the next trigger */
		}
	}, 40);
}
function showTermHint(message) {
	termHint.textContent = message || TERM_HINT_IDLE;
	termHint.style.display = "";
}
function errText(err) {
	return String((err && err.message) || err || "unknown error");
}
/**
 * A terminal that could not start must say so and must not leave a dead xterm (or a
 * server-side PTY) behind: the pane looked alive while nothing was running in it.
 */
function failTerminal(repoPath, message) {
	try {
		console.warn(`[multi-git] ${message}`);
	} catch {
		/* no console */
	}
	// A pane that never came up is thrown away: the next trigger builds a fresh one.
	forgetTerm(repoPath);
	state.termFailedRepo = repoPath;
	state.termFailedAt = Date.now();
	showTermHint(message);
	termTitle.textContent = `terminal · ${shortName(repoPath)} · not running`;
}
/**
 * One xterm per repository, each in its own wrapper inside the strip. Switching repositories then shows a
 * pane that is already there — no teardown, no replay from scratch, no visible tear — while the server
 * keeps the matching shell alive in its own pool. A pane that really is gone (view unmounted, browser
 * reloaded) is the only case that still needs the retained window replayed into a fresh xterm.
 */
const terms = new Map(); // repoPath → { wrap, term, fit, cursor, exited }
const termOrder = []; // repoPath, oldest first: the pane cache is capped like the server pool

/** How many panes to keep — the same setting the server pools shells by (prefs carry it). */
function termLimit() {
	const n = Number(state.prefs.termKeep);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

/** Drop one cached pane (the cap, a failed start, or unmount). */
function forgetTerm(p) {
	const entry = terms.get(p);
	if (!entry) return;
	try {
		entry.term.dispose();
	} catch {
		/* already disposed */
	}
	try {
		entry.wrap.remove();
	} catch {
		/* already detached */
	}
	terms.delete(p);
	// If that was the pane on screen, the view has none: without this, a disposed xterm's input handler
	// still sees a repo selected and forwards keystrokes into the void.
	if (state.termRepo === p) {
		state.termActive = null;
		state.termFit = null;
		state.termRepo = null;
		state.termExited = false;
	}
	const i = termOrder.indexOf(p);
	if (i >= 0) termOrder.splice(i, 1);
}

/** Mark a repository as the most recently used pane and evict past the cap. */
function touchTerm(p) {
	const i = termOrder.indexOf(p);
	if (i >= 0) termOrder.splice(i, 1);
	termOrder.push(p);
	while (termOrder.length > termLimit()) forgetTerm(termOrder[0]);
}

/** Record on the pane itself that its shell exited, so switching back to it is not amnesia (see showTerm). */
function markExited(p) {
	const entry = terms.get(p);
	if (entry) entry.exited = true;
}

/** The pane for `p` has rendered everything up to `cursor`; remember it, so a later catch-up asks the
 * server for the delta from there instead of being re-sent a window this pane already shows. */
function noteRendered(p, cursor) {
	const entry = terms.get(p);
	const want = Number(cursor);
	if (entry && Number.isFinite(want)) entry.cursor = want;
}

/** Show one cached pane and hide the rest; the view keeps writing into `state.termActive`. */
function showTerm(p) {
	for (const [key, other] of terms) other.wrap.style.display = key === p ? "" : "none";
	const entry = terms.get(p) ?? null;
	state.termActive = entry?.term ?? null;
	state.termFit = entry?.fit ?? null;
	state.termRepo = entry ? p : null;
	state.termExited = entry?.exited === true;
}

/** Create the xterm for a repository this view has not shown yet. */
function makeTerm(p, gly) {
	const wrap = document.createElement("div");
	wrap.style.height = "100%";
	termHost.appendChild(wrap);
	const term = new gly.Terminal({
		cursorBlink: true,
		fontSize: 12,
		fontFamily: TERM_FONT,
		scrollback: 4000,
		theme: TERM_THEME,
	});
	let fit = null;
	if (gly.FitAddon) {
		fit = new gly.FitAddon();
		fit.activate(term);
	}
	term.open(wrap);
	term.onData((d) => {
		// Send as the pane's own repository: with one cached pane per repository, `state.termRepo` is
		// whatever is on screen and the two can differ for a moment while a switch is in flight.
		if (destroyed || !state.termRepo || state.termExited) return;
		ctx.send({ action: `${PLUGIN_ID}:term-input`, repo: p, data: d });
	});
	const entry = { wrap, term, fit, cursor: null, exited: false, seat: null };
	terms.set(p, entry);
	return entry;
}

/**
 * Show the pane for a repository, creating it only if this view has never shown it. An existing pane is
 * reused and merely caught up: the server is asked what the shell produced while the pane was hidden,
 * from the cursor this client last rendered — so nothing is duplicated and nothing is torn down. Because
 * the shell stayed alive in the server's pool, the same prompt and scrollback are still there.
 */
async function openTerminal(repoPath) {
	const my = ++termOpenSeq;
	let gly;
	try {
		gly = await ensureTermClasses();
	} catch (err) {
		if (!destroyed && my === termOpenSeq) failTerminal(repoPath, `terminal engine failed to load: ${errText(err)}`);
		return;
	}
	injectTermCss();
	if (destroyed || my !== termOpenSeq) return;
	// Already on screen for this repository: nothing to attach, nothing to catch up on.
	if (state.termRepo === repoPath && state.termActive && !state.termExited) return;
	let entry = terms.get(repoPath);
	if (!entry) {
		try {
			entry = makeTerm(repoPath, gly);
		} catch (err) {
			failTerminal(repoPath, `terminal failed to start: ${errText(err)}`);
			return;
		}
	}
	touchTerm(repoPath);
	showTerm(repoPath);
	termHint.style.display = "none";
	termTitle.textContent = `terminal · ${shortName(repoPath)}`;
	try {
		entry.fit?.fit();
	} catch {
		/* resolved on the next fit */
	}
	try {
		entry.term.focus();
	} catch {
		/* focus settles after layout */
	}

	/**
	 * Attach first, spawn only when nothing is alive — the same handshake the server's pool answers. The
	 * PTY lives on the server, so the reply is the only proof a shell exists: an `ok:false` (unknown
	 * request, spawn failure, missing node-pty) has to be shown instead of leaving an empty xterm.
	 */
	const attach = await request("term-attach", { repo: repoPath });
	if (destroyed) return;
	if (my !== termOpenSeq) {
		// The selection moved on while this was in flight — release the seat, keep the shell.
		if (attach?.alive) void request("term-detach", seatDetach(repoPath, attach.seat));
		return;
	}
	let cursor = entry.cursor;
	if (attach?.alive) {
		// The seat this view now holds: its own detach has to carry this token (see seatDetach).
		entry.seat = Number(attach.seat) || null;
		// A pane that has never rendered this shell needs the window; one that is merely behind gets only
		// the delta from term-sync below — which is what makes coming back seamless.
		if (entry.cursor === null) {
			entry.term.reset?.();
			const win = typeof attach.data === "string" ? attach.data : "";
			if (win) entry.term.write(win);
			cursor = Number(attach.cursor) || 0;
		}
	} else {
		const res = await request("term-open", { repo: repoPath, cols: entry.term.cols, rows: entry.term.rows });
		if (destroyed) return;
		if (my !== termOpenSeq) {
			// Do not strand a shell nobody asked for: it was spawned for a selection that is gone.
			if (res?.ok) void request("term-close", { repo: repoPath });
			return;
		}
		if (!res?.ok) {
			failTerminal(repoPath, `terminal failed: ${res?.error ?? "no reply from the server"}`);
			return;
		}
		// A fresh shell is running here now: the pane's own exited flag has to clear with it, or a switch away
		// and back would keep claiming "exited" (see markExited and showTerm).
		entry.exited = false;
		entry.seat = Number(res.seat) || null; // the seat the fresh shell gave this view
		// The previous shell in this repository was dead or evicted: the new one inherits its window.
		entry.term.reset?.();
		const win = typeof res.data === "string" ? res.data : "";
		if (win) entry.term.write(win);
		cursor = Number(res.cursor) || 0;
	}
	const start = Number.isFinite(Number(cursor)) ? Number(cursor) : 0;
	const sync = await request("term-sync", { repo: repoPath, cursor: start });
	if (destroyed || my !== termOpenSeq) return;
	if (sync?.resync) {
		// The cursor fell behind the retained window: the server sent the window again, so replace what
		// is on screen rather than leaving a gap in it.
		entry.term.reset?.();
		if (typeof sync.data === "string" && sync.data) entry.term.write(sync.data);
	} else if (sync?.ok && typeof sync.data === "string" && sync.data) {
		entry.term.write(sync.data);
	}
	if (Number.isFinite(Number(sync?.cursor))) entry.cursor = Number(sync.cursor);
	state.termFailedRepo = null;
	state.termFailedAt = 0;
	try {
		entry.fit?.fit();
		sendTermResize();
	} catch {
		/* resolved on the next fit */
	}
}
/**
 * The detach payload for a seat this view holds. The seat token is what stops a detach from a superseded
 * openTerminal (A → B → A inside one attach round trip) freeing the seat a newer attach took for the same
 * repository: the server only honours a token that is still the current one. Without a token the server
 * falls back to matching the repository name, which is all an older server understands.
 */
function seatDetach(repo, seat) {
	const n = Number(seat);
	return Number.isFinite(n) && n > 0 ? { repo, seat: n } : { repo };
}

/**
 * Let go of every pane without killing any shell: the view is going away, the shells are not. The server
 * keeps the seats free (term-detach) so the next mount adopts the same shells, and their output stays in
 * the retained windows either way — the host's terminals outlive the view in exactly the same way.
 */
function disposeTerminals() {
	termOpenSeq++;
	const active = state.termRepo;
	// The seat this view took, read before the panes go: the release must only ever free its own, never a
	// seat a newer mount holds (see seatDetach).
	const seat = active ? terms.get(active)?.seat : null;
	for (const p of [...terms.keys()]) forgetTerm(p);
	state.termActive = null;
	state.termFit = null;
	state.termRepo = null;
	state.termExited = false;
	if (active) void request("term-detach", seatDetach(active, seat));
	showTermHint("");
	termTitle.textContent = state.selectedRepo ? `terminal · ${shortName(state.selectedRepo)}` : "terminal";
}
function syncTerminal() {
	const wantsTerm = state.prefs.termVisible === true;
	// Hiding the strip is not a teardown: the pane is only display:none, so every cached xterm keeps its
	// scrollback and the pooled shells keep running (the host does not kill a terminal because you looked
	// elsewhere either). Same when nothing is selected — leave the shell alone until it is replaced.
	if (!wantsTerm || !state.selectedRepo) {
		showTermHint("");
		return;
	}
	// Showing the pane for the selected repository goes through openTerminal even when this view already
	// has one: a cached pane is reused (no rebuild, no tear) and only has to catch up on what the shell
	// produced meanwhile.
	if (state.termRepo === state.selectedRepo && state.termActive && !state.termExited) return;
	// Throttle the automatic retry so a failing shell is not rebuilt on every render; the Term toggle
	// clears the record and retries at once.
	if (state.termFailedRepo === state.selectedRepo && Date.now() - state.termFailedAt < TERM_RETRY_MS) return;
	void openTerminal(state.selectedRepo);
}

	return { injectTermCss, ensureTermClasses, sendTermResize, fitTerm, showTermHint, errText, failTerminal, markExited, noteRendered, openTerminal, disposeTerminals, syncTerminal };
}
