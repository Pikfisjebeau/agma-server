const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme123';
const KEYS_FILE    = path.join(__dirname, 'keys.json');
const SCRIPT_FILE  = path.join(__dirname, 'script.js');

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function loadKeys() {
    if (!fs.existsSync(KEYS_FILE)) fs.writeFileSync(KEYS_FILE, '{}');
    return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
}
function saveKeys(keys) {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
}
function formatTimeLeft(ms) {
    if (ms <= 0) return 'Expired';
    const days  = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    const mins  = Math.floor((ms % 3600000)  / 60000);
    if (days > 0)  return `${days} day${days !== 1 ? 's' : ''} and ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins} minute${mins !== 1 ? 's' : ''}`;
}
function generateKey() {
    return [
        crypto.randomBytes(3).toString('hex').toUpperCase(),
        crypto.randomBytes(3).toString('hex').toUpperCase(),
        crypto.randomBytes(3).toString('hex').toUpperCase(),
        crypto.randomBytes(3).toString('hex').toUpperCase()
    ].join('-');
}
function adminCheck(req, res) {
    if (req.headers['x-admin-secret'] !== ADMIN_SECRET) {
        res.status(403).json({ error: 'Forbidden' });
        return false;
    }
    return true;
}
function validateKey(raw) {
    const key   = (raw || '').trim().toUpperCase();
    const keys  = loadKeys();
    const entry = keys[key];
    if (!entry) return { valid: false, reason: 'Invalid key' };
    const timeLeft = entry.expires - Date.now();
    if (timeLeft <= 0) return { valid: false, reason: 'Key expired' };
    return { valid: true, key, timeLeft, entry };
}

// ─── PUBLIC: VALIDATE + SERVE SCRIPT ─────────────────────────────────────────
// This is the main endpoint the loader calls.
// GET /script?key=XXXX-XXXX-XXXX-XXXX
// → if valid: returns the script JS as plain text
// → if invalid: returns JSON error
app.get('/script', (req, res) => {
    const result = validateKey(req.query.key);
    if (!result.valid) {
        return res.status(403).json({ valid: false, reason: result.reason });
    }

    if (!fs.existsSync(SCRIPT_FILE)) {
        return res.status(500).json({ error: 'Script not uploaded to server yet.' });
    }

    const scriptCode = fs.readFileSync(SCRIPT_FILE, 'utf8');

    // Return the script as plain text so the loader can eval() it
    res.setHeader('Content-Type', 'text/javascript');
    res.setHeader('X-Time-Left', formatTimeLeft(result.timeLeft));
    res.send(scriptCode);
});

// ─── PUBLIC: CHECK KEY (just validate, don't serve script) ───────────────────
// GET /check?key=XXXX
app.get('/check', (req, res) => {
    const result = validateKey(req.query.key);
    if (!result.valid) return res.json({ valid: false, reason: result.reason });
    return res.json({
        valid:    true,
        timeLeft: formatTimeLeft(result.timeLeft),
        note:     result.entry.note || ''
    });
});

// ─── ADMIN: UPLOAD / UPDATE THE SCRIPT ───────────────────────────────────────
// POST /admin/upload  (body = raw JS text, Content-Type: text/plain)
app.post('/admin/upload', express.text({ limit: '10mb', type: '*/*' }), (req, res) => {
    if (!adminCheck(req, res)) return;
    if (!req.body || typeof req.body !== 'string' || !req.body.trim()) {
        return res.status(400).json({ error: 'Send the script as plain text in the request body.' });
    }
    fs.writeFileSync(SCRIPT_FILE, req.body);
    return res.json({ success: true, bytes: req.body.length });
});

// ─── ADMIN: GENERATE KEY ──────────────────────────────────────────────────────
// POST /admin/generate  { "days": 30, "note": "player1" }
app.post('/admin/generate', (req, res) => {
    if (!adminCheck(req, res)) return;
    const { days, note } = req.body;
    if (!days) return res.status(400).json({ error: '"days" required' });
    const key    = generateKey();
    const keys   = loadKeys();
    const expires = Date.now() + Number(days) * 86400000;
    keys[key] = { expires, note: note || '', createdAt: Date.now() };
    saveKeys(keys);
    return res.json({ success: true, key, expires, timeLeft: formatTimeLeft(Number(days) * 86400000) });
});

// ─── ADMIN: ADD CUSTOM KEY ────────────────────────────────────────────────────
// POST /admin/add  { "key": "MY-KEY", "days": 7, "note": "vip" }
app.post('/admin/add', (req, res) => {
    if (!adminCheck(req, res)) return;
    const { key, days, note } = req.body;
    if (!key || !days) return res.status(400).json({ error: '"key" and "days" required' });
    const keys    = loadKeys();
    const k       = key.trim().toUpperCase();
    const expires  = Date.now() + Number(days) * 86400000;
    keys[k] = { expires, note: note || '', createdAt: Date.now() };
    saveKeys(keys);
    return res.json({ success: true, key: k, timeLeft: formatTimeLeft(Number(days) * 86400000) });
});

// ─── ADMIN: LIST KEYS ─────────────────────────────────────────────────────────
app.get('/admin/keys', (req, res) => {
    if (!adminCheck(req, res)) return;
    const keys = loadKeys();
    const now  = Date.now();
    return res.json(Object.entries(keys).map(([key, d]) => ({
        key, note: d.note,
        timeLeft: formatTimeLeft(d.expires - now),
        active: d.expires > now
    })));
});

// ─── ADMIN: DELETE KEY ────────────────────────────────────────────────────────
app.delete('/admin/keys/:key', (req, res) => {
    if (!adminCheck(req, res)) return;
    const keys = loadKeys();
    const k    = req.params.key.toUpperCase();
    if (!keys[k]) return res.status(404).json({ error: 'Key not found' });
    delete keys[k]; saveKeys(keys);
    return res.json({ success: true });
});

// ─── ADMIN: EXTEND KEY ────────────────────────────────────────────────────────
app.post('/admin/extend', (req, res) => {
    if (!adminCheck(req, res)) return;
    const { key, days } = req.body;
    if (!key || !days) return res.status(400).json({ error: '"key" and "days" required' });
    const keys = loadKeys();
    const k    = key.trim().toUpperCase();
    if (!keys[k]) return res.status(404).json({ error: 'Key not found' });
    keys[k].expires += Number(days) * 86400000;
    saveKeys(keys);
    return res.json({ success: true, key: k, timeLeft: formatTimeLeft(keys[k].expires - Date.now()) });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✅  Agma Script Server on port ${PORT}`);
    console.log(`🔐  Admin secret: ${ADMIN_SECRET === 'changeme123' ? '⚠️  CHANGE via env ADMIN_SECRET=yourpassword' : 'set'}`);
    console.log(`📄  Script file:  ${SCRIPT_FILE}`);
    console.log(`\nEndpoints:`);
    console.log(`  GET  /script?key=XXXX          → serve script to valid key holders`);
    console.log(`  GET  /check?key=XXXX           → check key without serving script`);
    console.log(`  POST /admin/upload             → upload/update the script`);
    console.log(`  POST /admin/generate           → generate a new key`);
    console.log(`  POST /admin/add                → add a custom key`);
    console.log(`  GET  /admin/keys               → list all keys`);
    console.log(`  DELETE /admin/keys/:key        → delete a key`);
    console.log(`  POST /admin/extend             → extend a key\n`);
});
