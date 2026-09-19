# tools/

Verification tools shared by both plugins. **Not** part of any plugin's runtime — the host serves
`/plugins/<id>/client/*` per plugin, so nothing here is shipped or imported by a plugin at load time. The test
suites import `scope-free.mjs` directly, which is the point.

## What lives here

| file | what it does |
|---|---|
| `scope-free.mjs` | Scope-aware reference analyzer. Parses a module with `@babel/parser`, builds the scope chain, and answers *where does this name resolve?* — used both by the split tooling and by the suites. Has a self-test (`node scope-free.mjs --self-test`, 13 cases) because a subtly wrong resolver produces code that looks fine and fails at runtime. Needs `@babel/parser` in a `node_modules` above this file (`npm i -D @babel/parser`); the suites print *skipped* for the check that uses it when it is absent. |
| `module-deps-check.mjs` | Reports identifiers a module references but never receives: not declared, not imported, not a global. `node module-deps-check.mjs <file.mjs> …` |

The suites run the dependency check themselves — see `9. module dependencies (N modules)` in each
`tests/client.test.mjs`. It walks `client/` and `server/`, asserts that every name resolves, and asserts that no
module imports the entry back. That check found `renderFoot` (referenced by the pane factory and never passed),
and would have caught `REQUEST_TIMEOUT_MS`, `detailHead` and `TAB_DEFS` before their failures.

## What is deliberately *not* here

The one-shot splitters that performed the refactor (`split.mjs`, `split-client.mjs`, `extract-actions.mjs` and the
JSON specs) are **not kept**. They moved ~6,000 lines once, by walking a spec of module names, and they are the
wrong tool for maintenance: they encode a migration, not a rule. What they learned is preserved in the code they
produced and in the checks above:

- babel attaches the *previous* statement's trailing `// comment` as a leading comment of the next one, so a
  doc-comment walk widens ranges and duplicates declarations;
- `for (const [k, v] of …)` patterns and parameter *defaults* must be walked, or names look undeclared;
- a `switch` has `cases`, not `body` — a naive walk pushes the node into itself forever;
- arrow consts have no scope name, so their inner references are attributed to the enclosing function;
- `[...x]` is a spread, not a property access — a lookbehind cannot tell them apart;
- `let` values read by two concerns must become boxes (`{ value }`), because a destructured copy leaves one
  holder writing to a value nobody reads.

## Reusing the analyzer

```js
import { analyse } from "./scope-free.mjs";
const a = analyse(code);
a.freeIn("renderDetail");   // Map(name → the function it resolves in)
a.writesOut("fitTerm");     // names this function assigns that are declared outside it
a.resolve("state", scope);  // the scope that declares a name, or null
```

`writesOut` is how the refactor found the shared state that needed boxing; `freeIn` is how each factory header was
generated instead of guessed.
