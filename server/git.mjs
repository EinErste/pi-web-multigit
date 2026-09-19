/**
 * Git plumbing: every call goes through `git()` (deadline + output cap), every revision through `REV_RE`,
 * every pathspec through `repoPathArg()` (POSIX form — git treats a backslash as an escape), and every
 * filesystem read through `insideRepoReal()` (realpath containment — a symlink must not leave the repo).
 */
import { execFile } from "node:child_process";
import { dirname, isAbsolute } from "node:path";
import { join } from "node:path";
import { open, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { relative } from "node:path";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { isWindows } from "./pty.mjs";

export const execFileAsync = promisify(execFile);

export const GIT_TIMEOUT_MS = 20_000;

export const GIT_MAX_OUTPUT = 8 * 1024 * 1024;

/** Fetch is a network round-trip: far more room than a local git call, and few in parallel. */
export const FETCH_TIMEOUT_MS = 120_000;

export const FETCH_CONCURRENCY = 3;

/** These answers are documents, not streams — cap what one request may return. */
export const BLAME_MAX_LINES = 3_000;

export const BRANCHES_MAX_PER_REPO = 40;

export const BRANCH_UNPUSHED_MAX = 5;

export const BRANCH_UNPUSHED_COMMITS = 20;

export const BLAME_TIMEOUT_MS = 60_000;

export const MAX_DIRS_VISITED = 4_000;

export const GIT_CONCURRENCY = 6;

/** Untracked files have no diff; read this many bytes as a content preview instead. */
export const UNTRACKED_PREVIEW_BYTES = 64 * 1024;

export const LOG_LIMIT = 60;

export const DEFAULT_DEPTH = 2;

export const DEFAULT_MAX_REPOS = 40;

export const DEFAULT_AUTO_REFRESH_SEC = 15;

/** Revision-ish tokens the client may pass to log/showfile/stashshow. */
export const REV_RE = /^(?!-)[A-Za-z0-9_.^~/-]{1,80}$/; // no leading "-": a revision must never look like an option

export const STASH_REF_RE = /^stash@\{\d+\}$/;

/** Directory names never entered while scanning (nothing useful lives there). */
export const BUILTIN_SKIP = [
	"node_modules",
	"target",
	"dist",
	"build",
	"out",
	"bin",
	"obj",
	"vendor",
	".git",
	".gradle",
	".m2",
	".venv",
	"venv",
	"__pycache__",
	".idea",
	".vscode",
	".next",
	".nuxt",
	"coverage",
];

/** Run one git command in `repo` and return stdout (throws on failure). */
export async function git(repo, args, timeout = GIT_TIMEOUT_MS) {
	const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], {
		cwd: repo,
		timeout,
		maxBuffer: GIT_MAX_OUTPUT,
		windowsHide: true,
		encoding: "utf8",
	});
	return stdout ?? "";
}

/** Error → one readable line (git's first stderr line is the informative one). */
export function firstLine(err) {
	const e = err ?? {};
	const detail = String(e.stderr ?? "").trim().split("\n")[0] || String(e.message ?? err ?? "");
	return detail.split("\n")[0].slice(0, 400) || "git failed";
}

/** Bounded-concurrency map (do not spawn one git process per repo all at once). */
export async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return out;
}

/** Path identity key; case-insensitive on Windows. */
export function pathKey(p) {
	const abs = resolve(String(p));
	return isWindows ? abs.toLowerCase() : abs;
}

/** Undo git's C-style quoting (core.quotepath=false covers non-ASCII; this covers control chars). */
export function unquotePath(s) {
	if (!s.startsWith('"')) return s;
	const inner = s.endsWith('"') ? s.slice(1, -1) : s.slice(1);
	return inner.replace(/\\(.)/g, (_m, c) => {
		switch (c) {
			case "n":
				return "\n";
			case "t":
				return "\t";
			case "r":
				return "\r";
			case "b":
				return "\b";
			case "f":
				return "\f";
			case "v":
				return "\v";
			case "\\":
				return "\\";
			case '"':
				return '"';
			default:
				return c;
		}
	});
}

/**
 * Repo-relative POSIX path for a git pathspec. `insideRepoReal()` returns an absolute path for
 * filesystem work, but git pathspecs treat a backslash as an escape character, so handing git a
 * `C:\...` string makes it match nothing (or fail outright). Always pass this form to git.
 * Lexical on purpose: git resolves a pathspec inside the repository itself and refuses one that
 * leaves it, so there is no filesystem read here for a symlink to redirect.
 */
export function repoPathArg(repo, relPath) {
	const abs = resolve(repo, String(relPath ?? ""));
	const rel = relative(resolve(repo), abs);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path escapes the repository");
	return rel.split(String.fromCharCode(92)).join("/");
}

/** Repo-relative path, or null when it would escape the repository (pathspec safety). */
export function safeRelPath(repo, relPath) {
	const abs = resolve(repo, String(relPath ?? ""));
	const rel = relative(resolve(repo), abs);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel.split("\\").join("/");
}

/**
 * Absolute path for filesystem work, refusing anything that leaves the repository.
 *
 * Lexical validation is not containment: a symlink inside a repository (or a Windows junction) points
 * anywhere, and `resolve()` still returns a path that *looks* like it is inside — `open()` then follows
 * the link out of it. So the deepest ancestor that exists on disk is resolved with `realpath()` and the
 * real path must stay inside the repository's real path.
 *
 * A target that does not exist is fine (a deleted file is exactly what history and diff views ask
 * about): only the part of the path that exists on disk can escape. A broken symlink stays inside too —
 * reading it fails later, harmlessly.
 */
export async function insideRepoReal(repo, relPath) {
	const root = resolve(repo);
	const abs = resolve(root, String(relPath ?? ""));
	const rel = relative(root, abs);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path escapes the repository");
	const rootReal = await realpath(root).catch(() => root);
	const existing = await deepestExisting(abs);
	const existingReal = await realpath(existing).catch(() => existing);
	const real = resolve(existingReal, relative(existing, abs));
	const realRel = relative(rootReal, real);
	if (!realRel || realRel.startsWith("..") || isAbsolute(realRel)) throw new Error("Path escapes the repository");
	return real;
}

/** Deepest ancestor of `p` that exists on disk — `p` itself when it does, the filesystem root otherwise. */
async function deepestExisting(p) {
	let cur = p;
	for (;;) {
		if (await stat(cur).then(() => true, () => false)) return cur;
		const up = dirname(cur);
		if (up === cur) return cur;
		cur = up;
	}
}

/**
 * Tracked files matching pathspecs; `-z` keeps spaces/UTF-8 intact. No pathspecs = every
 * tracked file, and `untracked: true` adds the ones that are not committed yet.
 */
export async function listRepoFiles(repo, patterns, opts = {}) {
	const args = ["ls-files", "-z"];
	if (opts.untracked) args.push("--cached", "--others", "--exclude-standard");
	if (patterns.length) args.push("--", ...patterns);
	const out = await git(repo, args).catch(() => "");
	return String(out).split("\u0000").filter(Boolean);
}

export async function readTextCapped(abs, maxBytes) {
	try {
		const st = await stat(abs);
		if (!st.isFile() || st.size > maxBytes) return null;
		return await readFile(abs, "utf8");
	} catch {
		return null;
	}
}

/** Read the head of a file (untracked preview); failures are non-fatal. */
export async function readHead(absPath, maxBytes) {
	let fh = null;
	try {
		fh = await open(absPath, "r");
		const buf = Buffer.alloc(maxBytes);
		const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
		const text = buf.subarray(0, bytesRead).toString("utf8");
		if (text.includes("\u0000")) return "[binary file]";
		return text;
	} catch (err) {
		return `[unreadable: ${firstLine(err)}]`;
	} finally {
		await fh?.close().catch(() => {});
	}
}


export async function dirHasGit(dir) {
	try {
		const st = await stat(join(dir, ".git"));
		return st.isDirectory() || st.isFile(); // a file means worktree / submodule
	} catch {
		return false;
	}
}

/** Depth-first search for directories containing .git; a hit stops descent. */
export async function discover(root, opts, state) {
	async function walk(dir, level) {
		if (state.truncated || state.found.length >= opts.maxRepos) {
			state.truncated = true;
			return;
		}
		if (state.dirsVisited >= MAX_DIRS_VISITED) {
			state.truncated = true;
			return;
		}
		state.dirsVisited++;
		if (await dirHasGit(dir)) {
			state.found.push({ path: dir, root });
			return;
		}
		if (level >= opts.depth) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return; // permission denied / disconnected drive: skip silently
		}
		for (const e of entries) {
			if (!e.isDirectory()) continue; // never follow symlinks (cycles)
			if (opts.skip.has(e.name)) continue;
			await walk(join(dir, e.name), level + 1);
		}
	}
	await walk(root, 0);
}
