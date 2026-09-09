// ipcheck.js — verifies the scanning device's IP falls inside MSU's campus network.
//
// Browsers cannot report which WiFi network a device is on (that's blocked for
// privacy reasons on every platform). The real-world equivalent — and what this
// file implements — is checking the device's public IP address against MSU's
// known campus network range(s). Set the real range(s) from the Admin dashboard
// once you have them from IT Services.

const ipRangeCheck = require('ip-range-check');
const db = require('./db');

function getClientIp(req) {
  // On Vercel, req.headers['x-forwarded-for'] is set reliably by Vercel's own
  // edge network (not spoofable by the end client) — this is the real client IP.
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || req.connection?.remoteAddress;
}

async function isOnCampusNetwork(req) {
  if (process.env.DISABLE_IP_CHECK === 'true') {
    return { allowed: true, ip: getClientIp(req), skipped: true };
  }

  const dbValue = await db.getSetting('allowed_ip_ranges');
  const rawRanges = dbValue !== null ? dbValue : process.env.ALLOWED_IP_RANGES || '';
  const ranges = rawRanges
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);

  if (ranges.length === 0) {
    // Fail closed: if no ranges are configured and the check isn't explicitly
    // disabled, nobody gets marked present rather than everybody being let through.
    return { allowed: false, ip: getClientIp(req), reason: 'Campus network not configured' };
  }

  const ip = getClientIp(req);
  const allowed = ipRangeCheck(ip, ranges);
  return {
    allowed,
    ip,
    reason: allowed ? null : 'You must be connected to MSU WiFi to check in',
  };
}

module.exports = { isOnCampusNetwork, getClientIp };
