// auth.js — password hashing + session token helpers.
//
// SECURITY NOTE: passwords are HASHED (bcrypt), never encrypted.
// Hashing is one-way — nobody, including this system's own admins, can ever
// recover a user's original password from what's stored in the database.
// A 12-round bcrypt cost factor is used, which is a solid default in 2026
// (high enough to resist offline brute-forcing, low enough not to slow down logins).

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SALT_ROUNDS = 12;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 20) {
  throw new Error('JWT_SECRET is missing or too short — set a long random value in .env');
}

async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

async function verifyPassword(plainPassword, hash) {
  return bcrypt.compare(plainPassword, hash);
}

function issueToken(payload, expiresIn = '8h') {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Express middleware: requires a valid httpOnly auth cookie for the given role.
// httpOnly cookies can't be read by JavaScript in the browser, which blocks the
// most common way session tokens get stolen (XSS reading localStorage).
function requireRole(roleOrRoles) {
  const allowed = Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles];
  return (req, res, next) => {
    const token = req.cookies?.auth_token;
    const decoded = token && verifyToken(token);
    if (!decoded || !allowed.includes(decoded.role)) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    req.user = decoded;
    next();
  };
}

module.exports = { hashPassword, verifyPassword, issueToken, verifyToken, requireRole };
