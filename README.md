# Attendance Register — Vercel + Postgres

Same app as the local pilot, restructured for Vercel's serverless model:

- All backend code lives under `/api` as a single Express app (`api/index.js`),
  exported for Vercel rather than run with `app.listen()`.
- Static pages (`index.html`, `lecturer.html`, `student.html`, `admin.html`,
  `css/`) sit at the project root — Vercel serves these automatically.
- The database is now **Postgres** (tested against a real Postgres instance
  before this was handed to you), not SQLite — serverless functions have no
  persistent local disk, so a SQLite file would reset constantly.

This was tested end-to-end against Postgres before packaging: admin bootstrap
(and correct refusal on a second bootstrap attempt), lecturer creation, roster
upload, session/QR lifecycle, duplicate-scan blocking, tampered/expired-token
rejection, live settings changes taking effect immediately, and the admin's
institution-wide view. What's *not* yet tested is the actual browser UI click-
through — do that yourself once it's deployed, ideally on the lecturer's phone.

## Step 1 — Create your database (Neon)

1. Go to **neon.tech**, sign up (free, browser only).
2. Create a project. Neon gives you a connection string immediately.
3. Copy the **pooled** connection string — the one with `-pooler` in the
   hostname. This matters: it's built for serverless functions opening lots of
   short-lived connections, which is exactly what Vercel does.

## Step 2 — Push the code to GitHub (browser only, no git install needed)

1. Go to **github.com**, sign up if you don't have an account, create a new
   repository (e.g. `attendance-register`).
2. Use GitHub's **"uploading an existing file"** link on the empty repo page —
   drag the whole unzipped project folder in. No terminal, no git install.

## Step 3 — Import into Vercel

1. Go to **vercel.com**, sign up (you can use your GitHub account to sign in,
   which also makes the import step below one click).
2. Click **Add New → Project**, select the GitHub repo you just created.
3. Before clicking Deploy, open **Environment Variables** and add everything
   from `.env.example`: `DATABASE_URL` (your Neon pooled string),
   `JWT_SECRET`, `QR_TOKEN_SECRET` (generate both with `openssl rand -hex 32`
   — Vercel's own web terminal isn't needed, any online "random hex generator"
   or even Neon's SQL editor running `select encode(gen_random_bytes(32),'hex')`
   works too), `SETUP_CODE`, `ALLOWED_IP_RANGES`, `QR_ROTATE_SECONDS`,
   `DISABLE_IP_CHECK=true` for now.
4. Click **Deploy**. Vercel builds and gives you a live URL
   (`your-project.vercel.app`).

## Step 4 — Create your first admin account

From any terminal with internet access (or a tool like Postman, or even your
phone's browser using a REST-client app), send:

```bash
curl -X POST https://your-project.vercel.app/api/setup/create-admin \
  -H "Content-Type: application/json" \
  -d '{
    "setup_code": "whatever-you-set-as-SETUP_CODE",
    "username": "admin1",
    "full_name": "Registrar Admin",
    "password": "a-strong-password-here"
  }'
```

Then visit `https://your-project.vercel.app/admin.html`, log in, and create
your pilot lecturer account from there.

## Making updates going forward

Since the repo lives on GitHub, any file you edit and re-upload through
GitHub's web interface (or any future push) automatically triggers a new
Vercel deployment — no redeploy step to remember.

## What changed from the local pilot version

| | Local pilot | This version |
|---|---|---|
| Database | SQLite file | Postgres (Neon) |
| Server | Long-running (`app.listen`) | Serverless function per request |
| Static files | `public/` folder | Project root |
| Settings (QR rotation, IP range) | `.env` + DB override | DB only, set via Vercel env vars + Admin dashboard |

Everything else — roles, permissions, the rotating-QR anti-fraud design, bcrypt
hashing, rate limiting — is unchanged.
