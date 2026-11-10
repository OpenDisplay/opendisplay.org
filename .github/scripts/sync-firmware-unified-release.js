#!/usr/bin/env node
/*
 * Sync a Firmware_Unified (3.x) release into httpdocs/firmware/toolbox/v3/.
 * 2.x (OpenDisplay/Firmware) keeps its own sync-firmware-release.sh and paths; this never
 * writes outside v3/.
 *
 *   node .github/scripts/sync-firmware-unified-release.js                 # latest published release (network)
 *   node .github/scripts/sync-firmware-unified-release.js --tag v3.0.0    # a given tag (network)
 *   node .github/scripts/sync-firmware-unified-release.js \
 *        --manifest path/manifest.json --assets-dir path/   [--out dir]  # offline, from local files
 *
 * --tag accepts `3.0.0` or `v3.0.0` (both are tried). Writes `changed=true|false` and `tag=` to
 * $GITHUB_OUTPUT. Contract: Firmware_Unified docs/RELEASE_ARTEFACTS.md; see lib/unified-release.js.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { REPOSITORY, planSync, validateWebManifest, artefactFor, bareVersion } = require('./lib/unified-release.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : null;
}
function output(k, v) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}
async function getJson(url) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'opendisplay-site-sync' };
  if (process.env.GH_TOKEN) headers.Authorization = 'Bearer ' + process.env.GH_TOKEN;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
async function getBytes(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'opendisplay-site-sync' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function main() {
  const outDir = path.resolve(arg('out') || path.join(REPO_ROOT, 'httpdocs', 'firmware', 'toolbox', 'v3'));
  const localManifest = arg('manifest');
  const assetsDir = arg('assets-dir');
  let manifest, release = {}, fetchAsset;

  if (localManifest) {
    manifest = JSON.parse(fs.readFileSync(localManifest, 'utf8'));
    const dir = assetsDir || path.dirname(localManifest);
    fetchAsset = async name => fs.readFileSync(path.join(dir, name));
  } else {
    const tag = arg('tag');
    // Drafts are invisible to /releases/latest, which is what we want: only published releases ship.
    const base = `https://api.github.com/repos/${REPOSITORY}/releases/`;
    if (!tag) release = await getJson(base + 'latest');
    else {
      // The contract allows either tag form; try the one given, then the other.
      const forms = [tag, /^v/i.test(tag) ? bareVersion(tag) : 'v' + tag];
      let last;
      for (const t of forms) {
        try { release = await getJson(base + 'tags/' + encodeURIComponent(t)); last = null; break; } catch (e) { last = e; }
      }
      if (last) throw last;
    }
    const assets = new Map((release.assets || []).map(a => [a.name, a.browser_download_url]));
    if (!assets.has('manifest.json')) throw new Error(`release ${release.tag_name} has no manifest.json; refusing to guess its files`);
    manifest = JSON.parse((await getBytes(assets.get('manifest.json'))).toString('utf8'));
    fetchAsset = async name => {
      if (!assets.has(name)) throw new Error(`manifest names ${name}, which is not attached to release ${release.tag_name}`);
      return getBytes(assets.get(name));
    };
  }

  const prev = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(outDir, 'firmware-version.json'), 'utf8')); } catch (e) { return null; }
  })();
  const plan = planSync(manifest, release);
  if (prev && prev.version === manifest.version && !arg('force')) {
    console.log(`Already synced to ${manifest.version}`);
    output('changed', 'false');
    return;
  }
  plan.warnings.forEach(w => console.warn('warning: ' + w));

  // Fetch and check everything in memory first, so a bad release leaves v3/ untouched.
  const got = new Map();
  for (const name of plan.downloads) {
    const buf = await fetchAsset(name);
    const info = artefactFor(manifest, name);
    if (info && info.sha256 && sha256(buf) !== info.sha256) throw new Error(`${name}: sha256 mismatch`);
    if (info && Number.isInteger(info.size) && buf.length !== info.size) throw new Error(`${name}: size ${buf.length} != ${info.size}`);
    got.set(name, buf);
  }
  // The upstream esp-web-tools manifests are used as shipped, so check them before anything points at them.
  for (const wm of plan.webManifests) {
    const json = JSON.parse(got.get(wm.file).toString('utf8'));
    const errs = validateWebManifest(json, wm.flow, manifest.artefacts, wm.kind);
    if (errs.length) throw new Error(`${wm.file}: ${errs.join('; ')}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, buf] of got) {
    fs.writeFileSync(path.join(outDir, name), buf);
    console.log(`  ${name} -> ${path.relative(REPO_ROOT, outDir)}/`);
  }
  for (const [rel, json] of Object.entries(plan.outputs)) {
    fs.writeFileSync(path.join(outDir, rel), JSON.stringify(json, null, 2) + '\n');
  }
  console.log(`Synced Firmware_Unified ${manifest.version} (${plan.downloads.length} files)`);
  output('changed', 'true');
  output('tag', plan.outputs['index.json'].tag);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
