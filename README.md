# Lock-Ops Controller 🛠️

**Lock-Ops Controller** is a centralized, live dispatch dashboard and financial remittance system designed specifically for managing field locksmith operations across the United States. It connects dispatchers directly with field technicians and streamlines manual data parsing workflows down to instantaneous clicks.

Live Frontend Client Prototype: [lockmess-frontend.vercel.app](https://lockmess-frontend.vercel.app)  
Live Backend REST Engine Endpoint: [lock-ops-backend.onrender.com](https://lock-ops-backend.onrender.com)

---

## 🗺️ Architectural Ecosystem Overview

```text
[ Clients ] ➡️ Inbound Order Matrix
                     ⬇️
             [ Web App Backend API (Render) ] 
                     ⬇️
 [ Discord API ]  ⬅️ (Dispatch Vectors) ➡️ [ WhatsApp Business API ]
                     ⬇️
         [ On-the-Ground Technicians ]
```

---

## ✨ Features Implemented

*   **Live US Field Tracking Map Canvas:** Visualizes task clusters and contractor dispatch pins seamlessly across key metropolitan areas (Austin, Miami, Los Angeles).
*   **Active Operations Influx Stream:** Aggregates regional job cards (`Review Pending` vs. `Dispatched`) directly into a data logging matrix.
*   **Custom Financial Rule Inspector:** Dynamically tracks the downstream independent contractor model. Calculates on-site retail collections minus out-of-pocket lock hardware assembly costs, splitting company remittance allocations live via adjustable ranges.
*   **Discord Dispatch Alerts:** Sends a job alert to a Discord channel through a webhook (logged in mock mode when no webhook is configured). WhatsApp dispatch is planned, not yet implemented.
*   **One-Click Accounting Ledger Exports:** Instantly compiles and exports the state registry database into downloadable `.CSV` spreadsheets for external evaluation or payroll analysis.

---

## 🛠️ Project Directory Tree Structure

```text
lock_mess/
├── backend/
│   ├── test/
│   │   └── api.test.js  # Endpoint + split-math tests (npm test)
│   ├── package.json     # Render build ecosystem dependencies
│   └── server.js        # Core Node.js express engine
├── frontend/
│   └── index.html       # Standalone user interface dashboard
└── .gitignore           # Runtime security credentials block
```

---

## 🚀 Native Local Deployment Quickstart

### Prerequisite Dependencies
Ensure you have [Node.js](https://nodejs.org) installed locally.

### 1. Fire Up the REST Server Backend
```bash
cd backend
npm install
node server.js
```
*The service initializes an active local event loop engine tracking on `http://localhost:5000`.*

### 2. Launch the Web Interface Frontend
Simply locate and double-click `frontend/index.html` on your filesystem or run a local browser asset server to spin up the dispatcher command control workspace.

The dashboard talks to `http://localhost:5000` by default. To point it at a deployed backend, open it with `?api=https://your-backend.onrender.com` or click **⚙️ API** in the header (the setting is remembered in your browser).

### 3. Run the tests
```bash
cd backend
npm test
```

---

## 🔧 Backend Configuration (`backend/.env`)

All variables are optional.

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default `5000`; Render sets this for you). |
| `DISPATCH_API_KEY` | When set, every `/api/*` call except `/api/health` must send it in an `X-API-Key` header. Enter the same key under **⚙️ API** in the dashboard. Strongly recommended for any public deployment. |
| `CORS_ORIGIN` | Allowed frontend origin(s), comma-separated, e.g. `https://lockmess-frontend.vercel.app`. Defaults to `*`. |
| `DISCORD_WEBHOOK_URL` | Discord channel webhook for dispatch alerts. Without it, alerts are only logged. |

> ⚠️ Orders are stored in memory and reset whenever the server restarts (which Render's free tier does often). Move them to a database before using this with real jobs.

## 📡 API

| Method | Endpoint | Body |
|---|---|---|
| `GET` | `/api/health` | — |
| `GET` | `/api/orders` | — |
| `POST` | `/api/dispatch/discord` | `{ orderId }` |
| `POST` | `/api/dispatcher/finalize-split` | `{ orderId, grossCollected?, partCost, customCompanyRate }` (rate 0–100). Closes the ticket; a closed ticket returns `409`. |
| `GET` | `/api/accounting/export-csv` | — |

Split math: `net = max(gross − parts, 0)`, `company = net × rate%`, `technician = gross − company` (so the technician is reimbursed for parts), all rounded to cents.
