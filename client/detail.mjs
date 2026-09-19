/**
 * The middle pane's content: a commit, a file's diff, a patch with its own toolbar. `parsePatch` and the
 * patch renderers live together because they share the parsed shape.
 */


export function createDetail(deps) {
	const {
	MAX_DIFF_LINES, // from module
	applyLayout, // from mount
	backFromHistory, // from mount
	branchRow, // from mount
	chip, // from mount
	collectByClass, // from mount
	commitCache, // from mount
	commitRow, // from mount
	copyPathButton, // from mount
	countsSpan, // from mount
	detailInfo, // from mount
	detailList, // from mount
	detailTitle, // from mount
	diffActions, // from mount
	diffBody, // from mount
	diffCache, // from mount
	diffHead, // from mount
	diffTitle, // from mount
	fileBadge, // from mount
	fileRow, // from mount
	gutterCells, // from mount
	gutterGeometry, // from mount
	h, // from mount
	lineClass, // from mount
	metaRow, // from mount
	pathParts, // from mount
	renderBlame, // from mount
	renderCompare, // from mount
	renderSearch, // from mount
	renderTimelineList, // from mount
	renderWorkspace, // from mount
	selectCommit, // from mount
	selectFile, // from mount
	selectStash, // from mount
	selectedRepo, // from mount
	showBlame, // from mount
	showCompare, // from mount
	showHistoryForFile, // from mount
	stashRow, // from mount
	stashshowCache, // from mount
	TAB_DEFS, // from mount
	state, // from mount
	stripAb, // from mount
	tabButtons, // from mount
	tabs, // from mount
	unquoteGitPath, // from mount
	} = deps;


/* ---------------- middle pane ---------------- */
function renderDetail() {
	applyLayout(); // pane widths + terminal visibility/title follow repo/prefs state
	if (state.searchActive) {
		renderSearch();
		return;
	}
	const repo = selectedRepo();
	tabs.style.display = state.repos.length ? "" : "none";
	for (const def of TAB_DEFS) tabButtons[def.id].classList.toggle("active", state.tab === def.id);

	tabButtons.changes.textContent = repo && repo.ok && repo.counts.total ? `Changes ${repo.counts.total}` : "Changes";
	tabButtons.history.textContent = state.history && state.history.length ? `History ${state.history.length}` : "History";
	tabButtons.branches.textContent = state.branches?.branches?.length ? `Branches ${state.branches.branches.length}` : "Branches";
	tabButtons.stashes.textContent = state.stashes?.stashes?.length ? `Stashes ${state.stashes.stashes.length}` : "Stashes";
	tabButtons.timeline.textContent = state.timeline?.events?.length ? `Timeline ${state.timeline.events.length}` : "Timeline";

	if (state.tab === "timeline") {
		detailTitle.textContent = "Workspace activity (7 days)";
		detailInfo.style.display = "none";
		renderTimelineList();
		return;
	}
	if (state.tab === "workspace") {
		detailTitle.textContent = "Cross-repo branches & unpushed";
		detailInfo.style.display = "none";
		renderWorkspace();
		return;
	}
	detailTitle.textContent = repo ? repo.name : "Select a repository";
	detailInfo.textContent = "";
	detailInfo.style.display = repo ? "" : "none";
	if (repo) {
		detailInfo.append(metaRow("Path", repo.path));
		detailInfo.append(metaRow("Branch", repo.detached ? "detached HEAD" : repo.branch || "—"));
		if (repo.upstream) {
			const flags = [repo.ahead ? `↑${repo.ahead}` : "", repo.behind ? `↓${repo.behind}` : ""].filter(Boolean).join(" ");
			detailInfo.append(metaRow("Upstream", `${repo.upstream}${repo.upstreamGone ? " (gone)" : ""}${flags ? ` ${flags}` : ""}`));
		}
		if (repo.head) detailInfo.append(metaRow("Last commit", `${repo.head.short} · ${repo.head.when} · ${repo.head.subject}`));
		const st = repo.state ?? {};
		if (st.flags?.length) detailInfo.append(metaRow("State", st.flags.join(", "), true));
		if (st.indexLock) detailInfo.append(metaRow("State", "index.lock present", true));
		if (!repo.ok) detailInfo.append(metaRow("Error", repo.error || "git error", true));
		if (state.detailError) detailInfo.append(metaRow("Error", state.detailError, true));
	}

	detailList.textContent = "";
	if (!repo) {
		detailList.append(h("div", "mg-empty", "Pick a repository on the left."));
		return;
	}

	if (state.tab === "changes") {
		if (!repo.ok) {
			detailList.append(h("div", "mg-error", repo.error || "git error"));
			return;
		}
		if (!repo.files.length) {
			detailList.append(h("div", "mg-empty", "Working tree clean."));
			return;
		}
		for (const f of repo.files) detailList.append(fileRow(repo, f));
		return;
	}

	if (state.tab === "history") {
		if (state.historyMode) {
			const line = h("div", "mg-section mg-section-back");
			line.append(h("span", null, state.historyMode === "file" ? `File history — ${state.historyPath}` : `Branch — ${state.historyRev}`));
			const back = h("button", "mg-btn sm", "← Back");
			back.type = "button";
			back.title = `Back to ${state.historyFrom ?? "branches"}`;
			back.onclick = () => backFromHistory();
			line.append(back);
			detailList.append(line);
		}
		if (!state.history) {
			detailList.append(h("div", "mg-empty", "Loading history…"));
			return;
		}
		if (!state.history.length) {
			detailList.append(h("div", "mg-empty", "No commits."));
			return;
		}
		const isFileMode = state.historyMode === "file";
		for (const commit of state.history) detailList.append(commitRow(commit, isFileMode));
		return;
	}

	if (state.tab === "branches") {
		renderBranchesDetail(repo);
		return;
	}

	if (state.tab === "stashes") {
		if (state.stashesError) {
			detailList.append(h("div", "mg-error", state.stashesError));
			return;
		}
		if (!state.stashes) {
			detailList.append(h("div", "mg-empty", "Loading stashes…"));
			return;
		}
		if (!state.stashes.stashes.length) {
			detailList.append(h("div", "mg-empty", "No stashes in this repository."));
			return;
		}
		for (const s of state.stashes.stashes) detailList.append(stashRow(s));
	}
}
function renderBranchesDetail(repo) {
	detailList.textContent = "";
	if (state.branchesError) {
		detailList.append(h("div", "mg-error", state.branchesError));
		return;
	}
	if (!state.branches) {
		detailList.append(h("div", "mg-empty", "Loading branches…"));
		return;
	}
	const sync = state.sync;
	if (sync && !state.syncError) {
		detailList.append(
			h("div", "mg-section", sync.upstream ? `${repo.branch || "HEAD"} vs ${sync.upstream}` : sync.note || "No upstream configured"),
		);
		if (sync.upstream) {
			if (!sync.unpushed.length && !sync.incoming.length) {
				detailList.append(h("div", "mg-empty", "In sync with upstream."));
			}
			if (sync.unpushed.length) {
				detailList.append(h("div", "mg-section-sub", "Unpushed"));
				for (const c of sync.unpushed) {
					detailList.append(commitRow({ hash: c.short, shortHash: c.short, author: "", date: c.date, subject: c.subject, decorations: "", graph: "" }, false, () => void selectCommit(c.short, repo.path)));
				}
			}
			if (sync.incoming.length) {
				detailList.append(h("div", "mg-section-sub", "Incoming (pull)"));
				for (const c of sync.incoming) {
					detailList.append(commitRow({ hash: c.short, shortHash: c.short, author: "", date: c.date, subject: c.subject, decorations: "", graph: "" }, false, () => void selectCommit(c.short, repo.path)));
				}
			}
		}
	} else if (state.syncError) {
		detailList.append(h("div", "mg-section", "Tracking unavailable"));
	}
	detailList.append(h("div", "mg-section", state.branches.defaultBranch ? `Branches (default: ${state.branches.defaultBranch})` : "Branches"));
	for (const b of state.branches.branches) detailList.append(branchRow(b, repo.path, state.branches.defaultRef ?? state.branches.defaultBranch));
}
/**
 * Split a unified patch (`git show` / `git diff` / `git stash show`) into commit meta, files,
 * hunks and numbered rows. The right pane renders from this structure, so file names, per-file
 * +/- counts and line numbers always exist — `diff --git` plumbing and the raw `--stat` block
 * are folded into the headers instead of being shown as loose text.
 */
function parsePatch(text) {
	const src = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
	const out = { meta: null, files: [], insertions: 0, deletions: 0, hidden: 0, rows: 0 };
	let i = 0;
	if (/^commit [0-9a-f]{7,40}/i.test(src[0] ?? "")) {
		const meta = { hash: (src[0].match(/^commit\s+([0-9a-f]{7,40})/i) ?? [])[1] ?? "", author: "", authorDate: "", committer: "", commitDate: "", merge: "", subject: "", body: "" };
		let k = 1;
		for (; k < src.length; k++) {
			const t = src[k];
			if (t.startsWith("Author:")) meta.author = t.slice(7).trim();
			else if (t.startsWith("AuthorDate:")) meta.authorDate = t.slice(11).trim();
			else if (t.startsWith("Commit:")) meta.committer = t.slice(7).trim();
			else if (t.startsWith("CommitDate:")) meta.commitDate = t.slice(11).trim();
			else if (t.startsWith("Merge:")) meta.merge = t.slice(6).trim();
			else if (t.trim() === "") {
				k += 1;
				break;
			} else break;
		}
		const msg = [];
		for (; k < src.length; k++) {
			const t = src[k];
			if (t === "---" || t.startsWith("diff --git ")) break;
			msg.push(t.startsWith("    ") ? t.slice(4) : t);
		}
		const joined = msg.join("\n").replace(/\s+$/, "");
		const nl = joined.indexOf("\n");
		meta.subject = nl < 0 ? joined : joined.slice(0, nl);
		meta.body = nl < 0 ? "" : joined.slice(nl + 1).replace(/^\n+/, "");
		out.meta = meta;
		i = k;
	}
	let cur = null;
	let hunk = null;
	const pushRow = (kind, raw) => {
		out.rows += 1;
		if (out.rows > MAX_DIFF_LINES) {
			out.hidden += 1;
			return;
		}
		const row = { kind, text: raw };
		if (kind === "add") row.newNo = hunk.newNo++;
		else if (kind === "del") row.oldNo = hunk.oldNo++;
		else if (kind === "nonewline") row.marker = true;
		else {
			row.oldNo = hunk.oldNo++;
			row.newNo = hunk.newNo++;
		}
		hunk.rows.push(row);
	};
	for (; i < src.length; i++) {
		const t = src[i];
		if (t.startsWith("diff --git ")) {
			// greedy: a path containing " b/" still splits at the last occurrence
			const rest = t.slice("diff --git ".length);
			const pair = rest.match(/^a\/(.*) b\/(.*)$/);
			const oldPath = pair ? unquoteGitPath(pair[1]) : stripAb(rest);
			cur = { oldPath, path: pair ? unquoteGitPath(pair[2]) : oldPath, status: "modified", additions: 0, deletions: 0, binary: false, notes: [], hunks: [] };
			hunk = null;
			out.files.push(cur);
			continue;
		}
		if (!cur) continue; // commit header / --stat block / trailing output
		if (t.startsWith("--- ")) {
			const p = stripAb(t.slice(4));
			if (p) cur.oldPath = p;
			else cur.status = "added";
			continue;
		}
		if (t.startsWith("+++ ")) {
			const p = stripAb(t.slice(4));
			if (p) cur.path = p;
			else cur.status = "deleted";
			continue;
		}
		if (t.startsWith("new file mode")) { cur.status = "added"; continue; }
		if (t.startsWith("deleted file mode")) { cur.status = "deleted"; continue; }
		if (t.startsWith("rename from ")) { cur.oldPath = unquoteGitPath(t.slice(12)); cur.status = "renamed"; continue; }
		if (t.startsWith("rename to ")) { cur.path = unquoteGitPath(t.slice(10)); cur.status = "renamed"; continue; }
		if (t.startsWith("copy from ")) { cur.oldPath = unquoteGitPath(t.slice(10)); cur.status = "copied"; continue; }
		if (t.startsWith("copy to ")) { cur.path = unquoteGitPath(t.slice(8)); cur.status = "copied"; continue; }
		if (t.startsWith("index ")) continue;
		if (t.startsWith("Binary files ") || t.startsWith("GIT binary patch")) { cur.binary = true; hunk = null; continue; }
		if (t.startsWith("similarity index ") || t.startsWith("dissimilarity index ") || t.startsWith("old mode ") || t.startsWith("new mode ")) { cur.notes.push(t); continue; }
		const hm = t.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
		if (hm) {
			hunk = { header: t.slice(0, t.indexOf("@@", 3) + 2), section: (hm[5] ?? "").trim(), oldNo: Number(hm[1]), newNo: Number(hm[3]), rows: [] };
			cur.hunks.push(hunk);
			continue;
		}
		if (!hunk) continue;
		if (t.startsWith("\\")) pushRow("nonewline", t);
		else if (t.startsWith("+")) {
			pushRow("add", t);
			cur.additions += 1;
		} else if (t.startsWith("-")) {
			pushRow("del", t);
			cur.deletions += 1;
		} else pushRow("ctx", t);
	}
	for (const f of out.files) {
		if (f.status === "deleted") f.path = f.oldPath;
		if (f.status === "added" || f.status === "deleted") f.oldPath = "";
		out.insertions += f.additions;
		out.deletions += f.deletions;
	}
	return out;
}
/**
 * Render a patch: optional commit header card, optional file index, then one card per file.
 * Text that no known shape matches still falls back to the plain line renderer.
 */
function renderPatch(parent, text, opts = {}) {
	const parsed = parsePatch(text);
	if (!parsed.files.length && !parsed.meta) {
		appendDiffText(parent, text);
		return null;
	}
	if (opts.meta && parsed.meta) parent.append(renderPatchMeta(parsed));
	const cards = document.createDocumentFragment();
	const cardOf = new Map();
	for (const f of parsed.files) {
		const card = renderFileCard(f);
		cardOf.set(f, card);
		cards.append(card);
	}
	if (opts.index && parsed.files.length > 1) parent.append(buildFileIndex(parsed, cardOf));
	parent.append(cards);
	if (!parsed.files.length) {
		const note = parsed.meta?.merge
			? "Merge commit — git shows no combined diff here (use the commit list to inspect either parent)."
			: parsed.meta
				? "This commit changes no files."
				: "No file changes in this patch.";
		parent.append(h("div", "mg-empty", note));
	}
	if (parsed.hidden) parent.append(h("div", "mg-empty", `… ${parsed.hidden} more diff lines hidden`));
	return parsed;
}
/** One file: sticky header (badge + path + counts), rename/mode notes, then its hunks. */
function renderFileCard(f) {
	const sec = h("div", "mg-dsec");
	const head = h("div", "mg-dsec-head");
	head.append(fileBadge(f), pathParts(f, "mg-path-dir", "mg-path-name"), countsSpan(f, "mg-counts"), copyPathButton(String(f.path ?? "")));
	sec.append(head);
	const notes = [];
	if (f.oldPath && f.oldPath !== f.path) notes.push(`${f.status === "copied" ? "copied from" : "renamed from"} ${f.oldPath}`);
	notes.push(...f.notes);
	if (notes.length) sec.append(h("div", "mg-dsec-note", notes.join(" · ")));
	const geo = gutterGeometry(f);
	for (const hunk of f.hunks) {
		sec.append(renderHunkHeader(hunk, geo));
		for (const r of hunk.rows) sec.append(patchLineRow(r, geo));
	}
	if (f.binary) sec.append(h("div", "mg-empty", "Binary file — no textual diff."));
	else if (!f.hunks.length) sec.append(h("div", "mg-empty", f.status === "renamed" ? "Renamed without content changes." : "No textual changes."));
	return sec;
}
function renderPatchMeta(parsed) {
	const meta = parsed.meta;
	const box = h("div", "mg-dh");
	box.append(h("div", "mg-dh-subject", meta.subject || "(no commit message)"));
	const row = h("div", "mg-dh-meta");
	if (meta.hash) row.append(chip(meta.hash.slice(0, 10), "", meta.hash));
	if (meta.author) row.append(chip(meta.author, "", meta.committer && meta.committer !== meta.author ? `${meta.author} (committed by ${meta.committer})` : meta.author));
	if (meta.authorDate) row.append(chip(meta.authorDate, "", meta.commitDate ? `authored ${meta.authorDate}, committed ${meta.commitDate}` : meta.authorDate));
	const n = parsed.files.length;
	row.append(chip(`${n} file${n === 1 ? "" : "s"}`, "", "files changed"));
	if (parsed.insertions) row.append(chip(`+${parsed.insertions}`, "mg-chip-add", "insertions"));
	if (parsed.deletions) row.append(chip(`-${parsed.deletions}`, "mg-chip-del", "deletions"));
	if (meta.merge) row.append(chip(`merge ${meta.merge.split(" ")[0]}`, "", `merge ${meta.merge}`));
	box.append(row);
	if (meta.body) box.append(h("pre", "mg-dh-body", meta.body));
	return box;
}
/** Clickable file list: badge + name + per-file counts, jumping to that file's card. */
function buildFileIndex(parsed, cardOf) {
	const box = h("div", "mg-dindex");
	const n = parsed.files.length;
	box.append(h("div", "mg-dindex-head", `${n} changed file${n === 1 ? "" : "s"} — click to jump`));
	const rows = [];
	for (const f of parsed.files) {
		const row = h("button", "mg-drow");
		row.type = "button";
		row.title = f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : String(f.path ?? "");
		row.append(fileBadge(f), pathParts(f, "mg-path-dir", "mg-path-name"), countsSpan(f, "mg-counts"));
		row.onclick = () => {
			for (const other of rows) other.classList.toggle("active", other === row);
			try {
				cardOf.get(f)?.scrollIntoView?.({ block: "start" });
			} catch {
				/* not scrollable (tests) */
			}
		};
		rows.push(row);
		box.append(row);
	}
	return box;
}
function patchLineRow(r, geo) {
	const kindCls = r.kind === "add" ? "mg-line-add" : r.kind === "del" ? "mg-line-del" : r.marker ? "mg-line-meta" : "mg-line-ctx";
	const row = h("div", `mg-line mg-line-p ${kindCls}`);
	row.append(gutterCells(geo, r.oldNo, r.newNo), h("span", "mg-code", r.text === "" ? " " : r.text));
	return row;
}
function renderHunkHeader(hunk, geo) {
	const row = h("div", "mg-line mg-line-p mg-line-hunk");
	const gut = h("span", "mg-gut");
	gut.style.width = geo.width;
	row.append(gut, h("span", "mg-code", hunk.section ? `${hunk.header}  ${hunk.section}` : hunk.header));
	return row;
}
/** Re-read the visible patch after -w / context changed (the cached text is now wrong). */
function applyPatchOptions() {
	diffCache.clear();
	commitCache.clear();
	stashshowCache.clear();
	state.diff = null;
	state.commit = null;
	state.stashText = null;
	if (state.compare) void showCompare(state.compare.repo, state.compare.base, state.compare.head);
	else if (state.stashRef) void selectStash(state.stashRef);
	else if (state.selectedCommit) void selectCommit(state.selectedCommit);
	else if (state.selectedFile) void selectFile(state.selectedFile);
	else renderDiff();
}
/**
 * Actions for a patch view: whitespace/context controls (server round-trip), change
 * navigation, copy-as-patch and the wrap toggle. Rebuilt with the pane head on each render.
 */
function addPatchActions() {
	const wsBtn = h("button", `mg-btn sm${state.ignoreWs ? " active" : ""}`, "Ignore ws");
	wsBtn.type = "button";
	wsBtn.title = "git diff -w: hide whitespace-only changes";
	wsBtn.onclick = () => {
		state.ignoreWs = !state.ignoreWs;
		applyPatchOptions();
	};
	const ctxSel = document.createElement("select");
	ctxSel.className = "mg-select mg-select-sm";
	ctxSel.title = "Context lines around each change";
	for (const n of [0, 1, 3, 10]) {
		const opt = document.createElement("option");
		opt.value = String(n);
		opt.textContent = `-U${n}`;
		ctxSel.append(opt);
	}
	ctxSel.value = String(state.context);
	ctxSel.onchange = () => {
		state.context = Number(ctxSel.value);
		applyPatchOptions();
	};
	const prevBtn = h("button", "mg-btn sm", "▲");
	prevBtn.type = "button";
	prevBtn.title = "Previous change";
	prevBtn.onclick = () => jumpChange(-1);
	const nextBtn = h("button", "mg-btn sm", "▼");
	nextBtn.type = "button";
	nextBtn.title = "Next change";
	nextBtn.onclick = () => jumpChange(1);
	const copyBtn = h("button", "mg-btn sm", "Copy patch");
	copyBtn.type = "button";
	copyBtn.title = "Copy this patch to the clipboard";
	copyBtn.onclick = () => {
		const write = globalThis.navigator?.clipboard?.writeText;
		if (typeof write !== "function") return;
		try {
			write.call(globalThis.navigator.clipboard, currentPatchText());
			copyBtn.textContent = "copied";
			setTimeout(() => {
				copyBtn.textContent = "Copy patch";
			}, 1200);
		} catch {
			/* clipboard blocked */
		}
	};
	const wrapBtn = h("button", `mg-btn sm${state.diffWrap ? " active" : ""}`, "Wrap");
	wrapBtn.type = "button";
	wrapBtn.title = "Wrap long lines instead of scrolling sideways";
	wrapBtn.onclick = () => {
		state.diffWrap = !state.diffWrap;
		wrapBtn.classList.toggle("active", state.diffWrap);
		diffBody.classList.toggle("mg-wrap", state.diffWrap);
	};
	diffActions.append(wsBtn, ctxSel, prevBtn, nextBtn, copyBtn, wrapBtn);
}
/** Jump to the next/previous hunk in the visible patch. */
function jumpChange(delta) {
	const hunks = collectByClass(diffBody, "mg-line-hunk");
	if (!hunks.length) return;
	state.hunkIndex = (((state.hunkIndex + delta) % hunks.length) + hunks.length) % hunks.length;
	const el = hunks[state.hunkIndex];
	try {
		el.scrollIntoView?.({ block: "center" });
	} catch {
		/* not scrollable (tests) */
	}
	el.classList.add("mg-hunk-focus");
	setTimeout(() => {
		try {
			el.classList.remove("mg-hunk-focus");
		} catch {
			/* element replaced by a re-render */
		}
	}, 900);
}
/** The patch text the viewer is showing (Copy patch). */
function currentPatchText() {
	if (state.compare?.patch) return state.compare.patch;
	if (state.commit?.text) return state.commit.text;
	if (state.stashText) return state.stashText;
	if (state.diff) return [state.diff.staged, state.diff.worktree].filter(Boolean).join("\n");
	return "";
}
function appendDiffText(parent, text) {
	const lines = String(text ?? "").replace(/\n$/, "").split("\n");
	const frag = document.createDocumentFragment();
	const limit = Math.min(lines.length, MAX_DIFF_LINES);
	for (let i = 0; i < limit; i++) {
		const line = h("div", `mg-line ${lineClass(lines[i])}`);
		line.textContent = lines[i] === "" ? " " : lines[i];
		frag.append(line);
	}
	if (lines.length > limit) {
		frag.append(h("div", "mg-empty", `… ${lines.length - limit} more lines hidden`));
	}
	parent.append(frag);
}
function appendPlainText(parent, text) {
	const lines = String(text ?? "").replace(/\n$/, "").split("\n");
	const frag = document.createDocumentFragment();
	const limit = Math.min(lines.length, MAX_DIFF_LINES);
	for (let i = 0; i < limit; i++) {
		const line = h("div", "mg-line mg-line-ctx");
		line.textContent = lines[i] === "" ? " " : lines[i];
		frag.append(line);
	}
	if (lines.length > limit) frag.append(h("div", "mg-empty", `… ${lines.length - limit} more lines hidden`));
	parent.append(frag);
}
/** File content with line numbers; lines matching the query are highlighted. */
function appendFileText(parent, text, query) {
	const lines = String(text ?? "").replace(/\n$/, "").split("\n");
	const q = (query ?? "").toLowerCase();
	const frag = document.createDocumentFragment();
	const limit = Math.min(lines.length, MAX_DIFF_LINES);
	for (let i = 0; i < limit; i++) {
		const hit = q && lines[i].toLowerCase().includes(q);
		const line = h("div", `mg-line mg-line-file${hit ? " mg-hit" : ""}`);
		line.textContent = `${String(i + 1).padStart(4)}\u2002${lines[i] === "" ? " " : lines[i]}`;
		frag.append(line);
	}
	if (lines.length > limit) frag.append(h("div", "mg-empty", `… ${lines.length - limit} more lines hidden`));
	parent.append(frag);
}
function renderDiff() {
	diffBody.textContent = "";
	diffBody.classList.toggle("mg-wrap", !!state.diffWrap);
	diffHead.textContent = "";
	diffActions.textContent = "";
	diffHead.append(diffTitle, diffActions);
	if (state.blame) {
		renderBlame();
		return;
	}
	if (state.compare) {
		renderCompare();
		return;
	}
	const repo = selectedRepo();

	if (state.stashRef && state.selectedRepo) {
		diffTitle.textContent = state.stashRef;
		if (state.detailError) {
			diffBody.append(h("div", "mg-error", state.detailError));
			return;
		}
		if (state.stashText == null) {
			diffBody.append(h("div", "mg-empty", "Loading stash…"));
			return;
		}
		addPatchActions();
		renderPatch(diffBody, state.stashText, { index: true });
		return;
	}

	if (state.showfile) {
		diffTitle.textContent = `${state.showfile.rev}:${state.showfile.path}`;
		addDiffAction("History", () => showHistoryForFile(state.showfile.repo, state.showfile.path));
		addDiffAction("Blame", () => void showBlame(state.showfile.repo, state.showfile.path, state.showfile.rev));
		if (state.detailError) {
			diffBody.append(h("div", "mg-error", state.detailError));
			return;
		}
		if (state.showfile.text == null) {
			diffBody.append(h("div", "mg-empty", "Loading file…"));
			return;
		}
		if (state.showfile.text === "[binary file]") {
			diffBody.append(h("div", "mg-empty", "[binary file]"));
			return;
		}
		appendFileText(diffBody, state.showfile.text, state.showfile.query);
		return;
	}

	if (state.selectedCommit) {
		diffTitle.textContent = state.selectedCommit.slice(0, 10);
		if (state.detailError) {
			diffBody.append(h("div", "mg-error", state.detailError));
			return;
		}
		if (!state.commit) {
			diffBody.append(h("div", "mg-empty", "Loading commit…"));
			return;
		}
		addPatchActions();
		// the pane head keeps the short hash + subject, so it stays readable after scrolling
		const parsed = renderPatch(diffBody, state.commit.text, { meta: true, index: true });
		if (parsed?.meta?.subject) diffTitle.textContent = `${state.selectedCommit.slice(0, 10)} · ${parsed.meta.subject}`;
		return;
	}

	if (state.selectedFile) {
		diffTitle.textContent = state.selectedFile;
		addDiffAction("History", () => showHistoryForFile(state.selectedRepo, state.selectedFile));
		addDiffAction("Blame", () => void showBlame(state.selectedRepo, state.selectedFile));
		if (state.detailError) {
			diffBody.append(h("div", "mg-error", state.detailError));
			return;
		}
		const diff = state.diff;
		if (!diff) {
			diffBody.append(h("div", "mg-empty", "Loading diff…"));
			return;
		}
		if (diff.untracked) {
			diffBody.append(h("div", "mg-section", "Untracked file — head of file"));
			appendPlainText(diffBody, diff.preview ?? "");
			return;
		}
		if (!diff.staged && !diff.worktree) {
			diffBody.append(h("div", "mg-empty", "No diff for this path (only metadata changed, or the file is untracked)."));
			return;
		}
		addPatchActions();
		if (diff.staged) {
			diffBody.append(h("div", "mg-section", "Staged"));
			renderPatch(diffBody, diff.staged);
		}
		if (diff.worktree) {
			diffBody.append(h("div", "mg-section", "Unstaged"));
			renderPatch(diffBody, diff.worktree);
		}
		return;
	}

	/**
	 * Each tab opens something different in this pane, so the empty state names the thing the
	 * user is actually looking at instead of a generic "select a file".
	 */
	const hints = {
		changes: "Select a changed file to see its patch, or Rollback it from the list.",
		history: "Select a commit to see its message, files and patch.",
		branches: "Select a branch for its history, or Compare it with the current branch.",
		stashes: "Select a stash to see its patch.",
		workspace: "Select a branch row to open its history, or a commit to see its patch.",
	};
	diffTitle.textContent = "Diff";
	diffBody.append(h("div", "mg-empty", repo ? hints[state.tab] ?? "Select a file or a commit to see its diff." : "Select a repository."));
}
/** Wrap toggle for long diff lines (view-local; rebuilt with the head on every render). */
/** Patch view options the server needs (`-w` and the context size). */
function patchOpts() {
	return { ignoreWs: state.ignoreWs, context: state.context };
}
/* ---------------- helpers ---------------- */
function resetDiffContext() {
	state.selectedFile = null;
	state.selectedCommit = null;
	state.stashRef = null;
	state.stashText = null;
	state.showfile = null;
	state.diff = null;
	state.commit = null;
	state.detailError = null;
	state.blame = null;
	state.compare = null;
}
/* ---------------- right pane ---------------- */
function addDiffAction(label, onClick) {
	const btn = h("button", "mg-btn sm", label);
	btn.type = "button";
	btn.onclick = onClick;
	diffActions.append(btn);
}

	return { renderDetail, renderBranchesDetail, parsePatch, renderPatch, renderFileCard, renderPatchMeta, buildFileIndex, patchLineRow, renderHunkHeader, applyPatchOptions, addPatchActions, jumpChange, currentPatchText, appendDiffText, appendPlainText, appendFileText, renderDiff, patchOpts, resetDiffContext, addDiffAction };
}
