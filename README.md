# slyci

Self-hosted GitHub Actions alternative. Runs your existing `.github/workflows/*.yml`
files **natively on your own machine** — no Docker, no hosted minutes, no queue.

Built the same way the open-source runners are built:

| Project | Recipe |
|---|---|
| gitea `act_runner` | polls the server for queued jobs, executes them locally |
| woodpecker agent | small daemon pulls pipeline YAML, runs steps, reports back |
| nektos/act | parses workflow YAML → plans jobs by `needs` → executes steps |

slyci does the same loop: **poll → fetch → parse YAML → run steps → post commit status**.
The green check / red X shows up on your commits on github.com just like hosted Actions,
under the `slyci` status context.

## Why

- Hosted Actions minutes run out (macOS runners burn minutes at 10x).
- The Mac on your desk is faster than a shared runner and already has Xcode,
  node, python, and your signing setup on it.
- Workflows stay in GitHub Actions syntax, so nothing needs rewriting if you
  ever move back.

## Install

```bash
git clone https://github.com/AssiamahS/githubactions.git ~/githubactions
cd ~/githubactions && npm install && npm link
```

Needs: node 18+, git, and `gh` logged in (`gh auth login`) for private repos
and commit statuses.

## Use

```bash
slyci add AssiamahS/myapp            # watch main
slyci add AssiamahS/myapp release    # or another branch
slyci daemon                         # poll loop in foreground
slyci install-daemon                 # or: launchd agent, survives reboot
```

Every new push to a watched branch gets fetched (shallow), its workflows run,
and a `slyci` commit status posted (pending → success/failure).

Other commands:

```bash
slyci run [dir]           # run a local checkout's workflows right now (CI dry-run)
slyci trigger owner/repo  # force fetch+run of a watched repo immediately
slyci list                # watched repos + last built sha
slyci logs                # recent run logs (~/.slyci/logs/)
```

## Workflow support

A practical subset of GitHub Actions syntax:

- triggers: `on: push`, `on: workflow_dispatch` (via `slyci trigger`)
- `jobs`, `needs` (topological order, failed needs skip dependents)
- steps: `run`, `name`, `env`, `working-directory`, `continue-on-error`,
  `timeout-minutes` (default 30 min per step)
- expressions: `${{ env.X }}`, `${{ secrets.X }}`, `${{ github.sha }}`,
  `${{ github.ref }}`, `${{ github.repository }}`
- env vars set for every step: `CI`, `GITHUB_SHA`, `GITHUB_REF`,
  `GITHUB_REPOSITORY`, `GITHUB_WORKSPACE`, plus `SLYCI=1` so a workflow can
  branch on where it's running

Not supported (on purpose — native runner, not a container farm):

- `uses:` marketplace actions — skipped with a log line. `actions/checkout`
  is implicit (the workspace is already checked out). Rewrite anything else
  as a `run:` step.
- matrix builds, services, artifacts, caches.

Secrets live in `~/.slyci/secrets.json`:

```json
{ "API_KEY": "value" }
```

## Layout on disk

```
~/.slyci/config.json   watched repos + poll interval
~/.slyci/secrets.json  ${{ secrets.* }} values
~/.slyci/work/         shallow clones (one per repo)
~/.slyci/logs/         one log file per run
~/.slyci/daemon.log    launchd daemon output
```
