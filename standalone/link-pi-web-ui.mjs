#!/usr/bin/env node
/**
 * Point pi-web-ui at this repository with a Windows directory junction.
 *
 *   node standalone/link-pi-web-ui.mjs            # create or repair the link
 *   node standalone/link-pi-web-ui.mjs --check     # report the link's state, change nothing
 *
 * pi-web-ui only loads plugins from `<dataDir>/plugins/<id>/` — it imports `<dir>/index.mjs` and serves
 * `/plugins/<id>/client/*` from there — while pi discovers this repository as a *package* wherever it
 * lives (`pi.extensions` in package.json). One checkout, two hosts, so one of them has to reach across.
 *
 * A junction rather than a copy: it is transparent to Node's fs (pi-web-ui cannot tell the difference),
 * it needs no elevation on Windows (unlike a symbolic link), and there is exactly one copy of the code, so the
 * standalone server and the pi-web-ui plugin can never drift apart.
 *
 * If pi-web-ui is running, reload its plugins (or restart it) after changing the link — it may have the
 * previous path cached in memory.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const LINK_DIR = process.env.PI_WEB_PLUGINS_DIR ?? join(homedir(), ".pi-web", "plugins");
const LINK = join(LINK_DIR, "pi-web-multigit");
/** The plugin id pi-web-ui keys on; the directory name must stay `pi-web-multigit`. */
const MANIFEST = join(REPO, "manifest.json");

const checkOnly = process.argv.includes("--check");

/** What is at the link path right now: nothing, a junction to us, a junction elsewhere, or a real dir. */
function describe() {
	try {
		const stat = lstatSync(LINK);
		if (!stat.isSymbolicLink()) return { kind: "real-directory", target: null };
		const target = resolve(readlinkSync(LINK));
		return { kind: target === REPO ? "linked-here" : "linked-elsewhere", target };
	} catch {
		return { kind: "missing", target: null };
	}
}

function report(state) {
	console.log(`repo       ${REPO}`);
	console.log(`link       ${LINK}`);
	console.log(`state      ${state.kind}${state.target ? ` -> ${state.target}` : ""}`);
	if (state.kind === "linked-here") console.log("           pi-web-ui loads this checkout");
	else if (state.kind === "linked-elsewhere") console.log("           points at a different checkout");
	else if (state.kind === "real-directory") console.log("           a real directory sits there, not a link to this repo");
}

const state = describe();

if (!existsSync(MANIFEST)) {
	console.error(`multi-git: this does not look like the plugin repository — ${MANIFEST} is missing`);
	process.exitCode = 2;
} else if (checkOnly) {
	report(state);
	if (state.kind !== "linked-here") process.exitCode = 1;
} else if (state.kind === "linked-here") {
	report(state);
	console.log("\nAlready linked; nothing to do.");
} else if (state.kind === "real-directory") {
	// Removing a directory we did not create would delete someone's checkout — refuse and say so.
	report(state);
	console.error(`\nmulti-git: refusing to replace a real directory at ${LINK}`);
	console.error("Move or delete it yourself if this repository is the one you want there.");
	process.exitCode = 2;
} else {
	if (state.kind === "linked-elsewhere") {
		console.log(`replacing a junction that pointed at ${state.target}`);
		rmSync(LINK, { force: true });
	}
	mkdirSync(LINK_DIR, { recursive: true });
	symlinkSync(REPO, LINK, "junction");
	report(describe());
	console.log("\nReload pi-web-ui plugins (or restart it, then refresh the browser) to pick this up.");
}