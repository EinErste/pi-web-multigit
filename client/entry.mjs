/**
 * multi-git — client view (loaded as a bare ESM bundle by the host).
 *
 * One responsibility: the plugin view tab (`plugin:multi-git`) — a three-pane overview with
 * repositories on the left; a tabbed middle pane (Changes | History | Branches | Stashes |
 * Workspace | Timeline) plus cross-repo code search in the header; the diff/revision viewer
 * on the right.
 *
 * Everything the host provides arrives through the narrow ctx channel (`send` / `onData`).
 */

import { createBridge } from "./bridge.mjs";
import { createDetail } from "./detail.mjs";
import { createDom } from "./dom.mjs";
import { CSS, createLayout } from "./layout.mjs";
import { createLists } from "./lists.mjs";
import { createSearch } from "./search.mjs";
import { createTerminal } from "./terminal.mjs";
import { createTimeline } from "./timeline.mjs";
import { createWorkspace } from "./workspace.mjs";
import { createPanes } from "./panes.mjs";

const PLUGIN_ID = "multi-git";
const REQUEST_TIMEOUT_MS = 60_000;
/** Fetching every repo is a network round-trip per repo: allow it far more time than a local call. */
const FETCH_TIMEOUT_MS = 180_000;
/**
 * A terminal that failed to start is retried automatically (an un-reloaded plugin server or a
 * scan that had not landed yet both heal by themselves), but not on every render: the pane is
 * re-rendered by each auto-refresh tick, and each retry builds and tears down an xterm.
 * An explicit toggle clears the record and retries immediately.
 */
const TERM_RETRY_MS = 20_000;

/** Test seam: the DOM stub tests inject fake xterm classes here so the real
 * vendor bundle is never imported/constructed outside a browser. The client
 * bundle itself stays import-free of anything outside `client/`. */
const _testSeam = { termClasses: null, groupBranches, branchGroupKey };
/**
 * Which branches belong together across repositories.
 *
 * The default is the **full branch name**: the same branch name in several services is one group,
 * which is what actually happens when a feature touches three repositories. No guessing — fishing a
 * "ticket key" out of a name merges branches that are not related and hides branches that carry none.
 *
 * A workspace can opt into key extraction with a pattern (plugin setting, or per workspace in the
 * view): group by the first capture group of a regular expression, e.g. `([0-9a-z]{8,12})__` turns
 * `feat/ab12cd34__add-thing` into `ab12cd34`. Branches that do not match keep their full name, so
 * nothing silently disappears; both counters are reported so the view can say so.
 */
function branchGroupKey(name, pattern) {
	const branch = String(name ?? "");
	if (!pattern) return { key: branch, matched: true };
	try {
		const m = new RegExp(pattern).exec(branch);
		if (!m) return { key: branch, matched: false };
		return { key: m[1] ?? m[0], matched: true };
	} catch {
		return { key: branch, matched: false };
	}
}

/** A branch whose name is the repository's default branch is never part of a "feature" group. */
function isDefaultBranch(branch) {
	const ref = String(branch.defaultRef ?? "").replace(/^[^/]+\//, "");
	return ref !== "" && ref === String(branch.name ?? "");
}

/** `origin/master` → `master`: branch names travel with and without their remote prefix. */
function shortBranchName(name) {
	return String(name ?? "").replace(/^[^/]+\//, "");
}

/**
 * A protected branch: the repository's default branch, whether it is shown as `master` or
 * `origin/master`. It is never a cleanup candidate — git would not delete it, and a UI that suggests
 * otherwise is wrong. Falls back to the usual names when the default branch is unknown.
 */
function isProtectedBranch(branch, defaultRef) {
	const name = shortBranchName(branch?.name);
	const def = shortBranchName(defaultRef ?? branch?.defaultRef);
	if (def) return name === def;
	return /^(master|main)$/.test(name);
}

/** Groups shared by more than one repository, biggest first. Pure: the tests assert on this directly. */
function groupBranches(branches, pattern) {
	const groups = new Map();
	let unmatched = 0;
	let defaultSkipped = 0;
	for (const b of branches ?? []) {
		if (isDefaultBranch(b)) {
			defaultSkipped += 1;
			continue; // master/main in every repo is not a cross-repo feature
		}
		const { key, matched } = branchGroupKey(b.name, pattern);
		if (!matched) unmatched += 1;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(b);
	}
	const shared = [...groups.entries()]
		.filter(([, list]) => new Set(list.map((b) => b.repo)).size > 1)
		.sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0])));
	return { groups: shared.map(([key, list]) => ({ key, list })), unmatched, defaultSkipped };
}

const MAX_DIFF_LINES = 4_000;

/** Auto-refresh presets (seconds); 0 = off. */
const REFRESH_CHOICES = [0, 5, 10, 15, 30, 60, 120];

/** Middle-pane tabs, in order. */
const TAB_DEFS = [
	{ id: "changes", label: "Changes" },
	{ id: "history", label: "History" },
	{ id: "branches", label: "Branches" },
	{ id: "stashes", label: "Stashes" },
	{ id: "timeline", label: "Timeline" },
	{ id: "workspace", label: "Workspace" },
];


/**
 * SDK helpers, inlined on purpose. The host serves a plugin's static files from
 * `<pluginDir>/client/` only (`GET /plugins/:id/client/*`); importing `../sdk/index.mjs`
 * from here would resolve to `/plugins/<id>/sdk/index.mjs`, miss that route, fall through
 * to the SPA fallback and come back as HTML — which kills the whole module graph: the view
 * never mounts and every UI action reports "the plugin does not handle this action".
 * So this bundle imports nothing and carries the one helper it needs.
 */

function defineView(view) {
	if (!view || typeof view !== "object") throw new Error("[multi-git] defineView needs an object");
	if (typeof view.mount !== "function") throw new Error("[multi-git] view is missing mount(el, ctx)");
	return view;
}


export default defineView({
	mount(container, ctx) {
		/* ---------------- state ---------------- */
		const state = {
			repos: [],
			cwd: "",
			prefs: { hideClean: false, autoRefreshSec: 15, termVisible: false, widths: null },
			scannedAt: 0,
			truncated: false,
			error: null,
			selectedRepo: null,
			tab: "changes",
			selectedFile: null,
			selectedCommit: null,
			stats: null,
			history: null,
			diff: null,
			commit: null,
			stashRef: null,
			stashText: null,
			showfile: null,
			detailError: null,
			diffWrap: false,
			// repo-list view: name filter, attention filter, fetch state
			filter: "",
			attention: null,
			fetching: false,
			fetchSummary: null,
			// cross-repo tabs + viewer extras
			ws: null,
			wsError: null,
			// folded segments (prefs)
			collapsed: new Set(),
			compare: null,
			compareError: null,
			blame: null,
			blameError: null,
			// patch options (client-side viewers; -w / context go to the server)
			ignoreWs: false,
			context: 3,
			hunkIndex: -1,
			pulling: false,
			pullSummary: null,
			pullResults: null,
			notice: null,
			// scoped history: null | "file" | "branch"
			historyMode: null,
			historyPath: null,
			historyRev: null,
			historyFrom: null, // the tab a branch/file history was opened from, so it can be gone back to
			lastBranch: null, // { repo, name }: the branch picked last, marked in the branch lists
			// search
			searchActive: false,
			searchQuery: "",
			searchResults: null,
			searchTruncated: false,
			searchError: null,
			// tab payloads
			branches: null,
			branchesError: null,
			sync: null,
			syncError: null,
			stashes: null,
			stashesError: null,
			timeline: null,
			timelineError: null,
		};
		const statsCache = new Map();
		const logCache = new Map();
		const diffCache = new Map();
		const commitCache = new Map();
		const branchesCache = new Map();
		const syncCache = new Map();
		const stashesCache = new Map();
		const stashshowCache = new Map();
		const showfileCache = new Map();
		// Boxed, not a bare `let`: two concerns (the timeline view and the repo loader) reassign it, and a
		// destructured copy would leave one of them writing to a value nobody reads.
		const timelineCache = { value: null };
		const pending = new Map();
		// Boxed like the caches: scheduleAutoRefresh() writes it and mount's cleanup clears it.
		const timer = { value: null };
		let destroyed = false;
		// Cross-module calls are late-bound: each view calls another's function through this holder,
		// exactly as it did inside the closure. It is filled once every factory exists.
		const fwd = {};
		// bridge: bridge.mjs. Destructuring its result keeps the names below in
		// scope, so the rest of mount() is unchanged.
		const bridge = createBridge({
			PLUGIN_ID,
			REQUEST_TIMEOUT_MS,
			ctx,
			destroyed,
			pending,
			renderAll,
			state,
			syncControls: (...args) => fwd.syncControls(...args), // client/lists.mjs
		});
		const { request, savePrefs } = bridge;


		const offData = ctx.onData((msg) => {
			if (!msg || typeof msg !== "object") return;
			if (msg.action === `${PLUGIN_ID}:cwd`) {
				void loadRepos(true);
				return;
			}
			if (msg.action !== `${PLUGIN_ID}:data`) return;
			if (typeof msg.reqId === "number") {
				const settle = pending.get(msg.reqId);
				if (settle) {
					pending.delete(msg.reqId);
					settle(msg);
				}
			}
			/* streaming pushed by the terminal bridge (no reqId) */
			if (msg.kind === "term-data" && state.termActive && samePath(msg.repo, state.termRepo)) {
				try {
					state.termActive.write(msg.data);
				} catch {
					/* terminal died underneath us */
				}
				return;
			}
			if (msg.kind === "term-exit" && state.termActive && samePath(msg.repo, state.termRepo) && !state.termExited) {
				state.termExited = true;
				termTitle.textContent = `terminal · ${shortName(state.termRepo ?? "")} · exited`;
				try {
					state.termActive.write(`\r\n\u001b[90m[process exited]\u001b[0m\r\n`);
				} catch {}
				return;
			}
		});


		const shortName = (p) => {
			const s = String(p ?? "");
			const parts = s.replace(/[\\/]+$/, "").split(/[\\/]/);
			return parts[parts.length - 1] || s;
		};

		/* ---------------- skeleton ---------------- */

		const FILE_STATUS = {
			added: { letter: "A", cls: "add", word: "added" },
			deleted: { letter: "D", cls: "del", word: "deleted" },
			renamed: { letter: "R", cls: "ren", word: "renamed" },
			copied: { letter: "C", cls: "ren", word: "copied" },
			modified: { letter: "M", cls: "", word: "modified" },
		};

		// dom: dom.mjs. `h` builds the panes below, so this factory has to exist first; destructuring its
		// result keeps the names the rest of mount() uses.
		const dom = createDom({
			FILE_STATUS,
			state,
		});
		const { h, chip, metaRow, pathParts, countsSpan, copyPathButton, fileBadge, gutterGeometry, gutterCells, collectByClass, optKey, unquoteGitPath, stripAb, samePath, statusKind, lineClass, withoutBranchPrefix } = dom;

		// panes: panes.mjs. Every element the view uses comes from here; destructuring keeps the names
		// below in scope, so the rest of mount() is unchanged.
		const panes = createPanes({
			CSS,
			TAB_DEFS,
			REFRESH_CHOICES,
			renderFoot: (...args) => fwd.renderFoot(...args), // later: lists
			h,
			setTab,
			state,
		});
		const { body, chips, cleanBox, cleanLabel, clearBtn, detailHead, detailInfo, detailList, detailPane, detailTitle, diffActions, diffBody, diffHead, diffPane, diffTitle, fetchBtn, filterInput, foot, groupSel, head, headBar, headRight, headTop, listGroup, pullBtn, refreshBtn, refreshSel, regexBtn, reposCount, reposHead, reposList, reposPane, root, scanGroup, searchBtn, searchGroup, searchInput, searchMode, sortSel, spacer, split1, split2, statusCwd, statusDirty, statusRepos, statusScan, style, sub, tabButtons, tabs, termClear, termEl, termHead, termHint, termHost, termTitle, termToggle } = panes;
		container.append(style, root);

		// search: search.mjs. Destructuring its result keeps the names below in
		// scope, so the rest of mount() is unchanged.
		const search = createSearch({
			REQUEST_TIMEOUT_MS,
			clearBtn,
			commitRow: (...args) => fwd.commitRow(...args), // client/lists.mjs
			destroyed,
			detailInfo,
			detailList,
			detailTitle,
			h,
			regexBtn,
			renderAll,
			renderDiff: (...args) => fwd.renderDiff(...args), // client/detail.mjs
			request: (...args) => fwd.request(...args), // client/bridge.mjs
			resetDiffContext: (...args) => fwd.resetDiffContext(...args), // client/detail.mjs
			searchInput,
			searchMode,
			selectCommit: (...args) => fwd.selectCommit(...args), // client/lists.mjs
			shortName,
			showfileCache,
			state,
			tabs,
		});
		const { renderSearch, submitSearch, clearSearch, asyncRunSearch, openSearchHit } = search;

		// timeline: timeline.mjs. Destructuring its result keeps the names below in
		// scope, so the rest of mount() is unchanged.
		const timeline = createTimeline({
			destroyed,
			detailList,
			h,
			renderDetail: (...args) => fwd.renderDetail(...args), // client/detail.mjs
			request: (...args) => fwd.request(...args), // client/bridge.mjs
			selectCommit: (...args) => fwd.selectCommit(...args), // client/lists.mjs
			shortName,
			state,
			timelineCache,
		});
		const { timelineFilters, renderTimelineList, ensureTimeline } = timeline;

		// terminal: terminal.mjs. Destructuring its result keeps the names below in
		// scope, so the rest of mount() is unchanged.
		const terminal = createTerminal({
			PLUGIN_ID,
			TERM_RETRY_MS,
			_testSeam,
			ctx,
			destroyed,
			request: (...args) => fwd.request(...args), // client/bridge.mjs
			shortName,
			state,
			termHint,
			termHost,
			termTitle,
		});
		const { injectTermCss, ensureTermClasses, sendTermResize, fitTerm, showTermHint, errText, failTerminal, openTerminal, closeTerminal, syncTerminal } = terminal;

		// workspace: workspace.mjs. Destructuring its result keeps the names below in
		// scope, so the rest of mount() is unchanged.
		const workspace = createWorkspace({
			addDiffAction: (...args) => fwd.addDiffAction(...args), // client/detail.mjs
			addPatchActions: (...args) => fwd.addPatchActions(...args), // client/detail.mjs
			chip,
			commitRow: (...args) => fwd.commitRow(...args), // client/lists.mjs
			destroyed,
			detailList,
			diffBody,
			diffTitle,
			errText: (...args) => fwd.errText(...args), // client/terminal.mjs
			groupBranches,
			h,
			isPickedBranch: (...args) => fwd.isPickedBranch(...args), // client/lists.mjs
			isProtectedBranch,
			patchOpts: (...args) => fwd.patchOpts(...args), // client/detail.mjs
			renderDetail: (...args) => fwd.renderDetail(...args), // client/detail.mjs
			renderDiff: (...args) => fwd.renderDiff(...args), // client/detail.mjs
			renderFoot: (...args) => fwd.renderFoot(...args), // client/lists.mjs
			renderPatch: (...args) => fwd.renderPatch(...args), // client/detail.mjs
			request: (...args) => fwd.request(...args), // client/bridge.mjs
			resetPaneExclusivity: (...args) => fwd.resetPaneExclusivity(...args), // client/lists.mjs
			savePrefs: (...args) => fwd.savePrefs(...args), // client/bridge.mjs
			segment,
			selectBranch: (...args) => fwd.selectBranch(...args), // client/lists.mjs
			selectCommit: (...args) => fwd.selectCommit(...args), // client/lists.mjs
			showHistoryForFile: (...args) => fwd.showHistoryForFile(...args), // client/lists.mjs
			state,
			withoutBranchPrefix,
		});
		const { activeBranchPattern, setBranchPattern, branchGroupBar, ensureWorkspace, renderWorkspace, showBlame, renderBlame, showCompare, renderCompare } = workspace;


		const isDirty = (repo) => !repo.ok || (repo.counts && repo.counts.total > 0);
		/**
		 * Attention filters behind the health chips: the states that actually need a human.
		 * `hideClean` (the "Only dirty" checkbox) stays separate because it is a persisted pref.
		 */
		const ATTENTION = {
			dirty: { label: "dirty", test: (r) => isDirty(r) },
			conflicted: { label: "conflicted", test: (r) => (r.counts?.conflicted ?? 0) > 0 },
			behind: { label: "behind", test: (r) => (r.behind ?? 0) > 0 },
			ahead: { label: "ahead", test: (r) => (r.ahead ?? 0) > 0 },
			midop: { label: "mid-op", test: (r) => (r.state?.flags?.length ?? 0) > 0 },
			lock: { label: "index.lock", test: (r) => r.state?.indexLock === true },
			failed: { label: "git error", test: (r) => !r.ok },
		};
		const attentionCount = (key) => state.repos.filter((r) => ATTENTION[key].test(r)).length;
		const matchesFilters = (repo) => {
			if (state.prefs.hideClean && !isDirty(repo)) return false;
			if (state.attention && !ATTENTION[state.attention].test(repo)) return false;
			const needle = state.filter.trim().toLowerCase();
			if (needle && !`${repo.name} ${repo.path} ${repo.rootRelative ?? ""}`.toLowerCase().includes(needle)) return false;
			return true;
		};
		const visibleRepos = () => sortRepos(state.repos.filter(matchesFilters));
		// lists: lists.mjs. Destructuring its result keeps the names below in
		// scope, so the rest of mount() is unchanged.
		const lists = createLists({
			FETCH_TIMEOUT_MS,
			ATTENTION,
			attentionCount,
			branchesCache,
			chips,
			cleanBox,
			clearSearch: (...args) => fwd.clearSearch(...args), // client/search.mjs
			commitCache,
			destroyed,
			diffCache,
			ensureTimeline: (...args) => fwd.ensureTimeline(...args), // client/timeline.mjs
			foot,
			groupSel,
			h,
			isDirty,
			isProtectedBranch,
			logCache,
			optKey,
			patchOpts: (...args) => fwd.patchOpts(...args), // client/detail.mjs
			pending,
			refreshSel,
			renderAll,
			renderDetail: (...args) => fwd.renderDetail(...args), // client/detail.mjs
			renderDiff: (...args) => fwd.renderDiff(...args), // client/detail.mjs
			reposCount,
			reposList,
			request: (...args) => fwd.request(...args), // client/bridge.mjs
			resetDiffContext: (...args) => fwd.resetDiffContext(...args), // client/detail.mjs
			samePath,
			searchMode,
			showCompare: (...args) => fwd.showCompare(...args), // client/workspace.mjs
			showfileCache,
			sortSel,
			stashesCache,
			stashshowCache,
			state,
			statsCache,
			statusCwd,
			statusDirty,
			statusKind,
			statusRepos,
			statusScan,
			sub,
			syncCache,
			timelineCache,
			timer,
			visibleRepos,
		});
		const { loadRepos, sortRepos, selectRepo, ensureStats, ensureHistory, ensureBranches, ensureSync, ensureStashes, renderRepos, renderChips, renderSub, renderFoot, fileRow, commitRow, branchRow, stashRow, isPickedBranch, backFromHistory, setScanning, syncControls, scheduleAutoRefresh, fetchAll, pullAll, revertFile, confirmAction, moveSelection, selectFile, selectCommit, selectStash, refetchShowfile, selectFileAtCommit, showingShowfile, resetPaneExclusivity, selectBranch, showHistoryForFile, groupKey, historyKey } = lists;
		const selectedRepo = () => state.repos.find((r) => r.path === state.selectedRepo) ?? null;
		// detail: detail.mjs. Destructuring its result keeps the names below in
		// scope, so the rest of mount() is unchanged.
		const detail = createDetail({
			MAX_DIFF_LINES,
			applyLayout: (...args) => fwd.applyLayout(...args), // client/layout.mjs
			backFromHistory: (...args) => fwd.backFromHistory(...args), // client/lists.mjs
			branchRow: (...args) => fwd.branchRow(...args), // client/lists.mjs
			chip,
			collectByClass,
			commitCache,
			commitRow: (...args) => fwd.commitRow(...args), // client/lists.mjs
			copyPathButton,
			countsSpan,
			TAB_DEFS,
			detailInfo,
			detailList,
			detailTitle,
			diffActions,
			diffBody,
			diffCache,
			diffHead,
			diffTitle,
			fileBadge,
			fileRow: (...args) => fwd.fileRow(...args), // client/lists.mjs
			gutterCells,
			gutterGeometry,
			h,
			lineClass,
			metaRow,
			pathParts,
			renderBlame: (...args) => fwd.renderBlame(...args), // client/workspace.mjs
			renderCompare: (...args) => fwd.renderCompare(...args), // client/workspace.mjs
			renderSearch: (...args) => fwd.renderSearch(...args), // client/search.mjs
			renderTimelineList: (...args) => fwd.renderTimelineList(...args), // client/timeline.mjs
			renderWorkspace: (...args) => fwd.renderWorkspace(...args), // client/workspace.mjs
			selectCommit: (...args) => fwd.selectCommit(...args), // client/lists.mjs
			selectFile: (...args) => fwd.selectFile(...args), // client/lists.mjs
			selectStash: (...args) => fwd.selectStash(...args), // client/lists.mjs
			selectedRepo,
			showBlame: (...args) => fwd.showBlame(...args), // client/workspace.mjs
			showCompare: (...args) => fwd.showCompare(...args), // client/workspace.mjs
			showHistoryForFile: (...args) => fwd.showHistoryForFile(...args), // client/lists.mjs
			stashRow: (...args) => fwd.stashRow(...args), // client/lists.mjs
			stashshowCache,
			state,
			stripAb,
			tabButtons,
			tabs,
			unquoteGitPath,
		});
		const { renderDetail, renderBranchesDetail, parsePatch, renderPatch, renderFileCard, renderPatchMeta, buildFileIndex, patchLineRow, renderHunkHeader, applyPatchOptions, addPatchActions, jumpChange, currentPatchText, appendDiffText, appendPlainText, appendFileText, renderDiff, patchOpts, resetDiffContext, addDiffAction } = detail;


		/* ---------------- blame view ---------------- */


		/* ---------------- branch/commit compare view ---------------- */


/* ---------------- releases tab: release/<date> branches + their summary ---------------- */


		/* ---------------- patch parsing (commit / working-tree / stash viewer) ---------------- */



		/**
		 * A collapsible list segment: a sticky, bolder header the user can fold, plus the body to fill.
		 * The folded set lives in prefs, so the shape of the view survives a reload.
		 */
		function segment(parent, key, title, opts = {}) {
			// Nested segments are containers of rows (one per branch, ticket or service) and start folded,
			// so a long view opens as an index. `opts.open` is for a nested group that *is* the content.
			const openKey = `!${key}`;
			const isNested = !!opts.sub;
			const folded = isNested ? !(state.collapsed.has(openKey) || opts.open === true) : state.collapsed.has(key);
			const collapsed = folded;
			const head = h("button", `mg-seg${opts.sub ? " mg-seg-sub" : ""}${collapsed ? " collapsed" : ""}`);
			head.type = "button";
			head.title = opts.title ?? (collapsed ? "Expand" : "Collapse");
			const chev = h("span", "mg-seg-chev", collapsed ? "▸" : "▾");
			head.append(chev, h("span", "mg-seg-title", title));
			if (opts.note) head.append(h("span", "mg-seg-note", opts.note));
			if (opts.count != null) head.append(h("span", "mg-seg-count", String(opts.count)));
			if (opts.action) head.append(opts.action);
			const body = h("div", `mg-seg-body${opts.sub ? " mg-seg-body-sub" : ""}`);
			body.style.display = collapsed ? "none" : "";
			head.onclick = () => {
				const next = !head.classList.contains("collapsed");
				if (isNested) {
					if (next) state.collapsed.delete(openKey);
					else state.collapsed.add(openKey);
				} else if (next) state.collapsed.add(key);
				else state.collapsed.delete(key);
				head.classList.toggle("collapsed", next);
				chev.textContent = next ? "▸" : "▾";
				body.style.display = next ? "none" : "";
				void savePrefs({ collapsed: [...state.collapsed] });
			};
			parent.append(head, body);
			return body;
		}


		function renderAll() {
			renderSub();
			renderChips();
			renderRepos();
			renderDetail();
			renderDiff();
			renderFoot();
		}


		function setTab(id) {
			if (state.searchActive) clearSearch();
			state.tab = id;
			if (id !== "history") state.historyFrom = null; // nothing to go back to once a tab is chosen
			if (id === "changes" || id === "history") {
				state.historyMode = null;
				state.historyPath = null;
				state.historyRev = null;
			}
			renderDetail();
			// The pane keeps whatever is open across tabs, but its empty state is tab-specific: without
			// this the hint still describes the tab the user just left.
			renderDiff();
			switch (id) {
				case "changes":
					void ensureStats(state.selectedRepo);
					break;
				case "history":
					void ensureHistory(state.selectedRepo, false);
					break;
				case "branches":
					void ensureBranches(state.selectedRepo);
					void ensureSync(state.selectedRepo);
					break;
				case "stashes":
					void ensureStashes(state.selectedRepo);
					break;
				case "timeline":
					void ensureTimeline();
					break;
				case "workspace":
					void ensureWorkspace();
					break;
			}
		}


		/* ---------------- workspace tab: branches across repos + unpushed ---------------- */


		const onKeyDown = (ev) => {
			const tag = ev.target && ev.target.tagName ? ev.target.tagName : "";
			if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
			if (ev.key === "ArrowDown") {
				ev.preventDefault();
				moveSelection(1);
			} else if (ev.key === "ArrowUp") {
				ev.preventDefault();
				moveSelection(-1);
			} else if (ev.key === "r" || ev.key === "R") {
				void loadRepos(true);
			}
		};

		const onVisibility = () => {
			if (!document.hidden) void loadRepos(false);
		};

		/** Window-listener detachers of every splitter, so a drag cannot outlive the view. */
		const splitterCleanup = [];
		// layout: layout.mjs. Destructuring its result keeps the names below in
		// scope, so the rest of mount() is unchanged.
		const layout = createLayout({
			body,
			detailPane,
			detailHead,
			diffPane,
			fitTerm: (...args) => fwd.fitTerm(...args), // client/terminal.mjs
			reposPane,
			savePrefs: (...args) => fwd.savePrefs(...args), // client/bridge.mjs
			shortName,
			splitterCleanup,
			state,
			syncTerminal: (...args) => fwd.syncTerminal(...args), // client/terminal.mjs
			termEl,
			termTitle,
			termToggle,
		});
		const { applyLayout, splitBounds, setupSplitter } = layout;
			fwd.addDiffAction = detail.addDiffAction;
			fwd.addPatchActions = detail.addPatchActions;
			fwd.applyLayout = layout.applyLayout;
			fwd.backFromHistory = lists.backFromHistory;
			fwd.branchRow = lists.branchRow;
			fwd.clearSearch = search.clearSearch;
			fwd.commitRow = lists.commitRow;
			fwd.ensureTimeline = timeline.ensureTimeline;
			fwd.errText = terminal.errText;
			fwd.fileRow = lists.fileRow;
			fwd.fitTerm = terminal.fitTerm;
			fwd.isPickedBranch = lists.isPickedBranch;
			fwd.patchOpts = detail.patchOpts;
			fwd.renderBlame = workspace.renderBlame;
			fwd.renderCompare = workspace.renderCompare;
			fwd.renderDetail = detail.renderDetail;
			fwd.renderDiff = detail.renderDiff;
			fwd.renderFoot = lists.renderFoot;
			fwd.renderPatch = detail.renderPatch;
			fwd.renderSearch = search.renderSearch;
			fwd.renderTimelineList = timeline.renderTimelineList;
			fwd.renderWorkspace = workspace.renderWorkspace;
			fwd.request = bridge.request;
			fwd.resetDiffContext = detail.resetDiffContext;
			fwd.resetPaneExclusivity = lists.resetPaneExclusivity;
			fwd.savePrefs = bridge.savePrefs;
			fwd.selectBranch = lists.selectBranch;
			fwd.selectCommit = lists.selectCommit;
			fwd.selectFile = lists.selectFile;
			fwd.selectStash = lists.selectStash;
			fwd.showBlame = workspace.showBlame;
			fwd.showCompare = workspace.showCompare;
			fwd.showHistoryForFile = lists.showHistoryForFile;
			fwd.stashRow = lists.stashRow;
			fwd.syncControls = lists.syncControls;
			fwd.syncTerminal = terminal.syncTerminal;

		/* ---------------- full terminal (xterm client + node-pty server) ---------------- */
		// Boxed: the terminal view assigns it and mount's cleanup disconnects it.
		const termResizeObs = { value: null };
		state.termActive = null;
		state.termFit = null;
		state.termRepo = null;
		state.termExited = false;
		state.termClasses = null;
		state.termFailedRepo = null;
		state.termFailedAt = 0;


		/* ---------------- wiring ---------------- */
		searchInput.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") {
				ev.preventDefault();
				submitSearch();
			}
		});
		searchBtn.onclick = () => submitSearch();
		clearBtn.onclick = () => clearSearch();
		regexBtn.onclick = () => regexBtn.classList.toggle("active");
		cleanBox.onchange = () => {
			state.prefs.hideClean = cleanBox.checked;
			renderRepos();
			void savePrefs({ hideClean: cleanBox.checked });
		};
		refreshSel.onchange = () => {
			const sec = Number(refreshSel.value) || 0;
			state.prefs.autoRefreshSec = sec;
			scheduleAutoRefresh();
			void savePrefs({ autoRefreshSec: sec });
		};
		refreshBtn.onclick = () => void loadRepos(true);
		confirmAction(fetchBtn, "Fetch", "Fetch all?", fetchAll);
		confirmAction(pullBtn, "Pull", "Pull all?", pullAll);
		filterInput.oninput = () => {
			state.filter = filterInput.value;
			renderRepos();
		};
		sortSel.onchange = () => {
			state.prefs.sort = sortSel.value;
			renderRepos();
			void savePrefs({ sort: sortSel.value });
		};
		groupSel.onchange = () => {
			state.prefs.group = groupSel.value;
			renderRepos();
			void savePrefs({ group: groupSel.value });
		};
		searchMode.onchange = () => {
			state.searchMode = searchMode.value;
			const placeholder =
				state.searchMode === "files" ? "find files by path… (Enter)" : state.searchMode === "pickaxe" ? "when did this string change… (Enter)" : "search all repos… (Enter)";
			searchInput.placeholder = placeholder;
			regexBtn.style.display = state.searchMode === "pickaxe" ? "none" : "";
			if (state.searchActive) submitSearch();
		};
		termToggle.onclick = () => {
			state.prefs.termVisible = !state.prefs.termVisible;
			state.termFailedAt = 0; // an explicit toggle always retries, no throttle
			applyLayout();
			void savePrefs({ termVisible: state.prefs.termVisible });
		};
		termClear.onclick = () => {
			if (state.termActive) {
				try {
					state.termActive.clear();
				} catch {
					/* already gone */
				}
			}
		};
		setupSplitter(split1, 0);
		setupSplitter(split2, 1);
		window.addEventListener("resize", fitTerm);
		if (typeof ResizeObserver !== "undefined") {
			try {
				termResizeObs.value = new ResizeObserver(() => fitTerm());
				termResizeObs.value.observe(termHost);
			} catch {
				/* no ResizeObserver (tests, old browsers) — window resize still fits */
			}
		}
		root.addEventListener("keydown", onKeyDown);
		document.addEventListener("visibilitychange", onVisibility);

		syncControls();
		renderAll();
		void loadRepos(true);
		scheduleAutoRefresh();

		/* ---------------- teardown ---------------- */
		return () => {
			destroyed = true;
			if (timer.value) clearInterval(timer.value);
			timer.value = null;
			root.removeEventListener("keydown", onKeyDown);
			for (const detach of splitterCleanup) {
				try {
					detach();
				} catch {
					/* already detached */
				}
			}
			document.removeEventListener("visibilitychange", onVisibility);
			offData();
			pending.clear();
			style.remove();
			closeTerminal(false);
			if (termResizeObs.value) {
				try {
					termResizeObs.value.disconnect();
				} catch {}
			}
			window.removeEventListener("resize", fitTerm);
			root.remove();
		};
	},
});

export const __test = _testSeam;