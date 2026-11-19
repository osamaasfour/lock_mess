// Passwords (scrypt), signed session tokens (HMAC), secret encryption (AES-256-GCM).
const crypto = require('crypto');

const b64url = buf => Buffer.from(buf).toString('base64url');

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 64);
    return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
    if (!stored || typeof stored !== 'string') return false;
    const [scheme, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length);
    return crypto.timingSafeEqual(expected, actual);
}

function createKeys(appSecret) {
    const signKey = crypto.createHash('sha256').update(`${appSecret}:session`).digest();
    const encKey = crypto.createHash('sha256').update(`${appSecret}:settings`).digest();

    function signToken(payload) {
        const body = b64url(JSON.stringify(payload));
        const sig = b64url(crypto.createHmac('sha256', signKey).update(body).digest());
        return `${body}.${sig}`;
    }

    function verifyToken(token) {
        if (typeof token !== 'string' || !token.includes('.')) return null;
        const [body, sig] = token.split('.');
        const expected = b64url(crypto.createHmac('sha256', signKey).update(body).digest());
        const a = Buffer.from(sig || ''); const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
        try {
            const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
            if (!payload.exp || payload.exp < Date.now()) return null;
            return payload;
        } catch { return null; }
    }

    function encrypt(plain) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
        const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
        return { enc: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    }

    function decrypt(box) {
        if (!box || box.enc !== 1) return null;
        try {
            const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(box.iv, 'base64'));
            decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
            return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
        } catch { return null; } // wrong APP_SECRET or tampered
    }

    return { signToken, verifyToken, encrypt, decrypt };
}

const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

function safeEqual(a, b) {
    const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { hashPassword, verifyPassword, createKeys, randomToken, safeEqual };
