/**
 * Persisted view state. Settings come from a JSON file, so every value is validated here and never trusted.
 */


/** The view state the client reads out of every scan/prefs reply. */
export function prefsPayload(opts) {
	return {
		depth: opts.depth,
		maxRepos: opts.maxRepos,
		autoRefreshSec: opts.autoRefreshSec,
		hideClean: opts.hideClean,
		termVisible: opts.termVisible,
		termHeight: opts.termHeight, // null = the stylesheet's default strip height
		termKeep: opts.termKeep, // the client caps its cached xterm panes with the same number
		widths: opts.widths,
		sort: opts.sort,
		group: opts.group,
		branchGroupPattern: opts.branchGroupPattern,
		branchGroups: opts.branchGroups,
		collapsed: opts.collapsed, // folded segments survive a reload through this field
	};
}

/** Small string list from storage (folded segment keys): trimmed, de-duplicated, capped. */
export function normStrings(value, maxItems = 80, maxLen = 64) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const v = item.trim().slice(0, maxLen);
		if (!v || out.includes(v)) continue;
		out.push(v);
		if (out.length >= maxItems) break;
	}
	return out;
}

/**
 * A branch-grouping pattern from storage/settings. Empty (the default) means "group by the full branch
 * name"; a pattern must be a valid regular expression, otherwise it is ignored rather than throwing on
 * every render.
 */
export function normPattern(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return "";
    if (raw.length > 200) return "";
    try {
        new RegExp(raw);
        return raw;
    } catch {
        return "";
    }
}

/** Workspace root → grouping pattern overrides, so one project can group differently from another. */
export function normPatternMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out = {};
    for (const [root, pattern] of Object.entries(value)) {
        const key = String(root ?? "").trim().slice(0, 400);
        const pat = normPattern(pattern);
        if (!key || !pat) continue;
        out[key] = pat;
        if (Object.keys(out).length >= 40) break;
    }
    return out;
}

/** Pane-width pair from storage; any malformed value → null (client uses its defaults). */
export function normWidths(value) {
	if (!Array.isArray(value)) return null;
	const w1 = Number(value[0]);
	const w2 = Number(value[1]);
	if (!Number.isFinite(w1) || !Number.isFinite(w2)) return null;
	return [Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(w1))), Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(w2)))];
}

/** Settings multi-value text → trimmed, non-empty strings (comma / semicolon / newline). */
export function splitList(value) {
	return String(value ?? "")
		.split(/[\n,;]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export function numOr(value, fallback, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.round(n)));
}

export function asBool(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}

/** One of a fixed set of values (view enums persisted in storage). */
export function oneOf(value, allowed, fallback) {
	return allowed.includes(value) ? value : fallback;
}

/** Repo-list view enums, persisted like the other view toggles. */
export const SORT_MODES = ["name", "status", "recent", "drift"];

export const GROUP_MODES = ["none", "prefix", "branch"];

/**
 * Terminal-strip height. The runtime clamp also respects the height of the pane the strip sits in;
 * these bounds are the storage-side sanity check, so a hand-edited storage.json cannot lock the
 * strip into a size the user cannot drag back out of. null = "use the stylesheet default".
 */
export const TERM_MIN = 120;

export const TERM_MAX = 1200;

/** Live repository shells kept at once (the `termKeep` setting). 16 is the host's own live-terminal cap. */
export const TERM_KEEP_DEFAULT = 5;

export const TERM_KEEP_MAX = 16;

export function normTermHeight(value) {
	if (value === null || value === undefined) return null;
	const n = Number(value);
	if (!Number.isFinite(n)) return null;
	return Math.min(TERM_MAX, Math.max(TERM_MIN, Math.round(n)));
}

export const WIDTH_MIN = 140;

export const WIDTH_MAX = 900;
