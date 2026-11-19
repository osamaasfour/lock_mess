// Demo data so a fresh install has something on the map. Disable with SEED_DEMO=false.
// Phone numbers are fake (555). Delete these from the dashboard once you add real ones.
function seedDemo(store) {
    const now = Date.now();
    const iso = msAgo => new Date(now - msAgo).toISOString();
    const techs = [
        { name: 'Marcus K. (demo)', phone: '+15550100144', channel: 'imessage', baseAddress: 'Austin, TX', baseLocation: { lat: 30.2672, lng: -97.7431 }, location: { lat: 30.285, lng: -97.735, accuracy: 15, at: iso(5 * 60e3) }, status: 'available', skills: ['Smart locks', 'Residential'] },
        { name: 'Sara P. (demo)', phone: '+15550100155', channel: 'whatsapp', baseAddress: 'Round Rock, TX', baseLocation: { lat: 30.5083, lng: -97.6789 }, status: 'available', skills: ['Automotive', 'Lockouts'] },
        { name: 'Alex R. (demo)', phone: '+15550100199', channel: 'whatsapp', baseAddress: 'Miami, FL', baseLocation: { lat: 25.7617, lng: -80.1918 }, status: 'busy', skills: ['Biometric', 'Commercial'] },
        { name: 'Dave J. (demo)', phone: '+15550100172', channel: 'discord', baseAddress: 'Los Angeles, CA', baseLocation: { lat: 34.0522, lng: -118.2437 }, status: 'off', skills: ['Rekeying', 'Residential'] },
    ].map(t => store.insert('technicians', { email: '', notes: '', discordUserId: '', active: true, ...t }));

    const tickets = [
        { client: { name: 'Jordan M. (demo)', phone: '+15550123001', channel: 'imessage' }, address: '1100 Congress Ave, Austin, TX 78701', location: { lat: 30.2747, lng: -97.7404 }, issue: 'Yale Assure keypad crazed by intense sun. Keypad swap required.', source: 'imessage' },
        { client: { name: 'Priya S. (demo)', phone: '+15550123002', channel: 'whatsapp' }, address: '3800 N Lamar Blvd, Austin, TX 78756', location: { lat: 30.3072, lng: -97.7426 }, issue: 'Locked out of house, keys inside.', source: 'form' },
        { client: { name: 'Tom W. (demo)', phone: '+15550123003', channel: 'imessage' }, address: '200 S Biscayne Blvd, Miami, FL 33131', location: { lat: 25.7713, lng: -80.1868 }, issue: 'Emergency lockout. High-security biometric reset.', source: 'phone' },
    ];
    for (const t of tickets) {
        store.insert('tickets', {
            id: store.nextTicketId(), status: 'New', locationSource: 'geocoded', technicianId: null, assignedAt: null,
            grossCollected: 0, partCost: 0, companyRate: 30, companyRemittanceDue: 0, technicianPayout: 0,
            unread: { client: 0, technician: 0 }, demo: true, ...t,
        });
    }
    return { techs };
}

module.exports = { seedDemo };
