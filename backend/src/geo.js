// Distance, map links and address → coordinates (OpenStreetMap Nominatim).

function isLatLng(loc) {
    return loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)
        && Math.abs(loc.lat) <= 90 && Math.abs(loc.lng) <= 180;
}

function parseLatLng(loc) {
    if (!loc) return null;
    const out = { lat: Number(loc.lat ?? loc.latitude), lng: Number(loc.lng ?? loc.longitude) };
    return isLatLng(out) ? out : null;
}

// Great-circle distance in kilometres.
function distanceKm(a, b) {
    if (!isLatLng(a) || !isLatLng(b)) return null;
    const R = 6371;
    const rad = d => d * Math.PI / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

function directionsLink(loc, address) {
    if (isLatLng(loc)) return `https://www.google.com/maps/dir/?api=1&destination=${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}`;
    if (address) return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
    return '';
}

// Nominatim usage policy: identify the app, max ~1 request/second, cache results.
function createGeocoder(http) {
    const cache = new Map();
    let last = 0;
    return async function geocode(address) {
        const q = String(address || '').trim();
        if (q.length < 3) return null;
        const key = q.toLowerCase();
        if (cache.has(key)) return cache.get(key);
        const wait = Math.max(0, last + 1100 - Date.now());
        if (wait) await new Promise(r => setTimeout(r, wait));
        last = Date.now();
        try {
            const { data } = await http.get('https://nominatim.openstreetmap.org/search', {
                params: { format: 'json', limit: 1, q },
                headers: { 'User-Agent': 'LockOpsDispatch/2.0 (https://github.com/osamaasfour/lock_mess)' },
                timeout: 8000,
            });
            const hit = Array.isArray(data) && data[0] ? parseLatLng({ lat: data[0].lat, lng: data[0].lon }) : null;
            cache.set(key, hit);
            return hit;
        } catch (err) {
            console.error('[geocode] failed:', err.message);
            return null;
        }
    };
}

module.exports = { isLatLng, parseLatLng, distanceKm, directionsLink, createGeocoder };
