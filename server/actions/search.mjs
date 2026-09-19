/**
 * Cross-repo search: content, file names, and pickaxe, bounded per repo and in total.
 */

import { GIT_CONCURRENCY, firstLine, git, listRepoFiles, mapLimit } from "../git.mjs";
import { parseCommitHistory, parseGrep } from "../parsers.mjs";
import { matchRegexInWorker } from "../regex-match.mjs";

export function createSearchActions(ctx) {
	const {
		SEARCH_MAX_PER_FILE,
		SEARCH_MAX_PER_REPO,
		SEARCH_MAX_TOTAL,
		SEARCH_PICKAXE_LIMIT,
		SEARCH_QUERY_MAX,
		basename,
		known,
		reply,
	} = ctx;

	async function onSearch(payload, from, reqId) {
		if (!known.value.size) {
			reply(from, { action: "multi-git:data", kind: "search", ok: true, reqId, results: [], truncated: false });
			return;
		}
		const query = String(payload.query ?? "").trim();
		if (!query) throw new Error("Search query is empty");
		if (query.length > SEARCH_QUERY_MAX) throw new Error("Search query is too long (max 200 chars)");
		const asRegex = payload.regex === true;
		const caseSensitive = payload.caseSensitive === true;
		if (asRegex) {
			try {
				new RegExp(query);
			} catch {
				throw new Error(`Invalid regular expression: ${query.slice(0, 80)}`);
			}
		}
		const mode = payload.mode === "files" ? "files" : payload.mode === "pickaxe" ? "pickaxe" : "content";
		const roots = [...known.value.values()];
		if (mode === "files") {
			// Search file NAMES (tracked + untracked), the "where does X live" question.
			// Literal matching is linear and stays on this thread; regex mode goes through the worker
			// (regex-match.mjs), because a client-supplied pattern can hang one test() call for minutes.
			const needle = caseSensitive ? query : query.toLowerCase();
			const flags = caseSensitive ? "" : "i";
			const hits = await mapLimit(roots, GIT_CONCURRENCY, async (repoPath) => {
				const files = await listRepoFiles(repoPath, [], { untracked: true });
				const matched = asRegex ? new Set(await matchRegexInWorker(query, flags, files)) : null;
				const own = [];
				for (const p of files) {
					if (own.length >= SEARCH_MAX_PER_REPO) break;
					const match = matched ? matched.has(p) : (caseSensitive ? p : p.toLowerCase()).includes(needle);
					if (match) own.push({ repo: repoPath, repoName: basename(repoPath), path: p });
				}
				return own;
			});
			const fileResults = hits.flat().slice(0, SEARCH_MAX_TOTAL);
			reply(from, {
				action: "multi-git:data",
				kind: "search",
				ok: true,
				reqId,
				query,
				mode,
				asRegex,
				caseSensitive,
				results: fileResults,
				truncated: fileResults.length >= SEARCH_MAX_TOTAL,
			});
			return;
		}
		if (mode === "pickaxe") {
			// `git log -S<query>`: when did this string appear or disappear, across every repo.
			let failure = null;
			const per = await mapLimit(roots, GIT_CONCURRENCY, async (repoPath) => {
				const args = ["log", "-n", String(SEARCH_PICKAXE_LIMIT), "--date=short", "--pretty=format:%H%x09%h%x09%an%x09%ad%x09%s%x09%D"];
				if (!caseSensitive) args.push("-i");
				args.push(`-S${query}`);
				const text = await git(repoPath, args).catch((err) => {
					if (!failure) failure = firstLine(err);
					return "";
				});
				return parseCommitHistory(text).map((c) => ({ ...c, repo: repoPath, repoName: basename(repoPath) }));
			});
			if (failure) throw new Error(failure);
			const commits = per.flat().slice(0, SEARCH_MAX_TOTAL);
			reply(from, {
				action: "multi-git:data",
				kind: "search",
				ok: true,
				reqId,
				query,
				mode,
				asRegex,
				caseSensitive,
				commits,
				truncated: commits.length >= SEARCH_MAX_TOTAL,
			});
			return;
		}
		const grepArgs = [
			"grep",
			"-n",
			"-I",
			...(asRegex ? ["-E"] : ["-F"]),
			...(caseSensitive ? [] : ["-i"]),
			"--",
			query,
		];
		const results = [];
		let total = 0;
		let truncated = false;
		let failure = null; // first real git error (bad ERE, unreadable repo) — reported, not hidden
		await mapLimit(roots, GIT_CONCURRENCY, async (repoPath) => {
			if (truncated || total >= SEARCH_MAX_TOTAL) return;
			const text = await git(repoPath, grepArgs).catch((err) => {
				if (err?.code === 1) return ""; // no matches in this repo
				// Output overflow / timeout: partial results, but say the cap fired.
				if (String(err?.code) === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || err?.killed || err?.signal) {
					truncated = true;
					return "";
				}
				// Anything else is a real failure — a bad regex must not look like "no hits".
				if (!failure) failure = firstLine(err);
				return "";
			});
			const matches = parseGrep(text, repoPath);
			let perRepo = 0;
			let perFile = 0;
			let lastPath = null;
			for (const m of matches) {
				if (total >= SEARCH_MAX_TOTAL) {
					truncated = true;
					break;
				}
				if (perRepo >= SEARCH_MAX_PER_REPO) {
					truncated = true;
					break;
				}
				if (m.path !== lastPath) perFile = 0;
				lastPath = m.path;
				if (perFile >= SEARCH_MAX_PER_FILE) continue;
				results.push(m);
				perRepo++;
				perFile++;
				total++;
			}
		});
		if (failure) throw new Error(failure);
		reply(from, {
			action: "multi-git:data",
			kind: "search",
			ok: true,
			reqId,
			query,
			asRegex,
			caseSensitive,
			results,
			truncated,
		});
		return;
	}


	return {
		"multi-git:search": onSearch,
	};
}
