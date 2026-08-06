#!/usr/bin/env node
// slyci — self-hosted GitHub Actions alternative.
// Same recipe the open-source runners use (gitea act_runner, woodpecker agent):
//   poll -> fetch -> parse workflow YAML -> run steps -> report commit status.
// Steps run natively on this machine (no Docker), which is exactly what you
// want for macOS/Xcode builds that eat 10x minutes on hosted runners.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const yaml = require('js-yaml');

// Piping output (slyci ... | head) closes stdout early; die quietly like cat does.
process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); });

const HOME = os.homedir();
const ROOT = path.join(HOME, '.slyci');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const SECRETS_PATH = path.join(ROOT, 'secrets.json');
const WORK_DIR = path.join(ROOT, 'work');
const LOG_DIR = path.join(ROOT, 'logs');
const STATUS_CONTEXT = 'slyci';

// ---------------------------------------------------------------- config

function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function loadConfig() {
  return loadJSON(CONFIG_PATH, { pollSeconds: 60, repos: {} });
}

function saveConfig(cfg) {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

function loadSecrets() {
  return loadJSON(SECRETS_PATH, {});
}

// ---------------------------------------------------------------- git/gh helpers

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function remoteSha(repo, branch) {
  const out = sh('git', ['ls-remote', `https://github.com/${repo}.git`, `refs/heads/${branch}`]);
  return out ? out.split(/\s+/)[0] : null;
}

function syncRepo(repo, branch, sha) {
  const dir = path.join(WORK_DIR, repo.replace('/', '__'));
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    sh('git', ['clone', '--depth', '1', '--branch', branch, `https://github.com/${repo}.git`, dir]);
  } else {
    sh('git', ['fetch', '--depth', '1', 'origin', branch], { cwd: dir });
    sh('git', ['checkout', '-f', 'FETCH_HEAD'], { cwd: dir });
  }
  const head = sh('git', ['rev-parse', 'HEAD'], { cwd: dir });
  if (sha && head !== sha) {
    // Branch moved between poll and fetch; run what we actually checked out.
    sha = head;
  }
  return { dir, sha: head };
}

function postStatus(repo, sha, state, description, context) {
  try {
    sh('gh', ['api', `repos/${repo}/statuses/${sha}`,
      '-f', `state=${state}`,
      '-f', `context=${context}`,
      '-f', `description=${description.slice(0, 130)}`]);
  } catch (e) {
    log(`  ! could not post status to ${repo}@${sha.slice(0, 7)}: ${firstLine(e)}`);
  }
}

function firstLine(e) {
  return String(e.stderr || e.message || e).split('\n')[0];
}

// ---------------------------------------------------------------- workflow parsing

function findWorkflows(repoDir) {
  const wfDir = path.join(repoDir, '.github', 'workflows');
  if (!fs.existsSync(wfDir)) return [];
  return fs.readdirSync(wfDir)
    .filter(f => /\.ya?ml$/.test(f))
    .map(f => {
      const file = path.join(wfDir, f);
      try {
        return { file: f, wf: yaml.load(fs.readFileSync(file, 'utf8')) };
      } catch (e) {
        log(`  ! skipping ${f}: yaml error: ${firstLine(e)}`);
        return null;
      }
    })
    .filter(Boolean)
    .filter(({ wf }) => triggersOnPush(wf));
}

function triggersOnPush(wf) {
  if (!wf || !wf.on) return false;
  const on = wf.on;
  if (on === 'push') return true;
  if (Array.isArray(on)) return on.includes('push') || on.includes('workflow_dispatch');
  return 'push' in on || 'workflow_dispatch' in on;
}

// Topological order of jobs honoring `needs`. Jobs whose needs failed are skipped.
function orderJobs(jobs) {
  const names = Object.keys(jobs);
  const ordered = [];
  const placed = new Set();
  let guard = names.length + 1;
  while (ordered.length < names.length && guard-- > 0) {
    for (const name of names) {
      if (placed.has(name)) continue;
      const needs = [].concat(jobs[name].needs || []);
      if (needs.every(n => placed.has(n))) {
        ordered.push(name);
        placed.add(name);
      }
    }
  }
  for (const name of names) if (!placed.has(name)) ordered.push(name); // cycle fallback
  return ordered;
}

// Minimal ${{ ... }} expression support: env.X, secrets.X, github.X, matrix-free.
function interpolate(str, ctx) {
  return String(str).replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    const [head, ...rest] = expr.split('.');
    const key = rest.join('.');
    if (head === 'env') return ctx.env[key] ?? '';
    if (head === 'secrets') return ctx.secrets[key] ?? '';
    if (head === 'github') return ctx.github[key] ?? '';
    return '';
  });
}

// ---------------------------------------------------------------- execution

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  if (log.stream) log.stream.write(line + '\n');
}
log.stream = null;

function runStep(script, cwd, env, timeoutMin) {
  return new Promise(resolve => {
    const child = spawn('bash', ['-eo', 'pipefail', '-c', script], { cwd, env });
    const timer = setTimeout(() => {
      log(`  ! step timed out after ${timeoutMin} minutes, killing`);
      child.kill('SIGKILL');
    }, timeoutMin * 60 * 1000);
    const forward = data => {
      process.stdout.write(data);
      if (log.stream) log.stream.write(data);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('close', code => { clearTimeout(timer); resolve(code ?? 1); });
    child.on('error', err => { clearTimeout(timer); log(`  ! ${err.message}`); resolve(1); });
  });
}

async function runWorkflow({ file, wf }, repoDir, github) {
  const secrets = loadSecrets();
  const wfEnv = wf.env || {};
  const jobs = wf.jobs || {};
  const results = {};

  log(`workflow: ${wf.name || file}`);

  for (const jobName of orderJobs(jobs)) {
    const job = jobs[jobName];
    const needs = [].concat(job.needs || []);
    if (needs.some(n => results[n] !== 'success')) {
      log(`job ${jobName}: skipped (needs ${needs.join(', ')})`);
      results[jobName] = 'skipped';
      continue;
    }

    log(`job ${jobName}: start`);
    const jobEnv = { ...wfEnv, ...(job.env || {}) };
    let failed = false;

    for (const [i, step] of (job.steps || []).entries()) {
      const label = step.name || step.run?.split('\n')[0]?.slice(0, 60) || step.uses || `step ${i + 1}`;

      if (step.uses) {
        // Native runner: checkout already happened, everything else is a shell step.
        if (/actions\/checkout/.test(step.uses)) { log(`  - ${label} (implicit, workspace already checked out)`); continue; }
        log(`  - ${label}: SKIPPED ('uses:' actions are not supported — rewrite as a 'run:' step)`);
        continue;
      }
      if (!step.run) continue;
      if (step.if && /always\(\)/.test(step.if) === false && failed) continue;

      const ctx = { env: { ...jobEnv, ...(step.env || {}) }, secrets, github };
      const stepEnv = {
        ...process.env,
        CI: 'true', SLYCI: '1',
        GITHUB_SHA: github.sha, GITHUB_REF: github.ref,
        GITHUB_REPOSITORY: github.repository, GITHUB_WORKSPACE: repoDir,
        ...Object.fromEntries(Object.entries(ctx.env).map(([k, v]) => [k, interpolate(v, ctx)])),
      };
      const cwd = step['working-directory']
        ? path.resolve(repoDir, interpolate(step['working-directory'], ctx))
        : repoDir;
      const script = interpolate(step.run, ctx);

      log(`  - ${label}`);
      const code = await runStep(script, cwd, stepEnv, wf['timeout-minutes'] || job['timeout-minutes'] || 30);
      if (code !== 0) {
        log(`  ! step failed (exit ${code})`);
        failed = true;
        if (!step['continue-on-error']) break;
        failed = false;
      }
    }

    results[jobName] = failed ? 'failure' : 'success';
    log(`job ${jobName}: ${results[jobName]}`);
  }

  const ok = Object.values(results).every(r => r === 'success' || r === 'skipped');
  return { ok, results, name: wf.name || file };
}

async function runRepoAt(repoDir, { repo, branch, sha, report }) {
  const workflows = findWorkflows(repoDir);
  if (!workflows.length) {
    log('no push-triggered workflows found in .github/workflows/');
    return true;
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logFile = path.join(LOG_DIR, `${(repo || path.basename(repoDir)).replace('/', '__')}-${stamp}.log`);
  log.stream = fs.createWriteStream(logFile);
  log(`run ${repo || repoDir} @ ${(sha || 'local').slice(0, 7)} -> ${logFile}`);

  const github = {
    sha: sha || 'local',
    ref: `refs/heads/${branch || 'local'}`,
    ref_name: branch || 'local',
    repository: repo || path.basename(repoDir),
    workspace: repoDir,
  };

  if (report) postStatus(repo, sha, 'pending', 'slyci: running on ' + os.hostname(), STATUS_CONTEXT);

  let allOk = true;
  for (const entry of workflows) {
    const { ok, name } = await runWorkflow(entry, repoDir, github);
    if (report) postStatus(repo, sha, ok ? 'success' : 'failure', `slyci: ${name} ${ok ? 'passed' : 'failed'}`, `${STATUS_CONTEXT}/${name}`);
    if (!ok) allOk = false;
  }

  if (report) postStatus(repo, sha, allOk ? 'success' : 'failure', allOk ? 'slyci: all workflows passed' : 'slyci: workflow failed', STATUS_CONTEXT);
  log(`run finished: ${allOk ? 'PASS' : 'FAIL'}`);
  log.stream.end();
  log.stream = null;
  return allOk;
}

// ---------------------------------------------------------------- poller

async function pollOnce(cfg) {
  for (const [repo, meta] of Object.entries(cfg.repos)) {
    let sha;
    try {
      sha = remoteSha(repo, meta.branch);
    } catch (e) {
      log(`${repo}: ls-remote failed: ${firstLine(e)}`);
      continue;
    }
    if (!sha || sha === meta.lastSha) continue;

    log(`${repo}: new commit ${sha.slice(0, 7)} on ${meta.branch}`);
    try {
      const { dir, sha: head } = syncRepo(repo, meta.branch, sha);
      await runRepoAt(dir, { repo, branch: meta.branch, sha: head, report: true });
      meta.lastSha = head;
    } catch (e) {
      log(`${repo}: run crashed: ${firstLine(e)}`);
      meta.lastSha = sha; // don't hot-loop a broken commit
    }
    saveConfig(cfg);
  }
}

async function daemon() {
  const cfg = loadConfig();
  const repos = Object.keys(cfg.repos);
  log(`slyci daemon up — ${repos.length} repo(s), polling every ${cfg.pollSeconds}s`);
  repos.forEach(r => log(`  watching ${r} (${cfg.repos[r].branch})`));
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await pollOnce(cfg);
    await new Promise(r => setTimeout(r, cfg.pollSeconds * 1000));
  }
}

// ---------------------------------------------------------------- launchd

const PLIST_PATH = path.join(HOME, 'Library', 'LaunchAgents', 'com.sly.slyci.plist');

function installDaemon() {
  const node = process.execPath;
  const self = path.resolve(__filename);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.sly.slyci</string>
  <key>ProgramArguments</key><array>
    <string>${node}</string>
    <string>${self}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(ROOT, 'daemon.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(ROOT, 'daemon.err')}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${process.env.PATH}</string>
  </dict>
</dict></plist>
`;
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(PLIST_PATH, plist);
  try { sh('launchctl', ['unload', PLIST_PATH]); } catch {}
  sh('launchctl', ['load', PLIST_PATH]);
  console.log(`installed + loaded ${PLIST_PATH}`);
  console.log(`daemon log: ${path.join(ROOT, 'daemon.log')}`);
}

// ---------------------------------------------------------------- CLI

const USAGE = `slyci — self-hosted GitHub Actions alternative (native runner, no Docker)

usage:
  slyci add <owner/repo> [branch]    watch a repo (default branch: main)
  slyci remove <owner/repo>          stop watching a repo
  slyci list                         show watched repos + last built sha
  slyci run [dir]                    run workflows of a local checkout right now
  slyci trigger <owner/repo>         force a fetch+run of a watched repo now
  slyci daemon                       poll loop in the foreground
  slyci install-daemon               install launchd agent (survives reboot)
  slyci logs                         list recent run logs

workflow support: .github/workflows/*.yml — on: push, jobs, needs, steps
(run / name / env / working-directory / continue-on-error / timeout-minutes),
\${{ env.X }} / \${{ secrets.X }} / \${{ github.X }}. 'uses:' actions are skipped
(actions/checkout is implicit). Secrets: ~/.slyci/secrets.json {"KEY":"value"}.`;

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const cfg = loadConfig();

  switch (cmd) {
    case 'add': {
      if (!a || !a.includes('/')) return console.error('usage: slyci add owner/repo [branch]');
      const branch = b || 'main';
      // Seed lastSha with the current tip so adding a repo doesn't instantly build old commits.
      const sha = remoteSha(a, branch);
      if (!sha) return console.error(`branch '${branch}' not found on ${a}`);
      cfg.repos[a] = { branch, lastSha: sha };
      saveConfig(cfg);
      console.log(`watching ${a} (${branch}), current tip ${sha.slice(0, 7)} — future pushes will build`);
      break;
    }
    case 'remove':
      delete cfg.repos[a];
      saveConfig(cfg);
      console.log(`removed ${a}`);
      break;
    case 'list':
      for (const [repo, m] of Object.entries(cfg.repos))
        console.log(`${repo}  branch=${m.branch}  last=${(m.lastSha || '-').slice(0, 7)}`);
      if (!Object.keys(cfg.repos).length) console.log('no repos — slyci add owner/repo');
      break;
    case 'run': {
      const dir = path.resolve(a || '.');
      const ok = await runRepoAt(dir, { report: false });
      process.exit(ok ? 0 : 1);
      break;
    }
    case 'trigger': {
      const meta = cfg.repos[a];
      if (!meta) return console.error(`${a} is not watched — slyci add ${a}`);
      const { dir, sha } = syncRepo(a, meta.branch, null);
      const ok = await runRepoAt(dir, { repo: a, branch: meta.branch, sha, report: true });
      meta.lastSha = sha;
      saveConfig(cfg);
      process.exit(ok ? 0 : 1);
      break;
    }
    case 'daemon':
      await daemon();
      break;
    case 'install-daemon':
      installDaemon();
      break;
    case 'logs': {
      if (!fs.existsSync(LOG_DIR)) return console.log('no runs yet');
      const files = fs.readdirSync(LOG_DIR).sort().slice(-15);
      files.forEach(f => console.log(path.join(LOG_DIR, f)));
      break;
    }
    default:
      console.log(USAGE);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
