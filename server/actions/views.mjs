/**
 * Read-only actions: status, diffs, history, branches, stashes, the timeline, blame and compare.
 * Each is a named handler; the entry dispatches to them through a table keyed by the action string.
 */

import { BLAME_TIMEOUT_MS, GIT_CONCURRENCY, LOG_LIMIT, REV_RE, STASH_REF_RE, UNTRACKED_PREVIEW_BYTES, firstLine, git, mapLimit, readHead, repoPathArg, safeRelPath } from "../git.mjs";
import { parseBlamePorcelain, parseBranchVV, parseCommitHistory, parseForEachRef, parseMergedBranches, parseNumStat, parseSimpleCommits, parseStashList, patchOptions } from "../parsers.mjs";
import { numOr } from "../prefs.mjs";
import { repoBranchOverview } from "../repos.mjs";

export function createViewActions(ctx) {
	const {
		SYNC_LOG_LIMIT,
		TIMELINE_DEFAULT_DAYS,
		TIMELINE_MAX_ENTRIES,
		TIMELINE_PER_REPO,
		basename,
		insideRepo,
		known,
		reply,
		resolveRepo,
	} = ctx;

	async function onStats(payload, from, reqId) {
		const repo = resolveRepo(payload.repo);
		const [worktree, staged] = await Promise.all([
			git(repo, ["diff", "--numstat"]).catch(() => ""),
			git(repo, ["diff", "--cached", "--numstat"]).catch(() => ""),
		]);
		const merged = parseNumStat(worktree);
		for (const [p, pair] of Object.entries(parseNumStat(staged))) {
			const prev = merged[p];
			merged[p] = [(prev?.[0] ?? 0) + pair[0], (prev?.[1] ?? 0) + pair[1]];
		}
		reply(from, { action: "multi-git:data", kind: "stats", ok: true, reqId, repo, stats: merged });
		return;
	}

	async function onDiff(payload, from, reqId) {
		const repo = resolveRepo(payload.repo);
		const relPath = String(payload.path ?? "");
		await insideRepo(repo, relPath);
		const diffOpts = patchOptions(payload);
		const [staged, worktree] = await Promise.all([
			git(repo, ["diff", "--cached", "--no-color", "--no-ext-diff", ...diffOpts, "--", relPath]).catch(() => ""),
			git(repo, ["diff", "--no-color", "--no-ext-diff", ...diffOpts, "--", relPath]).catch(() => ""),
		]);
		let preview = null;
		let untracked = false;
		if (!staged && !worktree) {
			const others = await git(repo, ["ls-files", "--others", "--exclude-standard", "--", relPath]).catch(() => "");
			if (others.trim()) {
				untracked = true;
				// realpath containment: an untracked symlink must not preview a file outside the repository
				preview = await readHead(await insideRepo(repo, relPath), UNTRACKED_PREVIEW_BYTES);
			}
		}
		reply(from, {
			action: "multi-git:data",
			kind: "diff",
			ok: true,
			reqId,
			repo,
			path: relPath,
			staged,
			worktree,
			untracked,
			preview,
		});
		return;
	}

	async function onLog(payload, from, reqId) {
		const repo = resolveRepo(payload.repo);
		const rev = payload.rev != null ? String(payload.rev) : null;
		if (rev && !REV_RE.test(rev)) throw new Error("Invalid revision");
		const relPath = payload.path != null ? String(payload.path) : null;
		if (relPath != null) await insideRepo(repo, relPath);

		const args = ["log"];
		if (!rev && !relPath) args.push("--all", "--graph");
		if (relPath) args.push("--follow");
		args.push(
			"--decorate=short",
			"--date=short",
			"--pretty=format:%H%x09%h%x09%an%x09%ad%x09%s%x09%D",
			"-n",
			String(LOG_LIMIT),
		);
		if (rev) args.push(rev);
		if (relPath) args.push("--", relPath);

		const text = await git(repo, args);
		reply(from, {
			action: "multi-git:data",
			kind: "log",
			ok: true,
			reqId,
			repo,
			rev: rev ?? null,
			path: relPath ?? null,
			history: parseCommitHistory(text),
		});
		return;
	}

	async function onCommit(payload, from, reqId) {
		const repo = resolveRepo(payload.repo);
		const hash = String(payload.hash ?? "");
		if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error("Invalid commit hash");
		const text = await git(repo, [
			"show",
			"--no-color",
			"--no-ext-diff",
			"--find-renames",
			"--format=fuller",
			"--stat",
			"--patch",
			...patchOptions(payload),
			hash,
		]);
		reply(from, { action: "multi-git:data", kind: "commit", ok: true, reqId, repo, hash, text });
		return;
	}

	async function onShowfile(payload, from, reqId) {
		const repo = resolveRepo(payload.repo);
		const relPath = String(payload.path ?? "");
		await insideRepo(repo, relPath);
		const rev = String(payload.rev ?? "HEAD");
		if (!REV_RE.test(rev)) throw new Error("Invalid revision");
		const text = await git(repo, ["show", `${rev}:${relPath}`]).catch((err) => {
			throw new Error(firstLine(err));
		});
		reply(from, {
			action: "multi-git:data",
			kind: "showfile",
			ok: true,
			reqId,
			repo,
			rev,
			path: relPath,
			text: text.includes("\u0000") ? "[binary file]" : text,
		});
		return;
	}

	async function onBranches(payload, from, reqId) {
		const repo = resolveRepo(payload.repo);
		const defaultOut = await git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
		const defaultBranch = defaultOut.trim() || null;
		const mergedSet = defaultBranch
			? parseMergedBranches(await git(repo, ["branch", "--merged", defaultBranch]).catch(() => ""))
			: new Set();
		const [refText, vvText] = await Promise.all([
			git(repo, [
				"for-each-ref",
				"--sort=-committerdate",
				"refs/heads",
				"refs/remotes",
				"--format=%(refname)%09%(objectname:short)%09%(committerdate:relative)%09%(subject)%09%(HEAD)",
			]).catch(() => ""),
			git(repo, ["branch", "-vv"]).catch(() => ""),
		]);
		const vv = parseBranchVV(vvText);
		const branches = [];
		for (const b of parseForEachRef(refText, "local")) {
			const info = vv.get(b.name) ?? {};
			branches.push({
				...b,
				remote: false,
				upstream: info.upstream ?? null,
				ahead: info.ahead ?? 0,
				behind: info.behind ?? 0,
				gone: info.gone ?? false,
				merged: mergedSet.has(b.name),
			});
		}
		for (const b of parseForEachRef(refText, "remote")) {
			branches.push({ ...b, remote: true, upstream: null, ahead: 0, behind: 0, gone: false, merged: false });
		}
		reply(from, {
			action: "multi-git:data",
			kind: "branches",
			ok: true,
			reqId,
			repo,
			defaultBranch,
			branches,
		});
		return;
	}

	async function onSync(payload, from, reqId) {
		const repo = resolveRepo(payload.repo);
		const upstreamRaw = await git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "");
		const upstream = upstreamRaw.trim();
		if (!upstream) {
			reply(from, {
				action: "multi-git:data",
				kind: "sync",
				ok: true,
				reqId,
				repo,
				upstream: null,
				unpushed: [],
				incoming: [],
				note: "no upstream configured",
			});
			return;
		}
		const [upText, inText] = await Promise.all([
			git(repo, ["log", "-n", String(SYNC_LOG_LIMIT), "--date=short", "--pretty=format:%h%x09%ad%x09%s", "@{upstream}..HEAD"]).catch(() => ""),
			git(repo, ["log", "-n", String(SYNC_LOG_LIMIT), "--date=short", "--pretty=format:%h%x09%ad%x09%s", "HEAD..@{upstream}"]).catch(() => ""),
		]);
		reply(from, {
			action: "multi-git:data",
			kind: "sync",
			ok: true,
			reqId,
			repo,
			upstream,
			unpushed: parseSimpleCommits(upText),
			incoming: parseSimpleCommits(inText),
		});
		return;
	}

	async function onStashes(payload, from, reqId) {
		const repo = resolveRepo(payload.repo);
		const text = await git(repo, ["stash", "list", "--pretty=format:%gd%x09%h%x09%ar%x09%gs"]).catch(() => "");
		reply(from, {
			action: "multi-git:data",
			kind: "stashes",
			ok: true,
			reqId,
			repo,
			stashes: parseStashList(text),
		});
		return;
	}

	async function onStashshow(payload, from, reqId) {
		const repo = resolveRepo(payload.repo);
		const ref = String(payload.ref ?? "");
		if (!STASH_REF_RE.test(ref)) throw new Error("Invalid stash ref");
		const text = await git(repo, ["-c", "color.diff=false", "stash", "show", "--patch", "--no-ext-diff", "--find-renames", ref]).catch((err) => {
			throw new Error(firstLine(err));
		});
		reply(from, { action: "multi-git:data", kind: "stashshow", ok: true, reqId, repo, ref, text });
		return;
	}

	async function onTimeline(payload, from, reqId) {
		const days = numOr(payload.days, TIMELINE_DEFAULT_DAYS, 1, 90);
		const since = `--since=${days} days ago`;
		const author = String(payload.author ?? "").trim().slice(0, 120);
		const relPath = payload.path ? String(payload.path) : null;
		const roots = [...known.value.values()];
		const per = await mapLimit(roots, GIT_CONCURRENCY, async (repoPath) => {
			const args = ["log", since, "--date=short", "--pretty=format:%H%x09%h%x09%an%x09%ad%x09%s%x09%D", "-n", String(TIMELINE_PER_REPO)];
			if (author) args.push(`--author=${author}`);
			if (relPath) {
				const safe = safeRelPath(repoPath, relPath);
				if (!safe) return { repo: repoPath, events: [] };
				args.push("--", safe);
			}
			const text = await git(repoPath, args).catch(() => "");
			return { repo: repoPath, events: parseCommitHistory(text) };
		});
		const events = [];
		for (const { repo, events: evs } of per) {
			for (const e of evs) events.push({ ...e, repo, repoName: basename(repo) });
		}
		events.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
		const truncated = events.length > TIMELINE_MAX_ENTRIES;
		events.length = Math.min(events.length, TIMELINE_MAX_ENTRIES);
		reply(from, { action: "multi-git:data", kind: "timeline", ok: true, reqId, days, events, truncated });
		return;
	}

	async function onBranchesAll(payload, from, reqId) {
		const roots = [...known.value.values()];
		if (!roots.length) throw new Error("Unknown repository — refresh the scan first");
		const data = await mapLimit(roots, GIT_CONCURRENCY, (repoPath) => repoBranchOverview(repoPath));
		reply(from, { action: "multi-git:data", kind: "branches-all", ok: true, reqId, repos: data, scannedAt: Date.now() });
		return;
	}

	async function onBlame(payload, from, reqId) {
		const repo = resolveRepo(payload.repo);
		const relPath = repoPathArg(repo, String(payload.path ?? ""));
		const rev = payload.rev != null ? String(payload.rev) : "HEAD";
		if (!REV_RE.test(rev)) throw new Error("Invalid revision");
		const text = await git(repo, ["blame", "--line-porcelain", rev, "--", relPath], BLAME_TIMEOUT_MS).catch((err) => {
			throw new Error(firstLine(err));
		});
		const parsed = parseBlamePorcelain(text);
		reply(from, { action: "multi-git:data", kind: "blame", ok: true, reqId, repo, path: relPath, rev, ...parsed });
		return;
	}

	async function onCompare(payload, from, reqId) {
		const repo = resolveRepo(payload.repo);
		const base = String(payload.base ?? "").trim();
		const head = String(payload.head ?? "HEAD").trim();
		if (!base || !REV_RE.test(base) || !REV_RE.test(head)) throw new Error("Invalid revision to compare");
		const [logText, numstat, patch, counts] = await Promise.all([
			git(repo, ["log", "--date=short", "--pretty=format:%H%x09%h%x09%an%x09%ad%x09%s%x09%D", "-n", String(LOG_LIMIT), `${base}..${head}`]).catch(() => ""),
			git(repo, ["diff", "--numstat", `${base}...${head}`]).catch(() => ""),
			git(repo, ["diff", "--no-color", "--no-ext-diff", "--find-renames", ...patchOptions(payload), `${base}...${head}`]).catch((err) => {
				throw new Error(firstLine(err));
			}),
			git(repo, ["rev-list", "--left-right", "--count", `${base}...${head}`]).catch(() => ""),
		]);
		const [behind, ahead] = String(counts).trim().split(/\s+/).map((n) => Number(n));
		reply(from, {
			action: "multi-git:data",
			kind: "compare",
			ok: true,
			reqId,
			repo,
			base,
			head,
			ahead: Number.isFinite(ahead) ? ahead : 0,
			behind: Number.isFinite(behind) ? behind : 0,
			history: parseCommitHistory(logText),
			stats: parseNumStat(numstat),
			patch,
		});
		return;
	}


	return {
		"multi-git:stats": onStats,
		"multi-git:diff": onDiff,
		"multi-git:log": onLog,
		"multi-git:commit": onCommit,
		"multi-git:showfile": onShowfile,
		"multi-git:branches": onBranches,
		"multi-git:sync": onSync,
		"multi-git:stashes": onStashes,
		"multi-git:stashshow": onStashshow,
		"multi-git:timeline": onTimeline,
		"multi-git:branches-all": onBranchesAll,
		"multi-git:blame": onBlame,
		"multi-git:compare": onCompare,
	};
}
