# MSU Attendance — Lecture Check-in

Students scan a rotating QR code with their own phone to check themselves
into a lecture, in real time, synced instantly to the lecturer's screen.
Four role-based sign-in tiers — Student, Lecturer, Chairperson, Admin — each
with a real email/password account and strictly scoped access, enforced at
the database level, not just in the app's UI.

**Before this works, you need to do a one-time free setup — see
[`SETUP.md`](./SETUP.md).** Everything in the app talks to your own free
Firebase project, so enrollments, check-ins and reports sync between every
device, instantly, for an institution of any size.

## How it works

**Students**
- Register once with their Reg Number, name, email and a password. The Reg
  Number must already exist in the system — added automatically the first
  time a Lecturer, Chairperson or Admin imports a class list that includes
  it — which is what stops anyone fabricating an account out of thin air.
- At a lecture, tap **Scan QR to check in**, point the camera at the code
  projected on the lecturer's screen, and they're marked present instantly.
- **My modules** shows every module they're enrolled in, with a live
  attendance count and DP (Duly Performed) status for each.

**Lecturers**
- Register with a staff email/password and a department; the account stays
  pending until a Chairperson (in their department) or an Admin approves it.
- **My modules** lists every module offering they've been assigned to.
  **Manage** a module to import/enrol a class list (CSV upload or paste),
  start a check-in session (a QR code that rotates automatically, so an old
  screenshot can't be reused later), watch students check in live, and
  correct the register by hand for anyone without a working phone that day.
- **Reports** — bar charts of attendance per session and a DP-eligibility
  summary for any of their modules, plus one-click CSV, Excel and PDF
  (of the charts) downloads.

**Chairpersons**
- Register the same way as a Lecturer, scoped to one department; only an
  Admin approves a Chairperson account.
- **Department modules** — every module offering in their department, with
  the exact same manage tools a Lecturer has (import, sessions, QR,
  roster) — just department-wide instead of scoped to one person.
- **Staff** — approve or suspend Lecturer accounts within their own
  department.
- **Reports** — the same charts/CSV/Excel/PDF reporting as Lecturers, rolled
  up across every offering in the department.

**Admins**
- Sign in with a real email/password account (set up in `SETUP.md`).
- **Structure** — Faculties (each with a default DP threshold), Departments,
  Programmes.
- **Modules** — the catalogue of modules each department teaches, with an
  optional per-module DP threshold override.
- **Offerings** — stand up a module offering for a given year/semester,
  assign it a campus, schedule, venue and lecturer(s).
- **Import & enrol** — import a class list into any module offering,
  institution-wide (the same tool Lecturers and Chairpersons use, just not
  limited to their own modules).
- **Staff** — approve or suspend any Lecturer or Chairperson account.
- **Reports** and **Settings** (current academic year/semester, QR rotation
  interval) — institution-wide.

Every dashboard refreshes itself the instant any of this changes — a new
module, a newly approved lecturer, a freshly created offering — with no
page reload needed, anywhere in the app.

## Security, by role

- **Admin** — real Firebase Authentication, gated by an allow-list
  (`admins` collection) that only you control from the Firebase console.
- **Chairperson** — a real account that stays `pending` and powerless until
  an Admin approves it; rules then scope it strictly to its own department.
- **Lecturer** — the same, but approved by either an Admin or that
  lecturer's own department Chairperson, and scoped strictly to the module
  offerings it's assigned to.
- **Student** — tied to a Reg Number that must already exist in the system
  before an account can even be created — the safeguard that stops
  fabricated accounts at institution scale.
- **QR check-in** rotates every ~25–30 seconds (configurable), the live code
  is never exposed to any device except the one displaying it, and
  Firestore rules reject any scan using an old or mismatched code.

See the "Notes on security" section in `SETUP.md` for the full, honest
details on what this does and doesn't protect against.

## Files in this project

| File | Purpose |
|---|---|
| `index.html` | The whole app — UI, styling, and logic |
| `firebase-config.js` | **Edit this** — paste your Firebase project keys here |
| `firestore.rules` | Security rules — paste into the Firebase console |
| `firebase.json` | Optional config for one-command Firebase Hosting deploys |
| `SETUP.md` | Step-by-step setup and deployment guide — start here |

## Requirements

- A free Firebase project (see `SETUP.md`)
- Hosting the files somewhere with **HTTPS** — required for camera access
  on phones (Firebase Hosting, Netlify, GitHub Pages, Vercel, etc. all work)
- Students' and lecturers' phones need camera permission granted to the site

---
Midlands State University — MSU Attendance
