# Design: canvas view rotation + photo rotation

Two rotation features for the Web OD App composer. They sound similar and are
deliberately built as opposites, so the first thing to fix is which side of the
line each falls on:

| | **A. Canvas view rotation** | **B. Photo rotation** |
|---|---|---|
| What turns | how the artboard is *presented* | the image *inside* a photo layer |
| Reaches the panel? | **never** | yes — it is part of the composition |
| Lives in | the device record (a per-tag UI preference) | the photo layer (part of the document) |
| Undoable? | no — it is a view setting, not an edit | yes, like any other layer edit |
| Affects `panelSignature`? | no | no (the panel is unchanged; the pixels differ) |

There is already a `rotationQuarterTurns` on the device record. **That one is
hardware.** It comes from the config read (`ble-adapter.js` →
`display.rotation & 0x03`), it swaps the artboard's width and height
(`model.artboardSize`), it is part of `panelSignature`, and it is handed to the
encoder at send time. Feature A must not touch it, must not be confused with
it, and must not be named like it.

---

## A. Canvas view rotation

### Intent

Turn the canvas 90° left or right on screen so the user can work in the
orientation the tag is actually mounted in. Purely presentational: the same
bytes go to the panel either way.

### Where the state lives

A new device-record field, `viewRotationQuarterTurns` (0–3, default 0), set via
the existing `store.updateDevice`.

- **Per device, not per draft.** How a tag is mounted on the wall is a property
  of the tag, and it should still be right when a different draft is opened.
- **Not in the undo history.** Rotating the view is not an edit to the
  composition; putting it in the history would make Undo mean two different
  things.
- **Excluded from export.** `sanitiseImported` builds from a field whitelist so
  it would be dropped on *import* anyway — but `exportDevices` copies every
  property except `bleId`, so without a change it would still appear in the
  exported JSON. It is a per-browser viewing preference exactly like `bleId`,
  so it gets stripped alongside it.
- One caveat to respect: `updateDevice` is a blind read-modify-write inside one
  transaction. That is safe here, but the write must carry *only* the rotation
  patch — never a stale copy of the panel facts.

### How it is applied — and why that is the safety argument

**A CSS transform on the canvas wrapper. Nothing else.**

```
.composer__canvaswrap[data-view-rot="1"] > canvas { transform: rotate(90deg); }
```

Both canvases (render + overlay) sit in the wrapper and rotate together. The
backing stores stay panel-resolution and panel-oriented; `renderDocument`,
`paintForSend`, the dither worker and the encoder never learn the view rotation
exists. That is the whole point: the guarantee that this cannot change what
lands on the device is *structural*, not a promise to be careful. A test will
assert that `renderDocument` produces byte-identical output at every view
rotation, but the design is what makes that true.

Layout mechanics:

- The wrapper gets the **rotated** box (H×W for quarter turns 1 and 3). Both
  canvases keep the **unrotated** W×H CSS size and are centred with
  `position:absolute; left:50%; top:50%; transform: translate(-50%,-50%) rotate(Ndeg)`.
  This is not a one-selector change: today the render canvas is
  `width:100%;height:100%` of the wrapper and the overlay is `inset:0` plus
  `100%/100%`, so simply adding a transform would stretch the canvas to the
  rotated footprint *before* rotating it and would misalign the overlay against
  it. Both existing rules have to be overridden, and both canvases must be
  given identical size, position and transform — they are only guaranteed to
  stay registered with each other if they are laid out by the same rule.
  JS writes the two pixel sizes (via custom properties) and the rotation index
  (via a `data-` attribute); CSS does the rest.
- `fitCanvasToStage()` must fit the **rotated** aspect into the stage, or a
  portrait view of a landscape panel will overflow.
- `screenScale()` currently divides the **wrapper's** width by the panel width.
  After an odd turn the wrapper's width is the panel's *height* axis, so it
  must measure the canvas instead: `canvas.clientWidth / W` is the untransformed
  layout size and stays on the right axis at every rotation. Getting this wrong
  does not fail loudly — it silently rescales the selection chrome and the
  handle hit boxes.
- `handleSize()` needs **no change**. Its per-axis normalized values are
  converted straight back through `W` and `H` in `paintOverlay`, producing a
  square in the backing store; a uniform CSS rotation preserves a square.
  Swapping the components would *introduce* a non-square handle on a
  non-square panel. (This was wrong in the first draft of this plan.)

### The risky part: pointer coordinates

`makeSurface.toNorm()` maps client coordinates to normalized artboard
coordinates using the canvas's `getBoundingClientRect()`. Under a CSS rotation
that rect is the **axis-aligned bounding box of the rotated element**, so the
naive mapping is wrong for every non-zero rotation, and wrong in a way that
still "works" enough to be believed (drags move, just along the wrong axis).

The fix is to measure against the wrapper and apply the inverse quarter turn
explicitly:

```
u = (clientX - wrapRect.left) / wrapRect.width      // view space, may be <0 or >1
v = (clientY - wrapRect.top)  / wrapRect.height
rot 0: (x, y) = (u, v)
rot 1: (x, y) = (v, 1 - u)
rot 2: (x, y) = (1 - u, 1 - v)
rot 3: (x, y) = (1 - v, u)
```

The values must stay unclamped — elements are allowed to bleed off the edge,
and clamping here would pin every drag at the boundary.

The convention: **"rotate right" increments the index and applies CSS
`rotate(90deg)`**, which (CSS rotates clockwise, y points down) moves the
panel's top edge to the view's right edge and its top-left corner to the view's
top-right. Forward is `(u,v) = (1-y, x)`; the table above is its inverse.

The rotation in force must be **captured at `pointerdown` and used for the whole
gesture**. Pointer capture keeps a drag alive across a rotation, and changing
the mapping mid-gesture would make the layer jump.

This mapping is exactly the kind of thing that is easy to get backwards, so it
gets the same treatment the panel rotation already has: a **hand-authored
oracle test** in the style of `tests/webapp/rotation-oracle.test.mjs`, with the
expected panel coordinate for each corner enumerated by hand at each rotation,
rather than derived from the same formula it is checking.

### What the user sees

- Two buttons, ⟲ / ⟳, in the composer action row, with the current rotation
  reflected in `composerPanelInfo` when it is non-zero, worded so a rotated
  *view* can never be mistaken for a rotated *panel*.
- Persisted per device, restored on open.
- Deliberately **not** in the undo stack.

### Applying it must not go through `paint()`

`paint()` drops `latestDither` and invalidates the worker's outstanding renders,
so routing a view rotation through it would disable Send and spend a full panel
re-render on an operation that changes no pixels. Rotating needs a
presentation-only path: re-fit the wrapper and canvases, repaint the **overlay**,
update the info line. The dithered preview already in the backing store stays
valid and rotates with it.

### Cache lifecycle (the part that actually bites)

The record is cached in three places and the plan has to say what happens to
each:

- `session.setDevice` accepts any record with a matching `recordId` — there is
  no owner or generation guard. So the write must patch **only**
  `viewRotationQuarterTurns` into the cached copy rather than install a whole
  record returned from an await.
- Every async step (the `updateDevice` write, any re-read) must capture `owner`
  and its generation and check `isCurrent()` before touching state, or a result
  can land in a session that replaced the one that asked for it.
- Device *cards* capture the record as it was when the list was rendered, and
  `openComposer` trusts that object. Rotate A, open B, then reopen A from the
  unchanged card and A comes back at the stale preference. `openComposer` must
  re-read the record rather than trust the captured one.
- Persist first, then apply — or define what happens when the write fails.

None of this can send wrong geometry: `prepareSend` re-reads the authoritative
record and compares `panelSignature`, and `updateDevice` merges inside a single
read-write transaction so a view patch cannot erase hardware truth. The failure
mode is a wrong or stale *view*, which is worth getting right on its own terms.

### Interaction notes

- Resize handles keep working: `resizeBox` operates in panel space, so a handle
  that visually reads as "top-left" at 90° is the panel's bottom-left and
  resizes consistently with what is drawn. No special-casing.
- The dithered preview blits into the same canvas, so it rotates for free.
- The tests' own pointer helpers (`composer-ui.test.mjs`, `offline-compose`)
  compute client coordinates from the canvas rect; they will need the same
  wrapper-based mapping if any test drives a rotated view.

### Tests

1. Oracle: view-space → panel-space for all four rotations, corners by hand.
2. `renderDocument` output is byte-identical at all four view rotations.
3. A send prepared under a rotated view produces the same frame and the same
   `panelSignature` as one prepared unrotated.
4. Browser: rotate, drag an element with real pointer events, assert it moved
   along the axis the *user* pushed it, not the panel's.
5. The preference survives closing and reopening the composer.

---

## B. Photo rotation

### Intent

Rotate a photo in 90° steps after importing it — including one that was just
pasted or dropped, which is the case that prompted this.

EXIF orientation is already applied at decode (`decodeBounded` uses
`imageOrientation: 'from-image'`), so this is a user-facing rotation *on top of*
a correctly-oriented source, not a fix for sideways phone photos.

### Model

Add `rotationQuarterTurns` (0–3, default 0) to `photoLayer`. Existing drafts
have no such field and default to 0; `validateDocument` rejects out-of-range
values the way it already rejects illegal ink.

**The rotation happens inside the layer box.** The box (`x, y, w, h`) does not
turn. That keeps `layerBounds`, hit-testing, the resize handles and the bleed
rule completely unchanged — a decision worth making explicitly, because
rotating the box instead would ripple through every one of them.

### Render

In `drawPhoto`, rotate about the box centre before drawing:

Getting the axes right here is the whole job, and the first draft of this plan
had it backwards. `dw`/`dh` are the destination size passed to `drawImage` **in
the source image's own axes**; the context rotation is what turns that into the
visible footprint. So:

- **cover / contain** — compute the fit *scale* against the **oriented**
  dimensions (`bitmap.height × bitmap.width` for an odd turn), because that is
  the footprint that has to cover or fit the box. Then still draw at
  `bitmap.width * scale × bitmap.height * scale`. Scale from the oriented
  dimensions, draw in the source's.
- **none** — draw at `srcW × srcH`, unswapped. The rotation produces the
  `srcH × srcW` footprint by itself. Swapping first *and* rotating applies the
  turn twice and changes the aspect ratio.

`srcW`/`srcH` are already recorded in display (EXIF-applied) orientation at
import, so no orientation correction belongs here.
- The adjusted path draws into an offscreen scratch canvas sized to the box and
  then composites. The rotation has to be applied **inside** that scratch
  canvas, not to the composite, or an adjusted photo will rotate and an
  unadjusted one will not.

`renderDocument` is shared by the editor, the dither worker and the send path,
so all three pick this up from one change.

### What the user sees

- ⟲ / ⟳ buttons in the Photo panel, acting on the selected photo layer, each a
  single undo step.
- After an import (picker, drop or paste) the composer switches to the Photo
  chip, so the rotate controls are in front of the user for the photo they just
  added instead of two clicks away.

### Tests

1. Each quarter turn rotates the drawn pixels (an asymmetric fixture, so 180°
   is distinguishable from 0°).
2. cover/contain use the rotated aspect: a portrait source in a landscape box
   at 90° fills it, where at 0° it letterboxes.
3. "none" at 90° occupies an `srcH × srcW` footprint, and its **crop geometry**
   is the same for a proxy bitmap and a 2× bitmap. Note the existing test
   asserts byte identity, which only works because its fixture is a solid
   colour: two decodes at different resolutions resample differently and are
   not required to match pixel for pixel. The rotation test asserts the drawn
   region's bounding box instead, which is the claim that is actually being
   made.
4. An adjusted photo and an unadjusted one rotate identically.
5. Rotation does not move the layer box: bounds, hit-test and handle positions
   are unchanged.
6. A draft saved before this feature loads with rotation 0 and renders exactly
   as it did.

---

## Sequencing

1. **B first.** It is self-contained, lives entirely in the model and the
   renderer, and has no interaction with the view transform.
2. **A second**, in two steps: the transform and layout (visible, low risk),
   then the pointer mapping with its oracle test (invisible, higher risk).
3. Codex review after each.

## Risks

- **The pointer mapping is the one thing that can silently be wrong.** It
  degrades to "drags work but along the wrong axis", which is easy to accept as
  correct while clicking around. Hence the hand-authored oracle rather than a
  formula-derived fixture.
- **Two rotations in the same UI.** `rotationQuarterTurns` already exists on the
  device and means something completely different. Naming, the info line, and
  the tests all need to keep them apart; a reviewer should be pointed at this
  specifically.
- **`screenScale` is axis-sensitive** and will produce plausible-but-wrong
  handle sizes and hit boxes under a quarter turn rather than failing loudly.
- **The photo-rotation axis convention** is easy to apply twice (scale from the
  oriented dimensions, draw in the source's). A square test fixture would hide
  it completely, so the fixtures must be non-square.
- **The send decode is capped at 2× the panel's longest edge**
  (`decodeForPanel`), not full resolution. That can under-resolve a `none` crop
  or an extreme-aspect `cover` crop. Pre-existing, not introduced here, but it
  is why the invariance claim is about geometry rather than pixels.
- **Hardware qualification is still outstanding** for everything in this app
  (`docs/webapp-hardware-qualification.md`); neither feature changes that, and
  feature A is specifically designed so it cannot make it worse.
