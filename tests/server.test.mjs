/**
 * Server-entry checks: scan / stats / diff / log / commit against the real repositories
 * below the cwd the plugin is activated with, plus the failure paths.
 *
 *   node tests/server.test.mjs [workspace-dir]
 *
 * Uses createMockHost from the vendored sdk/ copy — no running pi-web-ui needed.
 * Defaults to this plugin's parent-of-parent workspace shape only in the sense that the
 * scanned directory is passed in; run it with the workspace you care about.
 */
import assert from "node:assert/strict";

import { createMockHost } from "../sdk/index.mjs";

const PLUGIN_ENTRY = new URL("../index.mjs", import.meta.url).href;
const CWD = process.argv[2] ?? process.cwd();

// Any live ConPTY keeps the process's loop alive; fail fast instead of hanging on an assert error.
process.on("uncaughtException", (err) => {
	console.error(err);
	process.exit(1);
});
process.on("unhandledRejection", (err) => {
	console.error(err);
	process.exit(1);
});

const plugin = (await import(PLUGIN_ENTRY)).default;
const host = createMockHost({ cwd: CWD, settings: { depth: 2, maxRepos: 40 } });
const disposeMain = await plugin.activate(host);

const ask = async (payload) => {
	await host.mock.emitAsync("onMessage", payload, "client-1");
	// match by reqId: replies can be followed by pushes (e.g. term-exit after term-close)
	const sends = host.calls.filter((c) => c.method === "sendTo").map((c) => c.args[1]);
	return sends.findLast((m) => m && m.reqId === payload.reqId) ?? sends.at(-1);
};

const shortAbs = (p) => String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

console.log(`=== scan of ${CWD} ===`);
const scan = await ask({ action: "multi-git:scan", reqId: 1 });
console.log(
	JSON.stringify(
		{
			kind: scan.kind,
			ok: scan.ok,
			cwd: scan.cwd,
			root: scan.cwd,
			repos: scan.repos.length,
			truncated: scan.truncated,
			dirsVisited: scan.dirsVisited,
			prefs: scan.prefs,
		},
		null,
		1,
	),
);
for (const r of scan.repos) {
	console.log(
		[
			r.ok ? "ok " : "ERR",
			r.name.padEnd(22),
			(r.detached ? "detached" : r.branch).padEnd(24),
			`ahead=${r.ahead} behind=${r.behind}`,
			`files=${r.counts.total}`,
			r.head ? `${r.head.short} ${r.head.when}` : "no-commits",
			r.error ? `error=${r.error}` : "",
		].join(" | "),
	);
}
assert.ok(scan.repos.length > 0, "expected at least one repository below the scan root");
assert.ok(scan.repos.every((r) => r.name && r.path), "every repo has a name and path");

const target = scan.repos.find((r) => r.counts.total > 0) ?? scan.repos[0];

/*
 * The suites run against *your* workspace, so every check that asserts "this finds something" derives its
 * file and its search needle from what is really here. Hardcoded fixture names — a particular file, one
 * repository name, a word that only occurs in one project — made the suite pass only on the checkout
 * they were written against, and a missing fixture then looked like a plugin bug. Nothing suitable →
 * the check says "skipped" out loud.
 */
const lsFiles = (await import("node:child_process")).execFileSync;
const pathJoin = (await import("node:path")).join;
const readTextFile = (await import("node:fs")).readFileSync;
const fileSize = (await import("node:fs")).statSync;
const sampleFiles = (() => {
	try {
		return lsFiles("git", ["-C", target.path, "ls-files"], { encoding: "utf8" })
			.split("\n")
			.filter((p) => p && !p.endsWith("/"));
	} catch {
		return [];
	}
})();
/** A tracked file that is small enough to read for a needle, else just the first one. */
const sampleFile =
	sampleFiles.find((p) => {
		try {
			return fileSize(pathJoin(target.path, p)).size < 262_144;
		} catch {
			return false;
		}
	}) ?? sampleFiles[0] ?? null;
const sampleName = sampleFile ? sampleFile.split("/").pop() : null;
/** A word that certainly exists in this workspace, for the content search below. */
/** The name on the target repository's newest commit, for the author filter below. */
const sampleAuthor = (() => {
	try {
		return lsFiles("git", ["-C", target.path, "log", "-1", "--format=%an"], { encoding: "utf8" }).trim() || null;
	} catch {
		return null;
	}
})();
const contentNeedle = (() => {
	if (!sampleFile) return null;
	try {
		const text = readTextFile(pathJoin(target.path, sampleFile), "utf8");
		return (text.match(/[A-Za-z][A-Za-z_-]{7,}/g) ?? [])[0] ?? null;
	} catch {
		return null;
	}
})();
console.log(`\n=== detail queries: ${target.name}: ${target.path} ===`);

const stats = await ask({ action: "multi-git:stats", reqId: 2, repo: target.path });
assert.equal(stats.ok, true);
console.log(`stats:  ${stats.ok} ${Object.keys(stats.stats ?? {}).length} paths with line counts`);

const log = await ask({ action: "multi-git:log", reqId: 3, repo: target.path });
assert.equal(log.ok, true);
console.log(`log:    ${log.ok} ${log.history?.length ?? 0} commits, first ${log.history?.[0]?.shortHash ?? "—"}`);

if (target.files[0]) {
	const diff = await ask({ action: "multi-git:diff", reqId: 4, repo: target.path, path: target.files[0].path });
	console.log(
		`diff:   ${diff.ok} ${JSON.stringify(target.files[0].path)} staged=${(diff.staged ?? "").length} worktree=${(diff.worktree ?? "").length} untracked=${diff.untracked}`,
	);
	const escape = await ask({ action: "multi-git:diff", reqId: 5, repo: target.path, path: "../../escape" });
	assert.equal(escape.ok, false, "path escape must be refused");
	console.log(`guard:  path escape refused -> ${escape.error}`);
}

if (log.history?.[0]) {
	const commit = await ask({ action: "multi-git:commit", reqId: 6, repo: target.path, hash: log.history[0].hash });
	assert.equal(commit.ok, true);
	console.log(`commit: ${commit.ok} ${(commit.text ?? "").length} chars of patch`);
}


/* ---------------- read features (v0.2.0) ---------------- */
console.log("\n=== read features: state / search / branches / sync / stashes / timeline / showfile ===");

assert.ok(target.state, "repo summary carries a state object");
assert.ok(Array.isArray(target.state.flags) && typeof target.state.indexLock === "boolean", "state shape (flags + indexLock)");
console.log(`state:   flags=${JSON.stringify(target.state.flags)} indexLock=${target.state.indexLock} worktrees=${target.state.worktrees.length} submodules=${target.state.submodules}`);

/** Search hits, so the showfile / file-history checks below can reuse one that really exists. */
let searchHits = [];
if (!contentNeedle) {
	console.log("search:  skipped (no readable tracked file in the target repository)");
} else {
	const search = await ask({ action: "multi-git:search", reqId: 10, query: contentNeedle });
	assert.equal(search.ok, true);
	assert.ok(search.results.length > 0, `content search for "${contentNeedle}" (taken from ${sampleFile}) should hit`);
	assert.ok(search.results.every((m) => m.repo && m.path && typeof m.line === "number" && typeof m.text === "string"), "every hit carries repo/path/line/text");
	searchHits = search.results;
	console.log(`search: ${search.results.length} hits for "${contentNeedle}" (first: ${shortAbs(search.results[0].repo)} ${search.results[0].path}:${search.results[0].line})`);
}

const badRegex = await ask({ action: "multi-git:search", reqId: 11, query: "([", regex: true });
assert.equal(badRegex.ok, false, "an invalid regex must be rejected");
console.log(`guard:  invalid regex rejected -> ${badRegex.error}`);
const emptyQ = await ask({ action: "multi-git:search", reqId: 20, query: "   " });
assert.equal(emptyQ.ok, false, "an empty query must be rejected");
console.log(`guard:  empty query rejected -> ${emptyQ.error}`);

const branches = await ask({ action: "multi-git:branches", reqId: 12, repo: target.path });
assert.equal(branches.ok, true);
assert.ok(branches.branches.length > 0, "branches list is non-empty");
const currentBranch = branches.branches.find((b) => b.current);
assert.ok(currentBranch, "one branch is marked current");
console.log(`branches: ${branches.branches.length} rows, current=${currentBranch.name}, default=${branches.defaultBranch ?? "—"}`);

const sync = await ask({ action: "multi-git:sync", reqId: 13, repo: target.path });
assert.equal(sync.ok, true);
assert.ok(Array.isArray(sync.unpushed) && Array.isArray(sync.incoming), "unpushed/incoming are arrays");
console.log(`sync:    upstream=${sync.upstream ?? "—"} unpushed=${sync.unpushed.length} incoming=${sync.incoming.length}`);

const stashes = await ask({ action: "multi-git:stashes", reqId: 14, repo: target.path });
assert.equal(stashes.ok, true);
assert.ok(Array.isArray(stashes.stashes), "stashes is an array (may be empty)");
console.log(`stashes: ${stashes.stashes.length} (zero is fine on a clean repo)`);

const timeline = await ask({ action: "multi-git:timeline", reqId: 15, days: 30 });
assert.equal(timeline.ok, true);
assert.ok(Array.isArray(timeline.events), "timeline events is an array");
assert.ok(timeline.events.every((e) => e.repo && e.repoName && e.hash), "every event names its repo and commit");
let timelineSorted = true;
for (let i = 1; i < timeline.events.length; i++) if (timeline.events[i - 1].date < timeline.events[i].date) timelineSorted = false;
assert.ok(timelineSorted, "timeline is sorted newest-first");
console.log(`timeline: ${timeline.events.length} commits in 30 days${timeline.events.length ? `, newest: ${shortAbs(timeline.events[0].repo)} ${timeline.events[0].shortHash} ${timeline.events[0].subject}` : ""}`);

// showfile + path-scoped log against a path we know exists (from the search hits)
if (searchHits.length) {
	const knownHit = searchHits.find((m) => m.repo === target.path) ?? searchHits[0];
	const showfile = await ask({ action: "multi-git:showfile", reqId: 16, repo: knownHit.repo, rev: "HEAD", path: knownHit.path });
	assert.equal(showfile.ok, true);
	assert.ok(((showfile.text ?? "").replace(/\n$/, "")).length > 0, "file at HEAD round-trips through show <rev>:<path>");
	console.log(`showfile: ${knownHit.path} @ HEAD (${(showfile.text ?? "").length} chars)`);
	const pathLog = await ask({ action: "multi-git:log", reqId: 17, repo: knownHit.repo, path: knownHit.path });
	assert.equal(pathLog.ok, true);
	assert.equal(pathLog.path, knownHit.path);
	assert.ok(Array.isArray(pathLog.history) && pathLog.history.length > 0, "file history is non-empty for a tracked file");
	console.log(`filelog: ${pathLog.history.length} commits touching ${knownHit.path}`);
} else {
	console.log("showfile at HEAD + file history: skipped (the content search found nothing to reuse)");
}
const revLog = await ask({ action: "multi-git:log", reqId: 18, repo: target.path, rev: "HEAD" });
assert.equal(revLog.ok, true);
assert.equal(revLog.rev, "HEAD");
console.log(`log(rev=HEAD): ${revLog.history.length} commits`);
const badRev = await ask({ action: "multi-git:showfile", reqId: 19, repo: target.path, rev: "../escape", path: "README.md" });
assert.equal(badRev.ok, false, "unsafe revision must be rejected");
console.log(`guard:  unsafe revision rejected -> ${badRev.error}`);


/* ---------------- terminal: real PTY via node-pty (v0.4.0) ---------------- */
console.log("\n=== terminal (node-pty) ===");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const allSends = () => host.calls.filter((c) => c.method === "sendTo").map((c) => c.args[1]);
const waitFor = async (pred, ms = 10_000) => {
	const start = Date.now();
	while (Date.now() - start < ms) {
		const hit = allSends().find(pred);
		if (hit) return hit;
		await sleep(80);
	}
	return null;
};

const tOpen = await ask({ action: "multi-git:term-open", reqId: 21, repo: target.path, cols: 80, rows: 24 });
assert.equal(tOpen.ok, true, tOpen.error ?? "");
assert.equal(tOpen.repo, target.path);
assert.ok(tOpen.shell, "term-open reports the shell basename");
console.log(`term-open: ok shell=${tOpen.shell} cols=${tOpen.cols} rows=${tOpen.rows}`);

// The cursor handshake: nothing streams until the client says which window it rendered, so a replay
// and live output can neither arrive out of order nor be dropped.
const tSync = await ask({ action: "multi-git:term-sync", reqId: 21, repo: target.path, cursor: tOpen.cursor ?? 0 });
assert.equal(tSync.ok, true, tSync.error ?? "");
assert.equal(tSync.resync, false, "a client that rendered the window streams from its end");
assert.ok(tOpen.alive === true, "term-open reports a live shell");

// wrapping banner/prompt comes as pushed term-data
const firstChunk = await waitFor((m) => m && m.kind === "term-data" && m.repo === target.path);
assert.ok(firstChunk, "PTY output is streamed as term-data");
console.log(`term-data: first push ${JSON.stringify(String(firstChunk.data ?? "").slice(0, 48))}`);

// typing a marker must show up in the streamed output
const marker = `MGTERM_MK_${Date.now()}`;
const tIn = await ask({ action: "multi-git:term-input", reqId: 22, repo: target.path, data: `echo ${marker}\r` });
assert.equal(tIn.ok, true, tIn.error ?? "");
const echoed = await waitFor((m) => m && m.kind === "term-data" && typeof m.data === "string" && m.data.includes(marker));
assert.ok(echoed, "typed input reaches the shell and its output streams back");
console.log("term-input: marker echoed by the shell");

// The chunk names the absolute cursor it ends at: a pane that keeps it asks for the delta next time, so
// output it already rendered is not handed out again (nothing advanced that cursor before this).
await sleep(400); // let the shell finish echoing the marker before taking the last chunk that has it
const withMarker = allSends().filter((m) => m && m.kind === "term-data" && String(m.data ?? "").includes(marker));
const lastMarkerChunk = withMarker.at(-1);
assert.ok(lastMarkerChunk, "the marker reached the stream as term-data");
assert.ok(Number.isFinite(Number(lastMarkerChunk.cursor)), "term-data carries the cursor of its last byte");
const tNoDup = await ask({ action: "multi-git:term-sync", reqId: 29, repo: target.path, cursor: Number(lastMarkerChunk.cursor) });
assert.equal(tNoDup.ok, true, tNoDup.error ?? "");
assert.equal(tNoDup.resync, false, "a pane that rendered the last marker-bearing chunk is up to date");
assert.equal(String(tNoDup.data ?? "").includes(marker), false, "…so that output is not handed out again");
console.log(`term-data: cursor ${lastMarkerChunk.cursor} travels with the chunk, re-sync repeats nothing`);

const tRz = await ask({ action: "multi-git:term-resize", reqId: 23, repo: target.path, cols: 100, rows: 30 });
assert.equal(tRz.ok, true, tRz.error ?? "");
console.log("term-resize: ok");

const tOther = await ask({ action: "multi-git:term-input", reqId: 24, repo: `${CWD}/nope`, data: "x" });
assert.equal(tOther.ok, false, "input for another repo is rejected");
const tUnknownRepo = await ask({ action: "multi-git:term-open", reqId: 25, repo: `${CWD}/nope`, cols: 80, rows: 24 });
assert.equal(tUnknownRepo.ok, false);
console.log(`term guards: ${tOther.error} / ${tUnknownRepo.error}`);

const tCl = await ask({ action: "multi-git:term-close", reqId: 26, repo: target.path });
assert.equal(tCl.ok, true, tCl.error ?? "");
const tExit = await waitFor((m) => m && m.kind === "term-exit" && m.repo === target.path, 6_000);
assert.ok(tExit, "closing the terminal reports term-exit");
console.log(`term-close: ok (exit=${tExit.exitCode})`);

// ——— retained output: the window outlives the shell, and a dead shell stays replayable ———
const tDead = await ask({ action: "multi-git:term-attach", reqId: 31, repo: target.path });
assert.equal(tDead.ok, true, tDead.error ?? "");
assert.equal(tDead.alive, false, "the shell was closed, so nothing is live");
assert.equal(tDead.exited, true, "…but its output is retained as history");
assert.ok(String(tDead.data).includes(marker), "the retained window still holds what the shell printed");
console.log(`term-attach: replaying ${String(tDead.data).length} chars of history (cursor=${tDead.cursor})`);

// a fresh shell in the same repository inherits that window instead of starting blank
const tReopen = await ask({ action: "multi-git:term-open", reqId: 32, repo: target.path, cols: 80, rows: 24 });
assert.equal(tReopen.ok, true, tReopen.error ?? "");
assert.ok(String(tReopen.data).includes(marker), "the rebuilt shell inherits its predecessor's output");
const tResync = await ask({ action: "multi-git:term-sync", reqId: 33, repo: target.path, cursor: tReopen.cursor ?? 0 });
assert.equal(tResync.ok, true, tResync.error ?? "");

// detaching keeps the shell: unmounting a view must not kill it, and the next client adopts it
const tDetach = await ask({ action: "multi-git:term-detach", reqId: 34, repo: target.path });
assert.equal(tDetach.detached, true, "detach releases the seat");
assert.equal(tDetach.alive, true, "…without killing the shell");
const tAdopt = await ask({ action: "multi-git:term-attach", reqId: 35, repo: target.path });
assert.equal(tAdopt.alive, true, "the detached shell is still there to adopt");
assert.ok(String(tAdopt.data).includes(marker), "and its window is replayable again");
const tResync2 = await ask({ action: "multi-git:term-sync", reqId: 36, repo: target.path, cursor: tAdopt.cursor ?? 0 });
assert.equal(tResync2.ok, true, "streaming resumes after the hand-off");

// A detach names its repository, like a close does: one that arrives after the pane has moved on must not
// release the seat of whichever shell is attached by then. A superseded openTerminal sends exactly that
// (its own generation was bumped while the attach was in flight).
const tDetachOther = await ask({ action: "multi-git:term-detach", reqId: 44, repo: `${CWD}/nope` });
assert.equal(tDetachOther.detached, false, "a detach naming another repository does not give up the seat");
assert.equal(tDetachOther.alive, true, "…the shell keeps running");
const tStillMine = await ask({ action: "multi-git:term-sync", reqId: 45, repo: target.path, cursor: tAdopt.cursor ?? 0 });
assert.equal(tStillMine.ok, true, "…and the attached shell is still owned and still streaming");
console.log("term-detach: a detach for another repo leaves the seat alone");

// A detach may carry the seat token its own attach was given, and the token is what separates a current
// detach from a superseded one for the SAME repository (A → B → A inside one attach round trip): with only
// the repository name to go on, that stale detach freed the seat the newest attach had just taken.
assert.ok(Number.isFinite(Number(tAdopt.seat)), "term-attach hands the seat token to the client that took it");
const tHandoff = await ask({ action: "multi-git:term-detach", reqId: 101, repo: target.path });
assert.equal(tHandoff.detached, true, "the named owner releases the seat");
const tReattach = await ask({ action: "multi-git:term-attach", reqId: 102, repo: target.path });
assert.equal(tReattach.alive, true, "…and adopting it again takes a fresh seat");
assert.ok(Number(tReattach.seat) > Number(tAdopt.seat), "the new seat is newer than the old one");
const tStaleSeat = await ask({ action: "multi-git:term-detach", reqId: 103, repo: target.path, seat: Number(tAdopt.seat) });
assert.equal(tStaleSeat.detached, false, "a superseded detach cannot release the seat a newer attach holds");
const tStillHeld = await ask({ action: "multi-git:term-sync", reqId: 104, repo: target.path, cursor: tReattach.cursor ?? 0 });
assert.equal(tStillHeld.ok, true, "…the shell is still attached and still streaming");
// A detach that names no repository and carries no token gives up nothing: `pathKey("")` is the server's own
// cwd, so resolving it would have released whichever shell happened to live there.
const tNoName = await ask({ action: "multi-git:term-detach", reqId: 105, repo: "" });
assert.equal(tNoName.detached, false, "a detach naming nothing releases nothing");
const tNoField = await ask({ action: "multi-git:term-detach", reqId: 106 });
assert.equal(tNoField.detached, false, "…also when the field is absent entirely");
// …while the seat the holder actually carries does release it, and the shell is left for the tests below.
const tSeatRelease = await ask({ action: "multi-git:term-detach", reqId: 107, repo: target.path, seat: Number(tReattach.seat) });
assert.equal(tSeatRelease.detached, true, "the current seat releases the seat");
const tReattachAgain = await ask({ action: "multi-git:term-attach", reqId: 108, repo: target.path });
assert.equal(tReattachAgain.alive, true, "the shell is still there to adopt");
console.log("term-detach: the seat token tells a current detach from a superseded one");

// ownership: a shell someone else is driving cannot be adopted without a hand-off
const replyTo = (id) => host.calls.filter((c) => c.method === "sendTo").map((c) => c.args[1]).findLast((m) => m && m.reqId === id);
await host.mock.emitAsync("onMessage", { action: "multi-git:term-attach", reqId: 37, repo: target.path }, "client-2");
assert.equal(replyTo(37)?.ok, false, "another client cannot attach to a live shell");
await ask({ action: "multi-git:term-detach", reqId: 38, repo: target.path });
await host.mock.emitAsync("onMessage", { action: "multi-git:term-attach", reqId: 39, repo: target.path }, "client-2");
assert.equal(replyTo(39)?.alive, true, "after a hand-off the next client can adopt it");
await host.mock.emitAsync("onMessage", { action: "multi-git:term-detach", reqId: 40, repo: target.path }, "client-2");

// A takeover is not silent: the shell client-2 replaces is one client-1 is driving, and a pane that keeps
// claiming to be alive would swallow every keystroke it sends (term-input is fire-and-forget on the client).
// The host's own rule is the same — terminal_exit is what tells a client the terminal it watches is gone —
// while its in-place restart of a terminal the same client owns emits nothing, because there the pane
// continues. Both halves are pinned here.
const exitsTo1 = () => host.calls.filter((c) => c.method === "sendTo" && c.args?.[0] === "client-1" && c.args?.[1]?.kind === "term-exit").map((c) => c.args[1]);
{
	await ask({ action: "multi-git:term-open", reqId: 111, repo: target.path, cols: 80, rows: 24 }); // client-1 drives it
	const before = exitsTo1().length;
	await host.mock.emitAsync("onMessage", { action: "multi-git:term-open", reqId: 112, repo: target.path, cols: 80, rows: 24 }, "client-2");
	const pushed = exitsTo1().slice(before);
	assert.equal(pushed.length, 1, "the client that was driving the replaced shell is told it exited");
	assert.equal(pushed[0].repo, target.path);
	assert.equal(replyTo(112)?.ok, true, "…and the takeover itself succeeds");
	// The same client replacing its own shell is silent, like the host's restart-in-place: the pane continues,
	// and its term-open reply clears the exited flag the push would have set.
	await ask({ action: "multi-git:term-open", reqId: 113, repo: target.path, cols: 80, rows: 24 }); // takes it back
	const beforeOwn = exitsTo1().length;
	await ask({ action: "multi-git:term-open", reqId: 114, repo: target.path, cols: 80, rows: 24 }); // its own shell
	assert.equal(exitsTo1().length, beforeOwn, "a client replacing its own shell is told nothing");
	console.log("takeover: the replaced shell's owner is told, its own restart stays silent");
}

// clear forgets the retained window, so a remount cannot resurrect text the user cleared
const tClear = await ask({ action: "multi-git:term-clear", reqId: 41, repo: target.path });
assert.equal(tClear.cleared, true);
const tAfterClear = await ask({ action: "multi-git:term-attach", reqId: 42, repo: target.path });
assert.equal(String(tAfterClear.data), "", "the retained window is empty after a clear");

// leave the terminal closed for the rest of the suite
const tCloseEnd = await ask({ action: "multi-git:term-close", reqId: 43, repo: target.path });
assert.equal(tCloseEnd.ok, true, tCloseEnd.error ?? "");
await waitFor((m) => m && m.kind === "term-exit" && m.repo === target.path, 6_000);

// ——— the pool: a shell survives a repository switch, and the oldest gives way at the cap ———
{
	const second = scan.repos.find((r) => r.path !== target.path);
	assert.ok(second, "the scan found a second repository to switch to");
	// Open a shell in the target repo first: the pool keeps it running when the pane moves on (the
	// retention block above closed its shell, so this is a fresh one).
	const openA = await ask({ action: "multi-git:term-open", reqId: 50, repo: target.path, cols: 80, rows: 24 });
	assert.equal(openA.ok, true, openA.error ?? "");
	const openB = await ask({ action: "multi-git:term-open", reqId: 51, repo: second.path, cols: 80, rows: 24 });
	assert.equal(openB.ok, true, openB.error ?? "");
	const backA = await ask({ action: "multi-git:term-attach", reqId: 52, repo: target.path });
	assert.equal(backA.alive, true, "the first repository's shell kept running while the other was used");
	const backB = await ask({ action: "multi-git:term-attach", reqId: 53, repo: second.path });
	assert.equal(backB.alive, true, "…and the second one kept running when the first got the pane back");
	console.log(`pool: both shells stay alive across a switch (${shortAbs(target.path)} ↔ ${shortAbs(second.path)})`);
	const closeA = await ask({ action: "multi-git:term-close", reqId: 54, repo: target.path });
	assert.equal(closeA.exited, true, "closing names its repository, not whichever shell holds the pane");
	const stillB = await ask({ action: "multi-git:term-attach", reqId: 55, repo: second.path });
	assert.equal(stillB.alive, true, "the other repository's shell is untouched by that close");
	await ask({ action: "multi-git:term-close", reqId: 56, repo: second.path });
}

// ——— the cap: past `termKeep`, the least recently used shell is the one that goes ———
{
	const poolHost = createMockHost({ cwd: CWD, settings: { depth: 2, maxRepos: 40, termKeep: 2 } });
	const disposePool = await plugin.activate(poolHost);
	const askPool = async (payload) => {
		await poolHost.mock.emitAsync("onMessage", payload, "client-pool");
		const sends = poolHost.calls.filter((c) => c.method === "sendTo").map((c) => c.args[1]);
		return sends.findLast((m) => m && m.reqId === payload.reqId) ?? sends.at(-1);
	};
	await askPool({ action: "multi-git:scan", reqId: 60 });
	const three = scan.repos.slice(0, 3);
	assert.equal(three.length, 3, "three repositories are needed to exceed a pool of two");
	for (const [i, r] of three.entries()) {
		const opened = await askPool({ action: "multi-git:term-open", reqId: 61 + i, repo: r.path, cols: 80, rows: 24 });
		assert.equal(opened.ok, true, opened.error ?? "");
	}
	const alive = [];
	for (const [i, r] of three.entries()) {
		const attached = await askPool({ action: "multi-git:term-attach", reqId: 70 + i, repo: r.path });
		alive.push(attached.alive);
	}
	// Exactly one eviction, of the shell that had been parked longest.
	const evictions = poolHost.calls.filter((c) => c.method === "log" && String(c.args?.[1]).startsWith("terminal evicted"));
	assert.equal(evictions.length, 1, `one eviction past the cap, got ${evictions.length}`);
	assert.equal(String(evictions[0]?.args?.[2]?.repo ?? ""), three[0].path, "the oldest shell is the one that goes");
	assert.equal(alive.filter(Boolean).length, 2, `exactly termKeep shells stay alive (got ${alive.filter(Boolean).length})`);
	assert.equal(alive[0], false, "the evicted shell is the one that is gone");
	assert.equal(alive[1], true, "the shell parked before the newest one is still live");
	assert.equal(alive[2], true, "and the newest one holds the pane");
	console.log(`pool: termKeep=2 → ${alive.filter(Boolean).length} live shells, the oldest one evicted`);
	// Its own instance means its own shells: dispose it rather than leaving them to the trailing exit.
	disposePool?.();
}


const layout = await ask({ action: "multi-git:prefs", reqId: 27, termVisible: true, widths: [320, 400], termHeight: 320 });
assert.equal(layout.ok, true);
assert.equal(layout.prefs.termVisible, true);
assert.deepEqual(layout.prefs.widths, [320, 400]);
assert.equal(layout.prefs.termHeight, 320, "the terminal-strip height round-trips");
// Out-of-range and malformed values are clamped / ignored rather than trusted.
const clamped = await ask({ action: "multi-git:prefs", reqId: 28, termHeight: 5 });
assert.equal(clamped.prefs.termHeight, 120, "below the floor is clamped up");
const reset = await ask({ action: "multi-git:prefs", reqId: 29, termHeight: null });
assert.equal(reset.prefs.termHeight, null, "null means 'no override' (the stylesheet default)");
const junk = await ask({ action: "multi-git:prefs", reqId: 30, termHeight: "tall" });
assert.equal(junk.prefs.termHeight, null, "junk is ignored");
console.log(`prefs:      termVisible=${layout.prefs.termVisible} widths=${JSON.stringify(layout.prefs.widths)} termHeight=${layout.prefs.termHeight}`);

console.log("\n=== failure paths ===");
const unknownRepo = await ask({ action: "multi-git:stats", reqId: 7, repo: `${CWD}/nope` });
assert.equal(unknownRepo.ok, false);
console.log(`unknown repo:   ${unknownRepo.error}`);
const unknownAction = await ask({ action: "multi-git:nope", reqId: 8 });
assert.equal(unknownAction.ok, false);
console.log(`unknown action: ${unknownAction.error}`);

// A regex the JS engine accepts but git's ERE engine rejects (lookahead) must surface as an
// error: silently reporting "no hits / cap reached" hid a broken query behind an empty result.
const ereReject = await ask({ action: "multi-git:search", reqId: 10, query: "foo(?=bar)", regex: true });
assert.equal(ereReject.ok, false, "an ERE git rejects is reported instead of shown as 0 hits");
assert.match(String(ereReject.error ?? ""), /regular expression/i, "the git error text is forwarded");
console.log(`bad ERE search: ${ereReject.error}`);

// A scan that was in flight when the project switched must not republish its repo allowlist.
{
	const { join: pjoin } = await import("node:path");
	const otherRoot = pjoin(CWD, "agents"); // a directory with no repositories below it
	const genHost = createMockHost({ cwd: CWD, settings: { depth: 2, maxRepos: 40 } });
	await plugin.activate(genHost);
	const askOn = async (payload, from) => {
		await genHost.mock.emitAsync("onMessage", payload, from);
		const sends = genHost.calls.filter((c) => c.method === "sendTo").map((c) => c.args[1]);
		return sends.findLast((m) => m && m.reqId === payload.reqId) ?? sends.at(-1);
	};
	const oldRepo = scan.repos[0].path;
	const inflightScan = askOn({ action: "multi-git:scan", reqId: 11 }, "c-gen");
	genHost.cwd = otherRoot;
	genHost.mock.emit("onCwdChange");
	const freshScan = await askOn({ action: "multi-git:scan", reqId: 12 }, "c-gen");
	await inflightScan;
	const staleStats = await askOn({ action: "multi-git:stats", reqId: 13, repo: oldRepo }, "c-gen");
	assert.equal(staleStats.ok, false, "the previous project's repos are no longer a valid allowlist");
	assert.equal(freshScan.repos.length, 0, "the new root genuinely has no repositories");
	console.log(`cwd switch mid-scan: stale allowlist rejected (${staleStats.error})`);
}

console.log("\n=== view toggles (persisted in the plugin's storage) ===");
const prefs = await ask({ action: "multi-git:prefs", reqId: 9, hideClean: true, autoRefreshSec: 7 });
assert.equal(prefs.ok, true);
assert.equal(prefs.prefs.hideClean, true);
assert.equal(prefs.prefs.autoRefreshSec, 7);
console.log(`prefs: ${JSON.stringify(prefs.prefs)}`);


console.log("\n=== workspace views (branches / blame / compare / search modes) ===");

// --- cross-repo branch picture
const all = await ask({ action: "multi-git:branches-all", reqId: 30 });
assert.equal(all.ok, true, all.error ?? "");
assert.equal(all.repos.length, scan.repos.length, "every scanned repo is covered");
const branchTotal = all.repos.reduce((n, r) => n + r.branches.length, 0);
assert.ok(branchTotal > 0, "branches were collected");
assert.ok(all.repos.every((r) => Array.isArray(r.branches) && r.branches.every((b) => typeof b.name === "string" && b.name.length > 0)), "branch rows carry a name");
assert.ok(all.repos.every((r) => r.branches.filter((b) => b.current).length <= 1), "at most one current branch per repo");
const unpushedGroups = all.repos.reduce((n, r) => n + r.unpushed.length, 0);
console.log(`branches-all: ${all.repos.length} repos, ${branchTotal} branches, ${unpushedGroups} unpushed groups`);

// --- blame
if (!sampleFile) {
	console.log("blame: skipped (no tracked file in the target repository)");
} else {
	const blame = await ask({ action: "multi-git:blame", reqId: 31, repo: target.path, path: sampleFile });
	assert.equal(blame.ok, true, blame.error ?? "");
	assert.ok(blame.lines.length > 0, "blame returned lines");
	assert.ok(Object.keys(blame.commits).length > 0, "blame attributed commits");
	assert.ok(blame.lines.every((l) => blame.commits[l.sha]), "every blamed line points at an attributed commit");
	console.log(`blame: ${blame.lines.length} lines from ${Object.keys(blame.commits).length} commits (${sampleFile})`);
}
const blameEscape = await ask({ action: "multi-git:blame", reqId: 32, repo: target.path, path: "../../etc/passwd" });
assert.equal(blameEscape.ok, false, "blame refuses paths outside the repo");
// --- compare (HEAD against itself, then against its parent when there is one)
const same = await ask({ action: "multi-git:compare", reqId: 33, repo: target.path, base: "HEAD", head: "HEAD" });
assert.equal(same.ok, true, same.error ?? "");
assert.equal(same.ahead, 0);
assert.equal(same.behind, 0);
assert.equal(same.history.length, 0);
const vsPrev = await ask({ action: "multi-git:compare", reqId: 34, repo: target.path, base: "HEAD~1", head: "HEAD" });
assert.equal(vsPrev.ok, true, vsPrev.error ?? "");
assert.equal(vsPrev.ahead, 1, "one commit between HEAD~1 and HEAD");
assert.equal(vsPrev.history.length, 1);
assert.ok(vsPrev.patch.length > 0, "compare returns a patch");
const badCompareRev = await ask({ action: "multi-git:compare", reqId: 35, repo: target.path, base: "-0", head: "HEAD" });
assert.equal(badCompareRev.ok, false, "option-like revisions are refused");
console.log(`compare: HEAD~1..HEAD -> ${vsPrev.history.length} commit, ${vsPrev.patch.length}b patch`);

// --- search modes
if (!sampleName) {
	console.log("path + pickaxe search: skipped (no tracked file in the target repository)");
} else {
	const files = await ask({ action: "multi-git:search", reqId: 36, query: sampleName, mode: "files" });
	assert.equal(files.ok, true, files.error ?? "");
	assert.equal(files.mode, "files");
	assert.ok(files.results.length > 0 && files.results.every((r) => typeof r.path === "string"), "path search returns file paths");
	// The regex variant matches in a worker thread (server/regex-match.mjs) — same hits, off-thread.
	const asPattern = sampleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regexFiles = await ask({ action: "multi-git:search", reqId: 40, query: asPattern, regex: true, mode: "files" });
	assert.equal(regexFiles.ok, true, regexFiles.error ?? "");
	assert.ok(regexFiles.results.length > 0, "regex path search finds the same file through the worker");
	const pickaxe = await ask({ action: "multi-git:search", reqId: 37, query: contentNeedle ?? sampleName, mode: "pickaxe" });
	assert.equal(pickaxe.ok, true, pickaxe.error ?? "");
	assert.equal(pickaxe.mode, "pickaxe");
	assert.ok(Array.isArray(pickaxe.commits), "pickaxe returns commits");
	console.log(`search: ${files.results.length} paths (${regexFiles.results.length} via the regex worker), ${pickaxe.commits.length} pickaxe commits`);
}

// --- timeline filters + patch options
if (sampleAuthor) {
	const filtered = await ask({ action: "multi-git:timeline", reqId: 38, days: 365, author: sampleAuthor });
	assert.equal(filtered.ok, true, filtered.error ?? "");
	const authorRe = new RegExp(sampleAuthor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
	assert.ok(filtered.events.every((e) => authorRe.test(e.author)), "author filter is applied");
	console.log(`timeline(author=${sampleAuthor}): ${filtered.events.length} events`);
} else {
	console.log("timeline(author): skipped (no author to filter on)");
}
const tight = await ask({ action: "multi-git:diff", reqId: 39, repo: target.path, path: sampleName ?? "", context: 0, ignoreWs: true });
assert.equal(tight.ok, true, tight.error ?? "");
console.log(`diff(-w -U0): ${(tight.staged + tight.worktree).length}b`);

/* ---------------- fixture repo: stash flows in a controlled repository ---------------- */
{
	const { mkdtempSync, writeFileSync, rmSync, symlinkSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { execFileSync } = await import("node:child_process");

	const dir = mkdtempSync(join(tmpdir(), "mg-fixture-"));
	try {
		const GITCFG = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
		writeFileSync(join(dir, "hello.txt"), "line one\nneedle line\nline three\n");
		execFileSync("git", [...GITCFG, "add", "."], { cwd: dir, stdio: "ignore" });
		execFileSync("git", [...GITCFG, "commit", "-q", "-m", "fixture baseline"], { cwd: dir, stdio: "ignore" });
		writeFileSync(join(dir, "hello.txt"), "line one\nneedle line\nchanged\n");
		execFileSync("git", [...GITCFG, "stash", "push", "-q", "-m", "fixture stash"], { cwd: dir, stdio: "ignore" });

		const fixtureHost = createMockHost({ cwd: dir, settings: { depth: 2, maxRepos: 40 } });
		await plugin.activate(fixtureHost);
		const fask = async (payload) => {
			await fixtureHost.mock.emitAsync("onMessage", payload, "client-fixture");
			const sends = fixtureHost.calls.filter((c) => c.method === "sendTo");
			return sends.at(-1)?.args?.[1];
		};

		const fscan = await fask({ action: "multi-git:scan", reqId: 1 });
		assert.equal(fscan.repos.length, 1, "fixture repo discovered");
		assert.deepEqual(fscan.repos[0].state.flags, [], "fixture repo is not mid-operation");
		const fpath = fscan.repos[0].path;

		const fstashes = await fask({ action: "multi-git:stashes", reqId: 2, repo: fpath });
		assert.equal(fstashes.ok, true);
		assert.equal(fstashes.stashes.length, 1, "stash list sees the fixture stash");
		assert.match(fstashes.stashes[0].ref, /^stash@\{\d+\}$/);
		console.log(`fixture stash: ${fstashes.stashes[0].ref} "${fstashes.stashes[0].subject}" (${fstashes.stashes[0].when})`);

		const fshow = await fask({ action: "multi-git:stashshow", reqId: 3, repo: fpath, ref: fstashes.stashes[0].ref });
		assert.equal(fshow.ok, true);
		assert.ok((fshow.text ?? "").trim().length > 0, "stashshow returns a patch");
		console.log(`fixture stashshow: ${(fshow.text ?? "").split("\n").length} lines of patch`);

		const fsearch = await fask({ action: "multi-git:search", reqId: 4, query: "needle" });
		assert.equal(fsearch.ok, true);
		assert.equal(fsearch.results.length, 1, "search finds the needle in the fixture");
		console.log(`fixture search: ${fsearch.results[0].path}:${fsearch.results[0].line}`);

		const fbranches = await fask({ action: "multi-git:branches", reqId: 5, repo: fpath });
		assert.equal(fbranches.ok, true);
		assert.ok(fbranches.branches.some((b) => b.name === "main" && b.current), "fixture branch main is current");
		console.log(`fixture branches: ${fbranches.branches.map((b) => b.name).join(", ")}`);

		const fsync = await fask({ action: "multi-git:sync", reqId: 6, repo: fpath });
		assert.equal(fsync.ok, true);
		assert.equal(fsync.upstream, null, "fixture has no upstream configured");
		console.log(`fixture sync: ${fsync.note}`);

		// Containment is realpath-based: a symlink that lives inside the repo but points out of it must not
		// be previewed. The lexical check passed it and the linked file's content came along. Creating a
		// symlink needs privileges on Windows, so this says "skipped" rather than failing the checkout.
		const outsideDir = mkdtempSync(join(tmpdir(), "mg-outside-"));
		const secretPath = join(outsideDir, "secret.txt");
		writeFileSync(secretPath, "OUTSIDE-THE-REPO-SECRET\n");
		let linked = false;
		try {
			symlinkSync(secretPath, join(dir, "leak.txt"), "file");
			linked = true;
		} catch {
			/* no symlink privileges here */
		}
		try {
			if (!linked) {
				console.log("symlink containment: skipped (cannot create a symlink here)");
			} else {
				const leak = await fask({ action: "multi-git:diff", reqId: 7, repo: fpath, path: "leak.txt" });
				assert.equal(leak.ok, false, "a symlink pointing out of the repository is refused");
				assert.ok(!String(leak.preview ?? "").includes("OUTSIDE-THE-REPO-SECRET"), "the outside file's content is not previewed");
				console.log(`symlink containment: refused (${String(leak.error).slice(0, 40)}…)`);
			}
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/* ---------------- write actions: per-file rollback + fast-forward pull ---------------- */
{
	const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { execFileSync } = await import("node:child_process");
	const GITCFG = ["-c", "user.name=tester", "-c", "user.email=test@example.com"];
	const root = mkdtempSync(join(tmpdir(), "mg-write-"));
	const run = (cwd, ...args) => {
		try {
			return execFileSync("git", [...GITCFG, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
		} catch (err) {
			const detail = String(err.stderr || err.message || "").split(String.fromCharCode(10))[0];
			throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail}`);
		}
	};
	try {
		// A bare "origin" plus two clones: a real fetch/ff-only round trip with no network.
		const origin = join(root, "origin.git");
		const work = join(root, "work");
		const peer = join(root, "peer");
		execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
		execFileSync("git", ["clone", "-q", origin, work]);
		writeFileSync(join(work, "tracked.txt"), "one\ntwo\nthree\n");
		writeFileSync(join(work, "doomed.txt"), "delete me\n");
		run(work, "add", "-A");
		run(work, "commit", "-q", "-m", "baseline");
		run(work, "push", "-q", "-u", "origin", "main");
		execFileSync("git", ["clone", "-q", origin, peer]); // cloned after the baseline: same history

		const writeHost = createMockHost({ cwd: work, settings: { depth: 2, maxRepos: 10 } });
		await plugin.activate(writeHost);
		const wask = async (payload) => {
			await writeHost.mock.emitAsync("onMessage", payload, "w1");
			const sends = writeHost.calls.filter((c) => c.method === "sendTo");
			return sends.at(-1)?.args?.[1];
		};
		const wscan = await wask({ action: "multi-git:scan", reqId: 1 });
		assert.equal(wscan.repos.length, 1, "only the working clone is a repository");
		const repo = wscan.repos[0].path;

		console.log("\n=== write actions: rollback ===");
		writeFileSync(join(work, "tracked.txt"), "one\nCHANGED\nthree\n");
		const revertMod = await wask({ action: "multi-git:revert", reqId: 10, repo, path: "tracked.txt" });
		assert.equal(revertMod.ok, true, revertMod.error ?? "");
		assert.equal(revertMod.action2, "restored");
		const restoredText = readFileSync(join(work, "tracked.txt"), "utf8");
		assert.ok(!restoredText.includes("CHANGED"), "the work-tree edit is gone");
		assert.ok(restoredText.includes("two"), "the committed content is back (line endings differ on Windows)");
		const afterRevert = await wask({ action: "multi-git:stats", reqId: 11, repo });
		assert.equal(Object.keys(afterRevert.stats).length, 0, "the file is clean after the rollback");
		console.log(`rollback (modified): ${revertMod.output}`);

		rmSync(join(work, "doomed.txt"));
		const revertDel = await wask({ action: "multi-git:revert", reqId: 12, repo, path: "doomed.txt" });
		assert.equal(revertDel.ok, true, revertDel.error ?? "");
		assert.ok(existsSync(join(work, "doomed.txt")), "the deleted file is back");
		console.log(`rollback (deleted): ${revertDel.output}`);

		writeFileSync(join(work, "scratch.txt"), "scratch\n");
		const refused = await wask({ action: "multi-git:revert", reqId: 13, repo, path: "scratch.txt" });
		assert.equal(refused.ok, false, "untracked files are refused by default");
		assert.ok(existsSync(join(work, "scratch.txt")), "…and nothing is deleted");
		assert.match(String(refused.error), /allowUntracked/);
		const deleted = await wask({ action: "multi-git:revert", reqId: 14, repo, path: "scratch.txt", allowUntracked: true });
		assert.equal(deleted.ok, true, deleted.error ?? "");
		assert.equal(deleted.action2, "deleted");
		assert.ok(!existsSync(join(work, "scratch.txt")), "the untracked file is gone after the explicit delete");
		console.log(`rollback (untracked): refused (${String(refused.error).slice(0, 40)}…) then ${deleted.output}`);

		writeFileSync(join(work, "staged-new.txt"), "new\n");
		run(work, "add", "staged-new.txt");
		const staged = await wask({ action: "multi-git:revert", reqId: 15, repo, path: "staged-new.txt", allowUntracked: true });
		assert.equal(staged.ok, true, staged.error ?? "");
		assert.ok(!existsSync(join(work, "staged-new.txt")), "a staged new file is removed");
		console.log(`rollback (staged new): ${staged.output}`);

		const escape = await wask({ action: "multi-git:revert", reqId: 16, repo, path: "../../outside.txt" });
		assert.equal(escape.ok, false, "path escapes are refused");
		const unknownRepo = await wask({ action: "multi-git:revert", reqId: 17, repo: join(root, "nope"), path: "x.txt" });
		assert.equal(unknownRepo.ok, false, "unknown repositories are refused");
		const noChanges = await wask({ action: "multi-git:revert", reqId: 18, repo, path: "tracked.txt" });
		assert.equal(noChanges.ok, false, "a clean file has nothing to roll back");
		console.log("rollback guards: escape / unknown repo / clean file all refused");

		console.log("\n=== write actions: pull ===");
		writeFileSync(join(peer, "from-peer.txt"), "peer\n");
		run(peer, "add", "-A");
		run(peer, "commit", "-q", "-m", "peer change");
		run(peer, "push", "-q", "origin", "main");
		const pull1 = await wask({ action: "multi-git:pull", reqId: 20 });
		assert.equal(pull1.ok, true, pull1.error ?? "");
		const first = pull1.results[0];
		assert.equal(first.action, "updated", `expected a fast-forward, got ${JSON.stringify(first)}`);
		assert.notEqual(first.before, first.after, "HEAD moved");
		assert.ok(existsSync(join(work, "from-peer.txt")), "the peer's file arrived");
		assert.equal(pull1.summary.updated, 1);
		console.log(`pull (fast-forward): ${first.before} → ${first.after}`);

		const pull2 = await wask({ action: "multi-git:pull", reqId: 21 });
		assert.equal(pull2.results[0].action, "up-to-date", "a second pull is a no-op");
		console.log(`pull (no-op): ${pull2.results[0].action}`);

		const headBefore = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		writeFileSync(join(work, "local-only.txt"), "local\n");
		run(work, "add", "-A");
		run(work, "commit", "-q", "-m", "local change");
		writeFileSync(join(peer, "peer-only.txt"), "peer2\n");
		run(peer, "add", "-A");
		run(peer, "commit", "-q", "-m", "peer change 2");
		run(peer, "push", "-q", "origin", "main");
		const pull3 = await wask({ action: "multi-git:pull", reqId: 22 });
		const diverged = pull3.results[0];
		assert.equal(diverged.action, "diverged", `expected divergence, got ${JSON.stringify(diverged)}`);
		assert.ok(diverged.ahead > 0 && diverged.behind > 0, "ahead and behind are both reported");
		const headAfter = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		assert.notEqual(headAfter, headBefore, "the local commit is untouched by the pull");
		assert.ok(!existsSync(join(work, "peer-only.txt")), "nothing was merged");
		assert.equal(pull3.summary.diverged, 1);
		console.log(`pull (diverged): ahead=${diverged.ahead} behind=${diverged.behind} — left alone`);

		// Regression: the untracked confirmation is per FILE, so a path matching several entries — a
		// directory, or a glob — must be refused. An `A` on the first entry used to arm the delete branch,
		// and `git rm -f -- dir/*` then removed tracked files as well, uncommitted work and all. This runs
		// last: it commits, which would otherwise move HEAD under the pull checks above.
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(work, "dir"), { recursive: true });
		writeFileSync(join(work, "dir", "tracked.txt"), "tracked\n");
		run(work, "add", "dir/tracked.txt");
		run(work, "commit", "-q", "-m", "dir baseline");
		writeFileSync(join(work, "dir", "tracked.txt"), "tracked\nPRECIOUS UNCOMMITTED WORK\n");
		writeFileSync(join(work, "dir", "new.txt"), "new\n");
		run(work, "add", "dir/new.txt");
		const asGlob = await wask({ action: "multi-git:revert", reqId: 19, repo, path: "dir/*", allowUntracked: true });
		assert.equal(asGlob.ok, false, "a path matching several entries is refused");
		assert.match(String(asGlob.error), /one file at a time/);
		assert.ok(readFileSync(join(work, "dir", "tracked.txt"), "utf8").includes("PRECIOUS"), "the tracked file's uncommitted work survives");
		assert.ok(existsSync(join(work, "dir", "new.txt")), "…and so does the staged new file");
		const asDir = await wask({ action: "multi-git:revert", reqId: 23, repo, path: "dir", allowUntracked: true });
		assert.equal(asDir.ok, false, "a directory is refused");
		console.log(`rollback guards: glob + directory refused (${String(asGlob.error).slice(0, 40)}…)`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
// Deactivate the main instance: this is the plugin's own teardown path, which must kill whatever
// shell is still live (the pool keeps several).
disposeMain?.();

console.log("\nSERVER CHECKS PASSED");

/**
 * Exit explicitly, on purpose. This suite spawns real PTYs, and on Windows node-pty leaves a conout
 * worker thread plus its socket pair behind after a shell is closed (it disposes them only if the
 * native ClosePseudoConsole call does not throw; the host's own terminal manager spawns with the same
 * options and has the same residue). Those handles keep the event loop alive, so without this the
 * suite would print its verdict and then sit there for minutes instead of exiting. Assertions all
 * completed above — a failure would already have thrown before this point.
 */
process.exit(0);
