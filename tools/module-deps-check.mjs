/**
 * Find identifiers a client module references but never gets.
 *
 * The split computes a module's deps from its *functions*; a moved const (like `MIDDLE_MIN`, whose initializer
 * reads `detailHead`) was not covered, so the generated factory lacked a dep and the view threw at mount. This
 * checker resolves every reference in the finished module and reports the ones that resolve to nothing and are
 * not globals — i.e. exactly the names that still have to be passed in.
 *
 *   node module-deps-check.mjs <module.mjs> [...]
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { analyse } from "./scope-free.mjs";

const GLOBALS = new Set([
	"console", "process", "JSON", "Math", "Object", "Array", "String", "Number", "Boolean", "Date", "RegExp", "Map",
	"Set", "Promise", "Error", "TypeError", "Symbol", "BigInt", "Infinity", "NaN", "undefined", "null", "true",
	"false", "globalThis", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame",
	"cancelAnimationFrame", "queueMicrotask", "structuredClone", "fetch", "URL", "URLSearchParams", "TextEncoder",
	"TextDecoder", "AbortController", "ResizeObserver", "IntersectionObserver", "MutationObserver", "navigator",
	"document", "window", "location", "localStorage", "sessionStorage", "performance", "crypto", "atob", "btoa",
	"Buffer", "require", "module", "exports", "__dirname", "arguments", "Function", "Proxy", "Reflect", "WeakMap",
	"WeakSet", "Intl", "isNaN", "parseInt", "parseFloat", "encodeURIComponent", "decodeURIComponent", "escape",
	"unescape", "AggregateError", "RangeError", "SyntaxError", "ReferenceError", "eval", "isFinite", "undefined",
	"__piWebUiHost", "getComputedStyle", "matchMedia", "CustomEvent", "Event", "Node", "Element",
	"import", "meta",
]);

let problems = 0;
for (const file of process.argv.slice(2)) {
	const code = readFileSync(file, "utf8");
	const a = analyse(code);
	const missing = new Map(); // name → the scope that referenced it
	for (const ref of a.references) {
		if (a.resolve(ref.name, ref.scope)) continue; // declared somewhere in this module
		if (GLOBALS.has(ref.name)) continue;
		if (!missing.has(ref.name)) missing.set(ref.name, ref.scope.fn ?? "module");
	}
	if (missing.size) {
		problems++;
		console.log(`${basename(file)}: ${[...missing.entries()].map(([n, w]) => `${n} (used in ${w})`).join(", ")}`);
	}
}
console.log(problems ? `MISSING DEPS: ${problems} module(s)` : "MISSING DEPS: none — every reference resolves");
