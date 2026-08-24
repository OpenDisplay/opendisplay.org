// Shell tests for .github/scripts/deploy-ftp-curl.sh ordering and failure
// gating, using a fake `curl` on PATH. Covers the plan §2 invariants:
//  - assets upload before HTML entrypoints
//  - a failed asset upload BLOCKS HTML publication entirely
//  - HTML-only and asset-only diffs behave
//  - deletion-only diffs refresh the remote manifest
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../.github/scripts/deploy-ftp-curl.sh',
);

const FAKE_CURL = `#!/usr/bin/env bash
# Fake curl for deploy-script tests.
#  -o <file> <url> : remote-manifest fetch — copy $FAKE_REMOTE_MANIFEST if set
#  -T <file> <url> : upload — append url to $FAKE_UPLOAD_LOG; fail if url
#                    matches $FAKE_FAIL_PATTERN (grep -E)
out=""; up=""; url=""
args=("$@")
for ((i=0; i<\${#args[@]}; i++)); do
  case "\${args[i]}" in
    -o) out="\${args[i+1]}"; ((i++));;
    -T) up="\${args[i+1]}"; ((i++));;
    ftp://*) url="\${args[i]}";;
  esac
done
if [[ -n "$out" ]]; then
  if [[ -n "\${FAKE_REMOTE_MANIFEST:-}" && -f "\${FAKE_REMOTE_MANIFEST}" ]]; then
    cp "\${FAKE_REMOTE_MANIFEST}" "$out"; exit 0
  fi
  exit 9
fi
if [[ -n "$up" ]]; then
  echo "$url" >> "\${FAKE_UPLOAD_LOG}"
  if [[ -n "\${FAKE_FAIL_PATTERN:-}" ]] && grep -qE "\${FAKE_FAIL_PATTERN}" <<< "$url"; then
    exit 9
  fi
  exit 0
fi
exit 0
`;

function sha256(file) {
  return execFileSync('sha256sum', [file], { encoding: 'utf8' }).split(' ')[0];
}

function setup(files) {
  const dir = mkdtempSync(join(tmpdir(), 'od-deploy-test-'));
  const docs = join(dir, 'httpdocs');
  mkdirSync(docs, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(docs, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const curl = join(bin, 'curl');
  writeFileSync(curl, FAKE_CURL);
  chmodSync(curl, 0o755);
  return { dir, docs, bin };
}

function manifestFor(docs, files) {
  // Same format the script builds: "<sha256> <rel>", sorted by find|sort.
  return Object.keys(files)
    .sort()
    .map((rel) => `${sha256(join(docs, rel))} ${rel}`)
    .join('\n') + '\n';
}

function runDeploy({ dir, docs, bin }, { remoteManifest, failPattern } = {}) {
  const log = join(dir, 'uploads.log');
  writeFileSync(log, '');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FTP_SERVER: 'ftp.example.test',
    FTP_USERNAME: 'u',
    FTP_PASSWORD: 'p',
    OD_DEPLOY_HTTPDOCS: docs,
    FAKE_UPLOAD_LOG: log,
  };
  if (remoteManifest !== undefined) {
    const rm = join(dir, 'remote-manifest.txt');
    writeFileSync(rm, remoteManifest);
    env.FAKE_REMOTE_MANIFEST = rm;
  }
  if (failPattern) env.FAKE_FAIL_PATTERN = failPattern;
  let code = 0;
  let output = '';
  try {
    output = execFileSync('bash', [SCRIPT], { encoding: 'utf8', env, stdio: 'pipe' });
  } catch (err) {
    code = err.status ?? 1;
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  const uploads = existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(Boolean)
    : [];
  return { code, uploads, output };
}

const FILES = {
  'index.html': '<html>root</html>',
  'app/index.html': '<html>app</html>',
  'app/current-version.txt': 'v1\n',
  'app/RELEASED_VERSIONS': 'v1\n',
  'app/v1/app.css': 'css',
  'app/v1/js/main.js': 'js',
  'js/ble-common.js': 'lib',
};

test('first deploy phase order: assets -> html -> version pointer -> manifest', () => {
  const fx = setup(FILES);
  const { code, uploads } = runDeploy(fx);
  assert.equal(code, 0);
  const names = uploads.map((u) => u.replace(/^ftp:\/\/[^/]+\//, ''));
  const phase = (n) =>
    n.includes('.opendisplay-deploy-manifest') ? 3
    : n.endsWith('current-version.txt') ? 2
    : n.endsWith('.html') ? 1
    : 0;
  const phases = names.map(phase);
  assert.deepEqual(phases, [...phases].sort((a, b) => a - b), `phase order broken: ${names.join(', ')}`);
  assert.equal(phases.at(-1), 3, 'manifest uploaded last');
  assert.ok(phases.includes(2), 'version pointer uploaded');
});

test('failed asset upload blocks html AND version pointer publication', () => {
  const fx = setup(FILES);
  const { code, uploads } = runDeploy(fx, { failPattern: 'main\\.js' });
  assert.notEqual(code, 0);
  const names = uploads.map((u) => u.replace(/^ftp:\/\/[^/]+\//, ''));
  assert.ok(!names.some((n) => n.endsWith('.html')), `html was published: ${names.join(', ')}`);
  assert.ok(!names.some((n) => n.endsWith('current-version.txt')), 'version pointer withheld');
  assert.ok(!names.some((n) => n.includes('.opendisplay-deploy-manifest')), 'manifest not updated');
});

test('failed html upload blocks the version pointer', () => {
  const fx = setup(FILES);
  const { code, uploads } = runDeploy(fx, { failPattern: 'app/index\\.html' });
  assert.notEqual(code, 0);
  const names = uploads.map((u) => u.replace(/^ftp:\/\/[^/]+\//, ''));
  assert.ok(!names.some((n) => n.endsWith('current-version.txt')), 'version pointer withheld');
  assert.ok(!names.some((n) => n.includes('.opendisplay-deploy-manifest')), 'manifest not updated');
});

test('html-only diff uploads just the html + manifest', () => {
  const fx = setup(FILES);
  const remote = manifestFor(fx.docs, FILES).replace(
    sha256(join(fx.docs, 'app/index.html')),
    '0'.repeat(64),
  );
  const { code, uploads } = runDeploy(fx, { remoteManifest: remote });
  assert.equal(code, 0);
  const names = uploads.map((u) => u.replace(/^ftp:\/\/[^/]+\//, ''));
  assert.deepEqual(
    names.filter((n) => !n.includes('.opendisplay-deploy-manifest')),
    ['httpdocs/app/index.html'],
  );
});

test('deletion-only diff refreshes the remote manifest and exits 0', () => {
  const fx = setup(FILES);
  const remote =
    manifestFor(fx.docs, FILES) + `${'a'.repeat(64)} removed-file.html\n`;
  const { code, uploads } = runDeploy(fx, { remoteManifest: remote });
  assert.equal(code, 0);
  const names = uploads.map((u) => u.replace(/^ftp:\/\/[^/]+\//, ''));
  // The manifest refresh is the ONLY upload: no files, no removed-file re-upload.
  assert.equal(names.length, 1);
  assert.ok(names[0].includes('.opendisplay-deploy-manifest'));
});

test('identical manifests: no uploads at all', () => {
  const fx = setup(FILES);
  const { code, uploads } = runDeploy(fx, { remoteManifest: manifestFor(fx.docs, FILES) });
  assert.equal(code, 0);
  assert.deepEqual(uploads, []);
});

// --- Web OD App release preflight ---

const APP_FILES = {
  'index.html': '<html>root</html>',
  'app/index.html': '<html>app</html>',
  'app/current-version.txt': 'v1\n',
  'app/RELEASED_VERSIONS': '# comment\nv1\n',
  'app/v1/app.css': 'css',
};

test('deploy proceeds when the current app version is declared immutable', () => {
  const fx = setup(APP_FILES);
  const { code } = runDeploy(fx);
  assert.equal(code, 0);
});

test('deploy REFUSES to publish an app version missing from RELEASED_VERSIONS', () => {
  const fx = setup({ ...APP_FILES, 'app/RELEASED_VERSIONS': '# nothing released yet\n' });
  const { code, uploads, output } = runDeploy(fx);
  assert.notEqual(code, 0, 'a mutable version must not be released');
  assert.deepEqual(uploads, [], 'nothing was uploaded');
  assert.match(output, /NOT listed in app\/RELEASED_VERSIONS/);
});

test('deploy REFUSES when the pointer names a directory that does not exist', () => {
  const fx = setup({ ...APP_FILES, 'app/current-version.txt': 'v9\n' });
  const { code, output } = runDeploy(fx);
  assert.notEqual(code, 0);
  assert.match(output, /does not exist/);
});

test('a site without the app deploys unaffected by the preflight', () => {
  const fx = setup({ 'index.html': '<html>root</html>', 'js/x.js': 'x' });
  assert.equal(runDeploy(fx).code, 0);
});

test('an UNRELEASED app is NOT published, and does not block the rest of the site', () => {
  // The repository's current state. Unreleased must mean unpublished: httpdocs
  // deploys wholesale, so without the exclusion the unqualified app would go
  // live regardless of the pointer.
  const fx = setup({
    'index.html': '<html>root</html>',
    'js/site.js': 'site',
    'app/index.html': '<html>app</html>',
    'app/RELEASED_VERSIONS': '# nothing released yet\n',
    'app/v1/app.css': 'css',
  });
  const { code, uploads, output } = runDeploy(fx);
  assert.equal(code, 0, 'unrelated site files still deploy');
  const names = uploads.map((u) => u.replace(/^ftp:\/\/[^/]+\//, ''));
  assert.ok(names.some((n) => n.endsWith('js/site.js')), 'the site deployed');
  assert.ok(!names.some((n) => n.includes('/app/')),
    `the unreleased app must not be published: ${names.join(', ')}`);
});

test('once released, the app IS published', () => {
  const fx = setup({
    'index.html': '<html>root</html>',
    'app/index.html': '<html>app</html>',
    'app/current-version.txt': 'v1\n',
    'app/RELEASED_VERSIONS': 'v1\n',
    'app/v1/app.css': 'css',
  });
  const { code, uploads } = runDeploy(fx);
  assert.equal(code, 0);
  const names = uploads.map((u) => u.replace(/^ftp:\/\/[^/]+\//, ''));
  assert.ok(names.some((n) => n.includes('/app/v1/app.css')));
  assert.ok(names.some((n) => n.endsWith('/app/index.html')));
});
