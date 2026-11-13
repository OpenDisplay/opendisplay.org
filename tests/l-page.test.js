// The /l/ page's inline script with a stub DOM: the setup grammar (f=…) shows the setup view
// with a Toolbox link and the page rules' texts; the legacy boot-screen token keeps its old view.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'httpdocs');
const html = fs.readFileSync(path.join(ROOT, 'l', 'index.html'), 'utf8');
const inline = html.match(/<script>([\s\S]*?)<\/script>/g).pop().replace(/^<script>|<\/script>$/g, '');

function el(id) {
  return { id, hidden: false, textContent: '', innerHTML: '', href: '', style: {}, dataset: {}, title: '', value: '',
    classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, appendChild(c) { return c; }, setAttribute() {},
    querySelector() { return el('q'); }, replaceWith() {}, remove() {} };
}
function load(href) {
  const els = new Map();
  const get = id => { if (!els.has(id)) els.set(id, el(id)); return els.get(id); };
  const fetched = [];
  const u = new URL(href);
  const ctx = {
    console: { log() {}, error() {} }, atob: globalThis.atob, btoa: globalThis.btoa, setTimeout: () => 0, clearTimeout() {}, URL, URLSearchParams,
    navigator: { userAgent: 'node', bluetooth: undefined },
    window: null,
    document: { getElementById: get, querySelector: sel => get('sel:' + sel), querySelectorAll: () => [], createElement: () => el('new'), title: '', addEventListener() {} },
    QRCode: function () { this.makeCode = () => {}; this.clear = () => {}; },
    fetch: f => { fetched.push(f); return new Promise(() => {}); }
  };
  ctx.window = Object.assign(ctx, { location: { href: u.href, search: u.search, origin: u.origin, pathname: u.pathname }, history: { replaceState() {} } });
  vm.createContext(ctx);
  for (const f of ['od-texts.js', 'od-setup-url.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), ctx);
  vm.runInContext(inline, ctx);
  return { get, ctx, fetched };
}

test('setup URL (k=2): reset text, genuine-domain note, Toolbox link with the name and no key', () => {
  const w = load('https://opendisplay.org/l/?f=1&k=2&i=1A2B3C&t=3&v=3.0.0&b=16&d=10&p=2');
  assert.equal(w.get('setup').hidden, false);
  assert.equal(w.get('actions').hidden, true);
  assert.equal(w.get('actions-heading').hidden, true);
  assert.equal(w.get('display-name').textContent, 'OD1A2B3C');
  assert.match(w.get('setup-kind').textContent, /reset to factory settings/);
  assert.match(w.get('setup-genuine').textContent, /Only https:\/\/opendisplay.org\/l\/ is genuine/);
  const go = new URL(w.get('setup-go').href);
  assert.equal(go.searchParams.get('device'), 'OD1A2B3C');
  assert.equal(go.searchParams.get('kind'), 'reset');
  assert.equal(w.get('sel:.lp h1').textContent, 'Set up this display again');
  assert.deepEqual(w.fetched.sort(), ['../firmware/toolbox/simple-config-id-registry.json', '../firmware/toolbox/simple-config-presets.json']);
  assert.equal(w.get('display-key').textContent, '', 'no key shown');
});

test('setup URL served from another origin (local preview, staging): still the setup view', () => {
  const w = load('http://localhost:8000/l/?f=1&k=1&i=1A2B3C&t=3&v=3.0.0&b=16&d=10&p=2');
  assert.equal(w.get('setup').hidden, false);
  assert.equal(w.get('display-name').textContent, 'OD1A2B3C');
  assert.equal(new URL(w.get('setup-go').href).searchParams.get('device'), 'OD1A2B3C');
});

test('a newer format: the generic text and no preselection', () => {
  const w = load('https://opendisplay.org/l/?f=4&k=1&i=00ABCD&b=16');
  assert.match(w.get('setup-newer').textContent, /newer setup code/);
  assert.equal(new URL(w.get('setup-go').href).searchParams.get('driver'), null);
  assert.deepEqual(w.fetched, []);
});

test('firmware below 3: the Toolbox note', () => {
  const w = load('https://opendisplay.org/l/?f=1&k=1&i=00ABCD&v=2.5.0');
  assert.match(w.get('setup-old').textContent, /2\.x has no setup screen/);
});

test('the [hidden] attribute wins over the page\'s own display rules', () => {
  assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test('the legacy boot-screen link keeps its view', () => {
  const key = Buffer.from([0x00, 0x02, 0x1a, 0x2b, 0x3c, ...new Array(16).fill(0x11), 0x00, 0x01]).toString('base64url');
  const w = load('https://opendisplay.org/l/?' + key);
  assert.equal(w.get('actions').hidden, false, 'the normal actions stay');
  assert.equal(w.get('actions-heading').hidden, false);
  assert.equal(w.get('display-name').textContent, 'OD1A2B3C');
  assert.match(w.get('display-key').textContent, /1111/);
});
