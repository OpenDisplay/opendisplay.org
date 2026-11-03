/*
 * send.js — the send-preparation decision, with injected dependencies so the
 * exact interleavings can be tested without a browser or a radio.
 *
 * Everything here exists because of one hazard: `prepareSend` awaits, and the
 * user can open a different composer meanwhile. Two identical tags share a
 * panel signature, so signature comparison alone CANNOT tell them apart — only
 * the identity of the captured session and frame can.
 */

/** Immutable description of the panel a frame was rendered for. */
export function panelSignature(panel) {
  return [
    panel.width, panel.height, panel.rotationQuarterTurns ?? 0,
    panel.colorScheme, panel.panelIcType ?? 'null',
  ].join(':');
}

export class SendAbortedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SendAbortedError';
  }
}

/**
 * Validate that a captured frame may be sent to the currently connected panel.
 *
 * @param {object} deps
 * @param {object} deps.owner        the session captured at click time
 * @param {number} deps.ownerGen     that session's generation at click time
 * @param {object} deps.frame        the dither frame captured at click time
 * @param {object} deps.record       the device record the composer was opened for
 * @param {() => object|null} deps.currentSession   live session getter
 * @param {() => object|null} deps.currentFrame     live frame getter
 * @param {(id: string) => Promise<object|undefined>} deps.getDevice
 * @param {() => string|null} deps.connectedBleId
 * @returns {Promise<{record: object}>} the FRESH device record to send with
 * @throws {SendAbortedError}
 */
export async function prepareSend({
  owner, ownerGen, frame, record,
  currentSession, currentFrame, getDevice, connectedBleId,
}) {
  if (!owner || !frame || !record) {
    throw new SendAbortedError('nothing to send');
  }
  const stillOurs = () =>
    currentSession() === owner
    && owner.generation() === ownerGen
    && currentFrame() === frame;

  // Re-read the record: connecting refreshes it, and the composer session
  // survives navigation, so the in-memory copy can be stale.
  const fresh = await getDevice(record.recordId);

  // Re-check AFTER the await: the user may have switched composers.
  if (!stillOurs()) {
    throw new SendAbortedError('the composition changed while preparing to send — nothing was sent');
  }
  if (!fresh) throw new SendAbortedError('this device is no longer saved');
  // Panel facts that came from an import file — not from a config read — must
  // not decide what gets encoded and sent. Connecting once re-reads them.
  if (fresh.resolutionConfirmed !== true) {
    throw new SendAbortedError(
      'this device\'s panel details have not been read from the hardware yet — '
      + 'connect once to confirm them before sending',
    );
  }
  if (fresh.bleId !== connectedBleId()) {
    throw new SendAbortedError('the connected device is not the one this composition is for');
  }

  const wanted = panelSignature({
    width: fresh.width,
    height: fresh.height,
    rotationQuarterTurns: fresh.rotationQuarterTurns ?? 0,
    colorScheme: fresh.colorScheme,
    panelIcType: fresh.panelIcType,
  });
  if (frame.signature !== wanted) {
    throw new SendAbortedError(
      'the panel changed since this preview was rendered — reopen the composer',
    );
  }
  return { record: fresh };
}
