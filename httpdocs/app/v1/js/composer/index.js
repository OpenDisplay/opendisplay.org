/*
 * composer/index.js — composer view controller (M2).
 * Owns DOM wiring and history; document logic lives in model/tools/render.
 * Dithering + send arrive in M3 (the preview is currently the ideal-palette
 * composite, which is already exactly what the encoder will consume).
 */
import * as model from './model.js';
import * as tools from './tools.js';
import { renderDocument } from './render.js';
import { makeSurface, blitPreview } from './canvas.js';
import * as store from '../store.js';

const $ = (id) => document.getElementById(id);

const state = {
  history: null,
  device: null,
  draftId: null,
  bitmaps: new Map(), // assetId -> ImageBitmap (main-thread resolved)
  tool: null,
  selectTool: null,
  saveTimer: null,
};

function doc() {
  return state.history.present;
}

function apply(next, { commit = false } = {}) {
  state.history = commit
    ? model.commit(state.history, next)
    : { ...state.history, present: next };
  scheduleSave();
  paint();
}

function paint() {
  const { canvas, width, height } = renderDocument(doc(), state.bitmaps);
  blitPreview($('composerCanvas'), canvas, { width, height });
  $('undoBtn').disabled = !model.canUndo(state.history);
  $('redoBtn').disabled = !model.canRedo(state.history);
  const p = doc().panel;
  $('composerPanelInfo').textContent =
    `${p.width}×${p.height}${p.rotationQuarterTurns ? ` · rot ${p.rotationQuarterTurns * 90}°` : ''}` +
    ` · scheme ${p.colorScheme} · ${doc().layers.length} layer(s)`;
}

// Drafts autosave (debounced): a composition must survive reload.
function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    store.putDraft(model.toDraft(doc(), {
      id: state.draftId,
      recordId: state.device?.recordId ?? null,
    })).catch(() => { /* quota/storage errors surface on the next explicit save */ });
  }, 500);
}

async function loadBitmaps() {
  for (const layer of doc().layers) {
    if (layer.assetId && !state.bitmaps.has(layer.assetId)) {
      const asset = await store.getAsset(layer.assetId);
      if (asset?.blob) {
        state.bitmaps.set(
          layer.assetId,
          await createImageBitmap(asset.blob, { imageOrientation: 'from-image' }),
        );
      }
    }
  }
}

async function importPhoto(file) {
  const assetId = await store.putAsset(file);
  state.bitmaps.set(assetId, await createImageBitmap(file, { imageOrientation: 'from-image' }));
  apply(tools.placePhoto(doc(), { assetId }), { commit: true });
}

function currentSize() {
  const { width, height } = model.artboardSize(doc().panel);
  return { W: width, H: height };
}

function wireTools() {
  const drawTool = tools.makeDrawTool({ color: 0, width: 0.012 });
  const selectTool = tools.makeSelectTool({
    onSelect: (id) => { $('deleteLayerBtn').disabled = !id; },
  });
  state.selectTool = selectTool;
  state.tool = selectTool;

  const setTool = (tool, btnId) => {
    state.tool = tool;
    for (const b of document.querySelectorAll('.composer__tool')) {
      b.classList.toggle('composer__tool--active', b.id === btnId);
    }
  };
  $('toolSelect').addEventListener('click', () => setTool(selectTool, 'toolSelect'));
  $('toolDraw').addEventListener('click', () => setTool(drawTool, 'toolDraw'));

  $('toolText').addEventListener('click', () => {
    const text = window.prompt('Text to place:');
    if (text) {
      const c = { x: 0.1, y: 0.1 };
      apply(tools.placeText(doc(), c, { text, color: Number($('inkColor').value) }), { commit: true });
    }
  });
  $('toolQr').addEventListener('click', () => {
    const text = window.prompt('QR contents (URL or text):', 'https://opendisplay.org');
    if (text) {
      try {
        apply(tools.placeQr(doc(), { x: 0.1, y: 0.1 }, { text, color: Number($('inkColor').value) }), { commit: true });
      } catch (err) {
        window.alert(String(err.message ?? err));
      }
    }
  });
  $('inkColor').addEventListener('change', (ev) => drawTool.setColor(Number(ev.target.value)));

  makeSurface($('composerCanvas'), {
    onPointerDown: (pt) => {
      const r = state.tool.onDown(doc(), pt, currentSize());
      apply(r.doc, { commit: r.commit });
    },
    onPointerMove: (pt) => {
      const r = state.tool.onMove(doc(), pt, currentSize());
      apply(r.doc, { commit: r.commit });
    },
    onPointerUp: (pt) => {
      const r = state.tool.onUp(doc(), pt, currentSize());
      apply(r.doc, { commit: r.commit });
    },
  });

  $('undoBtn').addEventListener('click', () => {
    state.history = model.undo(state.history);
    scheduleSave();
    paint();
  });
  $('redoBtn').addEventListener('click', () => {
    state.history = model.redo(state.history);
    scheduleSave();
    paint();
  });
  $('deleteLayerBtn').addEventListener('click', () => {
    const id = state.selectTool.selectedId();
    if (id) apply(model.removeLayer(doc(), id), { commit: true });
  });
  $('photoFile').addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (file) importPhoto(file).catch((err) => window.alert(String(err.message ?? err)));
  });
}

/** Open the composer for a device record, restoring its draft if present. */
export async function openComposer(device) {
  state.device = device;
  state.draftId = `draft-${device.recordId}`;
  let document_;
  const existing = await store.getDraft(state.draftId).catch(() => null);
  if (existing?.doc) {
    document_ = model.fromDraft(existing);
    // Panel facts may have changed since the draft was written.
    document_.panel = model.createDocument(device).panel;
  } else {
    document_ = model.createDocument(device);
  }
  state.history = model.createHistory(document_);
  state.bitmaps = new Map();
  await loadBitmaps();
  if (!composerWired) {
    wireTools();
    composerWired = true;
  }
  paint();
}

let composerWired = false;
