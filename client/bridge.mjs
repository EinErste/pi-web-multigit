/**
 * The host bridge: request/response over the plugin channel, and the persisted view state. The request counter
 * and the prefs sequence guard live here because this is the code that writes them.
 */


export function createBridge(deps) {
	const {
	PLUGIN_ID, // from module
	REQUEST_TIMEOUT_MS, // from module
	ctx, // from mount
	destroyed, // from mount
	pending, // from mount
	renderAll, // from mount
	state, // from mount
	syncControls, // from mount
	} = deps;

	let seq = 0;
	let prefsSeq = 0;

/* ---------------- host channel ---------------- */
function request(action, extra, timeoutMs = REQUEST_TIMEOUT_MS) {
	// Guard rail: `repo` is always a PATH. A repo *object* reaches the server as
	// "[object Object]" and comes back as the misleading "Unknown repository".
	if (extra && extra.repo != null && typeof extra.repo !== "string") {
		console.warn(`[multi-git] ${action}: repo must be a path string, got ${typeof extra.repo}`);
		extra = { ...extra, repo: typeof extra.repo?.path === "string" ? extra.repo.path : "" };
	}
	const reqId = ++seq;
	return new Promise((resolve) => {
		const to = setTimeout(() => {
			pending.delete(reqId);
			resolve({ ok: false, error: "Request timed out" });
		}, timeoutMs);
		pending.set(reqId, (msg) => {
			clearTimeout(to);
			resolve(msg);
		});
		ctx.send({ action: `${PLUGIN_ID}:${action}`, reqId, ...(extra ?? {}) });
	});
}
async function savePrefs(patch) {
	// Replies carry the server's view of the prefs; with two quick saves they can arrive out of
	// order, and applying an older one would undo the newer toggle. Only the newest reply counts.
	const my = ++prefsSeq;
	const res = await request("prefs", patch);
	if (destroyed || !res.ok || my !== prefsSeq) return;
	if (Array.isArray(res.repos)) state.repos = res.repos;
	const folded = state.collapsed; // this view owns the folded set; it is restored from a scan
	const groups = state.prefs?.branchGroups;
	if (res.prefs) state.prefs = { ...state.prefs, ...res.prefs };
	state.collapsed = folded;
	if (groups) state.prefs.branchGroups = groups;
	state.truncated = !!res.truncated;
	state.scannedAt = Number(res.scannedAt) || state.scannedAt;
	syncControls();
	renderAll();
}

	return { request, savePrefs };
}
