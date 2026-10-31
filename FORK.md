# This fork

Public fork of [anh-chu/pi-hindsight](https://github.com/anh-chu/pi-hindsight).
The fork is based on upstream `1.5.2`; it can track upstream and send pull
requests from here. A fresh clone has only `origin` — add the upstream remote
when you want to sync:

```bash
git remote add upstream https://github.com/anh-chu/pi-hindsight
```

## What it changes

One memory bank per project **per machine**:

```
project-<namespace>-<slug>      e.g.  project-alexchenhplaptop-pi
```

The slug is the git repository's folder name when the cwd is inside git, so a
worktree and every subdirectory share the repository's bank. Outside git it is
the current directory's basename. Either way it is lowercased, reduced to
`[a-z0-9-]`, and truncated to 32 characters (`/home/alex/.pi` → `pi`,
`~/Projects/Aperture4` → `aperture4`, the home directory itself → `home`).
The namespace is `bank_namespace`, sanitized the same way.

Upstream 1.5.2 introduced the same repository/worktree-aware naming. This fork
keeps it and adds the namespace, so several machines can share one Hindsight
server without `project-pi` on the laptop and `project-pi` on the workstation
being the *same bank*. Without the namespace, both write into one bank, neither
can tell which facts came from where, and memory from one machine's checkout
surfaces while you work in another's.

So the requirement this fork exists to satisfy:

> A project's bank id includes the machine namespace, so every Pi session in
> that directory on that machine reaches the same bank, and another machine's
> bank never collides with it.

This is **id collision isolation, not access isolation**. Hindsight has no
per-bank ACL: anyone with the server URL and API key can list, read, and write
every bank on that server. If machines must be truly unable to read each
other's banks, run separate servers, or use a tenant/auth setup that maps each
machine to its own isolated tenant. `bank_namespace` alone does not do that.

The mapping is also not one-to-one in every case: two different non-git
directories with the same basename on one machine share a bank. Long names are
truncated to 32 characters, so very long names can also collide. Inside git,
worktrees and subdirectories of the same repository intentionally share the
repository's bank; the old folder-name bank for this config
(`project-<folder>` or `project-<namespace>-<folder>`) is still read for recall
so old memories remain reachable.

Everything else in this fork is optional; see [the end](#optional-session-scoped-banks).

## Configure

`~/.hindsight/config`:

```toml
api_url        = "http://localhost:8888"
bank_scope     = "project"
bank_namespace = "alexchenhplaptop"
retain_enabled = true
recall_enabled = true
```

`8888` is the upstream default API port. `api_url` above is an example; use
your server's address.

`bank_namespace` is the key this fork adds, and setting it is **not** optional:
`getProjectBank()` keeps the unnamespaced `project-<slug>` name when the key is
absent, so a missing namespace silently reintroduces the collision. Use a
stable machine name, not a DHCP hostname. Session banks fall back to the
hostname; project banks never do.

The bank id then resolves to `project-<namespace>-<slug>`:

| cwd | bank |
| --- | --- |
| `/home/alex/.pi` | `project-alexchenhplaptop-pi` |
| `~/Projects/Aperture4` | `project-alexchenhplaptop-aperture4` |

`/hindsight status` prints the scope and resolved bank; in session scope it
also prints the session id and the project bank that session scope does not
write to.

### Migrating from upstream

An existing upstream `project-<slug>` bank is not renamed and is not read by a
namespaced config. If it holds something worth keeping, read it deliberately
with `hindsight_recall`'s `bank` argument first, then delete it with the
Hindsight API (`DELETE /v1/default/banks/<bank_id>`) or another client. This
extension has no command for deleting project banks; `/hindsight prune` only
touches `sess-` banks.

Old fork banks created under a folder name (`project-<folder>`, or
`project-<namespace>-<folder>` when namespaced, in a subdirectory or worktree)
are recall-only through the legacy fallback; new retains go to the repository
bank (`project-<repo>` or `project-<namespace>-<repo>`).

`project_bank_id` still works and pins one flat bank per machine for every
project in project scope. In session scope it becomes the session-bank root
(`sess-<project_bank_id>-<tail>`). That was the pre-namespace workaround;
prefer `bank_namespace` unless you actually want all projects on a machine in
one vault.

## Optional: session-scoped banks

`bank_scope = "session"` gives every Pi session its own bank,
`sess-<namespace>-<project>-<session-tail>`, so concurrent sessions in one
directory cannot recall each other's turns. It came in with the namespace
change and is fully independent of it.

It is **not** the recommended mode. Nothing promotes a session bank into the
project bank, so recall sees only the current session (plus a configured
`global_bank`), and the memory is gone once that session is not resumed —
after which `/hindsight prune` can delete the only copy. Resuming the same
session keeps its id and bank, but that is still session-scoped memory, not
project memory. Use it only when you want scratch memory that must not outlive
the session.

The session bank is created by the first retain. Before that, auto-recall
finds no bank; when no global bank answers, it retries on later runs instead of
reporting a recall failure. The `sess-` prefix, `session_bank_ttl_days`, and
`/hindsight prune [days] [--yes]` all exist for that mode.

## Fork additions

This fork includes upstream 1.5.2's API-key isolation, OS-keyring lookup,
repository/worktree-aware project naming with legacy-bank recall, and the
`PI_SUBAGENT_CHILD` guard. The fork-specific parts are:

- Namespaced project banks (`bank_namespace`).
- Session-scoped banks (`bank_scope = "session"`) and the `sess-` prefix.
- `HINDSIGHT_BANK_SCOPE` / `HINDSIGHT_BANK_NAMESPACE` environment overrides.
  `HINDSIGHT_BANK_ID` / `HINDSIGHT_SCOPING` already existed upstream and are
  omp-compatible.
- `hindsight_recall` accepts an optional `bank` argument to read a bank outside
  the current recall set.
- `/hindsight prune`. `/hindsight status` and `/hindsight doctor` already
  existed upstream.

Sync when upstream moves again (expect conflicts in the bank-resolution code):

```bash
git remote add upstream https://github.com/anh-chu/pi-hindsight  # once per clone
git fetch upstream
git merge upstream/main
npm ci && npm run build
```

## Install on a machine

```bash
pi remove <whatever source `pi list` shows>   # avoid two copies loading and double-retaining
pi install git:github.com/fizban007/pi-hindsight
```

Pi clones the repo into its managed directory and installs dependencies; the
host-provided packages come from Pi itself. No build step, no checkout to
maintain.

This tracks the fork's `main` and reconciles on `pi update --extensions`. To pin:

```bash
pi install git:github.com/fizban007/pi-hindsight@<commit-or-tag>
```

Then write the config above, giving **each machine its own `bank_namespace`**.
That is the point: same `api_url` everywhere, different namespace per host.

**Caveat:** a git install runs the `index.js` committed in the repo — Pi does
not build it. Always `npm run build` before pushing (see below). Uncommitted
documentation and code changes in a local checkout are not shipped by a push
or a fresh clone.

## Develop on this fork

Use a local checkout on the machine where you edit; local packages are not
copied, so a rebuild is picked up immediately.

```bash
git clone https://github.com/fizban007/pi-hindsight.git ~/Projects/pi-hindsight
cd ~/Projects/pi-hindsight && npm ci
npm run build

pi remove <whatever source `pi list` shows>   # avoid double-loading
pi install ~/Projects/pi-hindsight
```

`index.js` is committed because git installs have no build step. The loop is:

```bash
npm run build && git add index.js && git commit -m "..." && git push
```

Tests: `npm test` (lifecycle + bank resolution) and `npx vitest run` (mission setup and mission hook). `npm run test:mission` runs only the mission-setup suite.

## Housekeeping

- `/hindsight status` shows the current scope and bank; in session scope it also shows the session id and the project bank.
- `/hindsight prune 30` previews session banks idle for 30+ days; add `--yes` to delete. It only ever touches the `sess-` prefix.
- `bank_scope = "session"` is the only mode that creates session banks at all.
