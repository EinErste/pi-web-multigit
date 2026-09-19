# multi-git — pi-web-ui UI plugin

A **read-only** overview of every Git repository in a workspace made of several independent
repositories. The host's built-in source-control pane runs git in exactly one directory — the active
conversation cwd — so a workspace root has no `.git` and permanently reports *"Current directory is
not a Git repository"*. This plugin discovers every repository below the workspace root and shows them
in one view: branch, upstream ahead/behind, staged / modified / untracked counts, the last commit,
per-file diffs, history, branches, stashes, a timeline and cross-repo search.

Every git query is read-only. Three things deliberately write: the optional **terminal strip** (exactly
the command you type, in the selected repo), **Pull** (fetch + fast-forward only) and **Rollback** (one
file's local changes).

## Install

pi-web-ui plugins are distributed as GitHub repositories, not as npm packages — the plugin catalogue
only stores sources. Install, update and remove this one with the CLI, or from **⚙ Settings → UI
plugins → plugin market → 添加插件** by pasting `EinErste/pi-web-multigit`:

```bash
pi-web-ui install EinErste/pi-web-multigit             # latest main
pi-web-ui install EinErste/pi-web-multigit#v0.13.2     # pin a tag (any branch/tag works)
pi-web-ui install EinErste/pi-web-multigit --force     # update in place
pi-web-ui uninstall pi-web-multigit
```

Refresh the browser tab afterwards — no server restart is needed. The install lands in
`<dataDir>/plugins/pi-web-multigit/` (`dataDir` defaults to `~/.pi-web/`), and a directory copied in by
hand works just as well.

**Updates** preserve `config.json` only — local UI state lives in `storage.json` (pane widths, folded
segments, favourites, pivot) and the consent marker in `.pi-approved`, so back both up before a forced
reinstall. `pi-web-ui plugins --rollback pi-web-multigit` restores the newest pre-upgrade snapshot.

**Requirements:** `git` on `PATH`, plus `node-pty`, which the host already ships (the terminal borrows
the host's copy rather than vendoring one). Activation needs a host whose plugin API is `apiVersion: 2`
— an older host refuses the plugin instead of half-loading it. Installs are refused on managed
instances (`PI_WEB_MANAGED=1`), where plugins are the deployer's responsibility.

## Where it shows up

| Entry point                      | What it does                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------- |
| 🧩 **Multi-repo Git** tab        | The three-pane view (repositories → tabbed middle pane → revision viewer), `plugin:multi-git`. |
| 🌿 **Workspace** tab             | Branches across repositories: unpushed commits, tickets spanning services, cleanup candidates. |
| 🌿 **All repos** in the git pane | Shortcut in the built-in SCM toolbar that switches to the tab above.         |
| ⚙ Settings → UI plugins          | The six settings below (schema-declared, no code needed).                    |

## Layout

```
┌ ~/work/acme     [search all repos… (Enter)] [.*] [Search]        [⟳]       ┐
├ Repositories ──┬ Changes │ History │ Branches │ Stashes │ Timeline [Term] ┬ Diff ─┤
│ ● web-app  ↑1 │ (tab content…)                                        │ …    │
│                │ ┌─ terminal · web-app ───────────────┐                │       │
│                │ │ $ git status --short               │                │       │
│                │ └────────────────────────────────────┘                │       │
└────────────────┴───────────────────────────────────────────────────────┴───────┘
        ↕  drag the two thin dividers between the panes to resize
```

The middle pane's tabs switch what it lists; the Diff pane on the right explains whatever row is picked
anywhere in the view.

## What it shows

**Repositories** — every repo with ahead/behind, change counts, last commit, a `cwd` badge for the repo
the agent is actually working in, and state chips (`merging` / `rebasing` / `cherry-picking` /
`reverting` / `bisecting`, `index.lock`, worktrees, submodules). A **health strip** counts what needs a
human (`dirty`, `conflicted`, `behind`, `ahead`, `mid-op`, `index.lock`, `git error`) and filters the
list on click.

**Changes** — files with their `XY` codes and `+add`/`-del` counts; untracked files show the head of the
file instead of a diff. Each row offers **History** and **Rollback** — tracked files restored from
HEAD, untracked ones deleted after an armed confirmation.

**Diff viewer** (right pane) — patches are parsed into files and hunks rather than printed raw: a commit
card (subject, author, date, counts), a clickable file index with status badges and per-file counts,
then one section per file with a sticky header, rename/mode notes and a line-number gutter. `Wrap`,
`copy path`, `Ignore ws`, context size (`-U0/-U1/-U3/-U10`), hunk jumping and `Copy patch`.

**History** — repo-wide `git log --all --graph` (60 commits), file history via `--follow`, or branch
history; clicking a commit shows its patch, or the file as of that commit in file scope.

**Branches** — current branch vs upstream with the exact unpushed and incoming commits (clickable), then
all local and remote branches sorted by last commit with ahead/behind and a "merged — safe to delete"
tag.

**Stashes** — `git stash list`; click one for its patch.

**Timeline** — the last 7 days of commits across all repositories (30 per repo, 200 total), clickable to
their patches, with window (1/7/30/90 days), author and path filters.

**Workspace** — three aggregated answers: **Unpushed** (every unpushed commit, grouped by repo — the
pre-release checklist), **Branches across repositories** (the same branch in several services is one
group) and **Cleanup candidates** (merged, stale or upstream gone). Grouping is explicit and visible: by
default a group is the full branch name; an optional regular expression groups by its first capture
group instead (`([0-9a-z]{8,12})__` turns `feat/ab12cd34__add-thing` into `ab12cd34`, `[A-Z]+-\d+`
groups by ticket key). Unmatched branches keep their full name and are counted in a note, and a repo's
own default branch is never grouped. Set plugin-wide in settings, overridable per workspace in the view
(`↺` clears the override).

**Search** — `git grep` across every repository, case-insensitive, literal by default with a `.*` regex
toggle; hits are grouped by repo and clicking one shows the file at HEAD with matching lines
highlighted. Modes: Content / File names / Pickaxe (`git log -S`).

**Blame / Compare** — `Blame` on any file view attributes each line to a clickable commit, with a "who
wrote this file" summary; `Compare` on a branch shows `current...branch`, ahead/behind, per-file stats
and the merge-base patch.

**Collapsible segments** — every group is a foldable segment with a count and a one-line explanation.
Nested groups open folded, so the tab reads as an index of branches, ticket keys and repositories instead
of a wall of rows, and the folded set persists across reloads.

**Header** — search mode, a repo name filter, sort (name / dirty first / recent commit / ahead-behind),
grouping (none / service prefix / branch), Refresh, the auto-refresh interval and a persisted "Only
dirty" toggle.

**Fetch / Pull** — `Fetch` runs `git fetch --all --prune` in every repo (remote refs only, never the work
tree). `Pull` fetches and then fast-forwards (`--ff-only` — never a merge commit, never a rebase,
whatever `pull.rebase` says). Repos mid-merge/rebase or holding `index.lock` are skipped, diverged
branches are reported and left alone, and every result is listed (`updated` / `up-to-date` / `diverged`
/ `skipped` / `blocked`). Both are two-click confirmed and followed by a rescan.

**Terminal** — the **Terminal** button under the middle pane's tabs toggles a real PTY shell at the
bottom of that pane (visibility persists). It uses the host's own `node-pty` and the same shell the
host's Terminal tab uses, cwd = the selected repo: `vim` / `top` / `ssh` and REPLs work, Ctrl+C works,
`TERM=xterm-256color`. One shell at a time, killed on hide / repo switch / deactivate; output is capped
at 200KB per flush and 64KB per input message. The shell belongs to the client that opened it: another
client (a second tab, or whoever else the server admits) cannot type into it, and only re-opening it —
a visible takeover that kills the previous shell — changes owner. A shell that cannot start says why in
the strip instead of leaving an empty pane, and is retried at most once per ~20s.

**Panes and keys** — the two dividers are drag handles (double-click resets, arrow keys move them); repos
and diff stay pixel-fixed while the middle pane absorbs the remainder. Widths persist across sessions.
`↑`/`↓` walk the repository list and `r` rescans. Every list marks the row the Diff pane is showing, so
it always says what it is looking at.

## Settings (⚙ Settings → UI plugins → Multi-repo Git)

| Key                   | Default | Meaning                                                                             |
| --------------------- | ------- | ----------------------------------------------------------------------------------- |
| `depth`               | 2       | How many levels below the root to search for `.git`. 1 = direct subdirectories only. |
| `maxRepos`            | 40      | Stop after this many repositories (the footer says when the scan was truncated).     |
| `ignore`              | —       | Extra directory names to skip, on top of `node_modules`, `target`, `dist`, …         |
| `autoRefreshSec`      | 15      | Periodic rescan; 0 = off.                                                           |
| `branchGroupPattern`  | —       | Workspace tab: regex whose first capture group groups branches across repositories. Empty = group by the full branch name (recommended). Overridable per workspace in the view. |
| `hideClean`           | false   | Start with the "Only dirty" filter applied.                                          |

The scan root is always the **project directory**, and scanning never walks upward: a workspace root
(`~/work/acme`) gives you every repository below it, and a single repository (`~/work/acme/web-app`)
gives you exactly that one — which the built-in pane already shows. There is deliberately no way to bolt
additional roots on.

## How it works

- **Server** (`index.mjs`) scans the project directory (`host.cwd`) depth-first for directories containing
  `.git` (a `.git` **file** counts too — worktrees and submodules), then runs the status / last-commit /
  worktree / submodule queries per repo with bounded concurrency (6 at a time). Diffs, history, search,
  branches, stashes, the timeline and the PTY bridge are answered on demand, each reply addressed to the
  requesting client by `reqId`. The work is split by concern: `server/git.mjs` (argv-only git + path
  containment), `server/parsers.mjs` (git output → data), `server/repos.mjs` (one repo's summary),
  `server/actions/*.mjs` (one module per action family) and `server/regex-match.mjs` (the file-name regex
  worker).
- **Client** (`client/entry.mjs`) is plain DOM — no framework, no build step — and talks to the server
  only through `ctx.send` / `ctx.onData`; the host action bridge is used for the one thing it cannot do
  itself, `setView("plugin:multi-git")` from the SCM toolbar. It imports nothing from outside `client/`,
  because such a request misses the plugin's static route and comes back as the SPA fallback HTML (blank
  tab). The xterm engine is vendored under `client/vendor/xterm/`; `sdk/` is for the server entry only.
- **Safety** — git runs as `execFile("git", [...args])`, an argv array and never a shell, and every
  repo/path coming from the client is validated against the repositories found by the last scan, so
  unknown repositories and path escapes are refused (`ok: false`) instead of thrown. Containment is
  realpath-based, so a symlink inside a repository that points out of it is refused too — a lexical
  check alone would have previewed that outside file. Rollback acts on one file: a path matching several
  entries (a directory, a glob) is refused rather than reverted wholesale. The terminal is the one
  deliberate write-side hole.

### Declared capabilities

`permissions: ["ui"]` — only the UI message channel, settings and plugin storage come from the host;
discovery and git execution happen in this plugin's own server-side code, which the plugin system
documents as trusted Node code (the capability gate covers host-provided APIs, not
`node:child_process`). The gated alternative, `host.bash` (`tools`), splits its command on whitespace
and refuses cwds outside the workspace — useless as soon as the agent's cwd is one of the listed
repositories.

## Develop (local edits)

Loaded from `<dataDir>/plugins/pi-web-multigit/` (dataDir defaults to `~/.pi-web`).

```bash
pi-web-ui plugins                             # should list pi-web-multigit (Multi-repo Git)
pi-web-ui install . --name pi-web-multigit    # re-install this working copy (local path form)
pi-web-ui plugin upgrade-sdk pi-web-multigit  # refresh the vendored sdk/ copy
```

The host serves the client bundle from disk on every request (`Cache-Control: no-cache`), so **client
edits apply on the next browser refresh**. `index.mjs` is imported once per process and never
re-imported when the file changes:

| You changed                           | What to do                                   |
| ------------------------------------- | -------------------------------------------- |
| `client/entry.mjs` (view, CSS, xterm) | refresh the browser tab (⌘/Ctrl-R)            |
| `index.mjs`, `manifest.json`, `sdk/`  | restart pi-web-ui — then refresh the tab      |

Skipping that restart gives a **mixed install**: the browser runs the new view while the process still
answers with the old server half (`Unknown request: multi-git:term-open` for whatever action you just
added). There is no reload button in the settings panel — the frontend only sends `plugins_reload` after
a terminal command that looks like a plugin install (`pi-web-ui install …` / `npm i -g …`), which also
bumps the `epoch` in the bundle URL so the bundle is re-imported. `plugins_reload` is a plain WebSocket
message (`{"type":"plugins_reload"}`) if you want to script it. The first activation shows a one-time
consent notice listing the declared capability.

## Tests

Three self-contained harnesses in `tests/`, no framework and no build step. They derive their files and
search needles from the workspace you point them at, so they pass on any checkout (a fixture that is not
there says *skipped* instead of asserting on an impossible view). One check — the client suite's
module-dependency walk — uses `tools/scope-free.mjs`, which needs `@babel/parser` resolvable from that
file, `npm i -D @babel/parser`; without it that check prints *skipped* and the rest still runs.)
Pass the workspace to inspect (the default is the current directory, which scans almost nothing from
inside the plugin dir):

```bash
node tests/server.test.mjs /path/to/workspace  # scan, stats/diff/log/commit, failure paths, write actions
node tests/client.test.mjs /path/to/workspace  # the view, driven through a DOM stub
node tests/host-loader.test.mjs                # real PluginManager — run it *from* the workspace (it scans cwd)
npm test -- /path/to/workspace                 # all three (also: WORKSPACE=… npm test)
```

- **`server.test.mjs`** activates the plugin with `createMockHost` from the vendored `sdk/` copy and runs
  real git against the workspace: scan, detail queries, search guards, branches, sync, stashes, timeline,
  the workspace views (blame, compare, file/pickaxe search modes), a project switch mid-scan, rollback
  and pull against a throwaway bare origin plus two clones, and the PTY bridge against a **real**
  `node-pty` shell.
- **`client.test.mjs`** drives `mount()` through a ~60-line DOM stub: scan → select repo → stats → file →
  diff → history → commit patch → prefs → cleanup, plus the Branches/Stashes/Timeline tabs, splitters, the
  Term toggle through an injected fake xterm (a successful `term-open` is never followed by a
  `term-close`; a failing open is throttled to one automatic attempt per 20s), health chips, filter,
  grouping (through the pure `groupBranches` helper), Fetch and the `-w` round trip.
- **`host-loader.test.mjs`** copies the plugin into a throwaway data dir and loads it through pi-web-ui's
  own `PluginManager`: zero diagnostics, the merged `scm.toolbar` contribution, the settings schema,
  message routing over a captured socket and client-bundle resolution (including a refused traversal).
  It finds the installed package in the usual global locations; override with `PI_WEB_PKG=/path/to/pi-web-ui`.

The suites also build their own throwaway fixture repository (bare origin + clone, a `release/<date>`
branch with a cherry-pick, a tag, a modified/staged/untracked work tree), because a diff test that
silently asserts nothing is worse than no test. Steps that need a tracked change in *your* workspace say
"skipped" out loud instead of asserting on an impossible view.

## Known limitations

- Read-only by design: no stage / unstage / commit / push and no branch operations. The three deliberate
  exceptions are listed at the top.
- Discovery is directory-based: a `.git` deeper than `depth` levels is not found (raise `depth`), the scan
  stops at `maxRepos` repositories and 4000 visited directories, and the footer reports `scan truncated`.
- The middle pane's `+add`/`-del` numbers refresh when a repository is selected, not on the auto-refresh
  cycle (status counts always do).
- Search stops at 500 total hits / 200 per repo / 50 per file and truncates lines to 400 chars; the
  timeline window is fixed at 7 days / 30 commits per repo / 200 total. Regex *file-name* search runs in a
  worker thread with a 3-second deadline (`server/regex-match.mjs`): a pattern that exceeds it is
  reported as an error instead of stalling the host, and the worker is discarded. Literal (default)
  matching is linear and stays on the server thread.
- Ahead/behind *vs upstream* comes from `git branch -vv`, so it is only as fresh as the last fetch —
  this plugin never fetches by itself. `Pickaxe` walks every blob in every repository's history: expect
  seconds, not milliseconds.
- The Workspace tab collects at most 40 branches per repo and unpushed commits for at most 5
  ahead-branches per repo (20 commits each).
- `Fetch` needs working credentials for each remote; a repo that cannot authenticate is reported and
  otherwise left alone. `Pull` never merges or rebases, so a diverged branch needs handling by hand, and
  `Rollback` deletes untracked files irreversibly after the armed confirmation.
- Exactly one terminal exists at a time and it exits when the plugin does. Windows-only quirk: `node-pty`'s
  ConPTY agent sometimes prints a cosmetic `AttachConsole failed` on shell teardown — the host's own
  terminal does the same.
- Pane widths and terminal visibility are per-plugin preferences (in `<pluginDir>/storage.json`), not
  per-project.