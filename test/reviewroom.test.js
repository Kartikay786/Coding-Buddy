'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseDiff, scanAdded } = require('../bin/reviewroom.js');
const { seed } = require('../scripts/seed-demo.js');

const CLI = path.join(__dirname, '..', 'bin', 'reviewroom.js');
const rr = (repo, ...args) => spawnSync('node', [CLI, ...args, '--repo', repo], { encoding: 'utf8' });

test('parseDiff tracks new-file line numbers', () => {
  const d = '+++ b/a.js\n@@ -1,0 +10,2 @@\n+one\n+two\n';
  assert.deepEqual(parseDiff(d), [{ file: 'a.js', line: 10, text: 'one' }, { file: 'a.js', line: 11, text: 'two' }]);
});

test('scanner flags the common serious patterns', () => {
  const cases = {
    NOSQL_FILTER: 'return users.find(req.body);',
    EVAL: 'eval(userInput)',
    CMD_INJECTION: 'exec(`ls ${dir}`)',
    SECRET: 'const apiKey = "sk_live_abcdefgh12345678";',
    WEAK_HASH: "crypto.createHash('md5')",
    XSS: 'el.innerHTML = name;',
  };
  for (const [rule, text] of Object.entries(cases)) {
    const f = scanAdded([{ file: 'src/x.js', line: 1, text }], ['src/x.js', 'test/x.test.js']);
    assert.ok(f.some((x) => x.rule === rule), `expected ${rule} for: ${text}`);
  }
});

test('scanner stays quiet on safe code and ignores secrets in test files', () => {
  const safe = scanAdded([{ file: 'src/x.js', line: 1, text: 'return users.find({ name: String(req.body.name) });' }], ['src/x.js', 'test/x.test.js']);
  assert.equal(safe.length, 0);
  const t = scanAdded([{ file: 'test/a.test.js', line: 1, text: 'const password = "hunter2hunter2";' }], ['test/a.test.js']);
  assert.equal(t.length, 0);
});

test('flags source changes without tests', () => {
  const f = scanAdded([{ file: 'src/x.js', line: 1, text: 'const a = 1;' }], ['src/x.js']);
  assert.ok(f.some((x) => x.rule === 'NO_TESTS'));
});

test('end to end: vulnerable PR is blocked, fixed PR merges, agents cannot approve', () => {
  const repo = seed(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-demo-')));
  const B = 'feature/user-search';

  assert.match(rr(repo, 'summary', B).stdout, /Risk: HIGH/);
  const scan = rr(repo, 'scan', B).stdout;
  assert.match(scan, /NoSQL injection/);
  assert.match(scan, /src\/search\.js:5/);
  assert.match(rr(repo, 'test', B).stdout, /FAILED/);

  assert.match(rr(repo, 'approve', B, '--by', 'security-agent').stderr, /looks like an agent/);
  assert.match(rr(repo, 'approve', B, '--by', 'Priya').stdout, /Approval recorded/);
  const blocked = rr(repo, 'gate', B, '--merge');
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /BLOCKED/);
  assert.match(blocked.stdout, /FAIL  No open HIGH findings/);

  // apply the fix on the branch (this is what the security agent does on "apply fix")
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('checkout', B);
  fs.writeFileSync(path.join(repo, 'src/search.js'), fs.readFileSync(path.join(repo, 'src/search.js'), 'utf8')
    .replace('users.find(req.body)', "users.find({ name: String(req.body.name ?? '') })"));
  g('commit', '-am', 'Fix NoSQL injection in user search');
  g('checkout', 'main');

  // old approval is void for the new head
  assert.match(rr(repo, 'gate', B, '--merge').stdout, /Scan ran on the current head/);
  assert.match(rr(repo, 'scan', B).stdout, /^### Security scan[\s\S]*(No findings|NO_TESTS|finding)/);
  assert.match(rr(repo, 'test', B).stdout, /PASSED/);
  const stale = rr(repo, 'gate', B, '--merge');
  assert.match(stale.stdout, /FAIL  Human approval for the current head/);
  rr(repo, 'approve', B, '--by', 'Priya');
  const ok = rr(repo, 'gate', B, '--merge');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /MERGED/);
  assert.match(rr(repo, 'decisions').stdout, /MERGED.*Priya/);
  assert.equal(g('status', '--porcelain').stdout.trim(), '', 'working tree stays clean');
});

test('clean PR passes every check and merges', () => {
  const repo = seed(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-demo-')));
  const B = 'feature/health-endpoint';
  assert.match(rr(repo, 'scan', B).stdout, /No findings/);
  assert.match(rr(repo, 'test', B).stdout, /PASSED/);
  rr(repo, 'approve', B, '--by', 'Sam');
  assert.match(rr(repo, 'gate', B).stdout, /READY/);
  assert.match(rr(repo, 'gate', B, '--merge').stdout, /MERGED/);
});

test('template and demo commands work outside a git repo (npm install use)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-pkg-'));
  const t = spawnSync('node', [CLI, 'template', path.join(dir, 't.yaml')], { cwd: dir, encoding: 'utf8' });
  assert.equal(t.status, 0, t.stderr);
  assert.match(fs.readFileSync(path.join(dir, 't.yaml'), 'utf8'), /gatekeeper/);
  const again = spawnSync('node', [CLI, 'template', path.join(dir, 't.yaml')], { cwd: dir, encoding: 'utf8' });
  assert.equal(again.status, 2); // refuses to overwrite
  const d = spawnSync('node', [CLI, 'demo', path.join(dir, 'demo')], { cwd: dir, encoding: 'utf8' });
  assert.equal(d.status, 0, d.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'demo', '.git')));
});
