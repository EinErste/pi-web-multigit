/**
 * Run the suites against a workspace.
 *
 * The suites take the workspace as their first argument, so baking a path into package.json would put one
 * machine's layout in the repository. This resolves it instead:
 *
 *   npm test                      workspace from $WORKSPACE, else the current directory
 *   npm test -- /path/to/workspace
 *
 * It also runs the host-loader suite *with the workspace as its working directory*, which is what that suite
 * needs — it scans the process cwd rather than an argument, so running it from the plugin directory finds no
 * repositories and fails for the wrong reason.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const only = process.argv.includes("--only=host") ? "host" : null;
const workspace = resolve(process.env.WORKSPACE ?? process.argv.find((a) => !a.startsWith("--") && a !== process.argv[0] && a !== process.argv[1]) ?? process.cwd());

if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
	console.error(`Not a directory: ${workspace}`);
	process.exit(2);
}

/** A workspace is a directory whose children include Git repositories. */
const repoCount = readdirSync(workspace, { withFileTypes: true }).filter((e) => {
	try {
		return e.isDirectory() && existsSync(join(workspace, e.name, ".git"));
	} catch {
		return false;
	}
}).length;

if (!repoCount) {
	console.error(
		[
			`No Git repositories below ${workspace}.`,
			"",
			"Pass the workspace to inspect, or set WORKSPACE:",
			"    npm test -- /path/to/workspace",
			"    WORKSPACE=/path/to/workspace npm test",
		].join("\n"),
	);
	process.exit(2);
}

const suites = only === "host" ? [["host-loader", "host-loader.test.mjs"]] : [
	["server", "server.test.mjs"],
	["client", "client.test.mjs"],
	["host-loader", "host-loader.test.mjs"],
];

console.log(`workspace: ${workspace} (${repoCount} repositories)\n`);
let failed = 0;
for (const [label, file] of suites) {
	console.log(`=== ${label} ===`);
	// the workspace is both the argument and the cwd: the host-loader suite reads cwd
	const res = spawnSync(process.execPath, [join(here, file), workspace], { cwd: workspace, stdio: "inherit" });
	if (res.status !== 0) failed++;
	console.log("");
}

if (failed) {
	console.error(`${failed} suite(s) failed`);
	process.exit(1);
}
console.log("all suites passed");
