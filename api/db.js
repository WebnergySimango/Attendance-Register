// db.js — Postgres database layer (works with Neon, Supabase, or any standard
// Postgres). Replaces the SQLite version used in local pilot testing, because
// Vercel's serverless functions have no persistent local disk — every function
// invocation can run on a different machine, so a SQLite file would reset
// constantly. A real hosted Postgres database solves that.
//
// All queries use parameterized placeholders ($1, $2, ...) — never string-
// concatenated SQL. This is what prevents SQL injection regardless of what a
// user types into a form.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is missing — set it to your Postgres connection string');
}

// A small pool, reused across warm serverless invocations. Neon's *pooled*
// connection string (the one with "-pooler" in the hostname) is what you want
// here — it's built for exactly this bursty, many-short-lived-connections
// pattern that serverless functions produce.
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS lecturers (
      id SERIAL PRIMARY KEY,
      staff_number TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      reg_number TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      programme TEXT,
      phone TEXT,
      gender TEXT,
      password_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pre-registered',
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      lecturer_id INTEGER NOT NULL REFERENCES lecturers(id),
      module_name TEXT NOT NULL,
      venue TEXT,
      is_open BOOLEAN NOT NULL DEFAULT false,
      opened_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      student_id INTEGER NOT NULL REFERENCES students(id),
      status TEXT NOT NULL DEFAULT 'present',
      scanned_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(session_id, student_id)
    );
  `);
}

// One-row-or-undefined helper
async function one(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows[0];
}
async function many(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

module.exports = {
  pool,
  init,

  // Admins
  createAdmin: (username, full_name, password_hash) =>
    pool.query(`INSERT INTO admins (username, full_name, password_hash) VALUES ($1,$2,$3)`, [
      username, full_name, password_hash,
    ]),
  getAdminByUsername: (username) => one(`SELECT * FROM admins WHERE username = $1`, [username]),
  countAdmins: async () => {
    const row = await one(`SELECT COUNT(*)::int AS n FROM admins`);
    return row.n;
  },

  // Settings
  getSetting: async (key) => {
    const row = await one(`SELECT value FROM settings WHERE key = $1`, [key]);
    return row ? row.value : null;
  },
  setSetting: (key, value) =>
    pool.query(
      `INSERT INTO settings (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [key, value]
    ),

  // Lecturers
  createLecturer: (staff_number, full_name, email, password_hash) =>
    pool.query(
      `INSERT INTO lecturers (staff_number, full_name, email, password_hash) VALUES ($1,$2,$3,$4)`,
      [staff_number, full_name, email, password_hash]
    ),
  getLecturerByStaffNumber: (staff_number) =>
    one(`SELECT * FROM lecturers WHERE staff_number = $1`, [staff_number]),
  listAllLecturers: () =>
    many(`SELECT id, staff_number, full_name, email, created_at FROM lecturers ORDER BY created_at DESC`),
  updateLecturerPassword: async (password_hash, id) => {
    const r = await pool.query(`UPDATE lecturers SET password_hash = $1 WHERE id = $2`, [password_hash, id]);
    return r.rowCount;
  },

  // Students
  upsertPreRegisteredStudent: ({ reg_number, full_name, programme, phone, gender }) =>
    pool.query(
      `INSERT INTO students (reg_number, full_name, programme, phone, gender)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (reg_number) DO UPDATE SET
         full_name = excluded.full_name,
         programme = excluded.programme,
         phone = excluded.phone,
         gender = excluded.gender
       WHERE students.status = 'pre-registered'`,
      [reg_number, full_name, programme, phone, gender]
    ),
  getStudentByRegNumber: (reg_number) =>
    one(`SELECT * FROM students WHERE reg_number = $1`, [reg_number]),
  activateStudent: (password_hash, reg_number) =>
    pool.query(`UPDATE students SET password_hash = $1, status = 'active' WHERE reg_number = $2`, [
      password_hash, reg_number,
    ]),
  getStudentById: (id) => one(`SELECT * FROM students WHERE id = $1`, [id]),

  // Sessions
  createSession: async (lecturer_id, module_name, venue) => {
    const row = await one(
      `INSERT INTO sessions (lecturer_id, module_name, venue) VALUES ($1,$2,$3) RETURNING id`,
      [lecturer_id, module_name, venue]
    );
    return row.id;
  },
  openSession: async (id, lecturer_id) => {
    const r = await pool.query(
      `UPDATE sessions SET is_open = true, opened_at = now() WHERE id = $1 AND lecturer_id = $2`,
      [id, lecturer_id]
    );
    return r.rowCount;
  },
  closeSession: async (id, lecturer_id) => {
    const r = await pool.query(
      `UPDATE sessions SET is_open = false, closed_at = now() WHERE id = $1 AND lecturer_id = $2`,
      [id, lecturer_id]
    );
    return r.rowCount;
  },
  getSessionById: (id) => one(`SELECT * FROM sessions WHERE id = $1`, [id]),
  getSessionForLecturer: (id, lecturer_id) =>
    one(`SELECT * FROM sessions WHERE id = $1 AND lecturer_id = $2`, [id, lecturer_id]),
  listSessionsForLecturer: (lecturer_id) =>
    many(`SELECT * FROM sessions WHERE lecturer_id = $1 ORDER BY created_at DESC`, [lecturer_id]),
  listAllSessionsWithCounts: () =>
    many(`
      SELECT
        sess.*,
        lec.full_name AS lecturer_name,
        lec.staff_number AS lecturer_staff_number,
        (SELECT COUNT(*) FROM attendance a WHERE a.session_id = sess.id AND a.status != 'absent')::int AS present_count
      FROM sessions sess
      JOIN lecturers lec ON lec.id = sess.lecturer_id
      ORDER BY sess.created_at DESC
    `),

  // Attendance
  markAttendance: (session_id, student_id, status) =>
    pool.query(
      `INSERT INTO attendance (session_id, student_id, status) VALUES ($1,$2,$3)
       ON CONFLICT (session_id, student_id) DO NOTHING`,
      [session_id, student_id, status]
    ),
  getAttendanceForSession: (session_id) =>
    many(
      `SELECT a.*, s.reg_number, s.full_name, s.programme
       FROM attendance a JOIN students s ON s.id = a.student_id
       WHERE a.session_id = $1
       ORDER BY a.scanned_at ASC`,
      [session_id]
    ),
  countPresentForSession: async (session_id) => {
    const row = await one(
      `SELECT COUNT(*)::int AS n FROM attendance WHERE session_id = $1 AND status != 'absent'`,
      [session_id]
    );
    return row.n;
  },
  hasAttendance: (session_id, student_id) =>
    one(`SELECT 1 FROM attendance WHERE session_id = $1 AND student_id = $2`, [session_id, student_id]),
};
