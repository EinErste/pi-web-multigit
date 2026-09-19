/**
 * One repository, as the overview needs it: status, branch, ahead/behind, and the summary behind a card.
 */
import { basename } from "node:path";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { join } from "node:path";
import { relative } from "node:path";
import { BRANCHES_MAX_PER_REPO, BRANCH_UNPUSHED_COMMITS, BRANCH_UNPUSHED_MAX, BUILTIN_SKIP, DEFAULT_AUTO_REFRESH_SEC, DEFAULT_DEPTH, DEFAULT_MAX_REPOS, FETCH_TIMEOUT_MS, GIT_MAX_OUTPUT, execFileAsync, firstLine, git } from "./git.mjs";
import { countFiles, parseBranchVV, parseMergedBranches, parseShortCommits, parseStatusFiles, parseStatusHeader, parseWorktreePaths } from "./parsers.mjs";
import { GROUP_MODES, SORT_MODES, asBool, normPattern, normPatternMap, normStrings, normWidths, numOr, oneOf, splitList } from "./prefs.mjs";


export function resolveOptions(host) {
	let settings = {};
	try {
		settings = host.getSettings() ?? {};
	} catch {
		settings = {};
	}
	let store = null;
	try {
		store = host.storage;
	} catch {
		store = null;
	}
	/** View-level toggles persist in the plugin's storage.json and win over settings. */
	const stored = (key, fallback) => {
		try {
			const v = store?.get(key, fallback);
			return v === undefined ? fallback : v;
		} catch {
			return fallback;
		}
	};
	return {
		depth: numOr(settings.depth, DEFAULT_DEPTH, 1, 4),
		maxRepos: numOr(settings.maxRepos, DEFAULT_MAX_REPOS, 1, 200),
		autoRefreshSec: numOr(stored("autoRefreshSec", settings.autoRefreshSec), DEFAULT_AUTO_REFRESH_SEC, 0, 600),
		hideClean: asBool(stored("hideClean", null), asBool(settings.hideClean, false)),
		termVisible: asBool(stored("termVisible", null), false),
		widths: normWidths(stored("widths", null)),
		sort: oneOf(stored("sort", null), SORT_MODES, "name"),
		group: oneOf(stored("group", null), GROUP_MODES, "none"),
		branchGroupPattern: normPattern(stored("branchGroupPattern", settings.branchGroupPattern)),
		branchGroups: normPatternMap(stored("branchGroups", null)),
		collapsed: normStrings(stored("collapsed", null)),
		skip: new Set([...BUILTIN_SKIP, ...splitList(settings.ignore)]),
	};
}

export async function headCommit(repo) {
	try {
		const text = await git(repo, ["log", "-1", "--format=%h%x09%ar%x09%s"]);
		const [short, when, ...rest] = text.trim().split("\t");
		if (!short) return null;
		return { short, when: when ?? "", subject: rest.join("\t") };
	} catch {
		return null; // repository without commits yet
	}
}

/**
 * Work-tree / repo state useful in a row of many repos: mid-operation flags
 * (merge/rebase/cherry-pick/revert/bisect), a stale index.lock, extra worktrees and
 * submodule count. All best-effort; failures degrade to empty state.
 */
export async function repoState(repo) {
	const out = { flags: [], indexLock: false, worktrees: [], submodules: 0 };
	try {
		const raw = (await git(repo, ["rev-parse", "--git-dir"])).trim();
		const gitDir = raw ? (isAbsolute(raw) ? raw : join(repo, raw)) : null;
		if (gitDir) {
			const probes = [
				["MERGE_HEAD", "merging"],
				["CHERRY_PICK_HEAD", "cherry-picking"],
				["REVERT_HEAD", "reverting"],
				["BISECT_START", "bisecting"],
				["rebase-merge", "rebasing"],
				["rebase-apply", "rebasing"],
			];
			for (const [name, flag] of probes) {
				if (existsSync(join(gitDir, name))) out.flags.push(flag);
			}
			if (existsSync(join(gitDir, "index.lock"))) out.indexLock = true;
		}
		const wl = await git(repo, ["worktree", "list", "--porcelain"]).catch(() => "");
		const paths = parseWorktreePaths(wl);
		if (paths.length > 1) out.worktrees = paths.slice(1);
		if (existsSync(join(repo, ".gitmodules"))) {
			const sub = await git(repo, ["submodule", "status"]).catch(() => "");
			out.submodules = sub.split("\n").filter((l) => l.trim().length > 0).length;
		}
	} catch {
		/* best-effort */
	}
	return out;
}

/** `git fetch --all --prune` in one repo. Never touches the work tree. */
export async function gitFetch(repo) {
	const { stdout, stderr } = await execFileAsync("git", ["-c", "core.quotepath=false", "fetch", "--all", "--prune"], {
		cwd: repo,
		timeout: FETCH_TIMEOUT_MS,
		maxBuffer: GIT_MAX_OUTPUT,
		windowsHide: true,
		encoding: "utf8",
	});
	return `${stdout ?? ""}${stderr ?? ""}`.trim();
}

/** `<rev>...HEAD` counts: how far ahead of / behind the given revision we are. */
export async function aheadBehind(repo, rev) {
	const spec = rev ? `${rev}...HEAD` : "@{upstream}...HEAD";
	const text = await git(repo, ["rev-list", "--left-right", "--count", spec]).catch(() => "");
	const [behind, ahead] = String(text).trim().split(/\s+/).map((n) => Number(n));
	return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 };
}

/**
 * Branch overview for one repo: every local branch with its tracking state, merged/stale flags
 * and the commits that branch still has to push. Feeds the cross-repo branch dashboard.
 */
export async function repoBranchOverview(repoPath) {
	const head = (await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
	const defaultRef = (await git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim() || null;
	const [refText, vvText, mergedText] = await Promise.all([
		git(repoPath, ["for-each-ref", "--sort=-committerdate", "refs/heads", "--format=%(refname:short)%09%(objectname:short)%09%(committerdate:relative)%09%(committerdate:unix)%09%(subject)"]).catch(() => ""),
		git(repoPath, ["branch", "-vv"]).catch(() => ""),
		defaultRef ? git(repoPath, ["branch", "--merged", defaultRef]).catch(() => "") : Promise.resolve(""),
	]);
	const vv = parseBranchVV(vvText);
	const merged = parseMergedBranches(mergedText);
	const now = Date.now();
	const branches = [];
	let truncated = false;
	for (const line of String(refText).split("\n")) {
		if (!line.trim()) continue;
		if (branches.length >= BRANCHES_MAX_PER_REPO) {
			truncated = true;
			break;
		}
		const [name, hash, when, unix, ...rest] = line.split("\t");
		if (!name) continue;
		const track = vv.get(name) ?? {};
		branches.push({
			name,
			hash: hash ?? "",
			when: when ?? "",
			days: Number.isFinite(Number(unix)) && Number(unix) > 0 ? Math.max(0, Math.round((now - Number(unix) * 1000) / 86_400_000)) : null,
			subject: (rest.join("\t") ?? "").slice(0, 200),
			current: name === head,
			upstream: track.upstream ?? null,
			ahead: track.ahead ?? 0,
			behind: track.behind ?? 0,
			gone: track.gone ?? false,
			merged: merged.has(name),
		});
	}
	// Unpushed detail only where tracking says there is something to push.
	const unpushed = [];
	for (const b of branches) {
		if (b.ahead <= 0 || unpushed.length >= BRANCH_UNPUSHED_MAX) continue;
		const text = await git(repoPath, ["log", "-n", String(BRANCH_UNPUSHED_COMMITS), "--date=short", "--pretty=format:%h%x09%ad%x09%an%x09%s", `@{upstream}..${b.name}`]).catch(() => "");
		const commits = parseShortCommits(text);
		if (commits.length) unpushed.push({ branch: b.name, ahead: b.ahead, current: b.current, commits });
	}
	return { repo: repoPath, name: basename(repoPath) || repoPath, head, defaultRef, branches, unpushed, truncated };
}

export async function repoSummary(entry) {
	const info = {
		path: entry.path,
		name: basename(entry.path) || entry.path,
		rootRelative: (() => {
			const rel = relative(entry.root, entry.path);
			return rel === "" ? "." : rel.split("\\").join("/");
		})(),
		branch: "",
		detached: false,
		upstream: null,
		ahead: 0,
		behind: 0,
		upstreamGone: false,
		files: [],
		counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, total: 0 },
		head: null,
		state: { flags: [], indexLock: false, worktrees: [], submodules: 0 },
		ok: false,
		error: null,
	};
	try {
		const statusText = await git(entry.path, ["status", "--porcelain=v1", "-b", "--find-renames"]);
		const headerLine = statusText.split("\n").find((l) => l.startsWith("## "));
		Object.assign(info, parseStatusHeader(headerLine ? headerLine.slice(3) : ""));
		info.files = parseStatusFiles(statusText);
		info.counts = countFiles(info.files);
		info.head = await headCommit(entry.path);
		info.state = await repoState(entry.path);
		info.ok = true;
	} catch (err) {
		info.error = firstLine(err);
	}
	return info;
}
