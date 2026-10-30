# This fork

Public fork of [anh-chu/pi-hindsight](https://github.com/anh-chu/pi-hindsight).
`upstream` points at the original, so this fork can track it and send pull
requests from here.

## What it changes

One memory bank per project **per machine**:

```
project-<namespace>-<slug>      e.g.  project-alexchenhplaptop-pi
```

The slug is the directory name, lowercased and reduced to `[a-z0-9-]`
(`/home/alex/.pi` → `pi`, `~/Projects/Aperture4` → `aperture4`). The namespace
is `bank_namespace`, sanitized the same way.

Upstream names a project bank `project-<dirname>`. That is right for one
machine and wrong for us: several machines share one Hindsight server, so
`project-pi` on the laptop and `project-pi` on the workstation are the *same
bank*. Both write into it, neither can tell which facts came from where, and
memory from one machine's checkout surfaces while you work in another's.

So the requirement this fork exists to satisfy:

> Every project gets exactly one bank per machine, shared by every Pi session on
> that machine, and unreadable and unwritable from any other machine.

Everything else in this fork is optional; see [the end](#optional-session-scoped-banks).

## Configure

`~/.hindsight/config`:

```toml
api_url        = "http://your-hindsight:8585"
bank_scope     = "project"            # one bank per project, shared by all sessions
bank_namespace = "alexchenhplaptop"   # ...but never shared across machines
retain_enabled = true
recall_enabled = true
```

`bank_namespace` is the key this fork adds, and setting it is **not** optional:
`getProjectBank()` keeps the legacy `project-<slug>` name when the key is
absent, deliberately byte-identical to upstream, so a missing namespace
silently reintroduces the collision. Use a stable machine name, not a DHCP
hostname. (Session banks fall back to the hostname; project banks never do.)

The bank id then resolves to `project-<namespace>-<slug>`:

| cwd | bank |
| --- | --- |
| `/home/alex/.pi` | `project-alexchenhplaptop-pi` |
| `~/Projects/Aperture4` | `project-alexchenhplaptop-aperture4` |

`/hindsight status` prints the scope, the session id, and the resolved bank.

### Migrating from upstream

Namespaced banks start empty — an existing `project-<slug>` bank is not renamed
and is not read. If it holds something worth keeping, read it deliberately with
`hindsight_recall`'s `bank` argument first, then delete it.

`project_bank_id` still works and pins one flat bank per machine for every
project. That was the pre-namespace workaround; prefer `bank_namespace` unless
you actually want all projects on a machine in one vault.

## Optional: session-scoped banks

`bank_scope = "session"` gives every Pi session its own bank,
`sess-<host>-<project>-<session-tail>`, so concurrent sessions in one directory
can never recall each other's turns. It came in with the namespace change and
is fully independent of it.

It is **not** the recommended mode. Nothing promotes a session bank into the
project bank, so recall sees only the current session and memory does not
survive the session at all — after which `/hindsight prune` deletes the only
copy. Use it only when you want scratch memory that must not outlive the
session. The `sess-` prefix, `session_bank_ttl_days`, and
`/hindsight prune [days] [--yes]` all exist for that mode.

## Other additions over upstream

- `HINDSIGHT_BANK_ID` / `HINDSIGHT_BANK_SCOPE` / `HINDSIGHT_BANK_NAMESPACE` /
  `HINDSIGHT_SCOPING` environment overrides — same names `omp` reads, so a
  launcher can steer both implementations the same way.
- `hindsight_recall` accepts an optional `bank` argument to read a bank outside
  the current recall set.
- `/hindsight prune` and `/hindsight status`.

## Install on a machine

```bash
pi remove npm:pi-hindsight          # otherwise two copies load and double-retain
pi install git:github.com/fizban007/pi-hindsight
```

Pi clones the repo into its managed directory and installs dependencies; the
host-provided packages come from Pi itself. No build step, no checkout to
maintain.

This tracks `main` and reconciles on `pi update --extensions`. To pin:

```bash
pi install git:github.com/fizban007/pi-hindsight@<commit-or-tag>
```

Then write the config above, giving **each machine its own `bank_namespace`**.
That is the whole point: same `api_url` everywhere, different namespace per
host.

**Caveat:** a git install runs the `index.js` committed in the repo — Pi does
not build it. Always `npm run build` before pushing (see below).

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

Tests: `npm test` (lifecycle + bank resolution) and `npx vitest run` (mission setup).

## Sync with upstream

```bash
git fetch upstream
git merge upstream/main
npm ci && npm run build
```

To offer a change upstream, push a branch here and open the pull request from
this fork — same as any other GitHub fork. The namespace change is the obvious
candidate: per-machine project banks are useful to anyone sharing one server.

## Housekeeping

- `/hindsight status` shows the current scope, session id, and bank.
- `/hindsight prune 30` previews session banks idle for 30+ days; add `--yes` to
  delete. It only ever touches the `sess-` prefix.
- `bank_scope = "session"` is the only mode that creates session banks at all.
