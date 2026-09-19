/**
 * Terminal plumbing: which shell to run, how to size it, and how much output one flush may carry.
 * node-pty is resolved from the host's install, never vendored here.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export const isWindows = process.platform === "win32";

/**
 * The plugin lives in its own module graph, so it cannot `import "node-pty"` by name.
 * Resolve the COPY pi-web-ui itself uses (global npm root / PI_WEB_PKG) and require it
 * by absolute path — same module instance, same ConPTY machinery as the host's terminal.
 */
export function loadNodePty() {
	if (cachedPty) return cachedPty;
	const candidates = [];
	if (process.env.PI_WEB_PKG) candidates.push(process.env.PI_WEB_PKG);
	const globalRoot = join(homedir(), "AppData", "Roaming", "npm", "node_modules");
	const apRoot = process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules") : "";
	candidates.push(join(globalRoot, "pi-web-ui"), apRoot && join(apRoot, "pi-web-ui"));
	candidates.push(join(globalRoot, "@earendil-works", "pi-coding-agent"));
	for (const p of ["/usr/lib/node_modules", "/usr/local/lib/node_modules"]) if (existsSync(p)) candidates.push(p);
	// No NODE_PATH fallback: resolving a module out of an env-controlled search path is a supply-chain
	// hole for a plugin that then executes it. PI_WEB_PKG is the explicit way to point this somewhere else.
	let lastErr = null;
	for (const base of candidates) {
		try {
			cachedPty = createRequire(join(base, "package.json"))("node-pty");
			return cachedPty;
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr ?? new Error("node-pty not found");
}

/** `-i` makes bash interactive; cmd.exe / powershell.exe are interactive on their own. */
export function bashArgs(shell) {
	return /[\\/]bash(\.exe)?$/i.test(shell) ? ["-i"] : [];
}

/**
 * Interactive shell for the PTY — the same resolution order as the host's own terminal
 * (dist/server/terminals.js → resolveShell), so this strip and the main Terminal tab never
 * disagree about which shell a repository gets:
 *   1. PI_WEB_SHELL (explicit override)   2. $SHELL when it exists on disk
 *   3. Git Bash install paths             4. busybox-w32 at ~/.pi-web/bin/bash.exe
 *   5. %COMSPEC% (cmd.exe)                6. powershell.exe (last resort)
 * Resolved per spawn (not at module load), so a busybox download that finishes after startup
 * is picked up by the next terminal. Without steps 1 and 4 this plugin would fall back to
 * cmd.exe in environments where the host still finds bash.
 */
export function resolveShell() {
	if (isWindows) {
		const explicit = process.env.PI_WEB_SHELL;
		if (explicit) return { shell: explicit, args: bashArgs(explicit) };
		const she = process.env.SHELL;
		if (she && existsSync(she)) return { shell: she, args: bashArgs(she) };
		const pf = process.env.ProgramFiles;
		const pf86 = process.env["ProgramFiles(x86)"];
		for (const cand of [pf ? join(pf, "Git", "bin", "bash.exe") : "", pf86 ? join(pf86, "Git", "bin", "bash.exe") : ""]) {
			if (cand && existsSync(cand)) return { shell: cand, args: ["-i"] };
		}
		const busybox = join(homedir(), ".pi-web", "bin", "bash.exe");
		if (existsSync(busybox)) return { shell: busybox, args: ["-i"] };
		return { shell: process.env.COMSPEC || process.env.ComSpec || "powershell.exe", args: [] };
	}
	return { shell: process.env.SHELL || "bash", args: ["-i"] };
}

/** Terminal (PTY) tuning: 16ms output coalescing, 200KB output cap per flush, 64KB input cap. */
export const TERM_FLUSH_MS = 16;

export const TERM_MAX_OUTPUT = 200_000;

export const TERM_MAX_INPUT = 64 * 1024;

/**
 * PTY geometry caps: only the lower bound is host parity (`terminal-manager` clamps at 2).
 * node-pty casts cols/rows to a 16-bit SHORT, so an absurd value from a buggy or hostile
 * client would wrap negative in CreatePseudoConsole/ResizePseudoConsole.
 */
export const TERM_MAX_COLS = 1000;

export const TERM_MAX_ROWS = 400;

/** One PTY dimension: floored, defaulted, and clamped to [2, max]. */
export function clampDim(value, fallback, max) {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(max, Math.max(2, n));
}

/* ---------------- node-pty resolution (the host already ships it) ---------------- */
export let cachedPty = null;
