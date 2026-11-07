#!/usr/bin/env node
'use strict';
// ReviewRoom toolkit: deterministic review + merge-gate tooling for AI agents in a Switch room.
// Zero dependencies. Node 18+. Agents call this; humans can too.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULTS = {
  base: 'main',
  testCommand: 'npm test',
  testSetup: '',
  testTimeoutSec: 120,
  // names that look like agents can never approve or waive; only humans can
  botPattern: '(triager|security|tests|gatekeeper|bot|agent)$',
};

// ---------- scan rules (applied to ADDED lines only) ----------
const TEST_FILE = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$|_test\.(py|go)$/;
const SRC_FILE = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|java|rb|php)$/;
const RULES = [
  { id: 'NOSQL_FILTER', sev: 'HIGH', title: 'Request data used directly as a database filter (NoSQL injection)',
    re: /\.(find|findOne|findOneAndUpdate|updateOne|updateMany|deleteOne|deleteMany|countDocuments)\(\s*(req\.(body|query|params)|body|query|params)\s*[,)]/,
    fix: 'Pick the expected fields and cast them, e.g. { name: String(req.body.name) }.' },
  { id: 'MONGO_WHERE', sev: 'HIGH', title: '$where executes JavaScript in the database', re: /\$where\b/,
    fix: 'Use normal query operators instead of $where.' },
  { id: 'EVAL', sev: 'HIGH', title: 'Dynamic code execution (eval / new Function)', re: /\b(eval|new Function)\s*\(/,
    fix: 'Remove dynamic evaluation; parse data with JSON.parse or use a lookup table.' },
  { id: 'CMD_INJECTION', sev: 'HIGH', title: 'Shell command built from a string (command injection)',
    re: /\b(exec|execSync)\s*\(\s*(`[^`]*\$\{|['"][^'"]*['"]\s*\+)/,
    fix: 'Use execFile/spawn with an argument array and validate input.' },
  { id: 'SQL_CONCAT', sev: 'HIGH', title: 'SQL built by string concatenation (SQL injection)',
    re: /\b(select|insert|update|delete)\b[^;]*\b(from|into|set)\b[^;]*(\$\{|['"]\s*\+)/i,
    fix: 'Use parameterised queries / prepared statements.' },
  { id: 'SECRET', sev: 'HIGH', title: 'Hard-coded secret or credential',
    re: /((api[_-]?key|secret|passw(or)?d|token|private[_-]?key)\w*\s*[:=]\s*['"][A-Za-z0-9_\-\/+=.]{8,}['"]|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC )?PRIVATE KEY-----)/i,
    skipFiles: TEST_FILE, fix: 'Move it to an environment variable or secret manager and rotate the leaked value.' },
  { id: 'TLS_OFF', sev: 'HIGH', title: 'TLS certificate verification disabled',
    re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/, fix: 'Keep verification on; trust the proper CA instead.' },
  { id: 'WEAK_RANDOM', sev: 'MED', title: 'Math.random used for a security value',
    re: /(token|secret|session|password|otp|nonce)\w*[^\n]*Math\.random\(/i, fix: 'Use crypto.randomBytes / crypto.randomUUID.' },
  { id: 'WEAK_HASH', sev: 'MED', title: 'Weak hash algorithm (md5/sha1)', re: /createHash\(\s*['"](md5|sha1)['"]/i,
    fix: 'Use sha256+, and bcrypt/argon2 for passwords.' },
  { id: 'XSS', sev: 'MED', title: 'Unsafe HTML injection sink', re: /(innerHTML\s*=|dangerouslySetInnerHTML|document\.write\()/,
    fix: 'Use textContent or sanitise with a vetted library.' },
  { id: 'REGEX_INPUT', sev: 'MED', title: 'RegExp built from user input (ReDoS / regex injection)',
    re: /new RegExp\(\s*(req\.|body\.|query\.|params\.)/, fix: 'Escape the input or avoid user-supplied patterns.' },
  { id: 'LOG_SENSITIVE', sev: 'MED', title: 'Sensitive value written to logs', re: /console\.(log|info|debug)\([^)]*(password|token|secret)/i,
    fix: 'Remove it or redact the value.' },
  { id: 'CORS_WILDCARD', sev: 'LOW', title: 'CORS allows any origin',
    re: /(origin\s*:\s*['"]\*['"]|Access-Control-Allow-Origin['"]?\s*,\s*['"]\*['"])/, fix: 'Allow-list the real origins.' },
  { id: 'LOOSE_DEP', sev: 'LOW', title: 'Unpinned or non-registry dependency', only: /(^|\/)package\.json$/,
    re: /"[^"]+"\s*:\s*"(\*|latest|git\+[^"]*|https?:[^"]*)"/, fix: 'Pin to a semver range from the registry.' },
];

// ---------- helpers ----------
function git(repo, args, opts = {}) {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch (e) {
    throw new Error(`git ${args.join(' ')} failed: ${(e.stderr || e.message).toString().trim()}`);
  }
}
const short = (s) => (s || '').slice(0, 7);
const now = () => new Date().toISOString();

function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[k] = true; else { flags[k] = next; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

function loadConfig(repo) {
  const p = path.join(repo, '.reviewroom.json');
  let cfg = {};
  if (fs.existsSync(p)) cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { ...DEFAULTS, ...cfg };
}

function stateDir(repo) {
  const d = path.join(repo, '.reviewroom');
  fs.mkdirSync(d, { recursive: true });
  // keep tool files out of git so the working tree stays clean for merges
  try {
    const ex = path.join(git(repo, ['rev-parse', '--absolute-git-dir']), 'info', 'exclude');
    const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
    const add = ['.reviewroom/', '.reviewroom.json'].filter((l) => !cur.split('\n').includes(l));
    if (add.length) { fs.mkdirSync(path.dirname(ex), { recursive: true }); fs.appendFileSync(ex, (cur && !cur.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n'); }
  } catch { /* not fatal */ }
  return d;
}
const loadState = (repo) => {
  const f = path.join(stateDir(repo), 'state.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { branches: {} };
};
const saveState = (repo, st) => fs.writeFileSync(path.join(stateDir(repo), 'state.json'), JSON.stringify(st, null, 2));
const branchState = (st, b) => (st.branches[b] ||= { findings: [] });

function resolveBranch(repo, b) {
  if (!b) throw new Error('Branch name required.');
  try { return git(repo, ['rev-parse', '--verify', `${b}^{commit}`]); } catch { throw new Error(`Branch "${b}" not found.`); }
}

function requireHuman(cfg, who, action) {
  if (!who || who === true) throw new Error(`--by <your name> is required to ${action}.`);
  if (new RegExp(cfg.botPattern, 'i').test(who)) throw new Error(`"${who}" looks like an agent. Only a human can ${action}.`);
}

// ---------- diff parsing & scanning ----------
function parseDiff(text) {
  const added = [];
  let file = null, line = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('+++ ')) { file = raw === '+++ /dev/null' ? null : raw.replace(/^\+\+\+ b\//, ''); continue; }
    const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { line = parseInt(h[1], 10); continue; }
    if (!file) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) { added.push({ file, line, text: raw.slice(1) }); line++; }
  }
  return added;
}

function scanAdded(added, changedFiles = []) {
  const out = [];
  for (const a of added) {
    for (const r of RULES) {
      if (r.only && !r.only.test(a.file)) continue;
      if (r.skipFiles && r.skipFiles.test(a.file)) continue;
      if (r.re.test(a.text)) out.push({ rule: r.id, sev: r.sev, title: r.title, file: a.file, line: a.line, fix: r.fix, evidence: a.text.trim().slice(0, 140) });
    }
  }
  for (const f of changedFiles) if (/(^|\/)\.env(\.|$)/.test(f) && !/example|sample/.test(f))
    out.push({ rule: 'ENV_FILE', sev: 'HIGH', title: 'Environment file committed', file: f, line: 1, fix: 'Remove it from git, add to .gitignore, rotate any secrets.', evidence: f });
  const src = changedFiles.filter((f) => SRC_FILE.test(f) && !TEST_FILE.test(f));
  if (src.length && !changedFiles.some((f) => TEST_FILE.test(f)))
    out.push({ rule: 'NO_TESTS', sev: 'MED', title: 'Source changed but no tests were added or updated', file: src[0], line: 1, fix: 'Add tests covering the new behaviour.', evidence: `${src.length} source file(s), 0 test files` });
  return out;
}

function diffInfo(repo, cfg, branch) {
  const range = `${cfg.base}...${branch}`;
  const files = git(repo, ['diff', '--name-only', range]).split('\n').filter(Boolean);
  const diff = git(repo, ['diff', '-U0', '--no-color', range]);
  return { files, added: parseDiff(diff) };
}

const SEV_ORDER = { HIGH: 3, MED: 2, LOW: 1 };
const open = (b) => (b.findings || []).filter((f) => f.status === 'open');

// ---------- commands ----------
const commands = {
  template(_repo, _cfg, [dest], flags) {
    const out = path.resolve(dest || 'review-room.template.yaml');
    if (fs.existsSync(out) && !flags.force) throw new Error(`${out} already exists (use --force to overwrite).`);
    fs.copyFileSync(path.join(__dirname, '..', 'review-room.template.yaml'), out);
    return `Switch room template written to ${out}\nImport it in Switch Console and fill in {team}, {provider} and {bridge}.`;
  },

  demo(_repo, _cfg, [dest]) {
    const dir = path.resolve(dest || 'demo-repo');
    require('../scripts/seed-demo.js').seed(dir);
    return `Demo repo ready at ${dir}\nBranches: feature/user-search (vulnerable), feature/health-endpoint (clean).\nPoint your agents' working directory at it and say: review feature/user-search`;
  },

  init(repo) {
    const p = path.join(repo, '.reviewroom.json');
    if (fs.existsSync(p)) return `Config already exists: ${p}`;
    fs.writeFileSync(p, JSON.stringify(DEFAULTS, null, 2) + '\n');
    stateDir(repo);
    return `Created ${p}. Edit "base", "testCommand" and "testSetup" for this repo.`;
  },

  summary(repo, cfg, [branch]) {
    const sha = resolveBranch(repo, branch);
    const stat = git(repo, ['diff', '--numstat', `${cfg.base}...${branch}`]).split('\n').filter(Boolean).map((l) => {
      const [a, d, f] = l.split('\t'); return { a: +a || 0, d: +d || 0, f };
    });
    const commits = git(repo, ['log', '--oneline', `${cfg.base}..${branch}`]).split('\n').filter(Boolean);
    const adds = stat.reduce((s, x) => s + x.a, 0), dels = stat.reduce((s, x) => s + x.d, 0);
    const sensitive = stat.filter((x) => /(auth|login|passw|payment|billing|db|model|route|api|middleware|config|\.env|package\.json|dockerfile|migrat)/i.test(x.f));
    const { files, added } = diffInfo(repo, cfg, branch);
    const found = scanAdded(added, files);
    const top = found.reduce((m, f) => Math.max(m, SEV_ORDER[f.sev]), 0);
    const risk = top === 3 ? 'HIGH' : top === 2 || sensitive.length || adds + dels > 400 ? 'MEDIUM' : 'LOW';
    const why = [];
    if (top === 3) why.push('quick scan already shows HIGH-severity patterns');
    if (sensitive.length) why.push(`touches sensitive paths (${sensitive.map((s) => s.f).slice(0, 3).join(', ')})`);
    if (adds + dels > 400) why.push('large change (>400 lines)');
    const st = loadState(repo); const b = branchState(st, branch); b.risk = risk; saveState(repo, st);
    return [
      `### PR summary: \`${branch}\` into \`${cfg.base}\``,
      `Head \`${short(sha)}\` · ${commits.length} commit(s) · ${stat.length} file(s) · +${adds} / -${dels}`,
      `**Risk: ${risk}**${why.length ? ' (' + why.join('; ') + ')' : ''}`,
      '', '**Commits**', ...commits.map((c) => `- ${c}`),
      '', '**Files**', ...stat.map((x) => `- ${x.f} (+${x.a} -${x.d})`),
    ].join('\n');
  },

  scan(repo, cfg, [branch]) {
    const sha = resolveBranch(repo, branch);
    const { files, added } = diffInfo(repo, cfg, branch);
    const st = loadState(repo); const b = branchState(st, branch);
    const prev = (b.findings || []).filter((f) => b.sha === sha && f.source === 'agent'); // keep agent findings for same head
    const found = scanAdded(added, files).map((f, i) => ({ ...f, id: `F${i + 1}`, source: 'scan', status: 'open' }));
    let n = found.length; prev.forEach((f) => { f.id = `F${++n}`; });
    b.sha = sha; b.scanSha = sha; b.scanAt = now(); b.findings = [...found, ...prev];
    saveState(repo, st);
    if (!b.findings.length) return `### Security scan: \`${branch}\` @ \`${short(sha)}\`\nNo findings from the automated rules. (Read the diff yourself for logic and auth flaws, then add anything you find with \`reviewroom finding add\`.)`;
    return [`### Security scan: \`${branch}\` @ \`${short(sha)}\``, `${b.findings.length} finding(s):`, '',
      ...b.findings.map((f) => `- **${f.id} [${f.sev}]** ${f.title}\n  \`${f.file}:${f.line}\` \`${f.evidence}\`\n  Fix: ${f.fix}`)].join('\n');
  },

  'finding'(repo, cfg, [sub, branch], flags) {
    if (sub !== 'add') throw new Error('Usage: reviewroom finding add <branch> --sev HIGH|MED|LOW --file f --line n --title "..." --fix "..."');
    const sha = resolveBranch(repo, branch);
    const sev = String(flags.sev || '').toUpperCase();
    if (!SEV_ORDER[sev]) throw new Error('--sev must be HIGH, MED or LOW.');
    if (!flags.file || !flags.title) throw new Error('--file and --title are required.');
    const st = loadState(repo); const b = branchState(st, branch);
    if (b.sha !== sha) { b.sha = sha; b.findings = []; }
    const id = `F${(b.findings.length || 0) + 1}`;
    b.findings.push({ id, sev, rule: 'AGENT_REVIEW', title: String(flags.title), file: String(flags.file), line: +flags.line || 1, fix: String(flags.fix || ''), evidence: 'manual review', source: 'agent', status: 'open' });
    saveState(repo, st);
    return `Recorded ${id} [${sev}] ${flags.title} at ${flags.file}:${flags.line || 1}`;
  },

  waive(repo, cfg, [branch, id], flags) {
    requireHuman(cfg, flags.by, 'waive a finding');
    if (!flags.reason || flags.reason === true) throw new Error('--reason is required.');
    const st = loadState(repo); const b = branchState(st, branch);
    const f = (b.findings || []).find((x) => x.id === id);
    if (!f) throw new Error(`No finding ${id} on ${branch}.`);
    f.status = 'waived'; f.waiver = { by: flags.by, reason: String(flags.reason), at: now() };
    saveState(repo, st);
    logDecision(repo, { branch, sha: b.sha, outcome: 'waived', by: flags.by, detail: `${id} ${f.title}: ${flags.reason}` });
    return `Finding ${id} waived by ${flags.by}: ${flags.reason}`;
  },

  test(repo, cfg, [branch]) {
    const sha = resolveBranch(repo, branch);
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewroom-'));
    let res;
    try {
      git(repo, ['worktree', 'add', '--detach', wt, branch]);
      // NODE_TEST_CONTEXT is inherited when we run inside another node:test run; it makes a nested `node --test` skip everything and "pass".
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      const run = (cmd) => spawnSync(cmd, { cwd: wt, env, shell: true, encoding: 'utf8', timeout: cfg.testTimeoutSec * 1000, maxBuffer: 32 * 1024 * 1024 });
      if (cfg.testSetup) { const s = run(cfg.testSetup); if (s.status !== 0) res = { status: s.status ?? 1, out: `Setup failed (${cfg.testSetup}):\n${s.stdout}${s.stderr}` }; }
      if (!res) { const r = run(cfg.testCommand); res = { status: r.error ? 1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}${r.error ? '\n' + r.error.message : ''}` }; }
    } finally {
      try { git(repo, ['worktree', 'remove', '--force', wt]); } catch { fs.rmSync(wt, { recursive: true, force: true }); }
    }
    const tail = res.out.trim().split('\n').slice(-40).join('\n');
    const st = loadState(repo); const b = branchState(st, branch);
    b.test = { sha, passed: res.status === 0, at: now(), command: cfg.testCommand, tail };
    saveState(repo, st);
    return `### Tests: \`${branch}\` @ \`${short(sha)}\`: ${res.status === 0 ? 'PASSED' : 'FAILED'}\nCommand: \`${cfg.testCommand}\`\n\`\`\`\n${tail}\n\`\`\``;
  },

  approve(repo, cfg, [branch], flags) {
    const sha = resolveBranch(repo, branch);
    requireHuman(cfg, flags.by, 'approve a merge');
    const st = loadState(repo); const b = branchState(st, branch);
    b.approval = { sha, by: String(flags.by), at: now(), note: flags.note ? String(flags.note) : '' };
    saveState(repo, st);
    return `Approval recorded for \`${branch}\` @ \`${short(sha)}\` by ${flags.by}. It is void if new commits are pushed to the branch.`;
  },

  gate(repo, cfg, [branch], flags) {
    const sha = resolveBranch(repo, branch);
    const st = loadState(repo); const b = branchState(st, branch);
    const openHigh = open(b).filter((f) => f.sev === 'HIGH');
    const checks = [
      ['Scan ran on the current head', b.scanSha === sha, b.scanSha ? `scan was on ${short(b.scanSha)}, head is ${short(sha)}` : 'no scan yet: run `reviewroom scan`'],
      ['No open HIGH findings', b.scanSha === sha && openHigh.length === 0, openHigh.map((f) => `${f.id} ${f.title}`).join('; ') || 'scan required first'],
      ['Tests passed on the current head', !!b.test && b.test.sha === sha && b.test.passed, !b.test ? 'tests not run' : b.test.sha !== sha ? `tests ran on ${short(b.test.sha)}, head is ${short(sha)}` : 'tests failed'],
      ['Human approval for the current head', !!b.approval && b.approval.sha === sha, !b.approval ? 'no approval recorded' : `approval was for ${short(b.approval.sha)}, head is ${short(sha)}`],
    ];
    const failed = checks.filter((c) => !c[1]);
    const lines = checks.map(([n, ok, why]) => `${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : ': ' + why}`);
    const head = `### Merge gate: \`${branch}\` @ \`${short(sha)}\``;
    if (failed.length) {
      if (flags.merge) logDecision(repo, { branch, sha, outcome: 'blocked', by: 'gatekeeper', detail: failed.map((c) => c[0]).join('; ') });
      process.exitCode = 1;
      return `${head}\n**BLOCKED**\n${lines.join('\n')}`;
    }
    if (!flags.merge) return `${head}\n**READY** (dry run, nothing merged. Add --merge to merge.)\n${lines.join('\n')}`;
    if (git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) !== cfg.base) throw new Error(`Check out ${cfg.base} in this repo before merging.`);
    if (git(repo, ['status', '--porcelain'])) throw new Error('Working tree is not clean; commit or stash first.');
    git(repo, ['merge', '--no-ff', '-m', `Merge ${branch} (ReviewRoom: approved by ${b.approval.by})`, branch]);
    const merged = git(repo, ['rev-parse', 'HEAD']);
    const waived = (b.findings || []).filter((f) => f.status === 'waived');
    logDecision(repo, { branch, sha, outcome: 'merged', by: b.approval.by, detail: `merge ${short(merged)}; tests passed; ${waived.length} waived finding(s)` });
    return `${head}\n**MERGED** into \`${cfg.base}\` as \`${short(merged)}\`, approved by ${b.approval.by}.\n${lines.join('\n')}`;
  },

  decisions(repo) {
    const f = path.join(stateDir(repo), 'decisions.jsonl');
    if (!fs.existsSync(f)) return 'No decisions recorded yet.';
    const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).slice(-20);
    return ['### Decision log (latest 20)', ...rows.map((r) => `- ${r.at} · **${r.outcome.toUpperCase()}** \`${r.branch}\` @ \`${short(r.sha)}\` · by ${r.by} · ${r.detail}`)].join('\n');
  },

  report(repo, cfg, [branch]) {
    const sha = resolveBranch(repo, branch);
    const b = branchState(loadState(repo), branch);
    const tag = (ok) => (ok ? 'yes' : 'no');
    const md = [
      `# Review report: ${branch}`, `Generated ${now()} · head ${short(sha)} · base ${cfg.base}`, '',
      `- Risk: ${b.risk || 'not rated'}`,
      `- Scan on current head: ${tag(b.scanSha === sha)}`,
      `- Tests on current head: ${b.test && b.test.sha === sha ? (b.test.passed ? 'passed' : 'FAILED') : 'not run'}`,
      `- Approval on current head: ${b.approval && b.approval.sha === sha ? 'by ' + b.approval.by : 'none'}`, '',
      '## Findings', ...((b.findings || []).length ? b.findings.map((f) => `- ${f.id} [${f.sev}] ${f.title} (${f.file}:${f.line}) status=${f.status}${f.waiver ? ` waived by ${f.waiver.by}: ${f.waiver.reason}` : ''}`) : ['None.']),
    ].join('\n');
    const dir = path.join(stateDir(repo), 'reports'); fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, branch.replace(/[^\w.-]+/g, '_') + '.md'); fs.writeFileSync(out, md + '\n');
    return `${md}\n\n_Saved to ${out}_`;
  },
};

function logDecision(repo, row) {
  fs.appendFileSync(path.join(stateDir(repo), 'decisions.jsonl'), JSON.stringify({ at: now(), ...row }) + '\n');
}

const HELP = `ReviewRoom toolkit
Usage: reviewroom <command> [args] [--repo <path>]
  template [file]                        write the Switch room template to a file
  demo [dir]                             build the demo repo with two PRs
  init                                   create .reviewroom.json
  summary <branch>                       PR summary + risk rating
  scan <branch>                          automated security scan of the diff
  finding add <branch> --sev --file --line --title --fix   record a manual finding
  test <branch>                          run tests on the branch in a clean worktree
  waive <branch> <id> --by <human> --reason "..."          waive a finding (human only)
  approve <branch> --by <human>          record human approval for the current head
  gate <branch> [--merge]                check all merge conditions (and merge)
  decisions                              show the decision log
  report <branch>                        write a markdown report`;

function main(argv) {
  const { pos, flags } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  if (!cmd || cmd === 'help' || flags.help) return console.log(HELP);
  const fn = commands[cmd];
  if (!fn) { console.error(`Unknown command "${cmd}".\n${HELP}`); process.exit(2); }
  try {
    const repo = path.resolve(flags.repo || process.cwd());
    if (!['template', 'demo'].includes(cmd)) git(repo, ['rev-parse', '--git-dir']);
    console.log(fn(repo, ['template', 'demo'].includes(cmd) ? {} : loadConfig(repo), rest, flags));
  } catch (e) { console.error(`Error: ${e.message}`); process.exit(2); }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { parseDiff, scanAdded, RULES, commands };
