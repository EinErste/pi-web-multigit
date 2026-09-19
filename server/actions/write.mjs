/**
 * The only actions that touch a repository: a fetch sweep, a fast-forward pull sweep, and per-file rollback.
 * All three are serialised per concern, and all three refuse anything outside the scanned repositories.
 */

import { FETCH_CONCURRENCY, FETCH_TIMEOUT_MS, firstLine, git, mapLimit, repoPathArg } from "../git.mjs";
import { aheadBehind, gitFetch, repoState } from "../repos.mjs";

export function createWriteActions(ctx) {
	const {
		basename,
		fetching,
		join,
		known,
		lastScan,
		pulling,
		reply,
		resolveRepo,
		stat,
		unlink,
	} = ctx;

	async function onFetch(payload, from, reqId) {
		const targets = payload.repo ? [resolveRepo(payload.repo)] : [...known.value.values()];
		if (!targets.length) throw new Error("Nothing to fetch — refresh the scan first");
		if (fetching.value) throw new Error("A fetch is already running");
		fetching.value = mapLimit(targets, FETCH_CONCURRENCY, async (repoPath) => {
			try {
				await gitFetch(repoPath);
				const upstream = (await git(repoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "")).trim();
				const counts = upstream ? await aheadBehind(repoPath) : { ahead: 0, behind: 0 };
				return { repo: repoPath, ok: true, upstream: upstream || null, ahead: counts.ahead, behind: counts.behind };
			} catch (err) {
				return { repo: repoPath, ok: false, error: firstLine(err) };
			}
		});
		let results;
		try {
			results = await fetching.value;
		} finally {
			fetching.value = null;
		}
		lastScan.value = null; // remote refs moved: the next scan must be fresh
		reply(from, {
			action: "multi-git:data",
			kind: "fetch",
			ok: true,
			reqId,
			results,
			summary: {
				repos: results.length,
				failed: results.filter((r) => !r.ok).length,
				behind: results.filter((r) => r.ok && r.behind > 0).length,
				ahead: results.filter((r) => r.ok && r.ahead > 0).length,
				noUpstream: results.filter((r) => r.ok && !r.upstream).length,
			},
		});
		return;
	}

	async function onPull(payload, from, reqId) {
		const targets = payload.repo ? [resolveRepo(payload.repo)] : [...known.value.values()];
		if (!targets.length) throw new Error("Nothing to pull — refresh the scan first");
		if (pulling.value) throw new Error("A pull is already running");
		if (fetching.value) throw new Error("A fetch is already running — wait for it to finish");
		pulling.value = mapLimit(targets, FETCH_CONCURRENCY, async (repoPath) => {
			const name = basename(repoPath) || repoPath;
			try {
				const state = await repoState(repoPath);
				if (state.flags.length) return { repo: repoPath, name, ok: false, skipped: true, error: `mid-${state.flags[0]} — resolve it first` };
				if (state.indexLock) return { repo: repoPath, name, ok: false, skipped: true, error: "index.lock present" };
				const upstream = (await git(repoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "")).trim();
				if (!upstream) return { repo: repoPath, name, ok: false, skipped: true, error: "no upstream configured" };
				const before = (await git(repoPath, ["rev-parse", "--short", "HEAD"])).trim();
				await gitFetch(repoPath);
				const counts = await aheadBehind(repoPath);
				if (counts.behind === 0) {
					return { repo: repoPath, name, ok: true, action: "up-to-date", upstream, ahead: counts.ahead, behind: 0, before, after: before };
				}
				if (counts.ahead > 0) {
					// Diverged: a fast-forward is impossible and merging is not this button's job.
					return { repo: repoPath, name, ok: true, action: "diverged", upstream, ahead: counts.ahead, behind: counts.behind, before, after: before };
				}
				// A non-fast-forward (or a work tree that would be overwritten) aborts cleanly here.
				const merge = await git(repoPath, ["merge", "--ff-only", upstream], FETCH_TIMEOUT_MS).catch((err) => ({
					failed: true,
					error: firstLine(err),
				}));
				if (merge.failed) {
					return { repo: repoPath, name, ok: false, action: "blocked", upstream, ahead: counts.ahead, behind: counts.behind, before, after: before, error: merge.error };
				}
				const after = (await git(repoPath, ["rev-parse", "--short", "HEAD"])).trim();
				return { repo: repoPath, name, ok: true, action: "updated", upstream, ahead: 0, behind: 0, before, after };
			} catch (err) {
				return { repo: repoPath, name, ok: false, action: "failed", error: firstLine(err) };
			}
		});
		let results;
		try {
			results = await pulling.value;
		} finally {
			pulling.value = null;
		}
		lastScan.value = null; // HEAD/branch state changed: the next scan must be fresh
		reply(from, {
			action: "multi-git:data",
			kind: "pull",
			ok: true,
			reqId,
			results,
			summary: {
				repos: results.length,
				updated: results.filter((r) => r.action === "updated").length,
				upToDate: results.filter((r) => r.action === "up-to-date").length,
				diverged: results.filter((r) => r.action === "diverged").length,
				blocked: results.filter((r) => r.action === "blocked" || r.skipped).length,
				failed: results.filter((r) => r.action === "failed").length,
			},
		});
		return;
	}

	async function onRevert(payload, from, reqId) {
		const repo = resolveRepo(payload.repo);
		const relPath = repoPathArg(repo, String(payload.path ?? ""));
		const porcelain = await git(repo, ["status", "--porcelain=v1", "--", relPath]).catch((err) => {
			throw new Error(firstLine(err));
		});
		/**
		 * One file, one entry. The client sends a path from the changes list, but the confirmation below only
		 * makes sense for a single file: a directory or a glob (`dir/*`) matches several entries with
		 * different codes, and an `A` on the first one would arm the delete branch — which then removes
		 * tracked files too (`git rm -f -- dir/*`), uncommitted work and all. So: exactly one entry, and
		 * never a directory.
		 */
		const entries = porcelain.split("\n").filter((l) => l.trim());
		if (!entries.length) throw new Error("Nothing to roll back — the file has no pending changes");
		if (entries.length > 1) throw new Error(`Rollback works on one file at a time — ${entries.length} entries match this path`);
		const code = entries[0].slice(0, 2);
		const abs = join(repo, relPath);
		const st = await stat(abs).catch(() => null);
		if (st?.isDirectory()) throw new Error("Rollback works on files, not directories");
		const untracked = code === "??" || code[0] === "A";
		if (untracked && payload.allowUntracked !== true) {
			throw new Error(`${code === "??" ? "Untracked" : "Newly added"} file — deleting it cannot be undone; confirm with allowUntracked`);
		}
		let output = "";
		if (untracked) {
			// abs/stat were resolved above, before the untracked decision
			if (code[0] === "A") {
				// staged new file: drop it from the index AND the work tree
				await git(repo, ["rm", "-f", "--", relPath]).catch((err) => {
					throw new Error(firstLine(err));
				});
				output = `removed ${relPath}`;
			} else {
				await unlink(abs);
				output = `deleted ${relPath}`;
			}
			reply(from, { action: "multi-git:data", kind: "revert", ok: true, reqId, repo, path: relPath, action2: "deleted", output });
			return;
		}
		await git(repo, ["restore", "--source=HEAD", "--staged", "--worktree", "--", relPath]).catch((err) => {
			throw new Error(firstLine(err));
		});
		reply(from, { action: "multi-git:data", kind: "revert", ok: true, reqId, repo, path: relPath, action2: "restored", output: `${code.trim() || "changed"} → reverted` });
		return;
	}


	return {
		"multi-git:fetch": onFetch,
		"multi-git:pull": onPull,
		"multi-git:revert": onRevert,
	};
}
