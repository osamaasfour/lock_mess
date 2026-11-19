# 🔐 Lock-Ops Dispatch

Dispatch software for a locksmith company: take client requests, see clients and technicians on a live map, send the job to the nearest available technician by iMessage, WhatsApp or Discord, and settle the payout split.

* **Dashboard:** [lockmess-frontend.vercel.app](https://lockmess-frontend.vercel.app) (Vercel, `frontend/`)
* **API:** [lock-ops-backend.onrender.com](https://lock-ops-backend.onrender.com) (Render, `backend/`)

---

## Pages

| Page | Who | What it does |
|---|---|---|
| `index.html` — **Dispatch** | Admins, dispatchers | Map of tickets and technicians, ticket list, nearest technicians ranked by distance, assign/reassign, payout split and closing, CSV export. |
| `technicians.html` — **Technicians** | Admins (dispatchers read-only) | Add/edit technicians: phone, preferred channel, Discord ID, skills, base address, status, and their GPS-page login. |
| `settings.html` — **Settings** | Admins | Company details, your own iMessage (Sendblue), WhatsApp and Discord keys, and user accounts. |
| `tech.html` — **Technician page** | Technicians (on their phone) | Set Available/Busy/Off, share live GPS, see assigned jobs with directions, mark *On my way* / *Job done*. |
| `request.html` — **Request form** | Clients (public) | Name, phone, address or "use my current location", problem. Creates a ticket. |
| `login.html` | Everyone | Log in; creates the first admin on a fresh local install. |

Roles: **admin** (everything), **dispatcher** (tickets, assigning, payouts), **technician** (own jobs and location only).

### How assigning works
1. Select a ticket. The panel lists technicians: **available first, then by distance** from the client. Distance uses the technician's live GPS if it is less than 2 hours old, otherwise their base address.
2. Click **Assign**. The job is sent on the technician's channel with the client's name, phone, address, problem and a **Google Maps directions link**, plus a link to their technician page.
3. The technician becomes *Busy*; they go back to *Available* automatically when their last open job is closed.

Channels without keys run in **mock mode**: the message is logged on the server instead of sent, and the dashboard says so.

---

## Deploying (Render + Vercel)

### 1. Create a free Postgres database
Without one, everything is lost whenever Render restarts. Either:
* **Neon** — [neon.tech](https://neon.tech) → New project → copy the *connection string*.
* **Supabase** — [supabase.com](https://supabase.com) → New project → Project Settings → Database → *Connection string* (URI).

### 2. Render → your backend service → Environment

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | ✅ | The Postgres connection string from step 1. |
| `APP_SECRET` | ✅ | A long random string (40+ characters). Signs logins and encrypts saved API keys. **Don't change it later**, or saved keys must be re-entered. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | ✅ first time | Creates the first admin login if none exists. You can remove them afterwards. |
| `ADMIN_NAME` | | Display name for that admin. |
| `CORS_ORIGIN` | recommended | `https://lockmess-frontend.vercel.app` |
| `SEED_DEMO` | | `false` to start without the demo technicians and tickets. |

Integration keys are best entered on the **Settings** page. The older variables (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEST_RECIPIENT`, `DISCORD_WEBHOOK_URL`, …) still work as fallbacks.

### 3. First login
Open the dashboard, log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, then:
1. **Settings → Company**: click *Use this site* for the dashboard address (used in links sent to technicians).
2. **Settings → iMessage / WhatsApp / Discord**: paste your keys.
3. **Settings → Users**: add dispatchers.
4. **Technicians**: add your technicians and give each a GPS-page login. Delete the *(demo)* ones.
5. Share `request.html` with clients (website button, Google Business profile, etc.).

---

## Running locally

```bash
cd backend
npm install
npm start            # http://localhost:5000, data saved to backend/data/lockops.json
```
Open `frontend/login.html` (or serve the folder) — it talks to `localhost:5000` automatically and lets you create the first admin. Add `?api=https://…` to any page to point it at another backend.

```bash
npm test             # API tests (node:test)
```

---

## API overview

All routes are under `/api`; everything except `health`, `auth/*` and `public/*` needs `Authorization: Bearer <token>` from `POST /api/auth/login`.

| Area | Endpoints |
|---|---|
| Auth | `GET auth/status` · `POST auth/setup` · `POST auth/login` · `GET auth/me` · `POST auth/password` |
| Users (admin) | `GET/POST users` · `PUT/DELETE users/:id` |
| Settings (admin) | `GET/PUT settings` — secrets are write-only and come back masked |
| Technicians | `GET technicians` · `POST technicians` · `PUT/DELETE technicians/:id` (admin) |
| Tickets | `GET tickets?scope=open\|all` · `POST tickets` · `GET/PUT/DELETE tickets/:id` · `GET tickets/:id/candidates` · `POST tickets/:id/assign` · `POST tickets/:id/unassign` · `POST tickets/:id/finalize` · `GET accounting/export-csv` |
| Technician page | `GET me/jobs` · `POST me/location` · `PUT me/status` · `POST me/jobs/:id/status` |
| Public | `GET public/info` · `POST public/requests` |

Payout math: `net = max(gross − parts, 0)`, `company = net × rate%`, `technician = gross − company`, rounded to cents.

## Limits worth knowing
* Data is stored as one JSON document in Postgres: simple and fine for a small company, but run **one** backend instance.
* Browsers pause GPS when the phone screen locks or the technician switches apps; the technician page resumes when reopened.
* Addresses are placed on the map with OpenStreetMap's free geocoder; if one isn't found, edit it or enter coordinates.
