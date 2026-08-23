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
  'app/v1/app.css': 'css',
  'app/v1/js/main.js': 'js',
  'js/ble-common.js': 'lib',
};

test('first deploy: all assets upload before any html; manifest last', () => {
  const fx = setup(FILES);
  const { code, uploads } = runDeploy(fx);
  assert.equal(code, 0);
  const names = uploads.map((u) => u.replace(/^ftp:\/\/[^/]+\//, ''));
  const firstHtml = names.findIndex((n) => n.endsWith('.html'));
  const lastAsset = names.reduce(
    (acc, n, i) => (!n.endsWith('.html') && !n.startsWith('.opendisplay') ? i : acc),
    -1,
  );
  assert.ok(firstHtml > lastAsset, `html before asset: ${names.join(', ')}`);
  assert.ok(names.at(-1).includes('.opendisplay-deploy-manifest'), 'manifest uploaded last');
});

test('failed asset upload blocks ALL html publication', () => {
  const fx = setup(FILES);
  const { code, uploads } = runDeploy(fx, { failPattern: 'main\\.js' });
  assert.notEqual(code, 0);
  const names = uploads.map((u) => u.replace(/^ftp:\/\/[^/]+\//, ''));
  assert.ok(!names.some((n) => n.endsWith('.html')), `html was published: ${names.join(', ')}`);
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
