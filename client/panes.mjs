/**
 * The pane construction: the header controls, the three panes, the terminal, the diff viewer and the
 * dividers. It owns the elements; the entry destructures them back, so the rest of mount() is unchanged.
 */

export function createPanes(deps) {
	const {
		CSS,
		TAB_DEFS,
		REFRESH_CHOICES,
		renderFoot,
		h,
		setTab,
		state,
	} = deps;

const style = document.createElement("style");
style.textContent = CSS;
const root = h("div", "mg-root");

const head = h("div", "mg-head");
const searchInput = document.createElement("input");
searchInput.type = "text";
searchInput.className = "mg-search";
searchInput.placeholder = "search all repos… (Enter)";
searchInput.title = "git grep across every repository";
const regexBtn = h("button", "mg-btn mg-search-regex", ".*");
regexBtn.type = "button";
regexBtn.title = "Treat the query as a regular expression";
const searchBtn = h("button", "mg-btn", "Search");
searchBtn.type = "button";
const clearBtn = h("button", "mg-btn mg-search-clear", "✕");
clearBtn.type = "button";
clearBtn.title = "Clear search results";
clearBtn.style.display = "none";
// The status is a slot, not a sentence: each part keeps its own box so a refresh cannot reflow the
// header, and the numbers stay readable while a scan is in flight.
const statusScan = h("span", "mg-status-scan");
const statusRepos = h("span", "mg-status-part mg-status-repos", "—");
const statusDirty = h("span", "mg-status-part mg-status-dirty", "");
const statusCwd = h("button", "mg-status-cwd");
statusCwd.type = "button";
const sub = h("div", "mg-sub"); // kept for the "names the scan root" contract of the tests
sub.append(statusScan, statusRepos, statusDirty, statusCwd);
statusCwd.onclick = () => {
	const write = globalThis.navigator?.clipboard?.writeText;
	if (typeof write !== "function" || !state.cwd) return;
	write.call(globalThis.navigator.clipboard, state.cwd).catch(() => {});
	state.notice = "Workspace path copied";
	renderFoot();
};
const spacer = h("div", "mg-spacer");
const cleanLabel = h("label", "mg-check");
const cleanBox = document.createElement("input");
cleanBox.type = "checkbox";
cleanLabel.append(cleanBox, h("span", null, "Only dirty"));
const refreshSel = h("select", "mg-select");
for (const sec of REFRESH_CHOICES) {
	const opt = document.createElement("option");
	opt.value = String(sec);
	opt.textContent = sec === 0 ? "Auto refresh: off" : `Auto refresh: ${sec}s`;
	refreshSel.append(opt);
}
const refreshBtn = h("button", "mg-btn", "Refresh");
refreshBtn.type = "button";
const searchMode = h("select", "mg-select mg-select-sm");
for (const [value, label, hint] of [
	["content", "Content", "git grep inside files"],
	["files", "File names", "match paths (tracked + untracked)"],
	["pickaxe", "Pickaxe", "git log -S: when did this string appear or vanish (slower)"],
]) {
	const opt = document.createElement("option");
	opt.value = value;
	opt.textContent = label;
	searchMode.append(opt);
}
searchMode.title = "What to search for";
const filterInput = document.createElement("input");
filterInput.type = "text";
filterInput.className = "mg-search mg-filter";
filterInput.placeholder = "filter repos…";
filterInput.title = "Show only repositories whose name or path contains this text";
const sortSel = h("select", "mg-select");
for (const [value, label] of [["name", "Sort: name"], ["status", "Sort: dirty first"], ["recent", "Sort: recent commit"], ["drift", "Sort: ahead/behind"]]) {
	const opt = document.createElement("option");
	opt.value = value;
	opt.textContent = label;
	sortSel.append(opt);
}
const groupSel = h("select", "mg-select");
for (const [value, label] of [["none", "Group: none"], ["prefix", "Group: service"], ["branch", "Group: branch"]]) {
	const opt = document.createElement("option");
	opt.value = value;
	opt.textContent = label;
	groupSel.append(opt);
}
// Pull is a write operation on the working tree: two-click confirm, fast-forward only.
const pullBtn = h("button", "mg-btn", "Pull");
pullBtn.type = "button";
pullBtn.title = "Fetch and fast-forward every repository (skips repos mid-rebase/merge, never merges divergent branches)";
const fetchBtn = h("button", "mg-btn", "Fetch");
fetchBtn.type = "button";
fetchBtn.title = "git fetch --all --prune in every scanned repo (updates remote refs only, never the work tree)";
const chips = h("div", "mg-chips"); // filled by renderChips(), placed in the repository pane
// Row one: who this is and what it found. Row two: what you can do, grouped by what it acts on.
const headTop = h("div", "mg-head-top");
headTop.append(h("span", "mg-title", "Multi-repo Git"), sub);
const searchGroup = h("div", "mg-hgroup");
searchGroup.append(searchInput, searchMode, regexBtn, searchBtn, clearBtn);
const listGroup = h("div", "mg-hgroup");
listGroup.append(filterInput, sortSel, groupSel);
const scanGroup = h("div", "mg-hgroup");
scanGroup.append(fetchBtn, pullBtn, refreshBtn, refreshSel, cleanLabel);
const headBar = h("div", "mg-head-bar");
headBar.append(searchGroup, spacer, listGroup, scanGroup);
head.append(headTop, headBar);

const body = h("div", "mg-body");

const reposPane = h("div", "mg-pane mg-pane-fixed mg-repos");
const reposHead = h("div", "mg-pane-head");
const reposCount = h("span", null, "Repositories");
reposHead.append(reposCount);
const reposList = h("div", "mg-list");
// The chips count and filter the *repositories*, so they belong to this pane, not to a row above
// both panes: a status about the left list reads as part of it.
reposPane.append(reposHead, chips, reposList);

const detailPane = h("div", "mg-pane mg-detail");
const detailHead = h("div", "mg-pane-head");
const detailTitle = h("span", "mg-diff-title", "Select a repository");
const tabs = h("div", "mg-tabs");
const tabButtons = {};
for (const def of TAB_DEFS) {
	const btn = h("button", "mg-tab", def.label);
	btn.type = "button";
	btn.addEventListener("click", () => setTab(def.id));
	tabButtons[def.id] = btn;
	tabs.append(btn);
}
const headRight = h("div", "mg-pane-head-right");
const termToggle = h("button", "mg-term-btn", "Terminal");
termToggle.type = "button";
termToggle.title = "Show / hide the command terminal (runs in the selected repo)";
headRight.append(tabs, termToggle);
detailHead.append(detailTitle, headRight);
const detailInfo = h("div", "mg-repo-meta");
const detailList = h("div", "mg-list");
const termEl = h("div", "mg-term");
termEl.style.display = "none";
const termHead = h("div", "mg-term-head");
const termTitle = h("span", "mg-term-title", "terminal");
const termClear = h("button", "mg-term-clear", "✕");
termClear.type = "button";
termClear.title = "Clear terminal output";
termHead.append(termTitle, termClear);
const termHost = h("div", "mg-term-host");
const termHint = h("div", "mg-term-hint", "the shell starts when a repository is selected");
termEl.append(termHead, termHost, termHint);
detailPane.append(detailHead, detailInfo, detailList, termEl);

const diffPane = h("div", "mg-pane mg-pane-fixed mg-diff");
const diffHead = h("div", "mg-pane-head");
const diffTitle = h("span", "mg-diff-title", "Diff");
const diffActions = h("div", "mg-diff-actions");
diffHead.append(diffTitle, diffActions);
const diffBody = h("div", "mg-diff-body");
diffPane.append(diffHead, diffBody);

const split1 = h("div", "mg-split");
const split2 = h("div", "mg-split");
body.append(reposPane, split1, detailPane, split2, diffPane);
const foot = h("div", "mg-foot");
root.append(head, body, foot);

	return { body, chips, cleanBox, cleanLabel, clearBtn, detailHead, detailInfo, detailList, detailPane, detailTitle, diffActions, diffBody, diffHead, diffPane, diffTitle, fetchBtn, filterInput, foot, groupSel, head, headBar, headRight, headTop, listGroup, pullBtn, refreshBtn, refreshSel, regexBtn, reposCount, reposHead, reposList, reposPane, root, scanGroup, searchBtn, searchGroup, searchInput, searchMode, sortSel, spacer, split1, split2, statusCwd, statusDirty, statusRepos, statusScan, style, sub, tabButtons, tabs, termClear, termEl, termHead, termHint, termHost, termTitle, termToggle };
}
