/**
 * Open a local URL in the user's browser.
 *
 * Shared by `standalone/ukma.mjs` (manual runs) and the pi extension, so there is one answer to
 * "how does this platform open a link" instead of two that drift.
 *
 * `MULTIGIT_BROWSER` (or the conventional `BROWSER`) names a browser to use instead of the system default;
 * the same sentinel values the rest of the ecosystem accepts ("true", "false", "none", ":", "0", "1")
 * mean "do not open anything".
 */
import { spawn } from "node:child_process";

const NOOP_BROWSER = new Set(["true", "false", "none", ":", "0", "1"]);

/** The browser command to use, or null for the platform default. */
export function browserOverride(env = process.env) {
	const raw = env.MULTIGIT_BROWSER ?? env.BROWSER;
	if (!raw) return null;
	const value = String(raw).trim();
	if (!value || NOOP_BROWSER.has(value.toLowerCase())) return null;
	return value;
}

/** True when the environment explicitly asked for no browser to be opened. */
export function browserSuppressed(env = process.env) {
	const raw = env.MULTIGIT_BROWSER ?? env.BROWSER;
	return !!raw && NOOP_BROWSER.has(String(raw).trim().toLowerCase());
}

/**
 * Fire-and-forget: a failure to launch a browser must never fail the command that wanted one, because
 * the URL is printed either way. Resolves to whether a launcher was started.
 */
export function openInBrowser(url, { env = process.env, logger = console } = {}) {
	if (browserSuppressed(env)) return Promise.resolve(false);

	const browser = browserOverride(env);
	const platform = process.platform;

	let cmd;
	let args;
	if (browser) {
		cmd = browser;
		args = [url];
	} else if (platform === "win32") {
		// `start` reads the first quoted argument as the window title, hence the empty one.
		cmd = "cmd.exe";
		args = ["/c", "start", "", url];
	} else if (platform === "darwin") {
		cmd = "open";
		args = [url];
	} else {
		cmd = "xdg-open";
		args = [url];
	}

	return new Promise((resolveOpen) => {
		let child;
		try {
			child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
		} catch (err) {
			logger.warn?.(`multi-git: could not open a browser (${err?.message ?? err})`);
			resolveOpen(false);
			return;
		}
		child.once("error", (err) => {
			logger.warn?.(`multi-git: could not open a browser (${err?.message ?? err})`);
			resolveOpen(false);
		});
		child.once("exit", () => resolveOpen(true));
		child.unref();
		// A detached launcher that never exits (some browser wrappers) must not hold this promise open.
		setTimeout(() => resolveOpen(true), 1_500).unref?.();
	});
}