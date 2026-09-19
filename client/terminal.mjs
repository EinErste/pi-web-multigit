/**
 * The embedded terminal: xterm wiring, the retry when the server is stale, resize fitting, and the hint that
 * replaces an empty pane.
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
	closeTerminal(true);
	state.termFailedRepo = repoPath;
	state.termFailedAt = Date.now();
	showTermHint(message);
	termTitle.textContent = `terminal · ${shortName(repoPath)} · not running`;
}
async function openTerminal(repoPath) {
	let my = ++termOpenSeq;
	let gly;
	try {
		gly = await ensureTermClasses();
	} catch (err) {
		if (!destroyed && my === termOpenSeq) failTerminal(repoPath, `terminal engine failed to load: ${errText(err)}`);
		return;
	}
	injectTermCss();
	if (destroyed || my !== termOpenSeq) return;
	if (state.termActive && state.termRepo === repoPath && !state.termExited) return;
	closeTerminal(true);
	my = ++termOpenSeq; // closeTerminal() bumped the generation to invalidate older opens — claim the newest
	let term;
	let fit;
	try {
		term = new gly.Terminal({
			cursorBlink: true,
			fontSize: 12,
			fontFamily: TERM_FONT,
			scrollback: 4000,
			theme: TERM_THEME,
		});
		if (gly.FitAddon) {
			fit = new gly.FitAddon();
			fit.activate(term);
		}
		term.open(termHost);
		try {
			term.focus();
		} catch {
			/* focus settles after layout */
		}
		term.onData((d) => {
			if (destroyed || !state.termRepo || state.termExited) return;
			ctx.send({ action: `${PLUGIN_ID}:term-input`, repo: state.termRepo, data: d });
		});
	} catch (err) {
		try {
			term?.dispose?.();
		} catch {
			/* partially constructed */
		}
		failTerminal(repoPath, `terminal failed to start: ${errText(err)}`);
		return;
	}
	state.termActive = term;
	state.termFit = fit ?? null;
	state.termRepo = repoPath;
	state.termExited = false;
	termHint.style.display = "none";
	termTitle.textContent = `terminal · ${shortName(repoPath)}`;
	if (fit) {
		try {
			fit.fit();
		} catch {
			/* resolved on the next fit */
		}
	}
	/**
	 * The PTY lives on the server, so the reply is the only proof that a shell exists:
	 * an `ok:false` (unknown request, spawn failure, missing node-pty) must be shown
	 * instead of leaving an empty xterm that never prints a prompt.
	 */
	const res = await request("term-open", { repo: repoPath, cols: term.cols, rows: term.rows });
	if (destroyed) return;
	if (my !== termOpenSeq) {
		// The selection moved on while the open was in flight — do not strand a PTY.
		if (res?.ok) void request("term-close", { repo: repoPath });
		return;
	}
	if (!res?.ok) {
		failTerminal(repoPath, `terminal failed: ${res?.error ?? "no reply from the server"}`);
		return;
	}
	state.termFailedRepo = null;
	state.termFailedAt = 0;
}
function closeTerminal(skipCloseMsg) {
	termOpenSeq++;
	const t = state.termActive;
	if (t) {
		if (!(skipCloseMsg && state.termExited)) void request("term-close", { repo: state.termRepo });
		try {
			t.dispose();
		} catch {
			/* already disposed */
		}
		state.termActive = null;
		state.termFit = null;
	}
	state.termRepo = null;
	state.termExited = false;
	showTermHint("");
	termHost.textContent = "";
	termTitle.textContent = state.selectedRepo ? `terminal · ${shortName(state.selectedRepo)}` : "terminal";
}
function syncTerminal() {
	const wantsTerm = state.prefs.termVisible === true;
	if (!wantsTerm || !state.selectedRepo) {
		if (state.termActive) closeTerminal(false);
		else showTermHint("");
		return;
	}
	if (!state.termActive || state.termRepo !== state.selectedRepo || state.termExited) {
		// Throttle the automatic retry so a failing shell is not rebuilt on every render;
		// the Term toggle clears the record and retries at once.
		if (state.termFailedRepo === state.selectedRepo && Date.now() - state.termFailedAt < TERM_RETRY_MS) return;
		void openTerminal(state.selectedRepo);
	}
}

	return { injectTermCss, ensureTermClasses, sendTermResize, fitTerm, showTermHint, errText, failTerminal, openTerminal, closeTerminal, syncTerminal };
}
