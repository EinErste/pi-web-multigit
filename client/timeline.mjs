/**
 * The workspace timeline: filters over the days/repos/actions, and the list itself.
 */


export function createTimeline(deps) {
	const {
	destroyed, // from mount
	detailList, // from mount
	h, // from mount
	renderDetail, // from mount
	request, // from mount
	selectCommit, // from mount
	shortName, // from mount
	state, // from mount
	timelineCache, // from mount
	} = deps;


/** Timeline filters: author, path and window. Changing any of them re-reads every repo. */
function timelineFilters() {
	const bar = h("div", "mg-tl-filter");
	const authorInput = document.createElement("input");
	authorInput.type = "text";
	authorInput.className = "mg-search mg-filter";
	authorInput.placeholder = "author…";
	authorInput.title = "Only commits whose author matches (git log --author)";
	authorInput.value = state.tlAuthor ?? "";
	authorInput.onchange = () => {
		state.tlAuthor = authorInput.value.trim();
		timelineCache.value = null;
		void ensureTimeline();
	};
	const pathInput = document.createElement("input");
	pathInput.type = "text";
	pathInput.className = "mg-search mg-filter";
	pathInput.placeholder = "path…";
	pathInput.title = "Only commits touching this path (relative to each repo)";
	pathInput.value = state.tlPath ?? "";
	pathInput.onchange = () => {
		state.tlPath = pathInput.value.trim();
		timelineCache.value = null;
		void ensureTimeline();
	};
	const daysSel = document.createElement("select");
	daysSel.className = "mg-select";
	for (const n of [1, 7, 30, 90]) {
		const opt = document.createElement("option");
		opt.value = String(n);
		opt.textContent = `${n}d`;
		daysSel.append(opt);
	}
	daysSel.value = String(state.tlDays ?? 7);
	daysSel.onchange = () => {
		state.tlDays = Number(daysSel.value);
		timelineCache.value = null;
		void ensureTimeline();
	};
	bar.append(authorInput, pathInput, daysSel);
	return bar;
}
function renderTimelineList() {
	detailList.textContent = "";
	detailList.append(timelineFilters());
	if (state.timelineError) {
		detailList.append(h("div", "mg-error", state.timelineError));
		return;
	}
	if (!state.timeline) {
		detailList.append(h("div", "mg-empty", "Loading workspace activity…"));
		return;
	}
	if (!state.timeline.events.length) {
		detailList.append(h("div", "mg-empty", "No commits in the last 7 days."));
		return;
	}
	for (const ev of state.timeline.events) {
		const row = h("button", "mg-commit");
		row.type = "button";
		// the event whose commit the Diff pane is showing
		row.classList.toggle("active", state.selectedCommit === ev.hash && state.selectedRepo === ev.repo && !state.showfile);
		row.append(h("span", "mg-graph", "◆ "));
		const main = h("div", "mg-commit-main");
		main.append(h("span", "mg-commit-subject", ev.subject || "(no subject)"));
		main.append(h("span", "mg-commit-meta", `${shortName(ev.repo)} · ${ev.shortHash} · ${ev.author} · ${ev.date}`));
		if (ev.decorations) main.append(h("span", "mg-commit-refs", ev.decorations));
		row.append(main);
		row.onclick = () => void selectCommit(ev.hash, ev.repo);
		detailList.append(row);
	}
	if (state.timeline.truncated) detailList.append(h("div", "mg-empty", "… more events hidden"));
}
async function ensureTimeline() {
	if (timelineCache.value) {
		state.timeline = timelineCache.value;
		renderDetail();
		return;
	}
	state.timeline = null;
	state.timelineError = null;
	renderDetail();
	const res = await request("timeline", { days: state.tlDays ?? 7, author: state.tlAuthor ?? "", path: state.tlPath ?? "" });
	if (destroyed) return;
	if (res.ok) {
		timelineCache.value = res;
		state.timeline = res;
		state.timelineError = null;
	} else {
		state.timelineError = res.error || "Failed to load timeline";
	}
	renderDetail();
}

	return { timelineFilters, renderTimelineList, ensureTimeline };
}
