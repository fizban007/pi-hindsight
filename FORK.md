# This fork

Public fork of [anh-chu/pi-hindsight](https://github.com/anh-chu/pi-hindsight).
It adds session-scoped memory banks: with `bank_scope = "session"` every Pi
session gets its own bank, so concurrent sessions can never recall each
other's turns. See the main README for the full behavior.

`upstream` points at the original, so this fork can track it and send pull
requests from here.

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

Then in `~/.hindsight/config`:

```toml
api_url        = "http://your-hindsight:8585"
bank_scope     = "session"
recall_enabled = true
retain_enabled = true
```

`bank_namespace` defaults to the hostname, which is what stops two machines
that share one Hindsight server from deriving the same bank id for the same
session. Set it explicitly if the hostname is unstable:

```toml
bank_namespace = "laptop"
```

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
this fork — same as any other GitHub fork.

## Housekeeping

- `/hindsight status` shows the current scope, session id, and bank.
- `/hindsight prune 30` previews session banks idle for 30+ days; add `--yes` to delete.
- `hindsight_recall` accepts a `bank` argument to read a project/global bank deliberately.
- `bank_scope = "project"` (the default) keeps upstream's one-bank-per-directory behavior byte-for-byte.
