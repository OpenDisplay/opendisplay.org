/*
 * Promise-returning <dialog> helpers. The key dialog is the app-owned
 * replacement for ble-common's prompt() path (which the adapter never engages).
 */
import { parseHexKey } from '../keys.js';

function el(id) {
  return document.getElementById(id);
}

/**
 * Ask for a 16-byte hex key. Resolves {key, save} or null on cancel.
 * Loops on invalid input UI-side (the adapter asks only once per operation).
 */
export function askForKey({ name }) {
  return new Promise((resolve) => {
    const dlg = el('keyDialog');
    const input = el('keyInput');
    const save = el('keySaveCheck');
    const error = el('keyError');
    el('keyDeviceName').textContent = name ?? 'device';
    input.value = '';
    error.textContent = '';
    save.checked = true;

    const onClose = () => {
      cleanup();
      resolve(null);
    };
    const onSubmit = (ev) => {
      ev.preventDefault();
      try {
        const key = parseHexKey(input.value);
        cleanup();
        dlg.close();
        resolve({ key, save: save.checked });
      } catch (err) {
        error.textContent = String(err.message ?? err);
      }
    };
    const form = el('keyForm');
    function cleanup() {
      form.removeEventListener('submit', onSubmit);
      dlg.removeEventListener('close', onClose);
    }
    form.addEventListener('submit', onSubmit);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    input.focus();
  });
}

/**
 * Rebind proposal: the freshly added device matches saved record(s) whose
 * permission is gone. Resolves the chosen recordId, or null for "save as new".
 */
export function askRebind({ name, candidates }) {
  return new Promise((resolve) => {
    const dlg = el('rebindDialog');
    const list = el('rebindList');
    el('rebindDeviceName').textContent = name ?? 'device';
    list.textContent = '';
    let chosen = null;

    for (const c of candidates) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'odapp__btn';
      btn.textContent = `${c.name} (${c.width}×${c.height})`;
      btn.addEventListener('click', () => {
        chosen = c.recordId;
        dlg.close();
      });
      list.appendChild(btn);
    }

    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(chosen); // null when "save as new" / Esc
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

/** Simple confirm dialog (native confirm() is fine for M1 destructive actions). */
export function confirmDanger(message) {
  return Promise.resolve(window.confirm(message));
}

export function toast(message, kind = 'info') {
  const line = el('statusLine');
  line.textContent = message;
  line.dataset.kind = kind;
}
