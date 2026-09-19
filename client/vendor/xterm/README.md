# client/vendor/xterm/

Vendored copies of the xterm.js engine the terminal strip runs on. Taken **unmodified** from the
`@xterm/*` packages that pi-web-ui itself already ships, so a plugin install does not add a second,
independent copy of that code to trust — and so the bundle stays reproducible offline (a CDN import
would also miss the plugin's static route and come back as the SPA fallback HTML).

| file           | upstream package | version | sha256                                                           |
| -------------- | ---------------- | ------- | ---------------------------------------------------------------- |
| `xterm.mjs`    | `@xterm/xterm`   | 6.0.0   | `b336ec65a086c056d4804b3d4c2347da5663d3f23c3f25be866467bd8857ad59` |
| `xterm.css`    | `@xterm/xterm`   | 6.0.0   | `854a7c0fb70e8b1a083c16797ab827299fb18744f5ad34f227b48337e33293c6` |
| `addon-fit.mjs` | `@xterm/addon-fit` | 0.11.0 | `2d87e1bddc73be9111de8beee5370c3bb7aac9c94e18e6f245f02ca741ef1769` |

Verified byte-identical to the copies at
`<pi-web-ui>/node_modules/@xterm/xterm/lib/xterm.mjs`, `…/css/xterm.css` and
`<pi-web-ui>/node_modules/@xterm/addon-fit/lib/addon-fit.mjs`:

```bash
HOST=$(npm root -g)/pi-web-ui/node_modules/@xterm
sha256sum "$HOST/xterm/lib/xterm.mjs" client/vendor/xterm/xterm.mjs
sha256sum "$HOST/xterm/css/xterm.css" client/vendor/xterm/xterm.css
sha256sum "$HOST/addon-fit/lib/addon-fit.mjs" client/vendor/xterm/addon-fit.mjs
```

Upgrading means re-copying those three files from the host (or from the npm package) and refreshing the
hashes above — the MIT license text travels inside each file, so no extra license copy is needed.

`addon-fit.mjs` carries a `sourceMappingURL` comment pointing at a `.map` that is not vendored; the
browser only fetches maps with devtools open, and the miss is harmless.