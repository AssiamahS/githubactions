# NOTES

- CLI output piped to `head` kills node with EPIPE — every CLI needs `process.stdout.on('error', e => e.code === 'EPIPE' && process.exit(0))`.
- CI workspaces are fresh shallow clones: workflows must `npm install` themselves; nothing from the dev checkout carries over.
- The global ~/.git-hooks auto-version pre-push hook amends the commit during push — `git status -sb` shows a stale "ahead 1, behind 1" until the next `git fetch`; don't panic-rebase, fetch first.
- Watched-repo state lives in ~/.slyci/config.json (lastSha per repo); `slyci add` seeds it with the current tip so old commits never rebuild.
