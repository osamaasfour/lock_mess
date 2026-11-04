const express = require('express');
const cors = require('cors');
const { Parser } = require('json2csv');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// In-Memory Database for presentation mock data
let ordersDb = [
    { id: "10943", address: "Austin, TX (78701)", techName: "Marcus K.", techPhone: "15550144", notes: "Yale Assure keypad crazed by intense sun. Keypad swapping required.", dispatcherStatus: "Review Pending", grossCollected: 350, partCost: 80, companyRemittanceDue: 81, location: { lat: 30.2672, lng: -97.7431 } },
    { id: "10944", address: "Miami, FL (33101)", techName: "Alex R.", techPhone: "15550199", notes: "Emergency lock out. High security biometric reset.", dispatcherStatus: "Dispatched", grossCollected: 0, partCost: 0, companyRemittanceDue: 0, location: { lat: 25.7617, lng: -80.1918 } }
];

// 1. Get all jobs (For Dispatcher Map & Feed View)
app.get('/api/orders', (req, res) => res.json({ success: true, ledger: ordersDb }));

// 2. Dispatch alert routing via Discord
app.post('/api/dispatch/discord', (req, res) => {
    console.log(`[DISCORD] Dispatch message fired for Order #${req.body.orderId}`);
    res.json({ success: true, msg: "Mocked Discord webhook payload sent." });
});

// 3. Finalize custom financial calculations split
app.post('/api/dispatcher/finalize-split', (req, res) => {
    const { orderId, partCost, customCompanyRate } = req.body;
    const order = ordersDb.find(o => o.id === orderId);
    if (!order) return res.status(404).json({ error: "Order context missing" });

    const net = order.grossCollected - parseFloat(partCost);
    order.partCost = parseFloat(partCost);
    order.companyRemittanceDue = net > 0 ? net * (parseFloat(customCompanyRate) / 100) : 0;
    order.dispatcherStatus = "Closed";

    res.json({ success: true, record: order });
});

// 4. Accounting Sheet Generation Export Download (.CSV)
app.get('/api/accounting/export-csv', (req, res) => {
    try {
        const fields = ['id', 'techName', 'grossCollected', 'partCost', 'companyRemittanceDue', 'dispatcherStatus'];
        const json2csvParser = new Parser({ fields });
        const csv = json2csvParser.parse(ordersDb);
        res.header('Content-Type', 'text/csv');
        res.attachment('lock-ops-ledger.csv');
        return res.send(csv);
    } catch (err) {
        res.status(500).send("Error exporting accounting metrics.");
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Dispatch API active on port ${PORT}`));
