/**
 * Git output → data. Same conventions as the host's server/scm.ts, reimplemented so this plugin stays
 * independent of internal paths. Every parser is pure: text in, structure out.
 */
import { relative } from "node:path";
import { BLAME_MAX_LINES, STASH_REF_RE, git, unquotePath } from "./git.mjs";
import { numOr } from "./prefs.mjs";


export function parseStatusHeader(rest) {
	const out = {
		branch: "HEAD",
		detached: false,
		upstream: null,
		ahead: 0,
		behind: 0,
		upstreamGone: false,
	};
	let branchPart = rest;
	let flags = "";
	const bi = rest.indexOf(" [");
	if (bi >= 0) {
		branchPart = rest.slice(0, bi);
		flags = rest.slice(bi + 2);
		if (flags.endsWith("]")) flags = flags.slice(0, -1);
	}
	if (branchPart === "HEAD (no branch)" || branchPart === "HEAD") {
		out.detached = true;
	} else {
		if (branchPart.startsWith("No commits yet on ")) branchPart = branchPart.slice("No commits yet on ".length);
		const up = branchPart.indexOf("...");
		if (up >= 0) {
			out.branch = branchPart.slice(0, up);
			out.upstream = branchPart.slice(up + 3);
		} else {
			out.branch = branchPart;
		}
	}
	for (const part of flags.split(",")) {
		const p = part.trim();
		const m = p.match(/^(ahead|behind) (\d+)$/);
		if (m) {
			if (m[1] === "ahead") out.ahead = Number(m[2]);
			else out.behind = Number(m[2]);
		} else if (p === "gone") {
			out.upstreamGone = true;
		}
	}
	return out;
}

export function parseStatusFiles(text) {
	const out = [];
	for (const rawLine of String(text).split("\n")) {
		const line = rawLine.replace(/\s+$/, "");
		if (!line || line.startsWith("## ")) continue;
		if (line.length < 3) continue;
		let p = line.slice(3);
		const arrow = p.indexOf(" -> "); // rename: "R  old -> new"
		if (arrow >= 0) p = p.slice(arrow + 4);
		out.push({ path: unquotePath(p.trim()), x: line[0], y: line[1] });
	}
	return out;
}

export function countFiles(files) {
	const counts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, total: files.length };
	for (const f of files) {
		if (f.x === "?") {
			counts.untracked++;
			continue;
		}
		if (f.x === "U" || f.y === "U" || (f.x === "A" && f.y === "A") || (f.x === "D" && f.y === "D")) counts.conflicted++;
		if (f.x !== " ") counts.staged++;
		if (f.y !== " ") counts.unstaged++;
	}
	return counts;
}

/** Parse `git diff --numstat`: "12\t3\tpath" → { path: [added, deleted] }. */
export function parseNumStat(text) {
	// prototype-less: a repository may contain a file literally named "__proto__", and assigning that
	// key on a normal object would shift its prototype and silently drop the entry.
	const stats = Object.create(null);
	for (const line of String(text).split("\n")) {
		if (!line.trim()) continue;
		const t1 = line.indexOf("\t");
		const t2 = t1 < 0 ? -1 : line.indexOf("\t", t1 + 1);
		if (t2 < 0) continue;
		let add = Number(line.slice(0, t1));
		let del = Number(line.slice(t1 + 1, t2));
		if (!Number.isFinite(add)) add = 0; // binary files report "-"
		if (!Number.isFinite(del)) del = 0;
		const p = unquotePath(line.slice(t2 + 1).trim());
		const prev = stats[p];
		stats[p] = [(prev?.[0] ?? 0) + add, (prev?.[1] ?? 0) + del];
	}
	return stats;
}

/** Parse `git log --graph --pretty=format:%H%x09%h%x09%an%x09%ad%x09%s%x09%D` (graph optional). */
export function parseCommitHistory(text) {
	const out = [];
	for (const line of String(text).split("\n")) {
		const tab = line.indexOf("\t");
		if (tab < 0) continue; // connector-only graph line
		const prefix = line.slice(0, tab);
		const m = prefix.match(/([0-9a-f]{7,40})$/i);
		if (!m || m.index === undefined) continue;
		const fields = line.slice(tab + 1).split("\t");
		if (fields.length < 4) continue;
		out.push({
			hash: m[1],
			shortHash: fields[0],
			author: fields[1],
			date: fields[2],
			subject: fields[3],
			decorations: fields[4] ?? "",
			graph: prefix.slice(0, m.index),
		});
	}
	return out;
}

/** `git log --pretty=format:%h%x09%ad%x09%s` → simple commits (no hash graph). */
export function parseSimpleCommits(text) {
	const out = [];
	for (const line of String(text).split("\n")) {
		const fields = line.split("\t");
		if (fields.length < 3) continue;
		const [short, date, ...rest] = fields;
		if (!/^[0-9a-f]{7,40}$/i.test(short)) continue;
		out.push({ short, date: date ?? "", subject: rest.join("\t") });
	}
	return out;
}

/** `git stash list --pretty=format:%gd%x09%h%x09%ar%x09%gs` → stashes. */
export function parseStashList(text) {
	const out = [];
	for (const line of String(text).split("\n")) {
		const [ref, hash, when, ...rest] = line.split("\t");
		if (!STASH_REF_RE.test(ref ?? "")) continue;
		out.push({ ref, hash: hash ?? "", when: when ?? "", subject: rest.join("\t") });
	}
	return out;
}

/**
 * `git for-each-ref … --format=%(refname)%09%(objectname:short)%09%(committerdate:relative)%09%(subject)%09%(HEAD)`
 * → per-branch rows. kind: "local" (refs/heads) | "remote" (refs/remotes).
 */
export function parseForEachRef(text, kind) {
	const out = [];
	const prefix = kind === "local" ? "refs/heads/" : "refs/remotes/";
	for (const line of String(text).split("\n")) {
		const [refname, hash, date, subject, head] = line.split("\t");
		if (!refname?.startsWith(prefix) || !hash) continue;
		const name = refname.slice(prefix.length);
		if (name.endsWith("/HEAD")) continue; // origin/HEAD symlink
		out.push({ name, hash, date: date ?? "", subject: subject ?? "", current: head === "*" });
	}
	return out;
}

/** `git branch -vv` → per-local-branch { upstream, ahead, behind, gone }. */
export function parseBranchVV(text) {
	const map = new Map();
	for (const line of String(text).split("\n")) {
		if (!line || line.startsWith("* (HEAD") || line.startsWith("(HEAD")) continue;
		const m = line.match(/^\*?\s*(\S+)\s+[0-9a-f]{7,40}\s*(?:\[([^\]]*)\])?(?:\s+.*)?$/);
		if (!m) continue;
		const entry = { upstream: null, ahead: 0, behind: 0, gone: false };
		const bkt = (m[2] ?? "").trim();
		if (bkt) {
			const colon = bkt.indexOf(":");
			const up = colon >= 0 ? bkt.slice(0, colon).trim() : bkt.trim();
			const detail = colon >= 0 ? bkt.slice(colon + 1) : "";
			if (up) entry.upstream = up;
			const ahead = detail.match(/ahead (\d+)/);
			const behind = detail.match(/behind (\d+)/);
			if (ahead) entry.ahead = Number(ahead[1]);
			if (behind) entry.behind = Number(behind[1]);
			if (/gone/.test(detail)) entry.gone = true;
		}
		map.set(m[1], entry);
	}
	return map;
}

/** `git branch --merged <ref>` → set of branch names. */
export function parseMergedBranches(text) {
	const out = new Set();
	for (const line of String(text).split("\n")) {
		const name = line.replace(/^\*?\s*/, "").trim();
		if (name) out.add(name);
	}
	return out;
}

/** `git grep -n` → matches `path:line:text`. */
export function parseGrep(text, repo) {
	const out = [];
	for (const rawLine of String(text).split("\n")) {
		if (!rawLine) continue;
		const c1 = rawLine.indexOf(":");
		if (c1 <= 0) continue;
		const c2 = rawLine.indexOf(":", c1 + 1);
		if (c2 < 0) continue;
		const path = unquotePath(rawLine.slice(0, c1));
		const lineNo = Number(rawLine.slice(c1 + 1, c2));
		const textLine = rawLine.slice(c2 + 1).slice(0, SEARCH_LINE_CAP);
		out.push({ repo, path, line: Number.isFinite(lineNo) ? lineNo : 0, text: textLine });
	}
	return out;
}

/** `git worktree list --porcelain` → worktree paths. */
export function parseWorktreePaths(text) {
	const paths = [];
	for (const line of String(text).split("\n")) {
		if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
	}
	return paths;
}

/** `%h%x09%ad%x09%an%x09%s` rows (unpushed/incoming lists). */
export function parseShortCommits(text) {
	const out = [];
	for (const line of String(text).split("\n")) {
		const [short, date, author, ...rest] = line.split("\t");
		if (!short || !/^[0-9a-f]{7,40}$/i.test(short)) continue;
		out.push({ short, date: date ?? "", author: author ?? "", subject: rest.join("\t") });
	}
	return out;
}

/**
 * `git blame --line-porcelain` → per-line attribution with commit metadata de-duplicated.
 * Porcelain (not the default format) because it is stable, machine-readable and locale-free.
 */
export function parseBlamePorcelain(text) {
	const commits = new Map();
	const lines = [];
	let sha = null;
	let truncated = false;
	for (const raw of String(text).split("\n")) {
		const header = raw.match(/^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/);
		if (header) {
			sha = header[1];
			if (!commits.has(sha)) commits.set(sha, { sha, short: sha.slice(0, 8), author: "", mail: "", date: "", summary: "" });
			continue;
		}
		if (!sha) continue;
		if (raw.startsWith("\t")) {
			if (lines.length >= BLAME_MAX_LINES) {
				truncated = true;
				break;
			}
			lines.push({ sha, text: raw.slice(1) });
			continue;
		}
		const sp = raw.indexOf(" ");
		if (sp < 0) continue;
		const key = raw.slice(0, sp);
		const value = raw.slice(sp + 1);
		const entry = commits.get(sha);
		if (key === "author" && !entry.author) entry.author = value;
		else if (key === "author-mail" && !entry.mail) entry.mail = value.replace(/[<>]/g, "");
		else if (key === "summary" && !entry.summary) entry.summary = value.slice(0, 200);
		else if (key === "author-time" && !entry.date) {
			const t = Number(value);
			entry.date = Number.isFinite(t) ? new Date(t * 1000).toISOString().slice(0, 10) : "";
		}
	}
	return { commits: Object.fromEntries(commits), lines, truncated };
}

/**
 * View options shared by every patch-producing action: `-w` stops whitespace-only churn from
 * drowning a real change, and the context size decides how much surrounding code you see.
 */
export function patchOptions(payload) {
	const ctx = numOr(payload.context, 3, 0, 50);
	return [...(payload.ignoreWs === true ? ["-w"] : []), `-U${ctx}`];
}

export const SEARCH_LINE_CAP = 400;
