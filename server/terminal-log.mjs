/**
 * Retained terminal output — this plugin's copy of what pi-web-ui does for its own terminals
 * (`dist/server/terminals.js`: a bounded `output` window per entry, an absolute `outputOffset`, a
 * `read(id, cursor)` and a `history` map for terminals that are no longer alive).
 *
 * Why a window and not just "send everything": the client can be a brand-new xterm (view remount,
 * top-bar tab switch, browser reload), so it needs the past; and it must never receive the same
 * bytes twice, so every read is expressed against an absolute cursor that never rewinds — not even
 * when the window is trimmed or cleared, nor when a rebuilt shell inherits its predecessor's window
 * (which is what `startTotal` is for: the fresh log continues that cursor, it does not restart it).
 */

/** Mirrors MAX_OUTPUT in the host's terminal manager. */
export const TERM_MAX_OUTPUT = 200_000;

/** Mirrors MAX_TERMINAL_HISTORY: how many dead shells keep their output readable. */
export const TERM_MAX_HISTORY = 32;

export function createTerminalLog(maxOutput = TERM_MAX_OUTPUT, startTotal = 0) {
	let output = "";
	// Not always 0: a shell rebuilt in the same repository inherits its predecessor's window and has to
	// continue its cursor, so the caller seeds the position the retained text starts at (see terminal-pool).
	let total = Number(startTotal) || 0;
	return {
		append(chunk) {
			const text = typeof chunk === "string" ? chunk : "";
			if (!text) return;
			total += text.length;
			output += text;
			if (output.length > maxOutput) output = output.slice(output.length - maxOutput);
		},
		/** The retained window: the text, the absolute position it starts at, and the end cursor. */
		window() {
			return { data: output, offset: total - output.length, cursor: total };
		},
		/**
		 * Bytes after an absolute cursor. `null` means the cursor fell behind the retained window (the
		 * client missed more than the window holds): the caller answers by re-sending the window.
		 */
		since(cursor) {
			const want = Number(cursor);
			const offset = total - output.length;
			if (!Number.isFinite(want) || want < offset) return null;
			const from = Math.max(offset, Math.min(want, total));
			return { data: output.slice(from - offset), cursor: total };
		},
		/** Drop the retained text but keep `total` monotonic, so cursors already issued stay valid. */
		clear() {
			output = "";
		},
		get length() {
			return output.length;
		},
		get cursor() {
			return total;
		},
	};
}

/**
 * Retained output of shells that are no longer running, keyed by repository — the analogue of the
 * host's `history` map. Newest last; the oldest entry is evicted at the cap.
 */
export function createTerminalHistory(max = TERM_MAX_HISTORY) {
	const entries = new Map();
	return {
		/** Remember a dead shell's log. Re-setting a key refreshes its recency. */
		set(key, log) {
			if (!key || !log) return;
			entries.delete(key);
			entries.set(key, log);
			while (entries.size > max) entries.delete(entries.keys().next().value);
		},
		/** Look at an entry without consuming it: attaching to a dead shell must not eat its window. */
		get(key) {
			return entries.get(key) ?? null;
		},
		/** Take an entry out — what a new shell does when it inherits its predecessor's output. */
		take(key) {
			const log = entries.get(key);
			if (log) entries.delete(key);
			return log ?? null;
		},
		has(key) {
			return entries.has(key);
		},
		get size() {
			return entries.size;
		},
		keys() {
			return [...entries.keys()];
		},
	};
}
