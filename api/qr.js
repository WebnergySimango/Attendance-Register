// qr.js — rotating, signed check-in tokens.
//
// Why not just encode the session ID in the QR code? Because a static code can be
// screenshotted and shared around a lecture hall (or a whole WhatsApp group) in seconds.
// Instead, the token embeds the current time window and is signed with a server-side
// secret, so it automatically expires and can't be forged by a student who only has
// the QR image, not the secret.

const crypto = require('crypto');
const db = require('./db');

const SECRET = process.env.QR_TOKEN_SECRET;
if (!SECRET || SECRET.length < 20) {
  throw new Error('QR_TOKEN_SECRET is missing or too short — set a long random value in your env vars');
}
const DEFAULT_ROTATE_SECONDS = parseInt(process.env.QR_ROTATE_SECONDS || '20', 10);

// Admin can change this at runtime via the settings dashboard — no redeploy needed.
// Falls back to the env default if no admin override has been saved yet.
async function getRotateSeconds() {
  const val = await db.getSetting('qr_rotate_seconds');
  const n = parseInt(val, 10);
  return Number.isInteger(n) && n >= 5 ? n : DEFAULT_ROTATE_SECONDS;
}

function sign(sessionId, window) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(`${sessionId}:${window}`)
    .digest('hex');
}

async function currentWindow() {
  return Math.floor(Date.now() / 1000 / (await getRotateSeconds()));
}

// Returns the token that should currently be displayed on the lecturer's QR code.
async function currentToken(sessionId) {
  const window = await currentWindow();
  return `${sessionId}.${window}.${sign(sessionId, window)}`;
}

// Verifies a token a student scanned. Accepts the current window and the one
// immediately before it, as a grace period for network/scan lag — anything older
// than that is rejected as expired.
async function verifyScanToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return { valid: false, reason: 'Malformed code' };

  const [sessionIdStr, windowStr, providedSig] = parts;
  const sessionId = parseInt(sessionIdStr, 10);
  const window = parseInt(windowStr, 10);
  if (!Number.isInteger(sessionId) || !Number.isInteger(window)) {
    return { valid: false, reason: 'Malformed code' };
  }

  const nowWindow = await currentWindow();
  if (window !== nowWindow && window !== nowWindow - 1) {
    return { valid: false, reason: 'This code has expired — rescan the current one' };
  }

  const expectedSig = sign(sessionId, window);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  // timingSafeEqual prevents leaking info via response-time differences
  const sigOk = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!sigOk) return { valid: false, reason: 'Invalid code' };

  return { valid: true, sessionId };
}

module.exports = { currentToken, verifyScanToken, getRotateSeconds };
