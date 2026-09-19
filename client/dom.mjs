/**
 * The element factory and the small pure helpers every pane is built from: chips, path parts, gutter geometry,
 * file badges, status classes. Takes no dependencies, so it can be created before the panes exist.
 */


export function createDom(deps) {
	const {
	FILE_STATUS, // from mount
	state, // from mount
	} = deps;


/* ---------------- dom helpers ---------------- */
function h(tag, className, text) {
	const el = document.createElement(tag);
	if (className) el.className = className;
	if (text != null) el.textContent = text;
	return el;
}
function chip(text, cls, title) {
	const el = h("span", `mg-chip ${cls}`.trim(), text);
	if (title) el.title = title;
	return el;
}
function metaRow(key, value, isError) {
	const row = h("div", "mg-meta-row");
	row.append(h("span", "mg-meta-k", key), h("span", isError ? "mg-err" : "mg-meta-v", value));
	return row;
}
/** Directory dims (and may truncate); the file NAME is always kept visible — that is the point. */
function pathParts(f, dirCls, nameCls) {
	const full = String(f.path ?? "");
	const cut = full.lastIndexOf("/");
	const box = h("span", "mg-path");
	if (cut >= 0) box.append(h("span", dirCls, full.slice(0, cut + 1)));
	box.append(h("span", nameCls, cut < 0 ? full : full.slice(cut + 1)));
	return box;
}
function countsSpan(f, cls) {
	const box = h("span", cls);
	if (f.binary) box.append(h("span", "mg-cbin", "binary"));
	else if (!f.additions && !f.deletions) box.append(h("span", "mg-cbin", "—"));
	else {
		if (f.additions) box.append(h("span", "mg-cadd", `+${f.additions}`));
		if (f.deletions) box.append(h("span", "mg-cdel", `-${f.deletions}`));
	}
	return box;
}
function copyPathButton(path) {
	const btn = h("button", "mg-copy", "copy path");
	btn.type = "button";
	btn.title = "Copy the full path";
	btn.onclick = () => {
		const write = globalThis.navigator?.clipboard?.writeText;
		if (typeof write !== "function") return;
		try {
			write.call(globalThis.navigator.clipboard, path);
			btn.textContent = "copied";
			setTimeout(() => { btn.textContent = "copy path"; }, 1200);
		} catch {
			/* clipboard blocked: the row title still carries the path */
		}
	};
	return btn;
}
function fileBadge(f) {
	const info = f.binary ? { letter: "B", cls: "bin", word: "binary" } : FILE_STATUS[f.status] ?? FILE_STATUS.modified;
	const b = h("span", `mg-sbadge ${info.cls}`.trim(), info.letter);
	b.title = info.word;
	return b;
}
/**
 * Gutter geometry for one file: two number columns + padding, sized to the biggest line number
 * in the file. Fixed pixel widths either clip long numbers or waste space on short files.
 */
function gutterGeometry(f) {
	let max = 1;
	for (const hunk of f.hunks) max = Math.max(max, hunk.oldNo, hunk.newNo);
	const digits = String(max).length;
	return { width: `${digits * 2 + 3}ch`, digits };
}
function gutterCells(geo, oldNo, newNo) {
	const gut = h("span", "mg-gut");
	gut.style.width = geo.width;
	const o = h("span", "mg-gut-o", oldNo == null ? "" : String(oldNo));
	const n = h("span", "mg-gut-n", newNo == null ? "" : String(newNo));
	o.style.minWidth = `${geo.digits}ch`;
	n.style.minWidth = `${geo.digits}ch`;
	gut.append(o, n);
	return gut;
}
/** Depth-first collection of a class inside the built DOM (hunk navigation). */
function collectByClass(node, cls, out = []) {
	if (node._cls?.has(cls)) out.push(node);
	for (const c of node.childNodes ?? []) collectByClass(c, cls, out);
	return out;
}
/** Cache-key suffix so a patch fetched with other options is never reused blindly. */
function optKey() {
	return `${state.ignoreWs ? "w" : "-"}${state.context}`;
}
/** Undo git's C-style path quoting ("a/pa\\tth" → a/pa<TAB>th). */
function unquoteGitPath(raw) {
	const s = String(raw ?? "");
	if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
	return s.slice(1, -1).replace(/\\(.)/g, (_m, c) => {
		switch (c) {
			case "n":
				return "\n";
			case "t":
				return "\t";
			case "r":
				return "\r";
			case "\\":
				return "\\";
			case '"':
				return '"';
			default:
				return c;
		}
	});
}
/** `a/path` or `b/path` → `path`; `/dev/null` → "" (add/delete marker). */
function stripAb(p) {
	const s = unquoteGitPath(String(p ?? "").trim());
	return s === "/dev/null" ? "" : s.replace(/^[ab]\//, "");
}
/* ---------------- interactions ---------------- */
function samePath(a, b) {
	const norm = (p) => String(p ?? "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
	return norm(a) === norm(b);
}
function statusKind(f) {
	if (f.x === "?") return "untracked";
	const x = f.x !== " ";
	const y = f.y !== " ";
	if (x && y) return "staged+modified";
	if (x) return "staged";
	return "modified";
}
function lineClass(line) {
	if (
		line.startsWith("diff --git") ||
		line.startsWith("index ") ||
		line.startsWith("new file") ||
		line.startsWith("deleted file") ||
		line.startsWith("old mode") ||
		line.startsWith("new mode") ||
		line.startsWith("similarity index") ||
		line.startsWith("rename ") ||
		line.startsWith("copy ") ||
		line.startsWith("commit ") ||
		line.startsWith("Author:") ||
		line.startsWith("AuthorDate:") ||
		line.startsWith("Commit:") ||
		line.startsWith("CommitDate:")
	) {
		return "mg-line-head";
	}
	if (line.startsWith("+++") || line.startsWith("---")) return "mg-line-meta";
	if (line.startsWith("@@")) return "mg-line-hunk";
	if (line.startsWith("+")) return "mg-line-add";
	if (line.startsWith("-")) return "mg-line-del";
	return "mg-line-ctx";
}
/**
 * `feat/ab12cd34__filter-accordion: fix the thing` under a header that already names the branch
 * reads as the same line twice, which is what the branch-prefixed commit style produces. The
 * prefix is dropped for display only — the untrimmed subject stays in the row's tooltip.
 */
function withoutBranchPrefix(subject, branch) {
	const text = String(subject ?? "");
	const name = String(branch ?? "");
	if (!name || !text.startsWith(name)) return text;
	const rest = text.slice(name.length).replace(/^\s*[:–—-]\s*/, "");
	return rest || text;
}

	return { h, chip, metaRow, pathParts, countsSpan, copyPathButton, fileBadge, gutterGeometry, gutterCells, collectByClass, optKey, unquoteGitPath, stripAb, samePath, statusKind, lineClass, withoutBranchPrefix };
}
