// Canvas VIEW rotation — the presentational quarter turn.
//
// Two things are being defended here, and they are different in kind:
//
//   1. The coordinate mapping, which is easy to get backwards in a way that
//      still looks like it works (drags move, just along the wrong axis). It
//      gets a HAND-AUTHORED oracle: the expected panel coordinate for each
//      corner at each rotation is written out by hand, not derived from the
//      formula under test. Deriving the fixture from the implementation would
//      make a mirrored or inverted convention pass.
//
//   2. That the view rotation cannot reach the panel. renderDocument is the
//      single entry point for the editor, the dither worker and the send path,
//      and it takes no view rotation at all — so the proof is that its output
//      is byte-identical whatever the view is doing, and that panelSignature
//      is unmoved.
//
// Convention under test: "rotate right" increments the index and applies CSS
// `rotate(90deg)`. CSS rotates clockwise with y pointing down, so the panel's
// top-left corner lands at the view's TOP-RIGHT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppModule } from './lib/load-app-module.mjs';

const canvas = await loadAppModule('composer/canvas.js');
const send = await loadAppModule('composer/send.js');

// Hand-enumerated: for each rotation, where each PANEL corner appears in VIEW
// space. Read it as "the panel's top-left corner is at the view's ...".
//
//   rot 0            rot 1 (right)     rot 2             rot 3 (left)
//   TL  TR           BL  TL            BR  BL            TR  BR
//   BL  BR           BR  TR            TR  TL            TL  BL
//
// i.e. at rot 1 the panel's top-left is the view's top-right, and the panel's
// top edge runs down the view's right-hand side.
const PANEL_CORNERS = {
  TL: { x: 0, y: 0 },
  TR: { x: 1, y: 0 },
  BR: { x: 1, y: 1 },
  BL: { x: 0, y: 1 },
};
const VIEW_CORNERS = {
  TL: { u: 0, v: 0 },
  TR: { u: 1, v: 0 },
  BR: { u: 1, v: 1 },
  BL: { u: 0, v: 1 },
};

/** rotation -> { panelCorner: viewCorner } */
const ORACLE = {
  0: { TL: 'TL', TR: 'TR', BR: 'BR', BL: 'BL' },
  1: { TL: 'TR', TR: 'BR', BR: 'BL', BL: 'TL' },
  2: { TL: 'BR', TR: 'BL', BR: 'TL', BL: 'TR' },
  3: { TL: 'BL', TR: 'TL', BR: 'TR', BL: 'BR' },
};

test('view -> panel mapping matches the hand-written oracle at every rotation', () => {
  for (const [rot, table] of Object.entries(ORACLE)) {
    for (const [panelName, viewName] of Object.entries(table)) {
      const { u, v } = VIEW_CORNERS[viewName];
      const got = canvas.viewToPanel(u, v, Number(rot));
      assert.deepEqual(
        { x: +got.x.toFixed(9), y: +got.y.toFixed(9) },
        PANEL_CORNERS[panelName],
        `rot ${rot}: view ${viewName} should be panel ${panelName}, got ${JSON.stringify(got)}`,
      );
    }
  }
});

test('rotate RIGHT puts the panel top-left at the view top-right', () => {
  // The single sentence that fixes the direction. If this flips, the whole
  // convention has flipped with it.
  const { u, v } = canvas.panelToView(0, 0, 1);
  assert.deepEqual({ u, v }, { u: 1, v: 0 });
  // And "left" (3) is its opposite, not its twin.
  assert.deepEqual(canvas.panelToView(0, 0, 3), { u: 0, v: 1 });
});

test('panelToView and viewToPanel are inverses at every rotation', () => {
  for (let rot = 0; rot < 4; rot++) {
    for (const p of [{ x: 0.13, y: 0.79 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 0.5 }]) {
      const { u, v } = canvas.panelToView(p.x, p.y, rot);
      const back = canvas.viewToPanel(u, v, rot);
      assert.ok(Math.abs(back.x - p.x) < 1e-9 && Math.abs(back.y - p.y) < 1e-9,
        `rot ${rot} round-trip of ${JSON.stringify(p)} gave ${JSON.stringify(back)}`);
    }
  }
});

test('the mapping does NOT clamp — elements may be dragged into the bleed', () => {
  // A pointer past the edge of the canvas is normal now: pointer capture keeps
  // delivering, and layers are allowed to hang off. Clamping here would pin
  // every drag at the boundary.
  const out = canvas.viewToPanel(1.4, -0.3, 0);
  assert.equal(out.x, 1.4);
  assert.equal(out.y, -0.3);
  const turned = canvas.viewToPanel(1.4, -0.3, 1);
  assert.equal(turned.x, -0.3);
  assert.ok(turned.y < 0, 'and stays outside after the turn');
});

test('four rights (or four lefts) is the identity', () => {
  let rot = 0;
  for (let i = 0; i < 4; i++) rot = (rot + 1) % 4;
  assert.equal(rot, 0);
  assert.deepEqual(canvas.viewToPanel(0.3, 0.7, rot), { x: 0.3, y: 0.7 });
  // Out-of-range indices are masked, not thrown at: the field is persisted and
  // could come back as anything.
  assert.deepEqual(canvas.viewToPanel(0.3, 0.7, 8), canvas.viewToPanel(0.3, 0.7, 0));
  assert.deepEqual(canvas.viewToPanel(0.3, 0.7, 5), canvas.viewToPanel(0.3, 0.7, 1));
});

test('the view rotation is absent from the panel signature', () => {
  // Not a field it could ever read — asserted anyway, because the day someone
  // adds it to panelSignature is the day a rotated view starts changing what
  // the encoder is asked to produce.
  const panel = {
    width: 800, height: 480, rotationQuarterTurns: 1, colorScheme: 4, panelIcType: 35,
  };
  const base = send.panelSignature(panel);
  for (const viewRotationQuarterTurns of [0, 1, 2, 3]) {
    assert.equal(send.panelSignature({ ...panel, viewRotationQuarterTurns }), base);
  }
  // The HARDWARE rotation is a different field and must still matter.
  assert.notEqual(send.panelSignature({ ...panel, rotationQuarterTurns: 2 }), base);
});
