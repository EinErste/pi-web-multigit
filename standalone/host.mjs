/**
 * A minimal `PluginHost` for the standalone server.
 *
 * `index.mjs`'s `activate(host)` is written against the pi-web-ui host interface. That interface is
 * small enough to satisfy here instead of forking the plugin: the module registers exactly one
 * `onMessage` handler and pushes every reply through `sendTo(from, msg)`; the other things it touches
 * are `storage` (view state) and `cwd`/`getSettings`/`log`.
 *
 * So this file is the whole adapter. Nothing in `index.mjs`, `server/` or `client/` changes, and both
 * the pi-web-ui plugin and this server keep reading the same code.
 *
 * The storage file is written in the same shape the plugin already keeps as `storage.json`, so a view
 * state saved inside pi-web-ui is picked up by the standalone server and vice versa.
 *
 * `broadcast` is a no-op: the plugin uses it only for terminal output, and the terminal is a pi-web-ui
 * feature (it needs a socket push channel this server does not implement).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function createStandaloneHost({ root, dataDir, settings = {}, onReply, logger = console } = {}) {
	const stateFile = join(dataDir, "storage.json");

	let state = {};
	try {
		const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed;
	} catch {
		/* missing or unreadable: start empty, exactly as a host that has never been written to */
	}

	/** Atomic-ish write: a torn JSON file would silently reset the user's pane sizes and toggles. */
	function flush() {
		try {
			mkdirSync(dirname(stateFile), { recursive: true });
			const tmp = `${stateFile}.tmp`;
			writeFileSync(tmp, JSON.stringify(state), "utf8");
			renameSync(tmp, stateFile);
		} catch (err) {
			logger.warn?.(`multi-git: could not persist view state (${err?.message ?? err})`);
		}
	}

	const messageHandlers = [];
	const cwdHandlers = [];
	const verbose = !!process.env.MULTIGIT_STANDALONE_DEBUG;

	const host = {
		// Where the plugin scans for repositories.
		cwd: root,
		// Where plugin-local files live (a pi-web-ui convention; the plugin only reads cwd/settings).
		dir: dataDir,
		dataDir,

		getSettings: () => settings,

		storage: {
			get: (key, fallback) => (Object.hasOwn(state, key) ? state[key] : fallback),
			set: (key, value) => {
				state[key] = value;
				flush();
			},
			delete: (key) => {
				delete state[key];
				flush();
			},
			all: () => ({ ...state }),
		},

		onMessage: (handler) => {
			if (typeof handler !== "function") return () => {};
			messageHandlers.push(handler);
			return () => {
				const i = messageHandlers.indexOf(handler);
				if (i >= 0) messageHandlers.splice(i, 1);
			};
		},

		onCwdChange: (handler) => {
			if (typeof handler !== "function") return () => {};
			cwdHandlers.push(handler);
			return () => {
				const i = cwdHandlers.indexOf(handler);
				if (i >= 0) cwdHandlers.splice(i, 1);
			};
		},

		// The server installs the reply sink at dispatch time; see standalone/server.mjs.
		sendTo: (_from, msg) => onReply?.(msg),
		broadcast: () => {},

		log: (levelOrArg, ...rest) => {
			const levels = ["debug", "info", "warn", "error"];
			const level = levels.includes(levelOrArg) ? levelOrArg : "info";
			const args = levels.includes(levelOrArg) ? rest : [levelOrArg, ...rest];
			if (level === "error" || level === "warn") logger.warn?.(`multi-git[${level}]`, ...args);
			else if (verbose) logger.log?.(`multi-git[${level}]`, ...args);
		},
	};

	/**
	 * Hand one request to the plugin's `onMessage` handler. The handler answers asynchronously through
	 * `sendTo`, so the caller awaits its own pending reply rather than this function's result; this only
	 * has to guarantee that a throwing handler cannot take the HTTP layer down with it.
	 */
	async function deliver(payload, from = "http") {
		for (const handler of [...messageHandlers]) {
			try {
				await handler(payload, from);
			} catch (err) {
				logger.warn?.(`multi-git: handler failed (${err?.message ?? err})`);
			}
		}
	}

	return { host, deliver, stateFile };
}