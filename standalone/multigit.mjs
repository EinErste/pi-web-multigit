#!/usr/bin/env node
/**
 * multi-git standalone — run the overview without pi.
 *
 *   node standalone/multigit.mjs [--root <dir>] [--port <n>] [--host <ip>] [--open] [--json]
 *
 * The pi extension imports `server.mjs` in-process; this CLI is for running the view by hand, from a
 * terminal, when pi is not involved (and for smoke-testing the server on its own).
 *
 * The scan root is the project directory. `--root` and `MULTIGIT_ROOT` override it for a one-off, and the
 * pi extension (`/multigit`) uses the session cwd the same way. Nothing is remembered, deliberately: a
 * stored root would be a second source of truth next to the directory you are actually in, and an empty repo
 * list from the wrong tree reads as "this project has no repositories" rather than as "you were elsewhere".
 *
 * `--json` prints one machine-readable line once listening and keeps running, so a launcher can learn the
 * chosen random port without guessing.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { openInBrowser } from "./open.mjs";
import { startMultigitServer } from "./server.mjs";

const USAGE = `usage: node standalone/multigit.mjs [options]

  -r, --root <dir>    project directory to scan (default: the current directory)
  -p, --port <n>      port to bind; 0 picks a free one (default: 0)
      --host <ip>      interface to bind (default: 127.0.0.1)
  -o, --open          open the browser once listening
      --json          print {"url":...} as one line instead of a human note
  -h, --help          this text`;

function parseArgs(argv) {
	const opts = { root: null, port: 0, host: "127.0.0.1", open: false, json: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			return value;
		};
		if (arg === "-h" || arg === "--help") opts.help = true;
		else if (arg === "-r" || arg === "--root") opts.root = next();
		else if (arg === "-p" || arg === "--port") opts.port = Number(next());
		else if (arg === "--host") opts.host = next();
		else if (arg === "-o" || arg === "--open") opts.open = true;
		else if (arg === "--json") opts.json = true;
		else throw new Error(`unknown option: ${arg}`);
	}
	if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error("--port must be 0-65535");
	return opts;
}

/** Which root to open, and why — so a wrong tree is never a silent guess. */
function chooseRoot(explicit) {
	if (explicit) return { root: resolve(explicit), source: "--root" };
	if (process.env.MULTIGIT_ROOT) return { root: resolve(process.env.MULTIGIT_ROOT), source: "MULTIGIT_ROOT" };
	return { root: process.cwd(), source: "current directory" };
}

async function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`multi-git: ${err.message}\n\n${USAGE}`);
		process.exitCode = 2;
		return;
	}
	if (opts.help) {
		console.log(USAGE);
		return;
	}

	const chosen = chooseRoot(opts.root);
	if (!existsSync(chosen.root)) {
		console.error(`multi-git: no such root: ${chosen.root}  (${chosen.source})`);
		process.exitCode = 2;
		return;
	}

	const server = await startMultigitServer({ root: chosen.root, port: opts.port, hostname: opts.host });

	if (opts.json) console.log(JSON.stringify({ url: server.url, port: server.port, root: server.root, source: chosen.source }));
	else
		console.log(
			`multi-git  ${server.url}\n            root ${server.root}  (${chosen.source})\n            state ${server.stateFile}\n\nCtrl+C to stop.`,
		);

	if (opts.open) void openInBrowser(server.url);
}

await main();