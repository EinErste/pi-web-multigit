/**
 * The retained output window and the history of dead shells.
 *
 * Hermetic: no server, no PTY. Pins the arithmetic the live bridge depends on — the absolute cursor
 * never rewinds (not after trimming, not after clear, nor when a rebuilt shell inherits the window), a
 * cursor that falls out of the window reports "resync" instead of silently skipping bytes, and history
 * evicts oldest-first.
 */
import assert from "node:assert/strict";

import { TERM_MAX_HISTORY, createTerminalHistory, createTerminalLog } from "../server/terminal-log.mjs";

console.log("=== terminal log ===");

console.log("1. append / window / cursor arithmetic");
{
	const log = createTerminalLog(100);
	assert.deepEqual(log.window(), { data: "", offset: 0, cursor: 0 }, "an empty log starts at zero");
	log.append("hello");
	assert.deepEqual(log.window(), { data: "hello", offset: 0, cursor: 5 });
	log.append("!");
	assert.equal(log.window().data, "hello!");
	assert.equal(log.cursor, 6, "the cursor is the absolute end");
	assert.equal(log.length, 6);
	log.append(""); // ignored
	log.append(undefined); // ignored
	assert.equal(log.cursor, 6, "junk appends change nothing");
}

console.log("2. trimming keeps the tail and moves the window offset");
{
	const log = createTerminalLog(5);
	log.append("abc");
	log.append("defgh");
	assert.equal(log.length, 5, "the window is capped");
	assert.equal(log.window().data, "defgh", "…and keeps the newest bytes");
	assert.equal(log.window().offset, 3, "the offset reports what fell off");
	assert.equal(log.window().cursor, 8);
}

console.log("3. since() hands out only unseen bytes");
{
	const log = createTerminalLog(100);
	log.append("abc");
	assert.deepEqual(log.since(0), { data: "abc", cursor: 3 }, "a new client gets everything");
	assert.deepEqual(log.since(3), { data: "", cursor: 3 }, "an up-to-date client gets nothing");
	log.append("de");
	assert.deepEqual(log.since(3), { data: "de", cursor: 5 }, "and only the new bytes after that");
	assert.deepEqual(log.since(99), { data: "", cursor: 5 }, "a cursor past the end is clamped, not an error");
	assert.equal(log.since("nonsense"), null, "a non-numeric cursor asks for a resync");
}

console.log("4. a cursor behind the window asks for a resync instead of skipping bytes");
{
	const log = createTerminalLog(4);
	log.append("abcdefgh");
	// The window now holds "efgh" from offset 4; a client that last saw offset 1 missed bytes.
	assert.equal(log.since(1), null, "it must be re-sent the window");
	assert.deepEqual(log.since(4), { data: "efgh", cursor: 8 }, "exactly at the window start is fine");
}

console.log("5. clear() drops the text but not the cursor");
{
	const log = createTerminalLog(100);
	log.append("secret");
	log.clear();
	assert.equal(log.window().data, "", "the text is gone");
	assert.equal(log.cursor, 6, "the absolute cursor is unchanged, so issued cursors stay valid");
	assert.deepEqual(log.since(6), { data: "", cursor: 6 }, "an up-to-date client is still up to date");
	log.append("new");
	assert.deepEqual(log.since(6), { data: "new", cursor: 9 }, "…and sees only what came after the clear");
}

console.log("6. history keeps dead shells, newest last, oldest evicted");
{
	const history = createTerminalHistory(3);
	for (const key of ["a", "b", "c"]) history.set(key, createTerminalLog());
	assert.equal(history.size, 3);
	history.set("d", createTerminalLog());
	assert.deepEqual(history.keys(), ["b", "c", "d"], "the oldest entry fell out at the cap");
	history.set("c", createTerminalLog()); // refresh recency
	assert.deepEqual(history.keys(), ["b", "d", "c"], "re-setting moves an entry to the newest position");
	const taken = history.take("d");
	assert.ok(taken, "take() returns the log");
	assert.equal(taken.cursor, 0);
	assert.equal(history.keys().includes("d"), false, "…and removes it, like the host's history.delete");
	assert.equal(history.take("nope"), null, "taking an unknown key is not an error");
	history.set("peek", createTerminalLog());
	assert.ok(history.get("peek"), "get() reads an entry");
	assert.equal(history.has("peek"), true, "…without consuming it (unlike take)");
	assert.equal(history.get("missing"), null, "an unknown key reads as null");
	history.set("", createTerminalLog());
	assert.equal(history.size, 3, "an empty key is ignored (3 = b, c and the peek entry above)");
	assert.equal(TERM_MAX_HISTORY, 32, "the default cap mirrors the host's MAX_TERMINAL_HISTORY");
}

console.log("7. a rebuilt shell continues its predecessor's cursor (window inheritance)");
{
	const old = createTerminalLog(10);
	old.append("0123456789abcdefghij"); // 20 chars: the window keeps the last 10, so offset 10 and cursor 20
	const win = old.window();
	assert.deepEqual(win, { data: "abcdefghij", offset: 10, cursor: 20 });
	// What terminal-pool does when a shell is rebuilt in the same repository: seed the fresh log where the
	// window starts, then append the window. Appending to a zero-based log is the bug this pins.
	const rebuilt = createTerminalLog(10, win.offset);
	rebuilt.append(win.data);
	assert.equal(rebuilt.cursor, 20, "the cursor continues where the predecessor left it");
	assert.equal(rebuilt.window().offset, 10, "…and the window still starts where it did");
	// A second tab that had rendered up to 15 in the OLD space now holds a valid cursor in the new one.
	assert.deepEqual(rebuilt.since(15), { data: "fghij", cursor: 20 }, "only the unseen tail is handed out");
	const rewound = createTerminalLog(10);
	rewound.append(win.data);
	assert.equal(rewound.cursor, 10, "a zero-based log restarts the cursor instead");
	assert.deepEqual(rewound.since(15), { data: "", cursor: 10 }, "…and answers an old cursor from the wrong space");
}

console.log("TERMINAL LOG CHECKS PASSED");
