const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');

const db = require('./db');
const { hashPassword, verifyPassword, issueToken, requireRole } = require('./auth');
const { currentToken, verifyScanToken, getRotateSeconds } = require('./qr');
const { isOnCampusNetwork } = require('./ipcheck');

const app = express();
app.use(helmet());
app.use(express.json());
app.use(cookieParser());

// Vercel's edge network sits in front of every function — this makes Express
// trust the X-Forwarded-* headers Vercel sets, which the IP check depends on.
app.set('trust proxy', 1);

// Postgres tables are created on first cold start, then skipped on warm
// invocations. Every request handler awaits this so nothing hits the DB before
// the schema exists — matters the very first time the function ever runs.
let initPromise = null;
app.use((req, res, next) => {
  if (!initPromise) initPromise = db.init();
  initPromise.then(() => next()).catch(next);
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB cap
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx or .xls files are accepted'), ok);
  },
});

// Strict rate limits on the endpoints most worth protecting from brute-forcing.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true });
const activateLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const scanLimiter = rateLimit({ windowMs: 60 * 1000, max: 6 }); // a student shouldn't scan 6x/min

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: true, // Vercel serves everything over HTTPS, so this is always safe
  maxAge: 8 * 60 * 60 * 1000,
};

// ---------- Lecturer auth ----------

app.post('/api/lecturer/login', loginLimiter, async (req, res) => {
  const { staff_number, password } = req.body || {};
  if (!staff_number || !password) return res.status(400).json({ error: 'Missing fields' });

  const lecturer = await db.getLecturerByStaffNumber(staff_number);
  const ok = lecturer && (await verifyPassword(password, lecturer.password_hash));
  if (!ok) return res.status(401).json({ error: 'Invalid staff number or password' });

  const token = issueToken({ role: 'lecturer', id: lecturer.id, name: lecturer.full_name });
  res.cookie('auth_token', token, COOKIE_OPTS);
  res.json({ ok: true, name: lecturer.full_name });
});

app.post('/api/lecturer/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ ok: true });
});

// ---------- Roster upload (lecturer or admin) ----------

app.post(
  '/api/lecturer/roster/upload',
  requireRole(['lecturer', 'admin']),
  upload.single('roster'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    if (/\.xls$/i.test(req.file.originalname)) {
      return res.status(400).json({
        error: 'This is an old .xls file, which this system can\'t read. Open it in Excel or Google Sheets and use "Save As" / "Download as" → .xlsx, then upload that instead.',
      });
    }

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const sheet = workbook.worksheets[0];
      if (!sheet) return res.status(400).json({ error: 'Spreadsheet has no sheets' });

      const header = sheet.getRow(1).values.map((v) => String(v || '').trim().toLowerCase());
      const col = (name) => header.indexOf(name);
      const idx = {
        reg_number: col('reg_number'),
        full_name: col('full_name'),
        programme: col('programme'),
        phone: col('phone'),
        gender: col('gender'),
      };
      if (idx.reg_number === -1 || idx.full_name === -1) {
        return res.status(400).json({
          error: 'Missing required columns. Expected at least: reg_number, full_name',
        });
      }

      let imported = 0;
      const skipped = [];
      const rowsToInsert = [];
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const get = (i) => (i > -1 ? String(row.values[i] ?? '').trim() : '');
        const reg_number = get(idx.reg_number);
        const full_name = get(idx.full_name);
        if (!reg_number || !full_name) {
          skipped.push(rowNumber);
          return;
        }
        rowsToInsert.push({
          reg_number, full_name,
          programme: get(idx.programme), phone: get(idx.phone), gender: get(idx.gender),
        });
      });

      for (const row of rowsToInsert) {
        await db.upsertPreRegisteredStudent(row);
        imported++;
      }

      res.json({ ok: true, imported, skippedRows: skipped });
    } catch (err) {
      res.status(400).json({ error: 'Could not read spreadsheet: ' + err.message });
    }
  }
);

app.post('/api/lecturer/roster/add', requireRole(['lecturer', 'admin']), async (req, res) => {
  const { reg_number, full_name, programme, phone, gender } = req.body || {};
  if (!reg_number || !full_name) return res.status(400).json({ error: 'Missing fields' });
  await db.upsertPreRegisteredStudent({
    reg_number: String(reg_number).trim(),
    full_name: String(full_name).trim(),
    programme: programme || '',
    phone: phone || '',
    gender: gender || '',
  });
  res.json({ ok: true });
});

// ---------- Sessions (lecturer) ----------

app.post('/api/lecturer/sessions', requireRole('lecturer'), async (req, res) => {
  const { module_name, venue } = req.body || {};
  if (!module_name) return res.status(400).json({ error: 'module_name required' });
  const sessionId = await db.createSession(req.user.id, module_name, venue || '');
  res.json({ ok: true, sessionId });
});

app.get('/api/lecturer/sessions', requireRole('lecturer'), async (req, res) => {
  res.json(await db.listSessionsForLecturer(req.user.id));
});

app.post('/api/lecturer/sessions/:id/open', requireRole('lecturer'), async (req, res) => {
  const changes = await db.openSession(req.params.id, req.user.id);
  if (changes === 0) return res.status(404).json({ error: 'Session not found' });
  res.json({ ok: true, rotateSeconds: await getRotateSeconds() });
});

app.post('/api/lecturer/sessions/:id/close', requireRole('lecturer'), async (req, res) => {
  const changes = await db.closeSession(req.params.id, req.user.id);
  if (changes === 0) return res.status(404).json({ error: 'Session not found' });
  res.json({ ok: true });
});

app.get('/api/lecturer/sessions/:id/qr', requireRole('lecturer'), async (req, res) => {
  const session = await db.getSessionForLecturer(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.is_open) return res.status(400).json({ error: 'Session is not open' });

  const token = await currentToken(session.id);
  const dataUrl = await QRCode.toDataURL(token, { margin: 1, width: 320 });
  const rotateSeconds = await getRotateSeconds();
  const secondsIntoWindow = Math.floor(Date.now() / 1000) % rotateSeconds;
  res.json({ dataUrl, rotatesInSeconds: rotateSeconds - secondsIntoWindow });
});

app.get('/api/lecturer/sessions/:id/attendance', requireRole('lecturer'), async (req, res) => {
  const session = await db.getSessionForLecturer(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const rows = await db.getAttendanceForSession(req.params.id);
  const present = await db.countPresentForSession(req.params.id);
  res.json({ session, rows, present });
});

app.post('/api/lecturer/sessions/:id/mark', requireRole('lecturer'), async (req, res) => {
  const session = await db.getSessionForLecturer(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { reg_number } = req.body || {};
  const student = await db.getStudentByRegNumber(String(reg_number || '').trim());
  if (!student) return res.status(404).json({ error: 'Student not found on roster' });
  await db.markAttendance(session.id, student.id, 'present-manual');
  res.json({ ok: true });
});

// ---------- Student self-activation & auth ----------

app.get('/api/student/check-reg/:regNumber', activateLimiter, async (req, res) => {
  const student = await db.getStudentByRegNumber(req.params.regNumber.trim());
  if (!student) return res.json({ found: false });
  res.json({ found: true, alreadyActive: student.status === 'active', name: student.full_name });
});

app.post('/api/student/activate', activateLimiter, async (req, res) => {
  const { reg_number, password } = req.body || {};
  if (!reg_number || !password || password.length < 8) {
    return res.status(400).json({ error: 'Reg number and an 8+ character password are required' });
  }
  const student = await db.getStudentByRegNumber(String(reg_number).trim());
  if (!student) {
    return res.status(404).json({ error: 'Reg number not found — ask your lecturer/admin to add you first' });
  }
  if (student.status === 'active') {
    return res.status(409).json({ error: 'Account already activated — please log in instead' });
  }
  const hash = await hashPassword(password);
  await db.activateStudent(hash, student.reg_number);
  res.json({ ok: true });
});

app.post('/api/student/login', loginLimiter, async (req, res) => {
  const { reg_number, password } = req.body || {};
  const student = await db.getStudentByRegNumber(String(reg_number || '').trim());
  const ok = student?.status === 'active' && (await verifyPassword(password, student.password_hash));
  if (!ok) return res.status(401).json({ error: 'Invalid reg number or password' });

  const token = issueToken({ role: 'student', id: student.id, reg_number: student.reg_number });
  res.cookie('auth_token', token, COOKIE_OPTS);
  res.json({ ok: true, name: student.full_name });
});

app.post('/api/student/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ ok: true });
});

// ---------- Student scan ----------

app.post('/api/student/scan', requireRole('student'), scanLimiter, async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'No code provided' });

  const netCheck = await isOnCampusNetwork(req);
  if (!netCheck.allowed) {
    return res.status(403).json({ error: netCheck.reason });
  }

  const verified = await verifyScanToken(token);
  if (!verified.valid) return res.status(400).json({ error: verified.reason });

  const session = await db.getSessionById(verified.sessionId);
  if (!session || !session.is_open) {
    return res.status(400).json({ error: 'This session is not currently open for check-in' });
  }

  const already = await db.hasAttendance(session.id, req.user.id);
  if (already) return res.status(409).json({ error: 'You are already marked present for this session' });

  await db.markAttendance(session.id, req.user.id, 'present');
  res.json({ ok: true, module: session.module_name, venue: session.venue });
});

app.get('/api/student/me', requireRole('student'), async (req, res) => {
  const student = await db.getStudentById(req.user.id);
  res.json({ reg_number: student.reg_number, full_name: student.full_name });
});

// ---------- Admin ----------

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  const admin = await db.getAdminByUsername(username);
  const ok = admin && (await verifyPassword(password, admin.password_hash));
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

  const token = issueToken({ role: 'admin', id: admin.id, name: admin.full_name });
  res.cookie('auth_token', token, COOKIE_OPTS);
  res.json({ ok: true, name: admin.full_name });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ ok: true });
});

app.post('/api/admin/lecturers', requireRole('admin'), async (req, res) => {
  const { staff_number, full_name, email, password } = req.body || {};
  if (!staff_number || !full_name || !password || password.length < 8) {
    return res.status(400).json({ error: 'Missing fields or password too short (8+ chars)' });
  }
  try {
    const hash = await hashPassword(password);
    await db.createLecturer(staff_number, full_name, email || '', hash);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'Could not create lecturer (staff number may already exist)' });
  }
});

app.get('/api/admin/lecturers', requireRole('admin'), async (req, res) => {
  res.json(await db.listAllLecturers());
});

app.post('/api/admin/lecturers/:id/reset-password', requireRole('admin'), async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const hash = await hashPassword(password);
  const changes = await db.updateLecturerPassword(hash, req.params.id);
  if (changes === 0) return res.status(404).json({ error: 'Lecturer not found' });
  res.json({ ok: true });
});

app.get('/api/admin/sessions', requireRole('admin'), async (req, res) => {
  res.json(await db.listAllSessionsWithCounts());
});

app.get('/api/admin/sessions/:id/attendance', requireRole('admin'), async (req, res) => {
  const session = await db.getSessionById(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const rows = await db.getAttendanceForSession(req.params.id);
  res.json({ session, rows });
});

app.get('/api/admin/settings', requireRole('admin'), async (req, res) => {
  const rotate = await db.getSetting('qr_rotate_seconds');
  const ranges = await db.getSetting('allowed_ip_ranges');
  res.json({
    qr_rotate_seconds: rotate ?? (process.env.QR_ROTATE_SECONDS || '20'),
    allowed_ip_ranges: ranges ?? (process.env.ALLOWED_IP_RANGES || ''),
    ip_check_disabled: process.env.DISABLE_IP_CHECK === 'true',
  });
});

app.post('/api/admin/settings', requireRole('admin'), async (req, res) => {
  const { qr_rotate_seconds, allowed_ip_ranges } = req.body || {};
  if (qr_rotate_seconds !== undefined) {
    const n = parseInt(qr_rotate_seconds, 10);
    if (!Number.isInteger(n) || n < 5) {
      return res.status(400).json({ error: 'qr_rotate_seconds must be an integer >= 5' });
    }
    await db.setSetting('qr_rotate_seconds', String(n));
  }
  if (allowed_ip_ranges !== undefined) {
    await db.setSetting('allowed_ip_ranges', String(allowed_ip_ranges));
  }
  res.json({ ok: true });
});

// ---------- One-time setup helper: create the first admin account ----------

app.post('/api/setup/create-admin', async (req, res) => {
  const { setup_code, username, full_name, password } = req.body || {};
  if (!process.env.SETUP_CODE || setup_code !== process.env.SETUP_CODE) {
    return res.status(403).json({ error: 'Invalid setup code' });
  }
  if ((await db.countAdmins()) > 0) {
    return res.status(403).json({ error: 'An admin account already exists — log in and create others from the dashboard' });
  }
  if (!username || !full_name || !password || password.length < 8) {
    return res.status(400).json({ error: 'Missing fields or password too short' });
  }
  try {
    const hash = await hashPassword(password);
    await db.createAdmin(username, full_name, hash);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'Could not create admin (username may already exist)' });
  }
});

module.exports = app;
