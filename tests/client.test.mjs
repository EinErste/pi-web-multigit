/**
 * Client-view checks without a browser: a ~60-line DOM stub drives mount() through the
 * real flow — scan → select repo → stats → select file → diff → history → commit patch →
 * cwd broadcast → prefs → cleanup. Payloads come from the plugin's own server entry
 * running against real repositories, so both halves are exercised together.
 *
 *   node tests/client.test.mjs [workspace-dir]
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
// readdirSync is what the module-dependency walk below lists client/ and server/ with: without it that
// walk caught its own ReferenceError and asserted over an empty file list — a check asserting nothing.
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createMockHost } from "../sdk/index.mjs";

const CWD = process.argv[2] ?? process.cwd();

/*
 * The host serves a plugin's static files from <pluginDir>/client/ only — the whole
 * client subtree (mermaid's plugin vendors its shared code under client/vendor/ that
 * way). Imports must stay INSIDE client/: one that resolves outside (e.g. `../sdk/
 * index.mjs`) gets the SPA fallback (HTML) instead of JS and fails to load —
 * blank tab, "the plugin does not handle this action" on every action.
 */
const entrySource = readFileSync(new URL("../client/entry.mjs", import.meta.url), "utf8");
const specifiers = [...entrySource.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*["']([^"']+)["']/g)].map((m) => m[1]);
const dynamic = [...entrySource.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
console.log("0. client bundle is self-contained (client/ subtree only)");
const outside = [...specifiers, ...dynamic].filter((s) => !s.startsWith("./") || s.includes("../"));
assert.deepEqual(outside, [], "every import must stay inside client/ (host serves client/ only)");
console.log(`   imports ok: ${[...new Set([...specifiers, ...dynamic])].join(", ")}`);

/* ---------------- minimal DOM ---------------- */
class El {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.childNodes = [];
		this.parentNode = null;
		this.style = {};
		this.dataset = {};
		this._text = "";
		this._cls = new Set();
		this._listeners = {};
		this.options = [];
	}
	set className(v) {
		this._cls = new Set(String(v).split(/\s+/).filter(Boolean));
	}
	get className() {
		return [...this._cls].join(" ");
	}
	get classList() {
		const self = this;
		return {
			toggle(c, force) {
				const on = force === undefined ? !self._cls.has(c) : !!force;
				if (on) self._cls.add(c);
				else self._cls.delete(c);
				return on;
			},
			add: (c) => self._cls.add(c),
			remove: (c) => self._cls.delete(c),
			contains: (c) => self._cls.has(c),
		};
	}
	set textContent(v) {
		this._text = v == null ? "" : String(v);
		this.childNodes = [];
	}
	get textContent() {
		return this._text + this.childNodes.map((c) => c.textContent).join("");
	}
	append(...nodes) {
		for (const n of nodes) {
			if (!n) continue;
			if (n.__fragment) {
				for (const c of n.childNodes) {
					c.parentNode = this;
					this.childNodes.push(c);
				}
				continue;
			}
			n.parentNode = this;
			this.childNodes.push(n);
		}
	}
	appendChild(n) {
		this.append(n);
		return n;
	}
	remove() {
		if (!this.parentNode) return;
		const i = this.parentNode.childNodes.indexOf(this);
		if (i >= 0) this.parentNode.childNodes.splice(i, 1);
		this.parentNode = null;
	}
	addEventListener(type, fn) {
		(this._listeners[type] ||= []).push(fn);
	}
	removeEventListener(type, fn) {
		const list = this._listeners[type] ?? [];
		const i = list.indexOf(fn);
		if (i >= 0) list.splice(i, 1);
	}
	querySelector() {
		return null;
	}
}

const documentStub = {
	hidden: false,
	documentElement: { lang: "en" },
	_listeners: {},
	createElement: (tag) => new El(tag),
	createDocumentFragment: () => {
		const frag = new El("#fragment");
		frag.__fragment = true;
		return frag;
	},
	addEventListener(type, fn) {
		(this._listeners[type] ||= []).push(fn);
	},
	removeEventListener(type, fn) {
		const list = this._listeners[type] ?? [];
		const i = list.indexOf(fn);
		if (i >= 0) list.splice(i, 1);
	},
};
globalThis.document = documentStub;
globalThis.window = {
	_listeners: {},
	addEventListener(type, fn) {
		(this._listeners[type] ||= []).push(fn);
	},
	removeEventListener(type, fn) {
		const list = this._listeners[type] ?? [];
		const i = list.indexOf(fn);
		if (i >= 0) list.splice(i, 1);
	},
};

/* ---------------- helpers ---------------- */
const tick = () => new Promise((r) => setTimeout(r, 0));

const clickTab = (label) => {
	const btn = find(container, "mg-tab").find((t) => t.textContent.startsWith(label));
	assert.ok(btn, `tab "${label}" exists`);
	btn._listeners.click.forEach((fn) => fn());
};
function find(node, cls, out = []) {
	if (node._cls?.has(cls)) out.push(node);
	for (const c of node.childNodes ?? []) find(c, cls, out);
	return out;
}
function findOne(node, cls) {
	const hits = find(node, cls);
	return hits.length ? hits[0] : null;
}
function texts(node, cls) {
	return find(node, cls).map((n) => n.textContent);
}

/* ---------------- server side of the same plugin ---------------- */
const serverPlugin = (await import(new URL("../index.mjs", import.meta.url).href)).default;
const mockHost = createMockHost({ cwd: CWD, settings: { depth: 2, maxRepos: 40 } });
await serverPlugin.activate(mockHost);
const askServer = async (payload) => {
	await mockHost.mock.emitAsync("onMessage", payload, "client-1");
	const sends = mockHost.calls.filter((c) => c.method === "sendTo");
	return sends.at(-1)?.args?.[1];
};

/* ---------------- mount ---------------- */
const _viewMod = await import(new URL("../client/entry.mjs", import.meta.url).href);
const view = _viewMod.default;
const __test = _viewMod.__test;
const container = new El("div");
const sent = [];
let onData = null;
const cleanup = view.mount(container, {
	send: (msg) => sent.push(msg),
	onData: (fn) => {
		onData = fn;
		return () => {
			onData = null;
		};
	},
});

console.log("1. mount");
assert.equal(typeof cleanup, "function", "mount must return a cleanup function");
assert.ok(onData, "the view must subscribe to onData");
assert.equal(sent.length, 1, "mount should request exactly one scan");
assert.equal(sent[0].action, "multi-git:scan");
assert.equal(typeof sent[0].reqId, "number");
assert.ok(findOne(container, "mg-root"), "skeleton rendered");
const mgStyle = container.childNodes.find((n) => n.tagName === "STYLE");
assert.ok(mgStyle && mgStyle.textContent.includes(".mg-root{"), "mount attaches the stylesheet to the document");
assert.ok(findOne(container, "mg-empty").textContent.length > 0, "empty state before data");

console.log("2. scan result renders the repository list");
const scan = await askServer({ action: "multi-git:scan", reqId: sent[0].reqId });
onData(scan);
await tick();
const rows = find(container, "mg-repo");
assert.equal(rows.length, scan.repos.length, `expected ${scan.repos.length} rows, got ${rows.length}`);
assert.ok(findOne(container, "mg-repos").textContent.includes("Repositories"), "pane header");
assert.equal(find(container, "mg-branch").length, scan.repos.length, "every repo shows a branch");
console.log(`   ${rows.length} rows · ${texts(container, "mg-branch").slice(0, 3).join(", ")} …`);

console.log("3. select a repository → stats → file list");
const dirtyIndex = scan.repos.findIndex((r) => r.counts.total > 0);
assert.ok(dirtyIndex >= 0, "expected a dirty repository in the working tree");
const dirtyRepo = scan.repos[dirtyIndex];
rows[dirtyIndex].onclick();
await tick();
const statsReq = sent.at(-1);
assert.equal(statsReq.action, "multi-git:stats");
assert.equal(statsReq.repo, dirtyRepo.path);
assert.ok(findOne(container, "mg-repo-meta").textContent.includes(dirtyRepo.path), "meta shows the repo path");
onData(await askServer({ action: "multi-git:stats", reqId: statsReq.reqId, repo: dirtyRepo.path }));
await tick();
const fileRows = find(container, "mg-file");
assert.equal(fileRows.length, dirtyRepo.files.length, "one row per changed file");
console.log(`   ${fileRows.length} changed files (first: ${texts(container, "mg-file-path")[0]})`);

console.log("4. select a file → diff");
// This suite runs against the live workspace, so the first changed entry can legitimately be an
// untracked directory (which has no patch at all). Prefer a tracked text change; when the workspace
// has none, assert that the untracked path is explained instead of silently rendering nothing.
const trackedIdx = dirtyRepo.files.findIndex((f) => f.x !== "?" && f.y !== "?");
const pick = trackedIdx >= 0 ? trackedIdx : 0;
fileRows[pick].onclick();
await tick();
const diffReq = sent.at(-1);
assert.equal(diffReq.action, "multi-git:diff");
const diffReply = await askServer({ action: "multi-git:diff", reqId: diffReq.reqId, repo: dirtyRepo.path, path: diffReq.path });
onData(diffReply);
await tick();
const diffLines = find(container, "mg-line");
if (trackedIdx >= 0) {
	assert.ok(diffLines.length > 0, "diff body should contain lines");
	assert.ok(find(container, "mg-line-add").length + find(container, "mg-line-del").length > 0, "diff should contain +/- lines");
	console.log(`   ${diffLines.length} diff lines for ${diffReq.path}`);
	console.log(`   file card: ${findOne(container, "mg-dsec-head").textContent.replace(/\s+/g, " ")}`);
} else {
	assert.ok(diffReply.untracked, "the only change in this workspace is untracked");
	const body = findOne(container, "mg-diff-body").textContent;
	assert.match(body, /untracked/i, "an untracked entry says so instead of rendering an empty patch");
	console.log(`   no tracked change in the workspace — untracked branch rendered (${diffReq.path}): ${body.slice(0, 60).replace(/\s+/g, " ")}`);
}

console.log("5. history tab → commit patch");
clickTab("History");
await tick();
const logReq = sent.at(-1);
assert.equal(logReq.action, "multi-git:log");
onData(await askServer({ action: "multi-git:log", reqId: logReq.reqId, repo: dirtyRepo.path }));
await tick();
const commitRows = find(container, "mg-commit");
assert.ok(commitRows.length > 0, "commit rows should render");
console.log(`   ${commitRows.length} commits listed; first: ${findOne(container, "mg-commit-subject").textContent}`);
commitRows[0].onclick();
await tick();
const commitReq = sent.at(-1);
assert.equal(commitReq.action, "multi-git:commit");
onData(await askServer({ action: "multi-git:commit", reqId: commitReq.reqId, repo: dirtyRepo.path, hash: commitReq.hash }));
await tick();
assert.ok(find(container, "mg-line").length > 0, "commit patch should render");
console.log(`   commit patch: ${find(container, "mg-line").length} lines`);

console.log("5b. commit view: header card + file names + per-file cards");
const subject = findOne(container, "mg-dh-subject");
assert.ok(subject && subject.textContent.length > 0, "the commit subject heads the viewer");
const cards = find(container, "mg-dsec");
const indexRows = find(container, "mg-drow");
assert.ok(cards.length > 0, "at least one file card renders");
assert.equal(find(container, "mg-dsec-head").length, cards.length, "every file card has its own header");
if (cards.length > 1) assert.equal(indexRows.length, cards.length, "a multi-file commit lists every file");
else assert.equal(indexRows.length, 0, "no index for a single-file commit");
const names = texts(container, "mg-path-name");
assert.ok(names.length >= cards.length && names.every((n) => n.length > 0), "file names are visible (not just truncated paths)");
assert.ok(texts(container, "mg-counts").length >= cards.length, "per-file +/- counts are shown");
assert.ok(find(container, "mg-gut").length > 0, "diff rows carry line-number gutters");
assert.equal(find(container, "mg-copy").length, cards.length, "one copy-path action per file");
const badgeLetters = texts(container, "mg-sbadge");
assert.ok(badgeLetters.every((t) => ["A", "D", "R", "C", "M", "B"].includes(t)), `status badges are A/M/D/R/C/B, got: ${badgeLetters.join("")}`);
const dirs = texts(container, "mg-path-dir");
console.log(`   ${cards.length} files: ${names.map((n, i) => `${dirs[i] ?? ""}${n}`).slice(0, 4).join(", ")}`);
if (indexRows.length) {
	indexRows[0].onclick(); // jump to that file
	await tick();
	assert.ok(indexRows[0]._cls.has("active"), "clicking a file marks it as the active one");
	assert.ok(findOne(container, "mg-dindex-head").textContent.includes("changed file"), "the index says how many files changed");
}
const wrapBtn = find(container, "mg-btn").find((b) => b.textContent === "Wrap");
assert.ok(wrapBtn, "wrap toggle in the diff head");
wrapBtn.onclick();
await tick();
assert.ok(findOne(container, "mg-diff-body")._cls.has("mg-wrap"), "wrap mode applies to the diff body");
wrapBtn.onclick();
await tick();
assert.ok(!findOne(container, "mg-diff-body")._cls.has("mg-wrap"), "wrap mode toggles back off");

console.log("6. cwd broadcast triggers a rescan");
const before = sent.length;
onData({ action: "multi-git:cwd", cwd: CWD });
await tick();
assert.equal(sent.length, before + 1, "cwd broadcast should trigger one rescan");
assert.equal(sent.at(-1).action, "multi-git:scan");
onData({ ...scan, reqId: sent.at(-1).reqId });
await tick();

console.log("7. view toggles + footer");
const cleanBox = findOne(container, "mg-check").childNodes[0];
cleanBox.checked = true;
cleanBox.onchange();
await tick();
const prefsReq = sent.at(-1);
assert.equal(prefsReq.action, "multi-git:prefs");
assert.equal(prefsReq.hideClean, true, "toggle forwarded to the server");
onData({ action: "multi-git:data", kind: "repos", ok: false, reqId: 0, error: "boom" }); // unsolicited: must not throw
await tick();
onData(await askServer({ action: "multi-git:scan", reqId: prefsReq.reqId }));
await tick();
assert.ok(findOne(container, "mg-foot").textContent.includes("dirty"), "footer summary rendered");
// The health chips count and filter the repositories, so they live in the repository pane rather than
// in a strip above both panes.
const chipsEl = findOne(container, "mg-chips");
assert.ok(chipsEl, "the health strip is rendered");
assert.ok(chipsEl.parentNode.className.includes("mg-repos"), `the strip sits in the repository pane (${chipsEl.parentNode.className})`);
assert.ok(!container.childNodes.some((n) => n.className?.includes?.("mg-chips")), "…and not as a row above the body");

console.log("7b. the scan root is the project directory (single-root model)");
const statusBefore = findOne(container, "mg-status-repos").textContent;
const cwdEl = findOne(container, "mg-status-cwd");
// Separators differ by platform (the view echoes what the server resolved: F:\x vs F:/x), so compare
// them normalised instead of assuming the argument's spelling came back verbatim.
const samePathText = (a, b) => String(a).replace(/\\/g, "/") === String(b).replace(/\\/g, "/");
assert.ok(samePathText(cwdEl.textContent, CWD), `the header names the scan root (${cwdEl.textContent} vs ${CWD})`);
assert.ok(String(cwdEl.title).replace(/\\/g, "/").includes(String(CWD).replace(/\\/g, "/")), "…and its tooltip carries the full path");
assert.ok(findOne(container, "mg-status-dirty").textContent.length > 0, "the readout says how many repositories changed");
find(container, "mg-btn").find((b) => b.textContent === "Refresh").onclick();
await tick();
const refreshReq = sent.at(-1);
assert.equal(refreshReq.action, "multi-git:scan");
// A scan must not blank the readout: it dims it and lights a fixed-width indicator, so the header
// cannot reflow and the numbers do not disappear and come back on every refresh.
assert.equal(findOne(container, "mg-status-repos").textContent, statusBefore, "the repository count survives the scan");
assert.ok(findOne(container, "mg-status-scan").textContent.includes("scanning"), "…while an indicator says it is scanning");
assert.ok(findOne(container, "mg-sub").className.includes("scanning"), "…and the status is marked as scanning");
onData({ ...scan, reqId: refreshReq.reqId });
await tick();
assert.equal(findOne(container, "mg-status-scan").textContent, "", "the indicator clears once the scan lands");
assert.equal(findOne(container, "mg-status-repos").textContent, statusBefore, "the count is still there");
// a force refresh drops the cached patch: the viewer re-fetches what it is showing instead
// of sitting on "Loading commit…" until the row is clicked again
const refetchedCommit = sent.filter((m) => m.action === "multi-git:commit").at(-1);
assert.ok(refetchedCommit && refetchedCommit.reqId !== commitReq.reqId, "a force refresh re-requests the open commit");
onData(await askServer({ action: "multi-git:commit", reqId: refetchedCommit.reqId, repo: dirtyRepo.path, hash: refetchedCommit.hash }));
await tick();
assert.ok(find(container, "mg-line").length > 0, "the patch renders again after the re-fetch");
const subText = findOne(container, "mg-sub").textContent.replace(/\s+/g, " ");
const footText = findOne(container, "mg-foot").textContent.replace(/\s+/g, " ");
const scanRootName = String(scan.root ?? CWD).split(/[\\/]/).filter(Boolean).at(-1);
assert.ok(subText.includes(scanRootName), `the header must name the scan root (${scanRootName}), got: ${subText}`);
assert.ok(!footText.includes("roots:"), "no multi-root wording must survive in the footer");
const badges = [...new Set(texts(container, "mg-badge"))];
assert.ok(badges.every((b) => b === "cwd"), `only the cwd badge is expected, got: ${badges.join(", ")}`);
console.log(`   header: ${subText}`);
console.log(`   badges: ${badges.join(", ") || "(none)"}`);

/* ---------------- read features: search / branches / stashes / timeline ---------------- */
console.log("8. cross-repo search");
const searchInput = findOne(container, "mg-search");
searchInput.value = "startServer";
searchInput._listeners.keydown.forEach((fn) => fn({ key: "Enter", preventDefault() {} }));
await tick();
const searchReq = sent.at(-1);
assert.equal(searchReq.action, "multi-git:search");
assert.equal(searchReq.query, "startServer");
onData({
	action: "multi-git:data",
	kind: "search",
	ok: true,
	reqId: searchReq.reqId,
	query: "startServer",
	results: [{ repo: dirtyRepo.path, path: "src/index.js", line: 12, text: "startServer()" }],
	truncated: false,
});
await tick();
assert.equal(find(container, "mg-hit").length, 1, "one search hit row renders");
assert.ok(findOne(container, "mg-group")?.textContent.includes(dirtyRepo.name), `hit group names the repo (${dirtyRepo.name})`);
console.log(`   ${find(container, "mg-hit").length} hit row; group: ${findOne(container, "mg-group").textContent}`);

console.log("9. search hit → file at HEAD with matched line highlighted");
find(container, "mg-hit")[0].onclick();
await tick();
const showReq = sent.at(-1);
assert.equal(showReq.action, "multi-git:showfile");
assert.equal(showReq.path, "src/index.js");
onData({ action: "multi-git:data", kind: "showfile", ok: true, reqId: showReq.reqId, repo: dirtyRepo.path, rev: "HEAD", path: "src/index.js", text: "line1\nstartServer here\nline3\n" });
await tick();
assert.equal(find(container, "mg-line-file").length, 3, "file content rendered with line numbers");
const highlighted = find(container, "mg-line").filter((l) => l._cls.has("mg-hit"));
assert.equal(highlighted.length, 1, "the matching line is highlighted");
console.log(`   ${find(container, "mg-line-file").length} file lines, ${highlighted.length} highlighted`);

console.log("10. History action on the file → file history tab → file-at-commit");
find(container, "mg-btn").find((b) => b.textContent === "History").onclick();
await tick();
const fileLogReq = sent.at(-1);
assert.equal(fileLogReq.action, "multi-git:log");
assert.equal(fileLogReq.path, "src/index.js");
onData({
	action: "multi-git:data",
	kind: "log",
	ok: true,
	reqId: fileLogReq.reqId,
	repo: dirtyRepo.path,
	path: "src/index.js",
	history: [{ hash: "1111111111111111", shortHash: "1111111", author: "a", date: "2026-09-01", subject: "touch index", decorations: "", graph: "" }],
});
await tick();
assert.ok(findOne(container, "mg-section")?.textContent.includes("File history — src/index.js"), "file-history section header");
assert.equal(find(container, "mg-commit").length, 1, "one file-history commit row");
find(container, "mg-commit")[0].onclick();
await tick();
const fileAtReq = sent.at(-1);
assert.equal(fileAtReq.action, "multi-git:showfile");
assert.equal(fileAtReq.rev, "1111111111111111");
onData({ action: "multi-git:data", kind: "showfile", ok: true, reqId: fileAtReq.reqId, repo: dirtyRepo.path, rev: "1111111111111111", path: "src/index.js", text: "old content\n" });
await tick();
const diffTitles = find(container, "mg-diff-title");
assert.ok(diffTitles[diffTitles.length - 1].textContent.endsWith(":src/index.js"), "diff title shows rev:path");
console.log("   file history + file-at-commit ok");

console.log("11. branches tab (with tracking + unpushed)");
clickTab("Branches");
await tick();
const branchesReq = sent.findLast((m) => m.action === "multi-git:branches");
const syncReq = sent.findLast((m) => m.action === "multi-git:sync");
assert.ok(branchesReq && syncReq, "branches tab requests branches and sync");
onData({
	action: "multi-git:data",
	kind: "branches",
	ok: true,
	reqId: branchesReq.reqId,
	repo: dirtyRepo.path,
	defaultBranch: "origin/master",
	branches: [
		// `merged: true` on the default branch is the normal state of a master that has been fully merged
		// into its remote — it must never be presented as a deletion candidate.
		{ name: "master", current: true, hash: "a", date: "2 days ago", subject: "s", remote: false, upstream: "origin/master", ahead: 1, behind: 0, gone: false, merged: true },
		{ name: "origin/master", current: false, hash: "a", date: "2 days ago", subject: "s", remote: true, upstream: null, ahead: 0, behind: 0, gone: false, merged: true },
		{ name: "feat/done", current: false, hash: "b", date: "3 days ago", subject: "s", remote: false, upstream: null, ahead: 0, behind: 0, gone: false, merged: true },
	],
});
onData({ action: "multi-git:data", kind: "sync", ok: true, reqId: syncReq.reqId, repo: dirtyRepo.path, upstream: "origin/master", unpushed: [{ short: "abc1234", date: "2026-09-01", subject: "unpushed commit" }], incoming: [] });
await tick();
assert.equal(find(container, "mg-brow").length, 3, "every branch row renders");
// master and origin/master are protected; only the feature branch is a deletion candidate.
const mergedTags = find(container, "mg-state").map((t) => t.textContent).filter((t) => t.includes("safe to delete"));
assert.equal(mergedTags.length, 1, `only a non-protected merged branch says so: ${JSON.stringify(mergedTags)}`);
const badged = find(container, "mg-brow").filter((r) => /safe to delete/.test(r.textContent));
assert.ok(!badged.some((r) => /master/.test(findOne(r, "mg-brow-name").textContent)), "master is never 'safe to delete'");
assert.ok(badged.some((r) => /feat\/done/.test(findOne(r, "mg-brow-name").textContent)), "a merged feature branch still is");
assert.ok(findOne(container, "mg-section-sub")?.textContent.includes("Unpushed"), "unpushed section rendered");
assert.ok(texts(container, "mg-brow-name").some((t) => t.includes("● master")), "current branch marked");
console.log(`   ${find(container, "mg-brow").length} branch rows, unpushed section ok`);
find(container, "mg-brow")[0].onclick();
await tick();
const revLogReq = sent.at(-1);
assert.equal(revLogReq.action, "multi-git:log");
assert.equal(revLogReq.rev, "master", "branch click requests log for that rev");
onData({ action: "multi-git:data", kind: "log", ok: true, reqId: revLogReq.reqId, repo: dirtyRepo.path, rev: "master", history: [{ hash: "2222222222222222", shortHash: "2222222", author: "a", date: "2026-09-02", subject: "on master", decorations: "", graph: "" }] });
await tick();
console.log(`   branch-scoped history: ${find(container, "mg-commit").length} commit`);

console.log("12. stashes + timeline tabs");
clickTab("Stashes");
await tick();
const stashesReq = sent.at(-1);
assert.equal(stashesReq.action, "multi-git:stashes");
onData({ action: "multi-git:data", kind: "stashes", ok: true, reqId: stashesReq.reqId, repo: dirtyRepo.path, stashes: [{ ref: "stash@{0}", hash: "c0ffee0", when: "2 days ago", subject: "WIP wiggle room" }] });
await tick();
assert.ok(texts(container, "mg-commit").some((t) => t.includes("stash@{0}")), "stash row renders");
find(container, "mg-commit")[0].onclick();
await tick();
const stashShowReq = sent.at(-1);
assert.equal(stashShowReq.action, "multi-git:stashshow");
onData({ action: "multi-git:data", kind: "stashshow", ok: true, reqId: stashShowReq.reqId, repo: dirtyRepo.path, ref: "stash@{0}", text: "diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n" });
await tick();
assert.equal(find(container, "mg-line-add").length, 1, "stash patch renders + line");
assert.equal(find(container, "mg-line-del").length, 1, "stash patch renders - line");
console.log(`   stash card: ${findOne(container, "mg-dsec-head").textContent.replace(/\s+/g, " ")}`);

clickTab("Timeline");
await tick();
const timelineReq = sent.at(-1);
assert.equal(timelineReq.action, "multi-git:timeline");
onData({
	action: "multi-git:data",
	kind: "timeline",
	ok: true,
	reqId: timelineReq.reqId,
	days: 7,
	events: [{ repo: dirtyRepo.path, repoName: dirtyRepo.name, hash: "3333333333333333", shortHash: "3333333", author: "a", date: "2026-09-03", subject: "timeline event", decorations: "", graph: "" }],
});
await tick();
assert.equal(find(container, "mg-commit").length, 1, "timeline event row renders");
assert.ok(texts(container, "mg-commit-meta")[0].includes(dirtyRepo.name), "event row names the repo");
// Clicking an event opens its commit in the Diff pane, so the row must show that it is the one open.
find(container, "mg-commit")[0].onclick();
await tick();
const eventCommitReq = sent.filter((m) => m.action === "multi-git:commit").at(-1);
assert.ok(eventCommitReq, "the timeline row asks for the commit patch");
onData({ action: "multi-git:data", kind: "commit", ok: true, reqId: eventCommitReq.reqId, repo: eventCommitReq.repo, hash: eventCommitReq.hash, text: "diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n" });
await tick();
const markedEvent = find(container, "mg-commit").filter((r) => r.className.includes("active"));
assert.equal(markedEvent.length, 1, `exactly the clicked event is marked (${markedEvent.length})`);
assert.ok(markedEvent[0].textContent.includes("timeline event"), "…and it is the one the Diff pane shows");
console.log("   timeline ok, with the clicked event marked");

console.log("12b. a picked branch sticks, and its history can be left again");
{
clickTab("Branches");
await tick();
// the branches payload from the earlier step is cached, so the tab renders straight from it
const branchRows = find(container, "mg-brow");
assert.ok(branchRows.length >= 2, `branch rows are on screen (${branchRows.length})`);
const picked = branchRows.find((r) => r.textContent.includes("feat/done"));
assert.ok(picked, "a feature branch row to pick");
picked.onclick();
await tick();
// the history may come from the cache, so assert what the pane shows rather than the request
assert.ok(texts(container, "mg-section").some((t) => t.includes("Branch — feat/done")), "the pane says which branch it lists");
// …and offers a way back to the list it came from
const back = find(container, "mg-btn").find((b) => b.textContent.includes("Back"));
assert.ok(back, "the branch history offers a way back");
back.onclick();
await tick();
assert.ok(find(container, "mg-brow").length >= 2, "back lands on the branches list again");
const stillMarked = find(container, "mg-brow").filter((r) => r.className.includes("active"));
assert.equal(stillMarked.length, 1, `the branch picked last stays marked (${stillMarked.length})`);
assert.ok(stillMarked[0].textContent.includes("feat/done"), "…and it is that branch");
console.log("   branch pick: marked after going back");


}

console.log("13. full terminal (xterm seam) + splitters");
assert.equal(find(container, "mg-split").length, 2, "two draggable splitters between the three panes");
const termBtn = find(container, "mg-term-btn")[0];
assert.ok(termBtn, "Term toggle button in the middle-pane head");

// swap in FAKE xterm classes before toggling so openTerminal uses the seam
let fakeTerm = null;
class FakeTerminal {
	constructor(opts) {
		this.opts = opts;
		this.cols = 80;
		this.rows = 24;
		this.writes = [];
		this.disposed = false;
		fakeTerm = this;
	}
	open(el) {
		this._host = el;
	}
	onData(fn) {
		this._onData = fn;
	}
	write(data) {
		this.writes.push(data);
	}
	clear() {
		this.writes = [];
	}
	dispose() {
		this.disposed = true;
	}
}
class FakeFit {
	activate(t) {
		this.term = t;
	}
	fit() {
		if (this.term && fakeTerm && !fakeTerm.disposed) this.term.cols = 100;
	}
}
__test.termClasses = { Terminal: FakeTerminal, FitAddon: FakeFit };

termBtn.onclick();
await tick();
const termPrefReq = sent.filter((m) => m.action === "multi-git:prefs").at(-1);
assert.equal(termPrefReq.action, "multi-git:prefs");
assert.equal(termPrefReq.termVisible, true);
assert.ok(fakeTerm, "xterm terminal constructed via the seam");
assert.equal(fakeTerm.disposed, false, "terminal not disposed while open");
const termOpenReq = sent.find((m) => m.action === "multi-git:term-open");
assert.ok(termOpenReq, "term-open sent after toggle");
assert.equal(termOpenReq.repo, dirtyRepo.path, "shell starts in the selected repo");
assert.equal(termOpenReq.cols, 100, "fit addon resized to 100 cols");
assert.equal(termOpenReq.rows, 24);
onData({ action: "multi-git:data", kind: "term-open", ok: true, reqId: termOpenReq.reqId, repo: dirtyRepo.path, shell: "bash", cols: 100, rows: 24 });
await tick();
// a successful open must leave the shell alone (the reply guard once bumped the generation
// and immediately sent term-close for the shell it had just started)
const openIdx = sent.indexOf(termOpenReq);
assert.equal(sent.slice(openIdx + 1).filter((m) => m.action === "multi-git:term-close").length, 0, "a successful term-open is not closed again");

const termEl = findOne(container, "mg-term");
assert.equal(termEl.style.display, "", "terminal strip visible after the toggle");
onData({ ...scan, reqId: termPrefReq.reqId, prefs: { ...scan.prefs, termVisible: true, widths: [320, 400] } });
await tick();
const fixedPanes = find(container, "mg-pane-fixed");
assert.equal(fixedPanes[0].style.width, "320px", "repos pane takes the saved width");
assert.equal(fixedPanes[1].style.width, "400px", "diff pane takes the saved width");

// typing in the terminal forwards term-input
fakeTerm._onData("git status --short\r");
await tick();
const inReq = sent.at(-1);
assert.equal(inReq.action, "multi-git:term-input");
assert.equal(inReq.repo, dirtyRepo.path);
assert.equal(inReq.data, "git status --short\r");

// pushed output renders into xterm
onData({ action: "multi-git:data", kind: "term-data", repo: dirtyRepo.path, data: " M src/index.js\n" });
await tick();
assert.ok(fakeTerm.writes.some((w) => w.includes("M src/index.js")), "streamed term-data reaches xterm");

// exit marks the terminal dead and blocks further input
onData({ action: "multi-git:data", kind: "term-exit", repo: dirtyRepo.path, exitCode: 0 });
await tick();
assert.ok(fakeTerm.writes.some((w) => w.includes("[process exited]")), "exit marker written");
const sentBefore = sent.length;
fakeTerm._onData("x");
await tick();
assert.equal(sent.length, sentBefore, "no term-input after exit");

termBtn.onclick();
await tick();
const termOffPref = sent.at(-1);
assert.equal(termOffPref.termVisible, false);
assert.ok(fakeTerm.disposed, "terminal disposed on hide");
const termCloseReq = sent.find((m) => m.action === "multi-git:term-close");
assert.ok(termCloseReq, "term-close sent on hide");
assert.equal(termCloseReq.repo, dirtyRepo.path);
onData({ ...scan, reqId: termOffPref.reqId, prefs: { ...scan.prefs, termVisible: false, widths: [320, 400] } });
await tick();
assert.equal(termEl.style.display, "none", "terminal hides after toggling off");
console.log("   splitters + full-terminal open/input/stream/exit/close ok");

console.log("13b. a terminal that cannot start says so, and a later trigger retries");
termBtn.onclick(); // show the strip again → a fresh open attempt
await tick();
const failedReq = sent.filter((m) => m.action === "multi-git:term-open").at(-1);
assert.ok(failedReq, "re-showing the strip sends another term-open");
const failedTerm = fakeTerm;
onData({ action: "multi-git:data", kind: "term-open", ok: false, reqId: failedReq.reqId, error: "Unknown request: multi-git:term-open" });
await tick();
assert.ok(failedTerm.disposed, "a shell that never started leaves no live xterm behind");
assert.equal(termEl.style.display, "", "the pane stays visible so the reason can be read");
assert.ok(findOne(container, "mg-term-title").textContent.includes("not running"), "title reports that no shell is running");
assert.ok(findOne(container, "mg-term-hint").textContent.includes("Unknown request"), "the server's error is shown in the pane, not swallowed");
const beforeTyping = sent.length;
failedTerm._onData("x");
await tick();
assert.equal(sent.length, beforeTyping, "typing into a terminal that never started sends nothing");

// the automatic retry is throttled (the pane is re-rendered by every auto-refresh tick),
// then an explicit Term toggle retries at once — no page reload either way
const openCountBefore = sent.filter((m) => m.action === "multi-git:term-open").length;
onData({ action: "multi-git:cwd", cwd: CWD });
await tick();
const scanReq1 = sent.filter((m) => m.action === "multi-git:scan").at(-1);
onData({ ...scan, reqId: scanReq1.reqId, prefs: { ...scan.prefs, termVisible: true, widths: [320, 400] } });
await tick();
assert.equal(sent.filter((m) => m.action === "multi-git:term-open").length, openCountBefore, "a failing open is not retried on every render");
termBtn.onclick(); // hide
await tick();
termBtn.onclick(); // and show again: an explicit toggle skips the throttle
await tick();
const toggleReq = sent.filter((m) => m.action === "multi-git:term-open").at(-1);
assert.ok(toggleReq && toggleReq.reqId !== failedReq.reqId, "toggling the strip retries the open immediately");
onData({ action: "multi-git:data", kind: "term-open", ok: false, reqId: toggleReq.reqId, error: "still broken" });
await tick();

// once the throttle window has passed, the periodic render retries by itself again
const realNow = Date.now;
Date.now = () => realNow() + 60_000;
onData({ action: "multi-git:cwd", cwd: CWD });
await tick();
const scanReq2 = sent.filter((m) => m.action === "multi-git:scan").at(-1);
onData({ ...scan, reqId: scanReq2.reqId, prefs: { ...scan.prefs, termVisible: true, widths: [320, 400] } });
await tick();
Date.now = realNow;
const retryReq = sent.filter((m) => m.action === "multi-git:term-open").at(-1);
assert.ok(retryReq.reqId !== toggleReq.reqId, "the open is retried once the throttle window has passed");
assert.equal(fakeTerm.disposed, false, "the retry leaves a live xterm");
onData({ action: "multi-git:data", kind: "term-open", ok: true, reqId: retryReq.reqId, repo: dirtyRepo.path, shell: "bash", cols: 100, rows: 24 });
await tick();
assert.equal(findOne(container, "mg-term-hint").style.display, "none", "the error hint is hidden once a shell is running");
assert.ok(!findOne(container, "mg-term-title").textContent.includes("not running"), "title drops the failure note");
fakeTerm._onData("git status\r");
await tick();
assert.equal(sent.at(-1).action, "multi-git:term-input", "typing works again after a successful retry");
console.log("   failed open is surfaced + retried ok");

console.log("15. workspace health strip, filters, fetch, cross-repo tabs, blame, compare, patch options");

// --- health chips
const chipBtns = find(container, "mg-chipbtn");
assert.equal(chipBtns.length, 7, `one chip per attention state, got ${chipBtns.length}`);
chipBtns[0].onclick(); // renderChips() rebuilds the strip, so re-query after every click
await tick();
assert.ok(find(container, "mg-chipbtn")[0]._cls.has("active"), "clicking a chip activates it");
assert.ok(find(container, "mg-repo").length >= 1, "the dirty filter still lists repos");
find(container, "mg-chipbtn")[0].onclick();
await tick();
assert.ok(!find(container, "mg-chipbtn")[0]._cls.has("active"), "clicking again clears the filter");

// --- repo name filter + grouping
const repoFilter = find(container, "mg-filter")[0];
// Filter on a name that really exists here (a hardcoded one only matched the author's checkout), and
// assert narrowing relatively so a workspace holding a single repository passes as well.
const reposBeforeFilter = find(container, "mg-repo").length;
repoFilter.value = findOne(container, "mg-repo-name").textContent;
repoFilter.oninput();
await tick();
const reposAfterFilter = find(container, "mg-repo").length;
assert.ok(reposAfterFilter >= 1, "the name filter keeps the repository it names");
assert.ok(reposBeforeFilter === 1 || reposAfterFilter < reposBeforeFilter, "the name filter narrows the list");
repoFilter.value = "";
repoFilter.oninput();
await tick();
const groupSelEl = find(container, "mg-select").find((s) => s.textContent.includes("Group:"));
groupSelEl.value = "prefix";
groupSelEl.onchange();
await tick();
assert.ok(find(container, "mg-group-head").length > 0, "grouping renders section headers");
groupSelEl.value = "none";
groupSelEl.onchange();
await tick();
console.log(`   ${chipBtns.length} chips, filter + grouping ok`);

// --- fetch button
const fetchButton = find(container, "mg-btn").find((b) => b.textContent === "Fetch");
assert.ok(fetchButton, "fetch button in the header");
fetchButton.onclick(); // arms
assert.ok(fetchButton._cls.has("armed"), "fetch arms before acting");
fetchButton.onclick(); // confirms
await tick();
const fetchReq = sent.at(-1);
assert.equal(fetchReq.action, "multi-git:fetch");
onData({ action: "multi-git:data", kind: "fetch", ok: true, reqId: fetchReq.reqId, results: [{ repo: dirtyRepo.path, ok: true, upstream: "origin/master", ahead: 0, behind: 2 }], summary: { repos: 1, failed: 0, behind: 1, ahead: 0, noUpstream: 0 } });
await tick();
const scanAfterFetch = sent.filter((m) => m.action === "multi-git:scan").at(-1);
assert.ok(scanAfterFetch.reqId > fetchReq.reqId, "a fetch triggers a fresh scan");
onData({ ...scan, reqId: scanAfterFetch.reqId, prefs: { ...scan.prefs, termVisible: false, widths: [320, 400] } });
await tick();
assert.ok(findOne(container, "mg-chips").textContent.includes("behind"), "the fetch summary is shown");
console.log("   fetch triggers a rescan and reports the summary");

// --- search modes
const modeSel = findOne(container, "mg-select-sm");
modeSel.value = "files";
modeSel.onchange();
await tick();
searchInput.value = "src/index.js";
searchInput._listeners.keydown.forEach((fn) => fn({ key: "Enter", preventDefault() {} }));
await tick();
const filesReq = sent.at(-1);
assert.equal(filesReq.action, "multi-git:search");
assert.equal(filesReq.mode, "files", "the mode is sent to the server");
onData({ action: "multi-git:data", kind: "search", ok: true, reqId: filesReq.reqId, query: "src/index.js", mode: "files", results: [{ repo: dirtyRepo.path, repoName: dirtyRepo.name, path: "packages/app/src/index.js" }], truncated: false });
await tick();
assert.equal(find(container, "mg-hit").length, 1, "path hits render");
assert.ok(texts(container, "mg-hit-path")[0].includes("index.js"), "the file name is shown");
find(container, "mg-search-clear")[0].onclick();
await tick();

// --- workspace tab (branches across repos + unpushed)
find(container, "mg-tab").find((t) => t.textContent === "Workspace")._listeners.click.forEach((fn) => fn());
await tick();
const wsReq = sent.at(-1);
assert.equal(wsReq.action, "multi-git:branches-all");
const wsData = await askServer({ action: "multi-git:branches-all", reqId: wsReq.reqId });
onData(wsData);
await tick();
assert.ok(find(container, "mg-ws-summary").length === 1, "workspace summary renders");
const wsSegTitles = texts(container, "mg-seg-title");
assert.ok(wsSegTitles.includes("Unpushed"), `unpushed segment rendered: ${wsSegTitles.join(", ")}`);
assert.ok(wsSegTitles.includes("Branches across repositories"), "cross-repo branches segment rendered");
assert.ok(wsSegTitles.includes("Cleanup candidates"), "cleanup segment rendered");
assert.ok(!wsSegTitles.includes("Tickets across repositories"), "no ticket-key section by default");
const wsBranches = find(container, "mg-brow");
// Nested groups (per branch, per repo) arrive folded: the tab reads as an index. Only a branch that
// really exists in 2+ repositories nests — derive that from the payload, because a workspace whose
// repositories share no branch name (or hold a single repository) has nothing to fold.
const sharedNames = (() => {
	const byName = new Map();
	for (const r of wsData.repos ?? []) {
		for (const b of r.branches ?? []) {
			if (/^(main|master)$/.test(b.name)) continue; // a default branch in several repos is not a feature
			if (!byName.has(b.name)) byName.set(b.name, new Set());
			byName.get(b.name).add(r.repo);
		}
	}
	return [...byName].filter(([, repos]) => repos.size > 1).map(([name]) => name);
})();
const foldedHeads = find(container, "mg-seg").filter((h) => h.title === "Expand");
if (sharedNames.length) {
	assert.ok(foldedHeads.length > 0, `nested segments start folded (${foldedHeads.length} of ${find(container, "mg-seg").length})`);
	const foldedTitles = foldedHeads.map((h) => h.textContent);
	assert.ok(foldedTitles.some((t) => sharedNames.some((name) => t.includes(name))), `…and they are the group headers: ${foldedTitles.slice(0, 3).join(" | ")}`);
} else {
	console.log("   nested folds: skipped (no branch is shared by two repositories here)");
}
// Grouping is explicit, and by default it is the full branch name (no key extraction).
const groupBar = findOne(container, "mg-groupbar");
assert.ok(groupBar, "the grouping bar is rendered");
assert.equal(findOne(container, "mg-groupbar-state").textContent, "grouped by full branch name", "the default grouping is named");
assert.ok(findOne(container, "mg-groupbar-input").placeholder.includes("full branch name"), "the input documents the default");
// folding: the header hides its body, the row count stays, and nothing is refetched
const foldHead = find(container, "mg-seg").find((head) => head.textContent.includes("Unpushed"));
const wsBefore = sent.length;
foldHead.onclick(); // `.onclick`, like every other row handler in the client
await tick();
assert.ok(foldHead.textContent.startsWith("▸"), "a folded segment shows the collapsed chevron");
const foldPrefs = sent.slice(wsBefore).find((m) => m.action === "multi-git:prefs");
assert.ok(foldPrefs, "folding persists the folded set");
assert.ok(foldPrefs.collapsed.some((k) => k === "ws:unpushed"), `the folded key is sent: ${JSON.stringify(foldPrefs.collapsed)}`);
assert.equal(sent.slice(wsBefore).filter((m) => m.action === "multi-git:branches-all").length, 0, "folding refetches nothing");
foldHead.onclick();
await tick();
assert.ok(foldHead.textContent.startsWith("▾"), "unfolding restores the chevron");
// The Workspace tab is about branches across repositories: release branches live in their own tab.
assert.ok(!wsSegTitles.includes("Release branches"), "the release segment is gone from the workspace tab");
assert.equal(find(container, "mg-rel").length, 0, "no release rows in the workspace tab");
console.log(`   workspace: ${wsSegTitles.length} segments · ${wsBranches.length} rows · folding ok`);

// --- branch grouping rules (pure helper: the live workspace's branches are not ours to pick)
const branch = (repoName, name, defaultRef = "origin/master") => ({ repo: `C:/ws/${repoName}`, repoName, name, defaultRef, ahead: 0, behind: 0, gone: false, merged: false, current: false });
const groupOf = (list, pattern) => __test.groupBranches(list, pattern);

console.log("   grouping: full branch name by default");
{
	const shared = [
		branch("alpha", "master"),
		branch("beta", "master"),
		branch("gamma", "master"),
		branch("alpha", "feat/same-name"),
		branch("beta", "feat/same-name"),
		branch("alpha", "feat/only-in-alpha"),
	];
	const { groups, unmatched, defaultSkipped } = groupOf(shared, "");
	assert.deepEqual(groups.map((g) => g.key), ["feat/same-name"], `only names shared by 2+ repos group: ${JSON.stringify(groups.map((g) => g.key))}`);
	assert.equal(groups[0].list.length, 2, "both repositories are listed");
	assert.equal(defaultSkipped, 3, "every repo's default branch is skipped (master in 3 repos is not a feature)");
	assert.equal(unmatched, 0, "with no pattern nothing is 'unmatched'");
	console.log(`   → 1 group (feat/same-name), ${defaultSkipped} default-branch entries skipped`);
}

console.log("   grouping: a pattern groups by its first capture group");
{
	const list = [
		branch("alpha", "master"),
		branch("beta", "master"),
		branch("alpha", "feat/ab12cd34__add-thing"),
		branch("beta", "feat/ab12cd34__other-part"),
		branch("gamma", "feat/unrelated-name"),
	];
	const { groups, unmatched } = groupOf(list, "([0-9a-z]{8,12})__");
	assert.deepEqual(groups.map((g) => g.key), ["ab12cd34"], `the capture group is the key: ${JSON.stringify(groups.map((g) => g.key))}`);
	assert.equal(groups[0].list.length, 2, "…and it groups branches whose names differ");
	assert.equal(unmatched, 1, "the branch that did not match is counted, not dropped");
	// a pattern without a capture group groups by the whole match; an invalid one never throws
	assert.deepEqual(groupOf([branch("a", "CU-1234-x"), branch("b", "CU-1234-y")], "[A-Z]+-\\d+").groups.map((g) => g.key), ["CU-1234"], "whole-match grouping");
	assert.equal(groupOf([branch("a", "x"), branch("b", "x")], "([0-9").groups.length, 1, "an invalid pattern falls back to full names");
	console.log(`   → 1 group (ab12cd34) from 2 differently named branches, ${unmatched} unmatched`);
}

console.log("   grouping: the view shows and edits what is being grouped");
// The bar renders from state.prefs, so no request is needed here — and a fabricated reply must never
// be fed to a pending request of another action (that replaces unrelated state).
assert.ok(findOne(container, "mg-groupbar"), "the grouping bar is on screen");
assert.equal(findOne(container, "mg-groupbar-state").textContent, "grouped by full branch name", "the default is named in the bar");
const patternInput = findOne(container, "mg-groupbar-input");
patternInput.value = "([0-9a-z]{8,12})__";
const beforePattern = sent.length;
find(container, "mg-btn").filter((b) => b.textContent === "Apply").forEach((b) => b.onclick());
await tick();
const patternPrefs = sent.slice(beforePattern).find((m) => m.action === "multi-git:prefs");
assert.ok(patternPrefs, "applying a pattern persists it");
assert.deepEqual(patternPrefs.branchGroups, { [scan.cwd]: "([0-9a-z]{8,12})__" }, `stored per workspace root: ${JSON.stringify(patternPrefs.branchGroups)}`);
assert.ok(findOne(container, "mg-groupbar-state").textContent.includes("this workspace"), "the bar says where the pattern comes from");

console.log("   grouping: an invalid pattern is refused, clearing falls back to the setting");
patternInput.value = "([0-9";
const beforeInvalid = sent.length;
find(container, "mg-btn").filter((b) => b.textContent === "Apply").forEach((b) => b.onclick());
await tick();
// The bar is re-rendered after every apply, so the live nodes must be re-queried (the old input is
// detached and a click on its stale Apply button would re-save the previous value).
const liveInput = () => findOne(container, "mg-groupbar-input");
const clickBar = (label) => find(container, "mg-btn").filter((b) => b.textContent === label).forEach((b) => b.onclick());
liveInput().value = "([0-9";
clickBar("Apply");
await tick();
// The invariant is that every pattern that reaches storage is a valid regex (a previous apply may
// still be in flight, so counting requests would be brittle).
const storedPatterns = sent.filter((m) => m.action === "multi-git:prefs").flatMap((m) => Object.values(m.branchGroups ?? {}));
assert.ok(!storedPatterns.includes("([0-9"), `the invalid pattern was never stored: ${JSON.stringify(storedPatterns)}`);
for (const stored of storedPatterns) assert.doesNotThrow(() => new RegExp(stored), `stored pattern must compile: ${stored}`);
assert.ok(String(findOne(container, "mg-foot").textContent).includes("Invalid pattern"), "the refusal is reported in the footer");
clickBar("↺");
await tick();
const cleared = sent.filter((m) => m.action === "multi-git:prefs").at(-1);
assert.deepEqual(cleared.branchGroups, {}, "clearing removes this workspace's entry");
assert.equal(findOne(container, "mg-groupbar-state").textContent, "grouped by full branch name", "back to the default");

// Blame needs a tracked file with history. This workspace is committed clean some days, so when the
// only change is an untracked entry, say so instead of asserting on a view that cannot render — the
// fixture section at the end covers blame, compare and the diff view on a repository it builds.
find(container, "mg-search-clear")[0].onclick();
await tick();
// re-select the dirty repo (the pin click above moved the selection to its consumer)
find(container, "mg-repo").find((r) => r.textContent.includes(dirtyRepo.name)).onclick();
await tick();
// Ask for the stats explicitly: earlier blocks (grouping, folding) leave their own requests behind,
// so "the last message sent" is not necessarily this one.
const statsAgain = sent.findLast((m) => m.action === "multi-git:stats");
onData(await askServer({ action: "multi-git:stats", reqId: statsAgain.reqId, repo: dirtyRepo.path }));
await tick();
find(container, "mg-tab").find((t) => t.textContent.startsWith("Changes"))._listeners.click.forEach((fn) => fn());
await tick();
assert.ok(find(container, "mg-file").length > 0, "the changes list is back for the dirty repo");
const blameFile = find(container, "mg-file")[trackedIdx >= 0 ? trackedIdx : 0];
blameFile.onclick();
await tick();
onData(await askServer({ action: "multi-git:diff", reqId: sent.at(-1).reqId, repo: dirtyRepo.path, path: sent.at(-1).path }));
await tick();
if (trackedIdx < 0) {
	console.log("   skipped: no tracked change in this workspace (blame/compare/diff covered by the fixture section)");
} else {
	find(container, "mg-btn").find((b) => b.textContent === "Blame").onclick();
	await tick();
	const blameReq = sent.at(-1);
	assert.equal(blameReq.action, "multi-git:blame");
	onData(await askServer({ action: "multi-git:blame", reqId: blameReq.reqId, repo: blameReq.repo, path: blameReq.path }));
	await tick();
	const blameRows = find(container, "mg-blame-hash");
	assert.ok(blameRows.length > 0, "blame rows render with commit links");
	blameRows[0].onclick();
	await tick();
	assert.equal(sent.at(-1).action, "multi-git:commit", "clicking a blame hash opens that commit");
	console.log(`   blame: ${blameRows.length} rows`);
}

// --- compare view from the branches tab
find(container, "mg-tab").find((t) => t.textContent.startsWith("Branches"))._listeners.click.forEach((fn) => fn());
await tick();
const branchReq = sent.filter((m) => m.action === "multi-git:branches").at(-1);
onData(await askServer({ action: "multi-git:branches", reqId: branchReq.reqId, repo: dirtyRepo.path }));
await tick();
const cmpBtn = find(container, "mg-btn").find((b) => b.textContent === "Compare");
assert.ok(cmpBtn, "compare action on a local branch");
cmpBtn.onclick();
await tick();
const cmpReq = sent.at(-1);
assert.equal(cmpReq.action, "multi-git:compare");
assert.ok(cmpReq.base && cmpReq.head, "compare carries both revisions");
onData(await askServer({ action: "multi-git:compare", reqId: cmpReq.reqId, repo: cmpReq.repo, base: cmpReq.base, head: cmpReq.head }));
await tick();
const cmpTitles = find(container, "mg-diff-title");
assert.ok(cmpTitles[cmpTitles.length - 1].textContent.includes("..."), "compare title shows base...head");
// a branch that really diverges: synthetic payload with commits + a patch
cmpBtn.onclick();
await tick();
const cmpReq2 = sent.filter((m) => m.action === "multi-git:compare").at(-1);
onData({
	action: "multi-git:data",
	kind: "compare",
	ok: true,
	reqId: cmpReq2.reqId,
	repo: dirtyRepo.path,
	base: "master",
	head: "feature/x",
	ahead: 2,
	behind: 1,
	history: [{ hash: "9999999999999999", shortHash: "9999999", author: "a", date: "2026-09-02", subject: "compare commit", decorations: "", graph: "" }],
	stats: { "src/index.js": [3, 1] },
	patch: ["diff --git a/src/index.js b/src/index.js", "@@ -1,2 +1,2 @@", "-old", "+new", ""].join(String.fromCharCode(10)),
});
await tick();
assert.ok(find(container, "mg-ws-summary").length >= 1, "compare summary chips render");
assert.ok(find(container, "mg-commit").length >= 1, "commits only on head are listed");
assert.ok(find(container, "mg-line-add").length >= 1, "the compare patch renders");
console.log("   compare view renders (empty + diverging case)");

// --- patch options (-w / context) round-trip
const tabsAway = find(container, "mg-tab").find((t) => t.textContent.startsWith("History"));
tabsAway._listeners.click.forEach((fn) => fn());
await tick();
onData(await askServer({ action: "multi-git:log", reqId: sent.at(-1).reqId, repo: dirtyRepo.path }));
await tick();
find(container, "mg-commit")[0].onclick();
await tick();
onData(await askServer({ action: "multi-git:commit", reqId: sent.at(-1).reqId, repo: dirtyRepo.path, hash: sent.at(-1).hash }));
await tick();
assert.ok(find(container, "mg-btn").some((b) => b.textContent === "Copy patch"), "copy-patch action present");
assert.ok(find(container, "mg-btn").some((b) => b.textContent === "▲"), "hunk navigation present");
const wsToggle = find(container, "mg-btn").find((b) => b.textContent === "Ignore ws");
assert.ok(wsToggle, "ignore-whitespace toggle in the patch head");
wsToggle.onclick();
await tick();
const wsCommitReq = sent.filter((m) => m.action === "multi-git:commit").at(-1);
assert.equal(wsCommitReq.ignoreWs, true, "-w is sent with the patch request");
onData(await askServer({ action: "multi-git:commit", reqId: wsCommitReq.reqId, repo: dirtyRepo.path, hash: wsCommitReq.hash }));
console.log("   patch options: -w round-trips to the server");
console.log("16. write actions: pull (fast-forward only) and per-file rollback");

const pullButton = find(container, "mg-btn").find((b) => b.textContent === "Pull");
assert.ok(pullButton, "pull button in the header");
pullButton.onclick();
assert.ok(pullButton._cls.has("armed"), "pull arms before acting");
pullButton.onclick();
await tick();
const pullReq = sent.at(-1);
assert.equal(pullReq.action, "multi-git:pull");
onData({ action: "multi-git:data", kind: "pull", ok: true, reqId: pullReq.reqId, results: [{ repo: dirtyRepo.path, name: dirtyRepo.name, ok: true, action: "updated", upstream: "origin/master", before: "aaaaaaa", after: "bbbbbbb" }, { repo: dirtyRepo.path, name: "other", ok: false, action: "diverged", error: null }], summary: { repos: 2, updated: 1, upToDate: 0, diverged: 1, blocked: 0, failed: 0 } });
await tick();
const scanAfterPull = sent.filter((m) => m.action === "multi-git:scan").at(-1);
assert.ok(scanAfterPull.reqId > pullReq.reqId, "a pull triggers a fresh scan");
onData({ ...scan, reqId: scanAfterPull.reqId, prefs: { ...scan.prefs, termVisible: false, widths: [320, 400] } });
await tick();
assert.ok(findOne(container, "mg-chips").textContent.includes("pull:"), "the pull summary is shown");
console.log("   pull: armed → confirmed → rescan + summary");

// rollback of one changed file, from the middle pane
find(container, "mg-tab").find((t) => t.textContent.startsWith("Changes"))._listeners.click.forEach((fn) => fn());
await tick();
const statsForRevert = sent.filter((m) => m.action === "multi-git:stats").at(-1);
onData(await askServer({ action: "multi-git:stats", reqId: statsForRevert.reqId, repo: dirtyRepo.path }));
await tick();
const revertActions = find(container, "mg-file-act");
assert.ok(revertActions.length > 0, "every changed file row carries a rollback action");
const revertBtn = revertActions[0];
const revertPath = find(revertBtn.parentNode, "mg-file-path")[0].textContent;
const wantsDelete = revertBtn.textContent === "Delete";
revertBtn.onclick();
assert.ok(revertBtn._cls.has("armed"), "rollback arms before acting");
assert.equal(revertBtn.textContent, "Confirm", "the armed label asks for confirmation");
revertBtn.onclick();
await tick();
const revertReq = sent.at(-1);
assert.equal(revertReq.action, "multi-git:revert");
assert.equal(revertReq.repo, dirtyRepo.path, "the rollback carries the repo PATH");
assert.equal(revertReq.path, revertPath, "the clicked file is the one reverted");
assert.equal(revertReq.allowUntracked, wantsDelete, "untracked files need the explicit delete flag");
onData({ action: "multi-git:data", kind: "revert", ok: true, reqId: revertReq.reqId, repo: dirtyRepo.path, path: revertPath, action2: wantsDelete ? "deleted" : "restored", output: "ok" });
await tick();
const scanAfterRevert = sent.filter((m) => m.action === "multi-git:scan").at(-1);
assert.ok(scanAfterRevert.reqId > revertReq.reqId, "a rollback rescans the workspace");
onData({ ...scan, reqId: scanAfterRevert.reqId, prefs: { ...scan.prefs, termVisible: false, widths: [320, 400] } });
await tick();
assert.ok(findOne(container, "mg-foot").textContent.includes(revertPath), "the rollback is reported in the footer");
console.log(`   rollback: ${revertPath} (${wantsDelete ? "delete untracked" : "restore from HEAD"})`);

// a refused rollback must surface the reason instead of looking successful
find(container, "mg-file")[0].onclick();
await tick();
onData(await askServer({ action: "multi-git:diff", reqId: sent.at(-1).reqId, repo: dirtyRepo.path, path: sent.at(-1).path }));
await tick();
const failBtn = find(container, "mg-file-act")[0];
failBtn.onclick();
failBtn.onclick();
await tick();
onData({ action: "multi-git:data", kind: "revert", ok: false, reqId: sent.at(-1).reqId, error: "Untracked file — deleting it cannot be undone; confirm with allowUntracked" });
await tick();
assert.ok(find(container, "mg-error").length > 0, "a refused rollback shows the reason");
assert.ok(findOne(container, "mg-error").textContent.includes("cannot be undone"), "…with the server's message");
console.log("   rollback refusal surfaces the reason");

// …and the REAL server resolves the same payload: a path that has no changes proves the request
// reaches git (an unresolved repo would have failed with "Unknown repository" instead), without
// writing anything.
const liveRevert = await askServer({ action: "multi-git:revert", reqId: 999, repo: dirtyRepo.path, path: "definitely-not-a-tracked-file.txt" });
assert.equal(liveRevert.ok, false, "nothing to roll back for an unchanged path");
assert.match(String(liveRevert.error), /Nothing to roll back/, "the real server resolved the repo and reported honestly");
assert.ok(!String(liveRevert.error).includes("Unknown repository"), "regression guard: the repo pointer must resolve");
console.log(`   real server round trip: ${liveRevert.error}`);

// Every request that names a repository must name it as a path string (an object used to reach the
// server as "[object Object]" and came back as "Unknown repository — refresh the scan first").
const badRepoArgs = sent.filter((m) => m && m.repo !== undefined && typeof m.repo !== "string");
assert.deepEqual(badRepoArgs, [], `requests with a non-string repo: ${JSON.stringify(badRepoArgs.slice(0, 3))}`);
console.log(`   ${sent.length} outgoing requests, all repo arguments are path strings`);

/* ------------------------------------------------------------------ */
/* deterministic fixture: a throwaway repository with a real release    */
/* The live workspace is committed clean some days, and a diff test     */
/* that silently asserts nothing is worse than no test. This section   */
/* builds its own repo — a release/<date> branch with a cherry-pick, a  */
/* tag, and a dirty work tree — and drives a second mounted view.       */
/* ------------------------------------------------------------------ */
console.log("17. fixture repo: diff, cards and rollback on a repository this suite builds");
const fixtureRoot = mkdtempSync(join(tmpdir(), "mg-fixture-"));
const originDir = join(fixtureRoot, "origin.git");
const workDir = join(fixtureRoot, "work");
const GITCFG = ["-c", "user.name=tester", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const fx = (...args) => execFileSync("git", [...GITCFG, ...args], { cwd: workDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
execFileSync("git", ["init", "--bare", "-q", "-b", "main", originDir]);
execFileSync("git", ["clone", "-q", originDir, workDir]);
writeFileSync(join(workDir, "version.txt"), "1.0.0\n");
writeFileSync(join(workDir, "notes.txt"), "first\nsecond\n");
fx("add", "-A");
fx("commit", "-q", "-m", "baseline: fixture service");
fx("push", "-q", "-u", "origin", "main");
fx("tag", "v1.0.0");
// a release branch with one commit the default branch does not have
fx("checkout", "-q", "-b", "release/2026-08-29");
writeFileSync(join(workDir, "version.txt"), "1.0.1\n");
fx("add", "-A");
fx("commit", "-q", "-m", "ab12cd34: cherry-picked fix for the release");
fx("push", "-q", "-u", "origin", "release/2026-08-29");
fx("checkout", "-q", "main");
// …and a dirty work tree on the default branch: modified + staged + untracked
writeFileSync(join(workDir, "notes.txt"), "first\nsecond\nthird\n");
writeFileSync(join(workDir, "staged.txt"), "staged content\n");
fx("add", "staged.txt");

const fixtureHost = createMockHost({ cwd: workDir, settings: { depth: 1, maxRepos: 5 } });
await serverPlugin.activate(fixtureHost);
const askFixture = async (payload) => {
	await fxHostMock(payload);
	return fixtureHost.calls.filter((c) => c.method === "sendTo").at(-1)?.args?.[1];
};
async function fxHostMock(payload) {
	await fixtureHost.mock.emitAsync("onMessage", payload, "client-2");
}

const fxContainer = new El("div");
const fxSent = [];
let fxOnData = null;
const fxCleanup = view.mount(fxContainer, {
	send: (msg) => fxSent.push(msg),
	onData: (fn) => {
		fxOnData = fn;
		return () => {
			fxOnData = null;
		};
	},
});
const fxScan = await askFixture({ action: "multi-git:scan", reqId: fxSent[0].reqId });
fxOnData(fxScan);
await tick();
assert.equal(fxScan.repos.length, 1, "the fixture holds exactly one repository");
const fxRepo = fxScan.repos[0];
assert.equal(fxRepo.name, "work");
console.log(`   fixture repo: ${fxRepo.files.length} changed entries (${fxRepo.files.map((f) => f.x + f.path).join(", ")})`);

// 17a. changed files, their patch and the per-file card
const fxRows = find(fxContainer, "mg-repo");
fxRows[0].onclick();
await tick();
const fxStatsReq = fxSent.at(-1);
assert.equal(fxStatsReq.action, "multi-git:stats");
fxOnData(await askFixture({ action: "multi-git:stats", reqId: fxStatsReq.reqId, repo: fxRepo.path }));
await tick();
const fxFileRows = find(fxContainer, "mg-file");
assert.equal(fxFileRows.length, 2, "one row per changed entry (modified + staged)");
const fxTracked = fxFileRows.find((row) => row.textContent.includes("notes.txt"));
assert.ok(fxTracked, "notes.txt is listed as changed");
fxTracked.onclick();
await tick();
const fxDiffReq = fxSent.at(-1);
assert.equal(fxDiffReq.action, "multi-git:diff");
fxOnData(await askFixture({ action: "multi-git:diff", reqId: fxDiffReq.reqId, repo: fxRepo.path, path: "notes.txt" }));
await tick();
assert.ok(find(fxContainer, "mg-line-add").length >= 1, "the fixture diff has an added line");
assert.ok(find(fxContainer, "mg-line-del").length + find(fxContainer, "mg-line-add").length >= 1, "the fixture diff renders +/- lines");
// Project-specific views live in their own plugin: this suite only covers git itself.
assert.deepEqual(texts(fxContainer, "mg-tab").filter((t) => /Releases|Contracts/.test(t)), [], "no project tabs in a git view");
console.log(`   diff rendered: ${find(fxContainer, "mg-line").length} lines, card "${findOne(fxContainer, "mg-dsec-head").textContent.replace(/\s+/g, " ")}"`);

fxCleanup();

// The fixture must be left exactly as it was: a rollback of the tracked file restores it.
fx("restore", "--source=HEAD", "--staged", "--worktree", "--", "notes.txt");
fx("clean", "-qfd");
rmSync(fixtureRoot, { recursive: true, force: true });
console.log("   fixture repository removed");

const GLOBALS = new Set([
	"console", "process", "JSON", "Math", "Object", "Array", "String", "Number", "Boolean", "Date", "RegExp",
	"Map", "Set", "Promise", "Error", "TypeError", "Symbol", "BigInt", "Infinity", "NaN", "undefined", "null",
	"true", "false", "globalThis", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask",
	// Buffer is a Node global used by server/git.mjs (readHead) — not available to client code, which is why
	// the walk covers both trees and this list has to name it explicitly.
	"structuredClone", "fetch", "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "AbortController", "Buffer",
	"ResizeObserver", "IntersectionObserver", "MutationObserver", "navigator", "document", "window", "location",
	"localStorage", "sessionStorage", "performance", "crypto", "atob", "btoa", "import", "meta", "require",
	"__piWebUiHost", "getComputedStyle", "matchMedia", "CustomEvent", "Event", "Node", "Element", "isNaN",
	"parseInt", "parseFloat", "encodeURIComponent", "decodeURIComponent", "RangeError", "SyntaxError",
]);

/* Every module must resolve every name it uses: a dep the entry forgot to pass would otherwise arrive as
 * `undefined` and fail only when that code path runs. The analyzer walks scopes, so this is exact. */
{
	// `tools/scope-free.mjs` needs @babel/parser, which is not a dependency of the plugin — skip the check
	// out loud rather than failing the suite when it is absent (`npm i -D @babel/parser` to run it).
	let analyse = null;
	try {
		({ analyse } = await import(new URL("../tools/scope-free.mjs", import.meta.url).href));
	} catch (err) {
		console.log(`9. module dependencies: skipped (${String(err?.message ?? err).slice(0, 80)}…)`);
	}
	if (!analyse) {
		// nothing to check without the analyzer
	} else {
	const dirs = ["../client/", "../server/"];
	const files = [];
	for (const dir of dirs) {
		const folder = fileURLToPath(new URL(dir, import.meta.url));
		let names = [];
		try {
			names = readdirSync(folder).filter((f) => f.endsWith(".mjs"));
		} catch {
			continue; // no server/ directory in this plugin
		}
		for (const name of names) files.push({ label: `${dir}${name}`, path: join(folder, name) });
	}
	const unresolved = [];
	for (const f of files) {
		const a = analyse(readFileSync(f.path, "utf8"));
		for (const ref of a.references) {
			if (a.resolve(ref.name, ref.scope)) continue;
			if (GLOBALS.has(ref.name)) continue;
			unresolved.push(`${f.label}: ${ref.name}`);
		}
	}
	console.log(`9. module dependencies (${files.length} modules)`);
	assert.deepEqual(unresolved, [], `every module resolves what it uses (${unresolved.slice(0, 5).join(", ")})`);
	console.log("   every module resolves every name it uses");
	}
}
console.log("14. cleanup");
cleanup();
assert.equal(onData, null, "onData subscription released");
assert.equal(container.childNodes.length, 0, "view DOM removed from the container");
assert.equal(documentStub._listeners.visibilitychange.length, 0, "visibilitychange listener released");

console.log("\nCLIENT CHECKS PASSED");
process.exit(0);
