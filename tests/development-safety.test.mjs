import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const run = (command, args, options = {}) =>
  spawnSync(command, args, {encoding: 'utf8', timeout: 15000, ...options})
const git = (cwd, ...args) => {
  const result = run('git', ['-C', cwd, ...args])
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const temp = t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'development-safety-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  return dir
}
const commit = (dir, message) =>
  git(dir, '-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '-am', message)
const initRepo = dir => {
  mkdirSync(dir, {recursive: true})
  git(dir, 'init', '-b', 'main')
  writeFileSync(path.join(dir, 'tracked.txt'), 'initial\n')
  git(dir, 'add', '.')
  commit(dir, 'Initial fixture')
}
const snapshot = dir => ({
  head: git(dir, 'rev-parse', 'HEAD'),
  refs: git(dir, 'show-ref', '--head'),
  status: git(dir, 'status', '--porcelain', '--untracked-files=all'),
  tracked: readFileSync(path.join(dir, 'tracked.txt'), 'utf8'),
  untracked: existsSync(path.join(dir, 'untracked.txt'))
    ? readFileSync(path.join(dir, 'untracked.txt'), 'utf8') : null,
})

for (const scenario of [
  'clean base branch', 'clean feature branch', 'unpushed main commit',
  'dirty files', 'staged files', 'untracked files only', 'detached HEAD',
]) {
  test(`startup preserves ${scenario} in all three repositories`, t => {
    const dir = temp(t)
    const repos = ['bluesky-demo', 'social-app', 'atproto'].map(name => path.join(dir, name))
    const scripts = path.join(repos[0], 'scripts')
    for (const repo of repos) {
      initRepo(repo)
      if (repo === repos[0]) {
        mkdirSync(scripts)
        for (const name of ['env-start.sh', 'assert-fixture.mjs']) {
          cpSync(path.join(root, 'scripts', name), path.join(scripts, name))
        }
        git(repo, 'add', 'scripts')
        commit(repo, 'Startup scripts')
      }
      if (scenario === 'clean base branch') continue
      if (scenario === 'untracked files only') {
        writeFileSync(path.join(repo, 'untracked.txt'), 'untracked work\n')
        continue
      }
      if (scenario === 'clean feature branch') git(repo, 'switch', '-c', 'feature/local-work')
      if (scenario === 'detached HEAD') git(repo, 'checkout', '--detach')
      writeFileSync(path.join(repo, 'tracked.txt'), 'local work\n')
      if (scenario === 'dirty files') {
        writeFileSync(path.join(repo, 'untracked.txt'), 'untracked work\n')
      } else if (scenario === 'staged files') {
        git(repo, 'add', 'tracked.txt')
      } else {
        commit(repo, 'Local work')
      }
    }
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    const marker = path.join(dir, 'git-invoked')
    writeFileSync(path.join(bin, 'git'), '#!/bin/sh\ntouch "$GIT_MARKER"\nexit 78\n', {mode: 0o755})
    // Stop at the first service operation: never start services in this test.
    writeFileSync(path.join(bin, 'install'), '#!/bin/sh\nexit 77\n', {mode: 0o755})
    const before = repos.map(snapshot)
    const result = run('bash', [path.join(scripts, 'env-start.sh')], {
      cwd: dir,
      env: {...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_MARKER: marker,
        NODE_ENV: 'development', DEMO_ORIGIN: 'https://demo.example.test',
        REPLIT_DOMAINS: ''},
    })
    assert.equal(result.status, 77, result.stderr)
    assert.match(result.stdout, /Starting checked-out code/)
    assert.equal(existsSync(marker), false, 'startup must not invoke Git')
    assert.deepEqual(repos.map(snapshot), before)
  })
}

test('startup derives its sandbox origin when an explicit origin is absent', t => {
  const dir = temp(t)
  writeFileSync(path.join(dir, 'install'), '#!/bin/sh\nexit 77\n', {mode: 0o755})
  const result = run('bash', [path.join(root, 'scripts/env-start.sh')], {
    env: {...process.env, PATH: `${dir}:${process.env.PATH}`, NODE_ENV: 'development',
      DEMO_ORIGIN: '', REPLIT_DOMAINS: 'cnvs_test-00-example.kirk.replit.dev'},
  })
  assert.equal(result.status, 77, result.stderr)
  assert.match(result.stdout, /https:\/\/bluesky--cnvs-test\.kirk\.replit\.dev/)
})

test('build preparation restores history without changing local work and is repeatable', t => {
  const dir = temp(t)
  const origin = path.join(dir, 'origin')
  const clone = path.join(dir, 'clone')
  initRepo(origin)
  writeFileSync(path.join(origin, 'tracked.txt'), 'second\n')
  commit(origin, 'Second fixture')
  git(dir, 'clone', '--depth', '1', pathToFileURL(origin).href, clone)
  git(clone, 'switch', '-c', 'feature/local-work')
  writeFileSync(path.join(clone, 'tracked.txt'), 'uncommitted work\n')
  const head = git(clone, 'rev-parse', 'HEAD')
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'true')
  for (let i = 0; i < 2; i++) {
    const result = run('bash', [path.join(root, 'scripts/prepare-git-history.sh'), clone])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'false')
    assert.equal(git(clone, 'rev-list', '--count', 'HEAD'), '2')
    assert.equal(git(clone, 'rev-parse', 'HEAD'), head)
    assert.equal(git(clone, 'branch', '--show-current'), 'feature/local-work')
    assert.equal(readFileSync(path.join(clone, 'tracked.txt'), 'utf8'), 'uncommitted work\n')
  }
})

for (const entry of ['scripts/env-start.sh', 'start-backend.sh', 'start-web.sh', 'server.mjs']) {
  test(`${entry} refuses production before starting services`, () => {
    const result = run(entry.endsWith('.mjs') ? process.execPath : 'bash', [path.join(root, entry)], {
      cwd: root,
      env: {...process.env, NODE_ENV: 'production', DEMO_ORIGIN: '',
        ATPROTO_DIR: '/missing-atproto', SOCIAL_APP_DIR: '/missing-social-app'},
    })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /The demo fixture cannot run in production/)
    assert.doesNotMatch(result.stdout, /listening|Starting PostgreSQL/)
  })
}

test('fixture guard permits development and test runtimes', () => {
  for (const mode of ['development', 'test', '']) {
    const result = run(process.execPath, [path.join(root, 'scripts/assert-fixture.mjs')], {
      env: {...process.env, NODE_ENV: mode},
    })
    assert.equal(result.status, 0, result.stderr)
  }
})

for (const scenario of ['recovering', 'permanent failure', 'never ready']) {
  test(`Supabase startup handles ${scenario} with bounded retries`, t => {
    const dir = temp(t)
    const count = path.join(dir, 'attempts')
    writeFileSync(path.join(dir, 'npx'), `#!/bin/sh
n=0
[ ! -f "$ATTEMPTS" ] || n=$(cat "$ATTEMPTS")
n=$((n + 1))
echo "$n" > "$ATTEMPTS"
if [ "$SCENARIO" = "permanent failure" ]; then
  echo "Non-transient startup failure" >&2
  exit 1
fi
if [ "$SCENARIO" = "recovering" ] && [ "$n" -ge 3 ]; then
  echo "CLI success output omitted from logs"
  exit 0
fi
echo '{"error":{"code":"StatusDbNotReadyError"}}' >&2
exit 1
`, {mode: 0o755})
    writeFileSync(path.join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', {mode: 0o755})
    const result = run('bash', [path.join(root, 'scripts/start-supabase.sh')], {
      env: {...process.env, PATH: `${dir}:${process.env.PATH}`,
        ATTEMPTS: count, SCENARIO: scenario},
    })
    assert.equal(result.status, scenario === 'recovering' ? 0 : 1, result.stderr)
    assert.equal(Number(readFileSync(count, 'utf8')),
      scenario === 'recovering' ? 3 : scenario === 'permanent failure' ? 1 : 12)
    assert.doesNotMatch(result.stdout, /CLI success output omitted/)
    if (scenario === 'recovering') assert.match(result.stdout, /Supabase started/)
    else assert.match(result.stderr, /Non-transient startup failure|StatusDbNotReadyError/)
  })
}
