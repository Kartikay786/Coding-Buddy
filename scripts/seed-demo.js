#!/usr/bin/env node
'use strict';
// Builds a small git repo with two PRs: one vulnerable (feature/user-search), one clean (feature/health-endpoint).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function seed(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  const commit = (m) => { git('add', '-A'); git('commit', '-m', m); };

  git('init', '-b', 'main');
  git('config', 'user.name', 'Demo Dev'); git('config', 'user.email', 'dev@example.com');

  write('package.json', JSON.stringify({ name: 'demo-api', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2) + '\n');
  write('src/db.js', `// Tiny in-memory collection with Mongo-style filters ($ne, $gt, $regex).
function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    const v = doc[key];
    if (cond && typeof cond === 'object') {
      if ('$ne' in cond && v === cond.$ne) return false;
      if ('$gt' in cond && !(v > cond.$gt)) return false;
      if ('$regex' in cond && !new RegExp(cond.$regex).test(v)) return false;
      return true;
    }
    return v === cond;
  });
}
class Collection {
  constructor(docs) { this.docs = docs; }
  find(filter = {}) { return this.docs.filter((d) => matches(d, filter)); }
}
const users = new Collection([
  { id: 1, name: 'alice', email: 'alice@example.com', role: 'admin' },
  { id: 2, name: 'bob', email: 'bob@example.com', role: 'user' },
  { id: 3, name: 'carol', email: 'carol@example.com', role: 'user' },
]);
module.exports = { users };
`);
  write('test/db.test.js', `const test = require('node:test');
const assert = require('node:assert/strict');
const { users } = require('../src/db');
test('find by exact name', () => assert.equal(users.find({ name: 'bob' }).length, 1));
`);
  commit('Initial API with in-memory users');

  // PR 1: vulnerable
  git('checkout', '-b', 'feature/user-search');
  write('src/search.js', `const { users } = require('./db');

// POST /users/search with a JSON body like { "name": "alice" }
function searchUsers(req) {
  return users.find(req.body).map(({ id, name, email }) => ({ id, name, email }));
}
module.exports = { searchUsers };
`);
  write('test/search.test.js', `const test = require('node:test');
const assert = require('node:assert/strict');
const { searchUsers } = require('../src/search');

test('finds a user by name', () => {
  const r = searchUsers({ body: { name: 'alice' } });
  assert.equal(r.length, 1);
});

test('operator objects must not widen the search', () => {
  const r = searchUsers({ body: { name: { $ne: '' } } });
  assert.equal(r.length, 0);
});
`);
  commit('Add user search endpoint');
  git('checkout', 'main');

  // PR 2: clean
  git('checkout', '-b', 'feature/health-endpoint');
  write('src/health.js', `function health(now = new Date()) {
  return { status: 'ok', uptimeSeconds: Math.round(process.uptime()), time: now.toISOString() };
}
module.exports = { health };
`);
  write('test/health.test.js', `const test = require('node:test');
const assert = require('node:assert/strict');
const { health } = require('../src/health');
test('health reports ok', () => assert.equal(health(new Date(0)).status, 'ok'));
test('health includes ISO time', () => assert.equal(health(new Date(0)).time, '1970-01-01T00:00:00.000Z'));
`);
  commit('Add health endpoint');
  git('checkout', 'main');
  return dir;
}

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || 'demo-repo');
  seed(dir);
  console.log(`Demo repo ready at ${dir}\nBranches: feature/user-search (vulnerable), feature/health-endpoint (clean)`);
}
module.exports = { seed };
