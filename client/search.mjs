/**
 * Cross-repo search: the query box, the three modes, and the results. The sequence guard lives here because
 * a slow reply must not overwrite a newer query's results.
 */


export function createSearch(deps) {
	const {
	REQUEST_TIMEOUT_MS, // from module
	clearBtn, // from mount
	commitRow, // from mount
	destroyed, // from mount
	detailInfo, // from mount
	detailList, // from mount
	detailTitle, // from mount
	h, // from mount
	regexBtn, // from mount
	renderAll, // from mount
	renderDiff, // from mount
	request, // from mount
	resetDiffContext, // from mount
	searchInput, // from mount
	searchMode, // from mount
	selectCommit, // from mount
	shortName, // from mount
	showfileCache, // from mount
	state, // from mount
	tabs, // from mount
	} = deps;

	let searchSeq = 0;

/* ---------------- search ---------------- */
function renderSearch() {
	tabs.style.display = "none";
	const modeLabel = state.searchMode === "files" ? "Files" : state.searchMode === "pickaxe" ? "Pickaxe" : "Search";
	detailTitle.textContent = `${modeLabel}: “${state.searchQuery}”`;
	detailInfo.style.display = "none";
	detailList.textContent = "";
	if (state.searchError) {
		detailList.append(h("div", "mg-error", state.searchError));
		return;
	}
	if (state.searchMode === "pickaxe") {
		if (!state.searchCommits) {
			detailList.append(h("div", "mg-empty", "Walking history with git log -S… this reads every blob, so it takes a moment."));
			return;
		}
		if (!state.searchCommits.length) {
			detailList.append(h("div", "mg-empty", `No commit adds or removes “${state.searchQuery}”.`));
			return;
		}
		let lastPickaxeRepo = null;
		for (const c of state.searchCommits) {
			if (c.repo !== lastPickaxeRepo) {
				detailList.append(h("div", "mg-group", shortName(c.repo)));
				lastPickaxeRepo = c.repo;
			}
			detailList.append(commitRow({ ...c, shortHash: c.shortHash ?? String(c.hash ?? "").slice(0, 8) }, false, () => void selectCommit(c.hash, c.repo)));
		}
		if (state.searchTruncated) detailList.append(h("div", "mg-empty", "… more commits hidden (cap reached)"));
		return;
	}
	if (!state.searchResults) {
		detailList.append(h("div", "mg-empty", "Searching…"));
		return;
	}
	if (!state.searchResults.length) {
		detailList.append(h("div", "mg-empty", state.searchMode === "files" ? `No file path matches “${state.searchQuery}”.` : `No matches for “${state.searchQuery}”.`));
		return;
	}
	let lastRepo = null;
	for (const hit of state.searchResults) {
		if (hit.repo !== lastRepo) {
			detailList.append(h("div", "mg-group", shortName(hit.repo)));
			lastRepo = hit.repo;
		}
		if (state.searchMode === "files") {
			// path hit: no line/text, the name IS the result
			const row = h("button", "mg-hit");
			row.type = "button";
			row.title = `${hit.repo} · ${hit.path}`;
			row.append(h("span", "mg-hit-path", hit.path));
			row.onclick = () => void openSearchHit({ ...hit, line: 1 });
			detailList.append(row);
			continue;
		}
		if (hit.repo !== lastRepo) {
			detailList.append(h("div", "mg-group", shortName(hit.repo)));
			lastRepo = hit.repo;
		}
		const row = h("button", "mg-hit");
		row.type = "button";
		row.title = `${hit.repo} · ${hit.path}:${hit.line}`;
		row.append(h("span", "mg-hit-line", String(hit.line)), h("span", "mg-hit-path", hit.path), h("span", "mg-hit-text", hit.text));
		row.onclick = () => void openSearchHit(hit);
		detailList.append(row);
	}
	if (state.searchTruncated) detailList.append(h("div", "mg-empty", "… more matches hidden (cap reached)"));
}
function submitSearch() {
	const raw = searchInput.value.trim();
	if (!raw) return;
	state.searchActive = true;
	state.searchQuery = raw;
	state.searchMode = searchMode.value;
	state.searchCommits = null;
	state.searchResults = null;
	state.searchTruncated = false;
	state.searchError = null;
	clearBtn.style.display = "";
	renderAll();
	void asyncRunSearch();
}
function clearSearch() {
	searchSeq++;
	state.searchActive = false;
	state.searchQuery = "";
	state.searchResults = null;
	state.searchTruncated = false;
	state.searchError = null;
	searchInput.value = "";
	clearBtn.style.display = "none";
	renderAll();
}
async function asyncRunSearch() {
	const my = ++searchSeq;
	const mode = state.searchMode;
	// Pickaxe walks every blob's history: give it room, and say so in the UI while it runs.
	const res = await request("search", { query: state.searchQuery, regex: regexBtn.classList.contains("active"), mode }, mode === "pickaxe" ? 150_000 : REQUEST_TIMEOUT_MS);
	if (destroyed || my !== searchSeq) return;
	if (res.ok) {
		if (mode === "pickaxe") {
			state.searchCommits = res.commits ?? [];
			state.searchResults = null;
		} else {
			state.searchResults = res.results ?? [];
			state.searchCommits = null;
		}
		state.searchTruncated = !!res.truncated;
		state.searchError = null;
	} else {
		state.searchError = res.error || "Search failed";
	}
	renderAll();
}
async function openSearchHit(hit) {
	resetDiffContext();
	state.showfile = { repo: hit.repo, rev: "HEAD", path: hit.path, query: state.searchQuery, text: null };
	renderDiff();
	const key = `${hit.repo}\nHEAD\n${hit.path}`;
	const cached = showfileCache.get(key);
	if (cached !== undefined) {
		state.showfile = { ...state.showfile, text: cached };
		renderDiff();
		return;
	}
	const res = await request("showfile", { repo: hit.repo, rev: "HEAD", path: hit.path });
	if (destroyed) return;
	if (res.ok) {
		showfileCache.set(key, res.text ?? "");
		if (state.showfile && state.showfile.repo === hit.repo && state.showfile.path === hit.path) {
			state.showfile = { ...state.showfile, text: res.text ?? "" };
		}
	} else {
		state.detailError = res.error || "Failed to read file";
	}
	renderDiff();
}

	return { renderSearch, submitSearch, clearSearch, asyncRunSearch, openSearchHit };
}
