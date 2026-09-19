/**
 * The Workspace tab (cross-repo grouping, branch pattern), and the blame/compare views that open from it.
 */


export function createWorkspace(deps) {
	const {
	addDiffAction, // from mount
	addPatchActions, // from mount
	chip, // from mount
	commitRow, // from mount
	destroyed, // from mount
	detailList, // from mount
	diffBody, // from mount
	diffTitle, // from mount
	errText, // from mount
	groupBranches, // from module
	h, // from mount
	isPickedBranch, // from mount
	isProtectedBranch, // from module
	patchOpts, // from mount
	renderDetail, // from mount
	renderDiff, // from mount
	renderFoot, // from mount
	renderPatch, // from mount
	request, // from mount
	resetPaneExclusivity, // from mount
	savePrefs, // from mount
	segment, // from mount
	selectBranch, // from mount
	selectCommit, // from mount
	showHistoryForFile, // from mount
	state, // from mount
	withoutBranchPrefix, // from mount
	} = deps;


/**
 * Which pattern is in force here: this workspace's override (saved in prefs, because plugin
 * settings are plugin-wide rather than per root), else the plugin setting, else nothing —
 * and "nothing" means group by the full branch name.
 */
function activeBranchPattern() {
	const perWorkspace = state.prefs?.branchGroups?.[state.cwd];
	if (typeof perWorkspace === "string" && perWorkspace) return { pattern: perWorkspace, source: "workspace" };
	const global = state.prefs?.branchGroupPattern;
	if (typeof global === "string" && global) return { pattern: global, source: "setting" };
	return { pattern: "", source: "default" };
}
/** The per-workspace grouping override, saved in prefs (settings are plugin-wide, not per root). */
async function setBranchPattern(pattern) {
	const root = state.cwd;
	const value = String(pattern ?? "").trim();
	// Re-applying the same value (or clearing when nothing is set) is a no-op: no round trip,
	// and no re-render that would steal focus from the field the user is typing in.
	const current = state.prefs?.branchGroups?.[root] ?? "";
	if (current === value) {
		renderDetail();
		return;
	}
	const next = { ...(state.prefs?.branchGroups ?? {}) };
	if (!value) delete next[root];
	else next[root] = value;
	state.prefs = { ...state.prefs, branchGroups: next };
	renderDetail();
	await savePrefs({ branchGroups: next });
}
/** The grouping bar above the cross-repo branch list: shows and edits what is being grouped. */
function branchGroupBar() {
	const active = activeBranchPattern();
	const bar = h("div", "mg-groupbar");
	const input = document.createElement("input");
	input.type = "text";
	input.className = "mg-search mg-groupbar-input";
	input.placeholder = "group by full branch name — or a regex, e.g. ([0-9a-z]{8,12})__";
	input.value = active.source === "workspace" ? active.pattern : "";
	input.title = "Leave empty to group by the full branch name. A regular expression groups by its first capture group.";
	const apply = () => {
		const value = input.value.trim();
		if (value) {
			try {
				new RegExp(value);
			} catch (err) {
				state.notice = `Invalid pattern: ${errText(err)}`;
				renderFoot();
				return;
			}
		}
		void setBranchPattern(value);
	};
	input.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") {
			ev.preventDefault();
			apply();
		}
	});
	const applyBtn = h("button", "mg-btn sm", "Apply");
	applyBtn.type = "button";
	applyBtn.onclick = apply;
	const clearBtn = h("button", "mg-btn sm", "↺");
	clearBtn.type = "button";
	clearBtn.title = "Clear this workspace's pattern (fall back to the plugin setting)";
	clearBtn.onclick = () => void setBranchPattern("");
	const stateText = h("span", "mg-groupbar-state");
	stateText.textContent =
		active.source === "default"
			? "grouped by full branch name"
			: `grouped by /${active.pattern}/ (${active.source === "workspace" ? "this workspace" : "plugin setting"})`;
	bar.append(h("span", "mg-groupbar-label", "group by"), input, applyBtn, clearBtn, stateText);
	return bar;
}
async function ensureWorkspace(force) {
	if (!force && state.ws) return;
	state.wsError = null;
	renderDetail();
	const res = await request("branches-all", {}, 120_000);
	if (destroyed) return;
	if (res.ok) state.ws = res;
	else state.wsError = res.error || "Failed to load branches";
	renderDetail();
}
function renderWorkspace() {
	detailList.textContent = "";
	if (state.wsError) {
		detailList.append(h("div", "mg-error", state.wsError));
		return;
	}
	if (!state.ws) {
		detailList.append(h("div", "mg-empty", "Loading cross-repo branches…"));
		return;
	}
	const repos = state.ws.repos ?? [];
	const branches = repos.flatMap((r) => (r.branches ?? []).map((b) => ({ ...b, repo: r.repo, repoName: r.name, defaultRef: r.defaultRef })));
	const unpushed = repos.flatMap((r) => (r.unpushed ?? []).map((u) => ({ ...u, repo: r.repo, repoName: r.name })));
	const merged = branches.filter((b) => b.merged && !b.current);
	const stale = branches.filter((b) => (b.days ?? 0) > 90 && !b.current);
	const gone = branches.filter((b) => b.gone);

	const summary = h("div", "mg-ws-summary");
	summary.append(
		chip(`${repos.length} repos`, "", "scanned repositories"),
		chip(`${branches.length} branches`, "", "local branches"),
		chip(`${unpushed.length} unpushed`, unpushed.length ? "mg-chip-del" : "", "branches with commits to push"),
		chip(`${merged.length} merged`, "", "merged into the default branch"),
		chip(`${stale.length} stale`, "", "no commit in 90+ days"),
	);
	if (gone.length) summary.append(chip(`${gone.length} upstream gone`, "mg-chip-del", "upstream branch deleted on the remote"));
	detailList.append(summary);
	// 1. everything not pushed yet: the pre-release checklist
	const unpushedSeg = segment(detailList, "ws:unpushed", "Unpushed", { count: unpushed.length, title: "Branches with commits that are not on the remote yet" });
	if (!unpushed.length) unpushedSeg.append(h("div", "mg-empty", "Nothing to push in any repository."));
	for (const u of unpushed) {
		const body = segment(unpushedSeg, `ws:unpushed:${u.repo}|${u.branch}`, `${u.repoName} · ${u.branch}`, { sub: true, count: `↑${u.ahead}${u.current ? " · current" : ""}`, note: "" });
		for (const c of u.commits) {
			// Branch-prefixed subjects (`feat/x: …`) repeat the header of this very section.
			const row = commitRow({ hash: c.short, shortHash: c.short, author: c.author, date: c.date, subject: withoutBranchPrefix(c.subject, u.branch) }, false, () => void selectCommit(c.short, u.repo));
			if (withoutBranchPrefix(c.subject, u.branch) !== c.subject) row.title = c.subject;
			body.append(row);
		}
	}

	// 2. branches that appear in more than one repository: "is this finished everywhere?"
	// The default key is the full branch name; a pattern (setting or per workspace) extracts one.
	const active = activeBranchPattern();
	const { groups: shared, unmatched, defaultSkipped } = groupBranches(branches, active.pattern);
	detailList.append(branchGroupBar());
	const ticketSeg = segment(detailList, "ws:tickets", "Branches across repositories", {
		count: shared.length,
		title: active.pattern ? `Branches grouped by /${active.pattern}/` : "Branches with the same name in several repositories",
	});
	if (!shared.length) {
		ticketSeg.append(
			h("div", "mg-empty", active.pattern ? `No branch key appears in more than one repository (pattern /${active.pattern}/).` : "No branch name appears in more than one repository."),
		);
	}
	if (unmatched) {
		const note = h("div", "mg-empty");
		note.textContent = `${unmatched} branch(es) did not match the pattern and are grouped by their full name.`;
		ticketSeg.append(note);
	}
	if (defaultSkipped) {
		const note = h("div", "mg-empty");
		note.textContent = `${defaultSkipped} default-branch entries (master/main per repository) are not grouped here.`;
		ticketSeg.append(note);
	}
	for (const { key, list } of shared) {
		const body = segment(ticketSeg, `ws:ticket:${key}`, key, { sub: true, count: `${new Set(list.map((b) => b.repo)).size} repos` });
		for (const b of list.slice().sort((a, c) => a.repoName.localeCompare(c.repoName))) {
			const row = h("button", "mg-brow mg-brow-h");
			row.type = "button";
			row.classList.toggle("active", isPickedBranch(b, b.repo));
			row.title = `${b.repo} · ${b.name}`;
			const flags = [b.ahead ? `↑${b.ahead}` : "", b.behind ? `↓${b.behind}` : "", b.gone ? "gone" : "", b.merged ? "merged" : "", b.current ? "current" : ""].filter(Boolean);
			row.append(h("span", "mg-brow-name", b.repoName), h("span", "mg-brow-track", b.name), h("span", "mg-brow-flags", flags.join(" ")));
			row.onclick = () => selectBranch({ name: b.name, current: b.current }, b.repo);
			body.append(row);
		}
	}

	// 3. hygiene: merged (safe to delete), stale and orphaned branches
	const isCandidate = (b) => !b.current && !isProtectedBranch(b, b.defaultRef) && (b.merged || (b.days ?? 0) > 90 || b.gone);
	const hygiene = repos.filter((r) => (r.branches ?? []).some((b) => isCandidate(b)));
	const cleanupSeg = segment(detailList, "ws:cleanup", "Cleanup candidates", { count: hygiene.length, title: "Merged, stale (90+ days) or orphaned branches" });
	if (!hygiene.length) cleanupSeg.append(h("div", "mg-empty", "No merged, stale or orphaned branches."));
	for (const r of hygiene) {
		const rows = (r.branches ?? []).filter((b) => !b.current && !isProtectedBranch(b, b.defaultRef) && (b.merged || (b.days ?? 0) > 90 || b.gone));
		const body = segment(cleanupSeg, `ws:cleanup:${r.repo}`, r.name, { sub: true, count: rows.length });
		for (const b of rows.slice(0, 12)) {
			const row = h("button", "mg-brow mg-brow-h");
			row.type = "button";
			row.classList.toggle("active", isPickedBranch(b, b.repo));
			row.title = `${b.name}${b.merged ? " — merged into the default branch" : ""}`;
			row.append(
				h("span", "mg-brow-name", b.name),
				h("span", "mg-brow-track", b.when || ""),
				h("span", "mg-brow-flags", [b.merged ? "merged" : "", (b.days ?? 0) > 90 ? "stale" : "", b.gone ? "gone" : ""].filter(Boolean).join(" ")),
			);
			row.onclick = () => selectBranch({ name: b.name, current: false }, r.repo);
			body.append(row);
		}
		if (rows.length > 12) body.append(h("div", "mg-empty", `… ${rows.length - 12} more in ${r.name}`));
	}
}
async function showBlame(repo, relPath, rev = "HEAD") {
	resetPaneExclusivity();
	state.blame = { repo, path: relPath, rev, lines: null, commits: {}, truncated: false };
	renderDiff();
	const res = await request("blame", { repo, path: relPath, rev });
	if (destroyed || state.blame?.path !== relPath) return;
	if (res.ok) state.blame = { repo, path: relPath, rev, lines: res.lines ?? [], commits: res.commits ?? {}, truncated: !!res.truncated };
	else state.blameError = res.error || "Blame failed";
	renderDiff();
}
function renderBlame() {
	const b = state.blame;
	diffTitle.textContent = `blame · ${b.path}`;
	addDiffAction("Diff", () => {
			state.blame = null;
			state.blameError = null;
			renderDiff();
		});
	addDiffAction("History", () => showHistoryForFile(b.repo, b.path));
	if (state.blameError) {
		diffBody.append(h("div", "mg-error", state.blameError));
		return;
	}
	if (!b.lines) {
		diffBody.append(h("div", "mg-empty", "Running git blame…"));
		return;
	}
	const commits = b.commits ?? {};
	const authors = new Map();
	for (const sha of Object.keys(commits)) {
		const c = commits[sha];
		authors.set(c.author || c.mail || sha, (authors.get(c.author || c.mail || sha) ?? 0) + 1);
	}
	const summary = h("div", "mg-ws-summary");
	summary.append(
		chip(`${b.lines.length} lines`, "", "blamed lines"),
		chip(`${Object.keys(commits).length} commits`, "", "commits touching this file"),
	);
	for (const [name, n] of [...authors.entries()].sort((a, c) => c[1] - a[1]).slice(0, 3)) {
		summary.append(chip(`${name} ${n}`, "", `${n} lines by ${name}`));
	}
	diffBody.append(summary);
	const frag = document.createDocumentFragment();
	for (const line of b.lines) {
		const c = commits[line.sha] ?? {};
		const row = h("div", "mg-line mg-line-p mg-line-ctx");
		const gut = h("span", "mg-gut mg-gut-blame");
		const hashBtn = h("button", "mg-blame-hash", c.short ?? String(line.sha).slice(0, 8));
		hashBtn.type = "button";
		hashBtn.title = `${c.author ?? ""} ${c.date ?? ""} — ${c.summary ?? ""}`.trim();
		hashBtn.onclick = () => void selectCommit(line.sha, b.repo);
		gut.append(hashBtn);
		row.append(gut, h("span", "mg-blame-who", `${c.author ?? "?"} · ${c.date ?? ""}`), h("span", "mg-code", line.text === "" ? " " : line.text));
		frag.append(row);
	}
	if (b.truncated) frag.append(h("div", "mg-empty", "… more lines hidden"));
	diffBody.append(frag);
}
/** `base...head`: commits on the head side plus the merge-base patch. */
async function showCompare(repo, base, head) {
	resetPaneExclusivity();
	state.compare = { repo, base, head, history: null, patch: null, stats: null, ahead: 0, behind: 0 };
	renderDiff();
	const res = await request("compare", { repo, base, head, ...patchOpts() });
	if (destroyed) return;
	if (res.ok) state.compare = res;
	else state.compareError = res.error || "Compare failed";
	renderDiff();
}
function renderCompare() {
	const c = state.compare;
	diffTitle.textContent = `${c.base}...${c.head}`;
	addDiffAction("Close", () => {
			state.compare = null;
			state.compareError = null;
			renderDiff();
		});
	if (state.compareError) {
		diffBody.append(h("div", "mg-error", state.compareError));
		return;
	}
	if (!c.patch) {
		diffBody.append(h("div", "mg-empty", `Comparing ${c.base} with ${c.head}…`));
		return;
	}
	const files = Object.keys(c.stats ?? {});
	const plus = Object.values(c.stats ?? {}).reduce((n, p) => n + (p?.[0] ?? 0), 0);
	const minus = Object.values(c.stats ?? {}).reduce((n, p) => n + (p?.[1] ?? 0), 0);
	const summary = h("div", "mg-ws-summary");
	summary.append(
		chip(`+${c.ahead ?? 0} on ${c.head}`, "mg-chip-add", "commits the head side has and the base does not"),
		chip(`+${c.behind ?? 0} on ${c.base}`, "mg-chip-del", "commits the base has and the head does not"),
		chip(`${files.length} files`, "", "files changed between the merge base and head"),
		chip(`+${plus}`, "mg-chip-add", "insertions"),
		chip(`-${minus}`, "mg-chip-del", "deletions"),
	);
	diffBody.append(summary);
	if ((c.history ?? []).length) {
		diffBody.append(h("div", "mg-section", `Commits only on ${c.head} (${c.history.length})`));
		for (const commit of c.history) {
			diffBody.append(commitRow(commit, false, () => void selectCommit(commit.hash, c.repo)));
		}
	}
	diffBody.append(h("div", "mg-section", "Patch (merge base → head)"));
	addPatchActions();
	renderPatch(diffBody, c.patch, { index: true });
}

	return { activeBranchPattern, setBranchPattern, branchGroupBar, ensureWorkspace, renderWorkspace, showBlame, renderBlame, showCompare, renderCompare };
}
