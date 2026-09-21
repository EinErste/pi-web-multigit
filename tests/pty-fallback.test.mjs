/**
 * ensureLocalNodePty(): the fallback for a host that does not ship node-pty.
 *
 * Hermetic by design — the resolver and the installer are injected, so this suite never runs npm
 * and never touches the network. It pins the ORDER (an already-installed copy first, npm only when
 * that fails) and the failure behaviour (null, never a throw) that index.mjs relies on.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ensureLocalNodePty, loadNodePtyFrom, pluginDir } from "../server/pty.mjs";

console.log("=== pty fallback ===");

const mod = { spawn() {}, name: "fake-node-pty" };

/** Host stub that records every call, including the progress lines it was handed. */
function fakeHost({ installed = true, throws = false, deps = true, onInstall } = {}) {
	const calls = [];
	const host = {
		calls,
		async ensureDeps(specs, opts) {
			calls.push({ kind: "ensureDeps", specs });
			opts?.onProgress?.("正在安装依赖：node-pty…");
			if (throws) throw new Error("npm exploded");
			onInstall?.();
			return installed;
		},
		log(level, text) {
			calls.push({ kind: "log", level, text: String(text) });
		},
	};
	if (!deps) delete host.ensureDeps;
	return host;
}

console.log("1. an already-installed copy wins — npm is never called");
{
	const host = fakeHost();
	const got = await ensureLocalNodePty(host, { local: () => mod });
	assert.equal(got, mod, "the local module is returned");
	assert.deepEqual(host.calls, [], "no ensureDeps, no log");
}

console.log("2. missing locally → ensureDeps(['node-pty']) → resolve again");
{
	const host = fakeHost({ onInstall: () => { installed = true; } });
	let installed = false;
	const local = () => {
		if (!installed) throw new Error("Cannot find module 'node-pty'");
		return mod;
	};
	const before = host.calls.length;
	const got = await ensureLocalNodePty(host, { local });
	assert.equal(got, mod, "the freshly installed copy is returned");
	const asked = host.calls.find((c) => c.kind === "ensureDeps");
	assert.deepEqual(asked?.specs, ["node-pty"], "it asks for exactly node-pty");
	const progress = host.calls.filter((c) => c.kind === "log" && /node-pty/.test(c.text));
	assert.ok(progress.length >= 1, "install progress is forwarded to host.log");
	assert.ok(host.calls.length > before, "the host was actually used");
}

console.log("3. a failed install returns null instead of throwing");
{
	const host = fakeHost({ installed: false });
	let installed = false;
	const local = () => {
		if (!installed) throw new Error("Cannot find module 'node-pty'");
		return mod;
	};
	assert.equal(await ensureLocalNodePty(host, { local }), null, "no module, no throw");
	assert.ok(
		host.calls.every((c) => c.kind !== "log" || c.level !== "info" || !/ready/.test(c.text)),
		"nothing claims success",
	);
}

console.log("4. an installer that throws is contained");
{
	const host = fakeHost({ throws: true });
	const local = () => {
		throw new Error("Cannot find module 'node-pty'");
	};
	assert.equal(await ensureLocalNodePty(host, { local }), null, "throwing installer → null");
	assert.ok(
		host.calls.some((c) => c.kind === "log" && c.level === "warn"),
		"the failure is logged as a warning",
	);
}

console.log("5. a host without ensureDeps gets null, not a TypeError");
{
	const host = fakeHost({ deps: false });
	assert.equal(typeof host.ensureDeps, "undefined", "stub really has no ensureDeps");
	const local = () => {
		throw new Error("Cannot find module 'node-pty'");
	};
	assert.equal(await ensureLocalNodePty(host, { local }), null);
	assert.equal(await ensureLocalNodePty(undefined, { local }), null, "no host at all");
	assert.equal(await ensureLocalNodePty({}, { local }), null, "host without the method");
}

console.log("6. the fallback install root is the plugin root");
{
	assert.ok(existsSync(join(pluginDir(), "manifest.json")), "pluginDir() has the manifest");
	assert.ok(existsSync(join(pluginDir(), "package.json")), "…and a package.json for npm to pin");
	assert.throws(() => loadNodePtyFrom(join(pluginDir(), "no-such-dir")), "a bad base throws cleanly");
}

console.log("PTY FALLBACK CHECKS PASSED");