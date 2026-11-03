// Gesture arbitration: who owns the pointer, and what a sequence becomes.
//
// These are the interleavings that corrupt a document if they are wrong, and
// they are miserable to reproduce through DOM callbacks — which is exactly why
// the router is DOM-free. Before it existed, makeSurface tracked a single
// `dragging` boolean and never read pointerId, so a second finger on any
// touchscreen re-entered beginGesture (resetting the undo base and discarding
// the first finger's edit) and the first finger up could commit half a gesture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppModule } from './lib/load-app-module.mjs';

const { createGestureRouter } = await loadAppModule('composer/gestures.js');

/** A router that records what it was asked to do, in order. */
function spy() {
  const log = [];
  const router = createGestureRouter({
    onToolDown: (pt) => log.push(['down', pt.x, pt.y]),
    onToolMove: (pt) => log.push(['move', pt.x, pt.y]),
    onToolUp: (pt) => log.push(['up', pt.x, pt.y]),
    onToolCancel: () => log.push(['cancel']),
    onZoomStart: (g) => log.push(['zoomStart', +g.anchor.x.toFixed(3), +g.anchor.y.toFixed(3)]),
    onZoomMove: (g) => log.push(['zoomMove', +g.ratio.toFixed(3)]),
    onZoomEnd: () => log.push(['zoomEnd']),
  });
  return { router, log, names: () => log.map((e) => e[0]) };
}

const T = 'touch';

test('one pointer drives the tool, start to finish', () => {
  const { router, names, log } = spy();
  router.down(1, { x: 0.1, y: 0.1 }, { x: 10, y: 10 }, T);
  router.move(1, { x: 0.2, y: 0.2 }, { x: 20, y: 20 });
  router.up(1, { x: 0.2, y: 0.2 }, { x: 20, y: 20 });
  assert.deepEqual(names(), ['down', 'move', 'up']);
  assert.deepEqual(log[0], ['down', 0.1, 0.1]);
  assert.equal(router._state().mode, 'idle');
});

test('a second finger CANCELS the tool gesture — it never commits', () => {
  const { router, names } = spy();
  router.down(1, { x: 0.1, y: 0.1 }, { x: 10, y: 10 }, T);
  router.move(1, { x: 0.3, y: 0.3 }, { x: 30, y: 30 });
  router.down(2, { x: 0.7, y: 0.7 }, { x: 70, y: 70 }, T);
  // Cancel, not up: calling the tool's onUp would commit the half-drag.
  assert.deepEqual(names(), ['down', 'move', 'cancel', 'zoomStart']);
  assert.equal(names().includes('up'), false);
});

test('the pinch ratio comes from CLIENT distance, not normalized points', () => {
  // Normalized space is anisotropic on a non-square panel, and its axes swap
  // under a quarter-turn view rotation, so a normalized ratio would give the
  // wrong magnification for a pinch that rotates as it scales.
  const { router, log } = spy();
  router.down(1, { x: 0, y: 0 }, { x: 0, y: 0 }, T);
  router.down(2, { x: 1, y: 0 }, { x: 100, y: 0 }, T);   // 100px apart
  router.move(2, { x: 1, y: 0 }, { x: 200, y: 0 });      // now 200px
  const zoom = log.filter((e) => e[0] === 'zoomMove');
  assert.deepEqual(zoom.at(-1), ['zoomMove', 2]);

  // A pinch that ROTATES without changing distance must not scale.
  router.move(2, { x: 0, y: 1 }, { x: 0, y: 200 });      // still 200px, turned
  assert.deepEqual(log.filter((e) => e[0] === 'zoomMove').at(-1), ['zoomMove', 2]);
});

test('the anchor is the midpoint of the two pointers, in panel space', () => {
  const { router, log } = spy();
  router.down(1, { x: 0.2, y: 0.4 }, { x: 20, y: 40 }, T);
  router.down(2, { x: 0.6, y: 0.8 }, { x: 60, y: 80 }, T);
  assert.deepEqual(log.find((e) => e[0] === 'zoomStart'), ['zoomStart', 0.4, 0.6]);
});

test('preemption is STICKY: the surviving finger does not resume anything', () => {
  const { router, names } = spy();
  router.down(1, { x: 0.1, y: 0.1 }, { x: 10, y: 10 }, T);
  router.down(2, { x: 0.9, y: 0.9 }, { x: 90, y: 90 }, T);
  router.up(2, { x: 0.9, y: 0.9 }, { x: 90, y: 90 });
  assert.equal(router._state().mode, 'dead', 'a pointer is still down, and it owns nothing');
  // Everything the survivor does is inert.
  router.move(1, { x: 0.5, y: 0.5 }, { x: 50, y: 50 });
  router.up(1, { x: 0.5, y: 0.5 }, { x: 50, y: 50 });
  assert.deepEqual(names(), ['down', 'cancel', 'zoomStart', 'zoomEnd']);
  assert.equal(router._state().mode, 'idle', 'and the sequence ends cleanly');
});

test('a fresh gesture works normally once every pointer is up', () => {
  const { router, names } = spy();
  router.down(1, { x: 0.1, y: 0.1 }, { x: 10, y: 10 }, T);
  router.down(2, { x: 0.9, y: 0.9 }, { x: 90, y: 90 }, T);
  router.up(1, { x: 0.1, y: 0.1 }, { x: 10, y: 10 });
  router.up(2, { x: 0.9, y: 0.9 }, { x: 90, y: 90 });
  router.down(3, { x: 0.5, y: 0.5 }, { x: 50, y: 50 }, T);
  router.up(3, { x: 0.5, y: 0.5 }, { x: 50, y: 50 });
  assert.deepEqual(names(), ['down', 'cancel', 'zoomStart', 'zoomEnd', 'down', 'up']);
});

test('a third finger changes nothing', () => {
  const { router, names } = spy();
  router.down(1, { x: 0.1, y: 0.1 }, { x: 10, y: 10 }, T);
  router.down(2, { x: 0.9, y: 0.9 }, { x: 90, y: 90 }, T);
  const before = names().length;
  router.down(3, { x: 0.5, y: 0.5 }, { x: 50, y: 50 }, T);
  assert.equal(names().length, before, 'no second zoomStart, no cancel');
});

test('a mouse cannot start a pinch', () => {
  const { router, names } = spy();
  router.down(1, { x: 0.1, y: 0.1 }, { x: 10, y: 10 }, 'mouse');
  router.down(2, { x: 0.9, y: 0.9 }, { x: 90, y: 90 }, 'mouse');
  assert.equal(names().includes('zoomStart'), false, 'two mice are not a pinch');
  assert.equal(names().includes('cancel'), false, 'and the first gesture is left alone');
});

test('two fingers landing on the same spot do not divide by zero', () => {
  const { router, names } = spy();
  router.down(1, { x: 0.5, y: 0.5 }, { x: 50, y: 50 }, T);
  router.down(2, { x: 0.5, y: 0.5 }, { x: 50, y: 50 }, T);
  assert.equal(names().includes('zoomStart'), false, 'no baseline to scale from');
  assert.equal(router._state().mode, 'dead', 'and the tool gesture is still cancelled');
  router.move(2, { x: 0.9, y: 0.9 }, { x: 90, y: 90 });
  assert.equal(names().filter((n) => n === 'zoomMove').length, 0);
});

test('pointercancel discards, never commits', () => {
  const { router, names } = spy();
  router.down(1, { x: 0.1, y: 0.1 }, { x: 10, y: 10 }, T);
  router.move(1, { x: 0.4, y: 0.4 }, { x: 40, y: 40 });
  router.cancel(1);
  assert.deepEqual(names(), ['down', 'move', 'cancel']);
  assert.equal(router._state().mode, 'idle');
});

test('cancelling one half of a pinch ends the zoom', () => {
  const { router, names } = spy();
  router.down(1, { x: 0.1, y: 0.1 }, { x: 10, y: 10 }, T);
  router.down(2, { x: 0.9, y: 0.9 }, { x: 90, y: 90 }, T);
  router.cancel(2);
  assert.deepEqual(names().at(-1), 'zoomEnd');
  assert.equal(router._state().mode, 'dead');
});

test('moves from a pointer the router never saw are ignored', () => {
  const { router, names } = spy();
  router.move(9, { x: 0.5, y: 0.5 }, { x: 50, y: 50 });
  router.up(9, { x: 0.5, y: 0.5 }, { x: 50, y: 50 });
  assert.deepEqual(names(), []);
});
