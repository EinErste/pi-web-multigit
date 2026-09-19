/**
 * Loads the plugin through the host's own PluginManager (the code path the running server
 * uses): manifest validation, capability gating, activate(), UI contribution merge,
 * settings schema, message routing and client-bundle resolution.
 *
 *   node tests/host-loader.test.mjs [workspace-dir]
 *
 * The pi-web-ui package is located via `npm root -g`; override with PI_WEB_PKG=/path/to/pi-web-ui.
 * The plugin is copied into a throwaway data dir first, so this never touches your install.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const CWD = process.argv[2] ?? process.cwd();
const PLUGIN_SRC = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Locate the installed pi-web-ui package (no child processes, no shell). */
function resolvePkg() {
	const candidates = [
		process.env.PI_WEB_PKG,
		join(process.env.APPDATA ?? "", "npm", "node_modules", "pi-web-ui"), // Windows npm -g
		join(dirname(process.execPath), "node_modules", "pi-web-ui"), // node install prefix
		"/usr/local/lib/node_modules/pi-web-ui",
		"/usr/lib/node_modules/pi-web-ui",
		join(homedir(), ".npm-global", "lib", "node_modules", "pi-web-ui"),
	].filter(Boolean);
	for (const c of candidates) {
		if (existsSync(join(c, "dist", "server", "plugins.js"))) return c;
	}
	throw new Error(`pi-web-ui not found — set PI_WEB_PKG to its install directory. Tried:\n${candidates.join("\n")}`);
}

const PKG = resolvePkg();
console.log(`pi-web-ui package: ${PKG}`);
console.log(`plugin source:     ${PLUGIN_SRC}`);
console.log(`workspace:         ${CWD}`);

const DATA = mkdtempSync(join(tmpdir(), "multi-git-loader-"));
mkdirSync(join(DATA, "plugins"), { recursive: true });
cpSync(PLUGIN_SRC, join(DATA, "plugins", "multi-git"), { recursive: true });
const cleanupFs = () => rmSync(DATA, { recursive: true, force: true });

const { PluginManager, resolvePluginClientFile } = await import(pathToFileURL(join(PKG, "dist/server/plugins.js")).href);

const captured = [];
const pm = new PluginManager(DATA, CWD, join(PKG, "plugins/catalog.json"));
pm.addSender(
	(msg) => captured.push(msg),
	() => "client-x",
);

console.log("\n1. reload() — scan, manifest validation, activation");
const list = await pm.reload(() => "en");
const info = list.find((p) => p.id === "multi-git");
assert.ok(info, `plugin missing from the list; got: ${list.map((p) => p.id).join(",") || "(none)"}`);
assert.equal(info.error, undefined, `loader reported an error: ${info.error}`);
assert.equal(info.view, true, "the plugin must expose a view tab");
console.log(
	JSON.stringify(
		{ id: info.id, name: info.name, version: info.version, apiVersion: info.apiVersion, permissions: info.permissions, view: info.view, icon: info.icon },
		null,
		1,
	),
);

console.log("\n2. manifest.ui as merged by the host");
assert.equal(info.ui.items.length, 1, "exactly one slot item expected");
const item = info.ui.items[0];
assert.equal(item.slot, "scm.toolbar", "slot must be the SCM toolbar");
assert.equal(item.kind, "action");
assert.equal(item.action, "multi-git:open");
console.log(JSON.stringify(info.ui.items, null, 1));

console.log("\n3. settings schema + values");
// Compare against the manifest itself: a hardcoded count breaks every time a setting is added, and
// says nothing about the *schema* being parsed at all.
const declared = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")).settings ?? [];
assert.equal(info.settingsSchema.length, declared.length, `all ${declared.length} settings parsed`);
assert.deepEqual(
	info.settingsSchema.map((s) => s.key).sort(),
	declared.map((s) => s.key).sort(),
	"every declared key is in the parsed schema",
);
assert.ok(info.settingsSchema.every((s) => s.type === "text" || s.type === "number" || s.type === "boolean"), "each setting has a known type");
console.log(info.settingsSchema.map((s) => `${s.key}:${s.type}${s.default === undefined ? "" : `=${s.default}`}`).join("  "));

console.log("\n4. diagnostics must be clean");
assert.deepEqual(pm.runtimeDiags.get("multi-git") ?? [], [], "no runtime diagnostics");
assert.ok(
	(pm.pluginLogs.get("multi-git") ?? []).some((l) => l.text.includes("multi-git ready")),
	"activation should be logged",
);
console.log(`logs: ${JSON.stringify((pm.pluginLogs.get("multi-git") ?? []).map((l) => `${l.level}: ${l.text}`))}`);

console.log("\n5. message routing through the host");
pm.handleMessage("multi-git", { action: "multi-git:scan", reqId: 42 }, "client-x");
pm.handleMessage("multi-git", { action: "other-plugin:thing" }, "client-x"); // foreign action: ignored
await new Promise((r) => setTimeout(r, 5_000));
const data = captured.filter((m) => m.type === "plugin_data" && m.pluginId === "multi-git");
assert.equal(data.length, 1, `expected exactly one reply, got ${data.length}`);
assert.equal(data[0].payload.kind, "repos");
assert.equal(data[0].payload.reqId, 42);
assert.ok(data[0].payload.repos.length > 0, "the reply must carry repositories");
console.log(`   kind=${data[0].payload.kind} reqId=${data[0].payload.reqId} repos=${data[0].payload.repos.length}`);

console.log("\n6. client bundle resolution (GET /plugins/:id/client/*)");
const entry = resolvePluginClientFile(join(DATA, "plugins"), "multi-git", "entry.mjs");
assert.ok(entry && entry.endsWith("entry.mjs"), "client entry must resolve");
assert.equal(resolvePluginClientFile(join(DATA, "plugins"), "multi-git", "../manifest.json"), null, "traversal refused");
console.log(`   entry.mjs resolved; ../manifest.json refused`);

console.log("\n7. reload re-activates cleanly");
await pm.reload(() => "en");
assert.deepEqual(pm.runtimeDiags.get("multi-git") ?? [], [], "still no diagnostics after reload");

console.log("\nHOST-LOADER CHECKS PASSED");
pm.dispose();
cleanupFs();
process.exit(0);
