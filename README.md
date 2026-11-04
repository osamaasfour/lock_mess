# Lock-Ops Controller 🛠️

**Lock-Ops Controller** is a centralized, live dispatch dashboard and financial remittance system designed specifically for managing field locksmith operations across the United States. It connects dispatchers directly with field technicians and streamlines manual data parsing workflows down to instantaneous clicks.

Live Frontend Client Prototype: [lockmess-frontend.vercel.app](https://vercel.app)  
Live Backend REST Engine Endpoint: [lock-ops-backend.onrender.com](https://onrender.com)

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
*   **One-Click Accounting Ledger Exports:** Instantly compiles and exports the state registry database into downloadable `.CSV` spreadsheets for external evaluation or payroll analysis.

---

## 🛠️ Project Directory Tree Structure

```text
lock_mess/
├── backend/
│   ├── config/          # Webhook configuration mappings
│   ├── routes/          # REST data settlement pipelines
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
