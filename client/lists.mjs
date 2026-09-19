/**
 * The repository list and everything it drives: the scan, the per-repo caches, the health chips and filters,
 * the rows of the middle pane, and the write actions (fetch, pull, rollback).
 */


export function createLists(deps) {
	const {
	FETCH_TIMEOUT_MS, // from module
	ATTENTION, // from mount
	attentionCount, // from mount
	branchesCache, // from mount
	chips, // from mount
	cleanBox, // from mount
	clearSearch, // from mount
	commitCache, // from mount
	destroyed, // from mount
	diffCache, // from mount
	ensureTimeline, // from mount
	foot, // from mount
	groupSel, // from mount
	h, // from mount
	isDirty, // from mount
	isProtectedBranch, // from module
	logCache, // from mount
	optKey, // from mount
	patchOpts, // from mount
	pending, // from mount
	refreshSel, // from mount
	renderAll, // from mount
	renderDetail, // from mount
	renderDiff, // from mount
	reposCount, // from mount
	reposList, // from mount
	request, // from mount
	resetDiffContext, // from mount
	samePath, // from mount
	searchMode, // from mount
	showCompare, // from mount
	showfileCache, // from mount
	sortSel, // from mount
	stashesCache, // from mount
	stashshowCache, // from mount
	state, // from mount
	statsCache, // from mount
	statusCwd, // from mount
	statusDirty, // from mount
	statusKind, // from mount
	statusRepos, // from mount
	statusScan, // from mount
	sub, // from mount
	syncCache, // from mount
	timelineCache, // from mount
	timer, // from mount
	visibleRepos, // from mount
	} = deps;


async function loadRepos(force) {
	if (destroyed) return;
	if (force) {
		statsCache.clear();
		logCache.clear();
		diffCache.clear();
		commitCache.clear();
		branchesCache.clear();
		syncCache.clear();
		stashesCache.clear();
		stashshowCache.clear();
		showfileCache.clear();
		timelineCache.value = null;
		state.stats = null;
		state.history = null;
		state.diff = null;
		state.commit = null;
		state.branches = null;
		state.sync = null;
		state.stashes = null;
		state.timeline = null;
		state.stashText = null;
		if (state.showfile) state.showfile = { ...state.showfile, text: null };
		state.branchesError = null;
		state.syncError = null;
		state.stashesError = null;
		state.timelineError = null;
	}
	setScanning(true);
	const res = await request("scan");
	setScanning(false);
	if (destroyed) return;
	if (!res.ok) {
		state.error = res.error || "Scan failed";
		renderAll();
		return;
	}
	state.error = null;
	state.repos = Array.isArray(res.repos) ? res.repos : [];
	state.cwd = res.cwd ?? "";
	state.scannedAt = Number(res.scannedAt) || Date.now();
	state.truncated = !!res.truncated;
	state.prefs = { ...state.prefs, ...(res.prefs ?? {}) };
	state.collapsed = new Set(Array.isArray(state.prefs.collapsed) ? state.prefs.collapsed : []);
	if (state.selectedRepo && !state.repos.some((r) => r.path === state.selectedRepo)) {
		state.selectedRepo = null;
		resetDiffContext();
		state.stats = null;
		state.history = null;
		state.branches = null;
		state.sync = null;
		state.stashes = null;
	}
	syncControls();
	renderAll();
	scheduleAutoRefresh();
	if (state.selectedRepo) {
		if (state.tab === "changes") void ensureStats(state.selectedRepo);
		else if (state.tab === "history") void ensureHistory(state.selectedRepo, false);
		else if (state.tab === "branches") {
			void ensureBranches(state.selectedRepo);
			void ensureSync(state.selectedRepo);
		} else if (state.tab === "stashes") void ensureStashes(state.selectedRepo);
		else void ensureTimeline();
	} else if (state.tab === "timeline") {
		void ensureTimeline();
	}
	if (!force) return;
	// A forced rescan dropped the payloads above: re-fetch whatever the viewer was showing,
	// so it cannot sit on "Loading …" until the user clicks the row again.
	if (state.stashRef && state.stashText == null) void selectStash(state.stashRef);
	else if (state.showfile && state.showfile.text == null) void refetchShowfile();
	else if (state.selectedCommit && !state.commit) void selectCommit(state.selectedCommit);
	else if (state.selectedFile && !state.diff) void selectFile(state.selectedFile);
}
/** Sort the visible repos; "drift" surfaces the ones that need attention most. */
function sortRepos(list) {
	const mode = state.prefs.sort ?? "name";
	const out = [...list];
	if (mode === "status") {
		out.sort((a, b) => Number(isDirty(b)) - Number(isDirty(a)) || a.name.localeCompare(b.name));
	} else if (mode === "recent") {
		out.sort((a, b) => String(b.head?.when ?? "").localeCompare(String(a.head?.when ?? "")) || a.name.localeCompare(b.name));
	} else if (mode === "drift") {
		const score = (r) => (r.counts?.conflicted ?? 0) * 100 + (r.state?.flags?.length ?? 0) * 50 + (r.behind ?? 0) * 10 + (r.ahead ?? 0) + (isDirty(r) ? 5 : 0);
		out.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
	} else {
		out.sort((a, b) => a.name.localeCompare(b.name));
	}
	return out;
}
async function selectRepo(repo) {
	state.selectedRepo = repo.path;
	resetDiffContext();
	state.historyMode = null;
	state.historyPath = null;
	state.historyRev = null;
	state.stats = statsCache.get(repo.path) ?? null;
	state.history = logCache.get(`all:${repo.path}`) ?? null;
	state.branches = branchesCache.get(repo.path) ?? null;
	state.sync = syncCache.get(repo.path) ?? null;
	state.stashes = stashesCache.get(repo.path) ?? null;
	state.branchesError = null;
	state.syncError = null;
	state.stashesError = null;
	renderRepos();
	renderDetail();
	renderDiff();
	if (state.tab === "changes") await ensureStats(repo.path);
	else if (state.tab === "history") await ensureHistory(repo.path, false);
	else if (state.tab === "branches") {
		await ensureBranches(repo.path);
		await ensureSync(repo.path);
	} else if (state.tab === "stashes") await ensureStashes(repo.path);
	else await ensureTimeline();
}
async function ensureStats(repoPath) {
	if (!repoPath || statsCache.has(repoPath)) return;
	const res = await request("stats", { repo: repoPath });
	if (destroyed) return;
	if (res.ok) statsCache.set(repoPath, res.stats ?? {});
	else if (state.selectedRepo === repoPath) state.detailError = res.error || "Failed to load diff stats";
	if (state.selectedRepo === repoPath) {
		state.stats = statsCache.get(repoPath) ?? null;
		renderDetail();
	}
}
async function ensureHistory(repoPath, force) {
	if (!repoPath) return;
	const key = historyKey(repoPath);
	if (!force && logCache.has(key)) {
		state.history = logCache.get(key);
		renderDetail();
		return;
	}
	if (state.selectedRepo === repoPath) {
		state.history = null;
		renderDetail();
	}
	const extra = state.historyMode === "file" ? { path: state.historyPath } : state.historyMode === "branch" ? { rev: state.historyRev } : {};
	const res = await request("log", { repo: repoPath, ...extra });
	if (destroyed) return;
	if (res.ok) logCache.set(key, res.history ?? []);
	if (state.selectedRepo === repoPath) {
		state.history = logCache.get(key) ?? [];
		if (!res.ok) state.detailError = res.error || "Failed to load history";
		renderDetail();
	}
}
async function ensureBranches(repoPath) {
	if (!repoPath) return;
	if (branchesCache.has(repoPath)) {
		state.branches = branchesCache.get(repoPath);
		renderDetail();
		return;
	}
	if (state.selectedRepo === repoPath) {
		state.branches = null;
		state.branchesError = null;
		renderDetail();
	}
	const res = await request("branches", { repo: repoPath });
	if (destroyed) return;
	if (res.ok) branchesCache.set(repoPath, res);
	if (state.selectedRepo === repoPath) {
		state.branches = res.ok ? res : null;
		state.branchesError = res.ok ? null : res.error || "Failed to load branches";
		renderDetail();
	}
}
async function ensureSync(repoPath) {
	if (!repoPath) return;
	if (syncCache.has(repoPath)) {
		state.sync = syncCache.get(repoPath);
		renderDetail();
		return;
	}
	if (state.selectedRepo === repoPath) {
		state.sync = null;
		state.syncError = null;
		renderDetail();
	}
	const res = await request("sync", { repo: repoPath });
	if (destroyed) return;
	if (res.ok) syncCache.set(repoPath, res);
	if (state.selectedRepo === repoPath) {
		state.sync = res.ok ? res : null;
		state.syncError = res.ok ? null : res.error || "Failed to load tracking data";
		renderDetail();
	}
}
async function ensureStashes(repoPath) {
	if (!repoPath) return;
	if (stashesCache.has(repoPath)) {
		state.stashes = stashesCache.get(repoPath);
		renderDetail();
		return;
	}
	if (state.selectedRepo === repoPath) {
		state.stashes = null;
		state.stashesError = null;
		renderDetail();
	}
	const res = await request("stashes", { repo: repoPath });
	if (destroyed) return;
	if (res.ok) stashesCache.set(repoPath, res);
	if (state.selectedRepo === repoPath) {
		state.stashes = res.ok ? res : null;
		state.stashesError = res.ok ? null : res.error || "Failed to load stashes";
		renderDetail();
	}
}
/* ---------------- repo list ---------------- */
function renderRepos() {
	reposList.textContent = "";
	const list = visibleRepos();
	const dirty = state.repos.filter(isDirty).length;
	const filtering = !!state.filter.trim() || !!state.attention;
	reposCount.textContent = state.repos.length
		? `Repositories ${list.length}/${state.repos.length}${dirty ? ` · ${dirty} dirty` : ""}`
		: "Repositories";
	if (!state.repos.length) {
		reposList.append(h("div", "mg-empty", state.error ? state.error : "No Git repository found below the workspace root."));
		return;
	}
	if (!list.length) {
		reposList.append(
			h("div", "mg-empty", filtering ? "No repository matches the current filter." : "Every repository is clean."),
		);
		return;
	}
	let lastGroup = null;
	for (const repo of list) {
		const key = groupKey(repo);
		if (key && key !== lastGroup) {
			const size = list.filter((r) => groupKey(r) === key).length;
			reposList.append(h("div", "mg-group-head", `${key} · ${size}`));
			lastGroup = key;
		}
		const row = h("button", "mg-repo");
		row.type = "button";
		row.classList.toggle("active", state.selectedRepo === repo.path);
		row.title = repo.path;

		const line1 = h("div", "mg-repo-line1");
		line1.append(h("span", "mg-repo-name", repo.name));
		if (state.cwd && samePath(repo.path, state.cwd)) line1.append(h("span", "mg-badge", "cwd"));
		if (repo.ahead || repo.behind) {
			const ab = h("span", "mg-ab");
			if (repo.ahead) ab.append(h("span", "mg-ahead", `↑${repo.ahead}`));
			if (repo.behind) ab.append(h("span", "mg-behind", `↓${repo.behind}`));
			line1.append(ab);
		}
		row.append(line1);

		const line2 = h("div", "mg-repo-line2");
		if (repo.ok) {
			line2.append(h("span", "mg-branch", repo.detached ? "detached HEAD" : repo.branch || "—"));
			const bits = [];
			if (repo.counts.conflicted) bits.push(`${repo.counts.conflicted} conflicted`);
			if (repo.counts.staged) bits.push(`${repo.counts.staged} staged`);
			if (repo.counts.unstaged) bits.push(`${repo.counts.unstaged} modified`);
			if (repo.counts.untracked) bits.push(`${repo.counts.untracked} untracked`);
			line2.append(h("span", bits.length ? "mg-dirty" : "mg-clean", bits.length ? bits.join(" · ") : "clean"));
		} else {
			line2.append(h("span", "mg-err", repo.error || "git error"));
		}
		row.append(line2);

		if (repo.head) {
			row.append(h("div", "mg-repo-head", `${repo.head.short} · ${repo.head.when} · ${repo.head.subject}`));
		}

		const st = repo.state ?? { flags: [], indexLock: false, worktrees: [], submodules: 0 };
		if (repo.ok && (st.flags.length || st.indexLock || st.worktrees.length || st.submodules)) {
			const stateLine = h("div", "mg-repo-state");
			for (const flag of st.flags) stateLine.append(h("span", "mg-state danger", flag));
			if (st.indexLock) stateLine.append(h("span", "mg-state warn", "index.lock"));
			if (st.worktrees.length) stateLine.append(h("span", "mg-state dim", `+${st.worktrees.length} worktree${st.worktrees.length > 1 ? "s" : ""}`));
			if (st.submodules) stateLine.append(h("span", "mg-state dim", `${st.submodules} submodule${st.submodules > 1 ? "s" : ""}`));
			row.append(stateLine);
			row.title = `${repo.path}\n${[
				...st.flags,
				st.indexLock ? "index.lock" : "",
				...st.worktrees.map((w) => `worktree: ${w}`),
				st.submodules ? `${st.submodules} submodules` : "",
			]
				.filter(Boolean)
				.join("\n")}`;
		}

		row.onclick = () => void selectRepo(repo);
		reposList.append(row);
	}
}
/**
 * Health strip: one clickable count per "needs attention" state. This is the answer to
 * "what should I look at first" that a plain repo list cannot give at 10+ repositories.
 */
function renderChips() {
	chips.textContent = "";
	if (!state.repos.length) return;
	for (const [key, def] of Object.entries(ATTENTION)) {
		const n = attentionCount(key);
		const btn = h("button", "mg-chipbtn");
		btn.type = "button";
		btn.append(h("span", null, def.label), h("span", "n", String(n)));
		btn.title = `Show only repositories with ${def.label}`;
		btn.classList.toggle("active", state.attention === key);
		btn.classList.toggle("zero", n === 0);
		btn.onclick = () => {
			state.attention = state.attention === key ? null : key;
			renderAll();
		};
		chips.append(btn);
	}
	if (state.attention) {
		const clear = h("button", "mg-chipbtn mg-chipbtn-plain", "clear filter");
		clear.type = "button";
		clear.onclick = () => {
			state.attention = null;
			renderAll();
		};
		chips.append(clear);
	}
	if (state.fetching) chips.append(h("span", "mg-foot-dim", "fetching…"));
	if (state.pulling) chips.append(h("span", "mg-foot-dim", "pulling…"));
	else if (state.pullSummary) {
		const s = state.pullSummary;
		const parts = [`${s.updated} updated`, `${s.upToDate} up-to-date`];
		if (s.diverged) parts.push(`${s.diverged} diverged`);
		if (s.blocked) parts.push(`${s.blocked} skipped`);
		if (s.failed) parts.push(`${s.failed} failed`);
		const el = h("span", s.diverged || s.failed ? "mg-err" : "mg-foot-dim", `pull: ${parts.join(" · ")}`);
		el.title = (state.pullResults ?? [])
			.filter((r) => r.action !== "up-to-date" && r.action !== "updated")
			.map((r) => `${r.name}: ${r.action ?? "error"}${r.error ? ` — ${r.error}` : ""}`)
			.join(String.fromCharCode(10));
		chips.append(el);
	}
	else if (state.fetchSummary) {
		chips.append(
			h("span", state.fetchSummary.failed ? "mg-err" : "mg-foot-dim", `fetch: ${state.fetchSummary.behind} behind · ${state.fetchSummary.ahead} ahead${state.fetchSummary.failed ? ` · ${state.fetchSummary.failed} failed` : ""}`),
		);
	}
}
function renderSub() {
	const dirty = state.repos.filter(isDirty).length;
	statusRepos.textContent = `${state.repos.length} repo${state.repos.length === 1 ? "" : "s"}`;
	statusDirty.textContent = dirty ? `${dirty} with changes` : "all clean";
	statusDirty.classList.toggle("dirty", dirty > 0);
	statusCwd.textContent = state.cwd || "";
	statusCwd.title = state.cwd ? `${state.cwd} — click to copy` : "";
	statusCwd.style.display = state.cwd ? "" : "none";
}
/* ---------------- header/footer ---------------- */
function renderFoot() {
	foot.textContent = "";
	const dirty = state.repos.filter(isDirty).length;
	const when = state.scannedAt ? new Date(state.scannedAt).toLocaleTimeString() : "—";
	foot.append(h("span", null, `${state.repos.length} repos · ${dirty} dirty · scanned ${when}`));
	if (state.truncated) foot.append(h("span", "mg-err", "scan truncated — raise “Max repos” or lower “Scan depth”"));
	if (state.notice) foot.append(h("span", "mg-foot-dim", state.notice));
	if (state.error) foot.append(h("span", "mg-err", state.error));
}
function fileRow(repo, f) {
	const row = h("button", "mg-file");
	row.type = "button";
	row.classList.toggle("active", state.selectedFile === f.path);
	row.append(
		h("span", `mg-xy ${f.x === "?" ? "mg-xy-q" : "mg-xy-x"}`, f.x === " " ? "·" : f.x),
		h("span", `mg-xy ${f.y === " " ? "mg-xy-q" : "mg-xy-y"}`, f.y === " " ? "·" : f.y),
		h("span", "mg-file-path", f.path),
	);
	const stat = state.stats ? state.stats[f.path] : null;
	if (stat && (stat[0] || stat[1])) {
		const el = h("span", "mg-stat");
		if (stat[0]) el.append(h("span", "add", `+${stat[0]}`));
		if (stat[1]) el.append(h("span", "del", `-${stat[1]}`));
		row.append(el);
	}
	row.title = `${f.path} — ${statusKind(f)}`;
	row.onclick = () => void selectFile(f.path);
	const untracked = f.x === "?" || f.x === "A";
	const act = h("button", "mg-file-act", untracked ? "Delete" : "Rollback");
	act.type = "button";
	act.title = untracked
		? `Delete the untracked file ${f.path} — git cannot undo this`
		: `Discard local changes to ${f.path} (git restore from HEAD)`;
	confirmAction(act, untracked ? "Delete" : "Rollback", "Confirm", () => revertFile(repo.path, f));
	const wrap = h("div", "mg-file-wrap");
	wrap.append(row, act);
	return wrap;
}
function commitRow(commit, isFileMode, onClick) {
	const row = h("button", "mg-commit");
	row.type = "button";
	row.classList.toggle("active", state.selectedCommit === commit.hash && !state.showfile);
	row.title = commit.hash;
	if (commit.graph) row.append(h("span", "mg-graph", commit.graph));
	const main = h("div", "mg-commit-main");
	main.append(h("span", "mg-commit-subject", commit.subject || "(no subject)"));
	main.append(h("span", "mg-commit-meta", [commit.shortHash, commit.author, commit.date].filter(Boolean).join(" · ")));
	if (commit.decorations) main.append(h("span", "mg-commit-refs", commit.decorations));
	row.append(main);
	row.onclick =
		onClick ??
		(() => {
			if (isFileMode) void selectFileAtCommit(commit.hash);
			else void selectCommit(commit.hash, state.selectedRepo);
		});
	return row;
}
function branchRow(b, repoPath, defaultRef) {
	const row = h("button", "mg-brow");
	row.type = "button";
	// The branch picked last — the same highlight the repo list uses, and it survives going back.
	row.classList.toggle("active", isPickedBranch(b, repoPath));
	row.title = b.hash;
	const l1 = h("div", "mg-brow-line1");
	l1.append(h("span", b.current ? "mg-brow-name current" : "mg-brow-name", `${b.current ? "● " : ""}${b.name}`));
	if (b.remote) l1.append(h("span", "mg-badge", "remote"));
	if (b.ahead) l1.append(h("span", "mg-ahead", `↑${b.ahead}`));
	if (b.behind) l1.append(h("span", "mg-behind", `↓${b.behind}`));
	row.append(l1);
	row.append(h("div", "mg-brow-meta", `${b.date} · ${b.subject || "(no subject)"}`));
	const tags = [];
	if (b.upstream) tags.push(h("span", "mg-badge", b.upstream));
	if (b.gone) tags.push(h("span", "mg-state warn", "upstream gone"));
	// A protected branch is merged into itself by definition: that is not a cleanup suggestion.
	if (b.merged && !b.current && !isProtectedBranch(b, defaultRef)) tags.push(h("span", "mg-state dim", "merged — safe to delete"));
	if (tags.length) {
		const tagRow = h("div", "mg-brow-tags");
		for (const t of tags) tagRow.append(t);
		row.append(tagRow);
	}
	if (!b.remote) {
		const cmp = h("button", "mg-btn sm", "Compare");
		cmp.type = "button";
		cmp.title = b.current ? "Compare this branch with the default branch" : "What does this branch add on top of the current one? (base...head)";
		cmp.onclick = (ev) => {
			try {
				ev?.stopPropagation?.();
			} catch {
				/* no event object (tests) */
			}
			const repo = state.repos.find((r) => r.path === repoPath);
			const current = repo?.branch || "HEAD";
			void showCompare(repoPath, b.current ? current : b.name, b.current ? b.name : current);
		};
		const cmpRow = h("div", "mg-brow-tags");
		cmpRow.append(cmp);
		row.append(cmpRow);
	}
	row.onclick = () => selectBranch(b, repoPath);
	return row;
}
function stashRow(s) {
	const row = h("button", "mg-commit");
	row.type = "button";
	row.classList.toggle("active", state.stashRef === s.ref);
	row.append(h("span", "mg-graph", "▣ "));
	const main = h("div", "mg-commit-main");
	main.append(h("span", "mg-commit-subject", s.subject || "(no message)"));
	main.append(h("span", "mg-commit-meta", `${s.ref} · ${s.hash || "—"} · ${s.when}`));
	row.append(main);
	row.onclick = () => void selectStash(s.ref);
	return row;
}
/** Is this branch the one picked last (marked in the Branches tab and on the Workspace tab)? */
function isPickedBranch(b, repoPath) {
	const picked = state.lastBranch;
	if (!picked) return false;
	return picked.name === b.name && (!repoPath || picked.repo === repoPath);
}
/** Go back from a branch/file history to the list it was opened from. */
function backFromHistory() {
	state.tab = state.historyFrom ?? "branches";
	state.historyFrom = null;
	state.historyMode = null;
	state.historyRev = null;
	state.historyPath = null;
	state.history = null;
	renderRepos();
	renderDetail();
	renderDiff();
	if (state.tab === "branches") {
		void ensureBranches(state.selectedRepo);
		void ensureSync(state.selectedRepo);
	}
}
/** A scan dims the status and lights a fixed-width indicator; the numbers themselves stay. */
function setScanning(on) {
	statusScan.textContent = on ? "● scanning" : "";
	sub.classList.toggle("scanning", on);
	statusScan.title = on ? "Reading the repositories…" : "";
}
function syncControls() {
	cleanBox.checked = !!state.prefs.hideClean;
	sortSel.value = state.prefs.sort ?? "name";
	groupSel.value = state.prefs.group ?? "none";
	searchMode.value = state.searchMode;
	const want = String(Number(state.prefs.autoRefreshSec) || 0);
	if (![...refreshSel.options].some((o) => o.value === want)) {
		const opt = document.createElement("option");
		opt.value = want;
		opt.textContent = `Auto refresh: ${want}s`;
		refreshSel.append(opt);
	}
	refreshSel.value = want;
}
function scheduleAutoRefresh() {
	if (timer.value) {
		clearInterval(timer.value);
		timer.value = null;
	}
	const sec = Number(state.prefs.autoRefreshSec) || 0;
	if (sec > 0) {
		timer.value = setInterval(() => {
			if (!destroyed && !pending.size) void loadRepos(false);
		}, sec * 1000);
	}
}
/**
 * Fetch every repo (`--all --prune`) and rescan. Read-only for the work tree, but it does
 * move remote-tracking refs — which is the whole point: ahead/behind only means something
 * after a fetch. Long enough timeout that a slow remote does not look like a failure.
 */
async function fetchAll() {
	if (state.fetching || destroyed) return;
	state.fetching = true;
	state.fetchSummary = null;
	renderChips();
	const res = await request("fetch", {}, FETCH_TIMEOUT_MS);
	if (destroyed) return;
	state.fetching = false;
	if (!res.ok) {
		state.error = res.error || "Fetch failed";
		renderAll();
		return;
	}
	state.fetchSummary = res.summary ?? null;
	const failed = (res.results ?? []).filter((r) => !r.ok);
	state.error = failed.length ? `fetch failed in ${failed.length} repo(s): ${failed[0].error}` : null;
	await loadRepos(true); // remote refs moved: re-read ahead/behind
}
/**
 * Pull every repo: fetch, then fast-forward only (the server does `merge --ff-only`).
 * Never merges a diverged branch, never rebases, skips repos mid-operation.
 */
async function pullAll() {
	if (state.pulling || destroyed) return;
	state.pulling = true;
	state.pullSummary = null;
	state.notice = null;
	renderChips();
	const res = await request("pull", {}, FETCH_TIMEOUT_MS);
	if (destroyed) return;
	state.pulling = false;
	if (!res.ok) {
		state.error = res.error || "Pull failed";
		renderAll();
		return;
	}
	state.pullSummary = res.summary ?? null;
	state.pullResults = res.results ?? [];
	const problems = state.pullResults.filter((r) => r.ok === false);
	state.error = problems.length ? `pull: ${problems.map((r) => `${r.name} (${r.error})`).slice(0, 3).join("; ")}` : null;
	await loadRepos(true);
}
/**
 * Discard the local changes of one file. Tracked files are restored from HEAD (index and
 * work tree); untracked/newly added ones are deleted, which is why that path needs the
 * armed confirmation and the explicit `allowUntracked` flag.
 */
async function revertFile(repoPath, f) {
	const untracked = f.x === "?" || f.x === "A";
	const res = await request("revert", { repo: repoPath, path: f.path, allowUntracked: untracked });
	if (destroyed) return;
	if (!res.ok) {
		state.detailError = res.error || "Rollback failed";
		state.notice = null;
		renderDiff();
		return;
	}
	state.detailError = null;
	state.notice = `${res.action2 === "deleted" ? "Deleted" : "Reverted"} ${f.path}`;
	if (state.selectedFile === f.path) resetDiffContext();
	statsCache.clear();
	diffCache.clear();
	await loadRepos(true);
}
/**
 * Two-click confirmation for actions that touch the working tree. A host dialog would be
 * another dependency; arming the button is honest, visible and testable.
 */
function confirmAction(btn, label, armedLabel, run) {
	let armed = false;
	let timer = null;
	const disarm = () => {
		armed = false;
		btn.classList.remove("armed");
		btn.textContent = label;
	};
	btn.onclick = () => {
		if (!armed) {
			armed = true;
			btn.classList.add("armed");
			btn.textContent = armedLabel;
			timer = setTimeout(disarm, 5000);
			return;
		}
		clearTimeout(timer);
		disarm();
		void run();
	};
}
function moveSelection(delta) {
	const list = visibleRepos();
	if (!list.length) return;
	const current = list.findIndex((r) => r.path === state.selectedRepo);
	const next = current < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, current + delta));
	void selectRepo(list[next]);
}
async function selectFile(relPath) {
	if (!state.selectedRepo) return;
	const repo = state.selectedRepo;
	resetDiffContext();
	state.selectedFile = relPath;
	const key = `${repo}\n${relPath}\n${optKey()}`;
	state.diff = diffCache.get(key) ?? null;
	renderDetail();
	renderDiff();
	if (state.diff) return;
	const res = await request("diff", { repo, path: relPath });
	// The reply must belong to the repo it was asked for: switching repos clears the
	// selection, but the same file name can be picked again in another repo meanwhile.
	if (destroyed || state.selectedRepo !== repo || state.selectedFile !== relPath) return;
	if (res.ok) {
		diffCache.set(key, res);
		state.diff = res;
	} else {
		state.detailError = res.error || "Failed to load diff";
	}
	renderDiff();
}
async function selectCommit(hash, repoPath) {
	const rp = repoPath ?? state.selectedRepo;
	if (!rp) return;
	resetDiffContext();
	if (state.selectedRepo !== rp) {
		// A timeline or search hit can belong to any repository: the left pane follows it.
		state.selectedRepo = rp;
		renderRepos();
	}
	state.selectedCommit = hash;
	renderDetail();
	renderDiff();
	const key = `${rp}\n${hash}\n${optKey()}`;
	const cached = commitCache.get(key);
	if (cached !== undefined) {
		state.commit = { hash, text: cached };
		renderDiff();
		return;
	}
	const res = await request("commit", { repo: rp, hash, ...patchOpts() });
	if (destroyed || state.selectedCommit !== hash) return;
	if (res.ok) {
		commitCache.set(key, res.text ?? "");
		state.commit = { hash, text: res.text ?? "" };
	} else {
		state.detailError = res.error || "Failed to load commit";
	}
	renderDiff();
}
async function selectStash(ref) {
	if (!state.selectedRepo) return;
	const repo = state.selectedRepo;
	resetDiffContext();
	state.stashRef = ref;
	state.stashText = stashshowCache.get(`${repo}\n${ref}\n${optKey()}`) ?? null;
	renderDetail();
	renderDiff();
	if (state.stashText != null) return;
	const res = await request("stashshow", { repo, ref, ...patchOpts() });
	if (destroyed || state.selectedRepo !== repo || state.stashRef !== ref) return;
	if (res.ok) {
		stashshowCache.set(`${repo}\n${ref}\n${optKey()}`, res.text ?? "");
		state.stashText = res.text ?? "";
	} else {
		state.detailError = res.error || "Failed to load stash";
	}
	renderDiff();
}
/** Re-fetch the file the viewer shows (a forced rescan dropped its cached text). */
async function refetchShowfile() {
	const cur = state.showfile;
	if (!cur || cur.text != null) return;
	const res = await request("showfile", { repo: cur.repo, rev: cur.rev, path: cur.path });
	if (destroyed) return;
	if (res.ok) {
		showfileCache.set(`${cur.repo}\n${cur.rev}\n${cur.path}`, res.text ?? "");
		if (state.showfile === cur) state.showfile = { ...cur, text: res.text ?? "" };
	} else if (state.showfile === cur) {
		state.detailError = res.error || "Failed to read file";
	}
	renderDiff();
}
async function selectFileAtCommit(hash) {
	if (!state.selectedRepo || !state.historyPath) return;
	const repo = state.selectedRepo;
	const relPath = state.historyPath;
	resetDiffContext();
	state.showfile = { repo, rev: hash, path: relPath, query: null, text: null };
	renderDetail();
	renderDiff();
	const key = `${repo}\n${hash}\n${relPath}`;
	const cached = showfileCache.get(key);
	if (cached !== undefined) {
		state.showfile = { ...state.showfile, text: cached };
		renderDiff();
		return;
	}
	const res = await request("showfile", { repo, rev: hash, path: relPath });
	if (destroyed) return;
	if (res.ok) {
		showfileCache.set(key, res.text ?? "");
		if (showingShowfile(repo, hash, relPath)) state.showfile = { ...state.showfile, text: res.text ?? "" };
	} else if (showingShowfile(repo, hash, relPath)) {
		state.detailError = res.error || "Failed to read file";
	}
	renderDiff();
}
/** Is the file viewer showing exactly this repo/rev/path? (reply guard) */
function showingShowfile(repo, rev, path) {
	return !!state.showfile && state.showfile.repo === repo && state.showfile.rev === rev && state.showfile.path === path;
}
/** Line-by-line authorship for one file: the "who wrote this and why" view. */
/**
 * The right pane shows exactly one of: a diff/commit, a blame or a compare.
 * Opening one has to close the others here, or the pane keeps the previous view's state.
 */
function resetPaneExclusivity() {
	state.blame = null;
	state.blameError = null;
	state.compare = null;
	state.compareError = null;
}
function selectBranch(b, repoPath) {
	// Remember the list this was opened from, and the branch itself: the history header offers a way
	// back, and the branch keeps its highlight in the list it came from.
	if (state.tab !== "history") state.historyFrom = state.tab;
	state.lastBranch = { repo: repoPath, name: b.name };
	state.selectedRepo = repoPath;
	state.tab = "history";
	state.historyMode = "branch";
	state.historyRev = b.name;
	state.historyPath = null;
	resetDiffContext();
	renderRepos();
	renderDetail();
	renderDiff();
	void ensureHistory(repoPath, true);
}
function showHistoryForFile(repoPath, relPath) {
	if (state.searchActive) clearSearch();
	state.selectedRepo = repoPath;
	state.tab = "history";
	state.historyMode = "file";
	state.historyPath = relPath;
	state.historyRev = null;
	resetDiffContext();
	renderRepos();
	renderDetail();
	renderDiff();
	void ensureHistory(repoPath, true);
}
/** Group key for the repo list: service prefix (name before the first dash) or current branch. */
function groupKey(repo) {
	const mode = state.prefs.group ?? "none";
	if (mode === "prefix") return String(repo.name).split("-")[0] || repo.name;
	if (mode === "branch") return repo.branch ? `${repo.branch}${repo.detached ? " (detached)" : ""}` : "(no branch)";
	return "";
}
function historyKey(repoPath) {
	if (state.historyMode === "file") return `file:${repoPath}\n${state.historyPath}`;
	if (state.historyMode === "branch") return `rev:${repoPath}\n${state.historyRev}`;
	return `all:${repoPath}`;
}

	return { loadRepos, sortRepos, selectRepo, ensureStats, ensureHistory, ensureBranches, ensureSync, ensureStashes, renderRepos, renderChips, renderSub, renderFoot, fileRow, commitRow, branchRow, stashRow, isPickedBranch, backFromHistory, setScanning, syncControls, scheduleAutoRefresh, fetchAll, pullAll, revertFile, confirmAction, moveSelection, selectFile, selectCommit, selectStash, refetchShowfile, selectFileAtCommit, showingShowfile, resetPaneExclusivity, selectBranch, showHistoryForFile, groupKey, historyKey };
}
