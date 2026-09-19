/**
 * Free-identifier analysis for a JavaScript module.
 *
 * Purpose: when a function that closes over its enclosing scope is moved into a factory, every name it
 * used from that enclosing scope must be passed in and destructured. This tool answers exactly which names
 * those are, by resolving every reference through a real scope chain — so a header can be generated and
 * then verified, instead of guessed.
 *
 *   node scope-free.mjs <file> [functionName ...]      → what each function needs from outside itself
 *   node scope-free.mjs --self-test                    → check the resolver against known cases
 *
 * `@babel/traverse` is not installed here, so the walk and the scope chain are hand-rolled. That is exactly
 * why the self-test exists: a resolver that is subtly wrong produces a header that looks fine and fails at
 * runtime.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * `@babel/parser` is not a dependency of this plugin (the suites use it to check that every module
 * reference resolves). Resolve it relative to THIS file so it comes from whatever node_modules sits
 * above the checkout — a hardcoded profile path would only ever work on the machine it was written on.
 */
const require = createRequire(import.meta.url);
let parse;
try {
	({ parse } = require("@babel/parser"));
} catch {
	throw new Error("tools/scope-free.mjs needs @babel/parser — install it (`npm i -D @babel/parser`) or run the suites with one on NODE_PATH");
}
/** Walk a file, tracking scopes, and return every reference with the scope it resolved in. */
export function analyse(code) {
	const ast = parse(code, { sourceType: "module", plugins: ["jsx", "classProperties"], errorRecovery: true });

	const FUNCTION = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
	const BLOCK = new Set(["BlockStatement", "ForStatement", "ForInStatement", "ForOfStatement", "CatchClause", "SwitchStatement"]);

	const references = []; // { name, scope, node }
	const writes = []; // assignments to identifiers: a moved function that writes outward needs care

	const root = { parent: null, decls: new Map(), fn: null, kind: "module" };

	const declare = (scope, name, kind) => {
		if (name && !scope.decls.has(name)) scope.decls.set(name, kind);
	};

	/** Which function owns this scope (its own name, or the nearest enclosing function's). */
	const ownerOf = (scope) => scope.fn;

	const isDescendant = (scope, ancestor) => {
		for (let s = scope; s; s = s.parent) if (s === ancestor) return true;
		return false;
	};

	/** Named function declarations hoist into the enclosing scope; everything else stays where it is written. */
	/**
	 * Iterative walk: a recursive one overflows the stack on a large file (deeply nested expressions).
	 * Scopes are created here too, so each work item carries the scope it belongs to.
	 */
	const walk = (startNode, startScope, startParent) => {
		const stack = [[startNode, startScope, startParent]];
		while (stack.length) {
			const [node, scope, parent] = stack.pop();
			walkOne(node, scope, parent, stack);
		}
	};

	const walkOne = (node, scope, parent, stack) => {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (let i = node.length - 1; i >= 0; i--) stack.push([node[i], scope, parent]);
			return;
		}

		if (node.type === "Identifier") {
			const MEMBER = parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression";
			const isMemberProperty = MEMBER && parent.property === node && !parent.computed;
			const isKey =
				(parent?.type === "ObjectProperty" ||
					parent?.type === "ObjectMethod" ||
					parent?.type === "ClassMethod" ||
					parent?.type === "ClassProperty" ||
					parent?.type === "ObjectPattern") &&
				parent.key === node &&
				!parent.computed &&
				!parent.shorthand;
			const isDeclaration = parent?.type === "VariableDeclarator" && parent.id === node;
			const isParam = FUNCTION.has(parent?.type) && (parent.params ?? []).includes(node);
			const isFnName = FUNCTION.has(parent?.type) && parent.id === node;
			const isMemberObject = MEMBER && parent.object === node && parent.computed === false;
			if (!isMemberProperty && !isKey && !isDeclaration && !isParam && !isFnName) {
				references.push({ name: node.name, scope, node });
			}
			return;
		}

		if (node.type === "ImportDeclaration") {
			for (const s of node.specifiers) declare(scope, s.local.name, "import");
			return;
		}

		if (node.type === "FunctionDeclaration") {
			declare(scope, node.id?.name, "function");
			const inner = link({ parent: scope, decls: new Map(), fn: node.id?.name ?? ownerOf(scope), kind: "function", node });
			for (const p of node.params) collectParams(p, inner);
			stack.push([node.body, inner, node]);
			return;
		}

		if (node.type === "ObjectMethod" || node.type === "ClassMethod") {
			// `mount(el, ctx) { … }` is an object method: without this branch its locals would land in the
			// enclosing block scope, and every dep would be labelled "outer" instead of "mount".
			const selfName = node.key?.type === "Identifier" ? node.key.name : ownerOf(scope);
			const inner = link({ parent: scope, decls: new Map(), fn: selfName, kind: "function", node });
			for (const p of node.params) collectParams(p, inner);
			stack.push([node.body, inner, node]);
			return;
		}

		if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
			const inner = link({ parent: scope, decls: new Map(), fn: ownerOf(scope), kind: "function", node });
			if (node.id?.name) declare(inner, node.id.name, "function");
			for (const p of node.params) collectParams(p, inner);
			stack.push([node.body, inner, node]);
			return;
		}

		if (node.type === "ClassDeclaration") {
			declare(scope, node.id?.name, "class");
			stack.push([node.body, scope, node]);
			return;
		}

		if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") {
			const target = node.left ?? node.argument;
			if (target?.type === "Identifier") {
				// an assignment target is also a reference: it must appear in the deps, and it is a write
				writes.push({ name: target.name, scope });
				references.push({ name: target.name, scope, node: target });
			}
			stack.push([node.right ?? null, scope, node]);
			if (node.left && node.left.type !== "Identifier") stack.push([node.left, scope, node]);
			return;
		}

		if (node.type === "VariableDeclaration") {
			for (const d of node.declarations) {
				for (const name of bindingNames(d.id)) declare(scope, name, node.kind);
				stack.push([d.init, scope, node]);
			}
			return;
		}

		if (BLOCK.has(node.type)) {
			const inner = link({ parent: scope, decls: new Map(), fn: ownerOf(scope), kind: "block", node });
			if (node.type === "CatchClause") collectParams(node.param, inner);
			// A switch has `cases`, not `body`; pushing `node` itself would loop forever.
			if (node.type === "SwitchStatement") stack.push([node.cases, inner, node]);
			else if (node.type === "ForStatement") stack.push([node.init, inner, node], [node.test, inner, node], [node.update, inner, node], [node.body, inner, node]);
			else {
				// for-in / for-of: the `left` is a declaration or pattern that must be walked, or every name
				// destructured there looks undeclared
				stack.push([node.left, inner, node], [node.right, inner, node], [node.body, inner, node]);
			}
			return;
		}

		for (const [k, v] of Object.entries(node)) {
			if (k === "loc" || k.endsWith("Comments") || k === "type") continue;
			stack.push([v, scope, node]);
		}
	};

	const collectParams = (param, scope) => {
		for (const name of bindingNames(param)) declare(scope, name, "param");
		// Default values are expressions evaluated in the function's scope: `timeoutMs = REQUEST_TIMEOUT_MS`
		// is a reference to that const, and missing it produced a silent runtime failure.
		walkParamDefaults(param, scope);
	};

	/** Only the expression parts of a parameter pattern: defaults, computed keys and nested defaults. */
	const walkParamDefaults = (param, scope) => {
		if (!param || typeof param !== "object") return;
		if (param.type === "AssignmentPattern") {
			walk(param.right, scope, param);
			walkParamDefaults(param.left, scope);
			return;
		}
		if (param.type === "ObjectPattern") {
			for (const p of param.properties ?? []) {
				if (p.computed) walk(p.key, scope, p);
				if (p.type === "RestElement") walkParamDefaults(p.argument, scope);
				else walkParamDefaults(p.value, scope);
			}
			return;
		}
		if (param.type === "ArrayPattern") {
			for (const el of param.elements ?? []) walkParamDefaults(el, scope);
			return;
		}
		if (param.type === "RestElement") walkParamDefaults(param.argument, scope);
	};

	const bindingNames = (id) => {
		if (!id) return [];
		if (id.type === "Identifier") return [id.name];
		const out = [];
		for (const p of id.properties ?? []) {
			if (p.type === "RestElement") out.push(...bindingNames(p.argument));
			else out.push(...bindingNames(p.value ?? p.argument ?? p.key));
		}
		if (id.type === "AssignmentPattern") out.push(...bindingNames(id.left));
		if (id.type === "RestElement") out.push(...bindingNames(id.argument));
		if (id.type === "ArrayPattern") for (const el of id.elements ?? []) out.push(...bindingNames(el));
		return out;
	};

	walk(ast.program.body, root, null);

	/** Where does this name resolve? The nearest scope that declares it, or null for a global. */
	const resolve = (name, scope) => {
		for (let s = scope; s; s = s.parent) if (s.decls.has(name)) return s;
		return null;
	};

	return {
		root,
		references,
		resolve,
		isDescendant,
		/** Names a function (by name) uses from scopes outside itself — what its factory header must provide. */
		freeIn(fnName) {
			const fnScope = findScope(root, fnName);
			if (!fnScope) return null;
			const out = new Map();
			for (const ref of references) {
				if (!isDescendant(ref.scope, fnScope)) continue; // not inside this function
				const where = resolve(ref.name, ref.scope);
				if (where && isDescendant(where, fnScope)) continue; // satisfied inside the function
				const owner = where ? (where.kind === "module" ? "module" : where.fn ?? "outer") : "global";
				if (owner === "global") continue;
				if (!out.has(ref.name)) out.set(ref.name, owner);
			}
			return out;
		},
		/** Names a function assigns to that are declared outside it: destructuring would break these. */
		writesOut(fnName) {
			const fnScope = findScope(root, fnName);
			if (!fnScope) return [];
			const out = new Set();
			for (const w of writes) {
				if (!isDescendant(w.scope, fnScope)) continue;
				const where = resolve(w.name, w.scope);
				if (where && !isDescendant(where, fnScope)) out.add(`${w.name} (${where.fn ?? "outer"})`);
			}
			return [...out];
		},
		/** All scopes owned by a function name, so nested functions can be listed with their parent. */
		scopesOf(fnName) {
			const out = [];
			const visit = (scope) => {
				if (scope.fn === fnName) out.push(scope);
				for (const child of scope.children ?? []) visit(child);
			};
			visit(root);
			return out;
		},
	};
}

function findScope(scope, fnName) {
	if (scope.fn === fnName && scope.kind === "function") return scope;
	for (const child of scope.children ?? []) {
		const hit = findScope(child, fnName);
		if (hit) return hit;
	}
	return null;
}

/** Keep the scope tree so ancestry checks and listings work. */
function link(scope) {
	scope.children = [];
	const orig = scope.parent;
	if (orig) (orig.children ??= []).push(scope);
	return scope;
}

// Only act as a CLI when run directly: importing this module must not run the self-test and exit.
const IS_CLI = process.argv[1] && process.argv[1].replace(String.fromCharCode(92), "/").endsWith("scope-free.mjs");

// --- self-test: the resolver must be right before any header is generated from it -----------------------
const CASES = [
	["function f(a) { return a; }", "f", {}, "own param is not a dep"],
	["function f() { const x = 1; return x; }", "f", {}, "own local is not a dep"],
	["const g = 1; function f() { return g; }", "f", { g: "module" }, "module const is a dep"],
	["function m() { const s = 1; function f() { return s; } return f; }", "f", { s: "m" }, "outer function local is a dep"],
	["function m() { let h = 1; function f() { function n() { return h; } return n; } }", "f", { h: "m" }, "used inside a nested function"],
	["function m() { function f() { if (1) { const y = 2; return y; } return 0; } }", "f", {}, "block local is not a dep"],
	["function m() { const obj = { prop: 1 }; function f() { return obj.prop; } }", "f", { obj: "m" }, "member object counts, property does not"],
	["function m() { function f() { return { key: 1 }; } }", "f", {}, "object key is not a reference"],
	["function m() { const x = 1; function f() { const x = 2; return x; } }", "f", {}, "shadowing"],
	["function m() { let t = 0; function f() { t = 1; } }", "f", { t: "m" }, "assignment to an outer let is a dep"],
	["function m() { const c = 1; function f(a) { return a.b(c); } }", "f", { c: "m" }, "call argument counts"],
	["function m() { const T = 5; function f(a = T) { return a; } }", "f", { T: "m" }, "default parameter value"],
	["function m() { const T = 5; function f({ a = T } = {}) { return a; } }", "f", { T: "m" }, "nested destructuring default"],
];

let failed = 0;
if (!IS_CLI) failed = 0;
for (const [src, fn, expected, why] of CASES) {
	const a = analyse(src);
	const got = Object.fromEntries([...(a.freeIn(fn) ?? new Map())].filter(([n]) => n !== "undefined"));
	const ok = JSON.stringify(got) === JSON.stringify(expected);
	if (!ok) {
		failed++;
		console.log(`  FAIL ${why}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
	}
}
if (IS_CLI) console.log(failed ? `SELF-TEST: ${failed} failure(s)` : `SELF-TEST: ${CASES.length} cases pass`);

if (IS_CLI && process.argv[2] === "--self-test") process.exit(failed ? 1 : 0);

if (IS_CLI) {
	// --- report ----------------------------------------------------------------------------------------------
	const file = process.argv[2];
	const names = process.argv.slice(3);
	if (!file) process.exit(0);
	const code = readFileSync(file, "utf8");
	const a = analyse(code);
	for (const name of names) {
		const free = a.freeIn(name);
		if (!free) {
			console.log(`${name}: not found`);
			continue;
		}
		const byOwner = new Map();
		for (const [n, owner] of free) byOwner.set(owner, [...(byOwner.get(owner) ?? []), n]);
		console.log(`${name} needs ${free.size} outer names:`);
		for (const [owner, list] of [...byOwner].sort()) console.log(`    from ${owner}: ${list.sort().join(", ")}`);
	}

}
