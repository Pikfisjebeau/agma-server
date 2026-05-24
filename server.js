const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.text({ limit: '10mb', type: '*/*' }));

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme123';
const KEYS_FILE = path.join(__dirname, 'keys.json');
const SCRIPT_FILE = path.join(__dirname, 'script.js');
const SCRIPT_ADV_FILE = path.join(__dirname, 'script-advanced.js');

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadKeys() {
    if (!fs.existsSync(KEYS_FILE)) fs.writeFileSync(KEYS_FILE, '{}');
    return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
}
function saveKeys(k) { fs.writeFileSync(KEYS_FILE, JSON.stringify(k, null, 2)); }
function formatTimeLeft(ms) {
    if (ms <= 0) return 'Expired';
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
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
    const key = (raw || '').trim().toUpperCase();
    const keys = loadKeys();
    const entry = keys[key];
    if (!entry) return { valid: false, reason: 'Invalid key' };
    const timeLeft = entry.expires - Date.now();
    if (timeLeft <= 0) return { valid: false, reason: 'Key expired' };
    return { valid: true, key, timeLeft, entry };
}
function rndHex(n) { return crypto.randomBytes(n).toString('hex'); }
function morphScript(code) {
    const uid = rndHex(8).toUpperCase();
    const ts = Date.now();
    const fakeVars = Array.from({ length: 8 }, () =>
        `var _${rndHex(4)} = ${Math.floor(Math.random() * 9999)};`
    ).join(' ');
    const comments = Array.from({ length: 5 }, () => `/* ${rndHex(6)} */`);
    let morphed = `// uid:${uid} ts:${ts}\n`;
    morphed += `(function(){${fakeVars}})();\n`;
    const lines = code.split('\n');
    let ci = 0;
    const result = lines.map((line, i) => {
        if (ci < comments.length && i > 0 && i % Math.floor(lines.length / comments.length) === 0)
            return comments[ci++] + '\n' + line;
        return line;
    });
    morphed += result.join('\n');
    return morphed;
}

// ── Admin Dashboard ───────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
    if (req.query.secret !== ADMIN_SECRET) return res.status(403).send('<h1>Forbidden</h1>');
    const keys = loadKeys();
    const now = Date.now();
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    const totalKeys = Object.keys(keys).length;
    const activeBasic = Object.values(keys).filter(d => d.expires > now && (d.tier || 'basic') === 'basic').length;
    const activeAdv = Object.values(keys).filter(d => d.expires > now && d.tier === 'advanced').length;
    const expiredKeys = Object.values(keys).filter(d => d.expires <= now).length;

    const rows = Object.entries(keys).sort((a, b) => b[1].expires - a[1].expires).map(([key, d]) => {
        const tl = d.expires - now;
        const active = tl > 0;
        const tier = d.tier || 'basic';
        const tierBadge = tier === 'advanced'
            ? `<span style="background:#3a1a5a;color:#c07fff;border:1px solid #6a2aaa;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:700">ADVANCED</span>`
            : `<span style="background:#1a2a3a;color:#7fc7ff;border:1px solid #1a4a6a;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:700">BASIC</span>`;
        const fp = d.fingerprint
            ? `<span style="color:#7fc7ff;font-size:11px">${esc(d.fingerprint.slice(0, 12))}…</span>`
            : '<span style="color:#444">none</span>';
        const expDate = new Date(d.expires).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        return `<tr style="border-bottom:1px solid #1a2a3a">
            <td style="padding:10px;font-family:monospace;color:#39ff5a;font-size:13px">${esc(key)}</td>
            <td style="padding:10px;color:#aaa">${esc(d.note || '-')}</td>
            <td style="padding:10px">${tierBadge}</td>
            <td style="padding:10px;color:${active ? '#7fff8c' : '#ff6060'}">${active ? formatTimeLeft(tl) : 'EXPIRED'}</td>
            <td style="padding:10px;color:#7fc7ff;font-size:12px">${expDate}</td>
            <td style="padding:10px">${fp}</td>
            <td style="padding:10px;white-space:nowrap">
                <button onclick="resetFP('${esc(key)}')" style="background:#1a3a5a;color:#7fc7ff;border:none;padding:5px 8px;border-radius:5px;cursor:pointer;margin-right:4px;font-size:12px">Reset FP</button>
                <button onclick="extendKey('${esc(key)}',30)" style="background:#1a3a1a;color:#7fff8c;border:none;padding:5px 8px;border-radius:5px;cursor:pointer;margin-right:4px;font-size:12px">+30d</button>
                <button onclick="deleteKey('${esc(key)}')" style="background:#5a1a1a;color:#ff6060;border:none;padding:5px 8px;border-radius:5px;cursor:pointer;font-size:12px">Delete</button>
            </td>
        </tr>`;
    }).join('');

    res.send(`<!DOCTYPE html>
<html>
<head>
<title>Agma Suite — Admin</title>
<meta charset="utf-8">
<style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#060c14;color:#cde;font-family:sans-serif;padding:30px}
    h1{color:#39ff5a;letter-spacing:2px;margin-bottom:6px}
    .sub{color:#3a5a3a;font-size:13px;margin-bottom:24px}
    .card{background:#0a1220;border:1px solid #1a2a3a;border-radius:12px;padding:20px;margin-bottom:20px}
    .card h2{font-size:13px;letter-spacing:1px;margin-bottom:14px;text-transform:uppercase}
    .card h2.basic{color:#7fc7ff}.card h2.adv{color:#c07fff}
    input,select{background:#0f1a28;border:1px solid #1a2a3a;border-radius:6px;color:#cde;padding:8px 12px;font-size:13px;outline:none}
    input:focus,select:focus{border-color:#39ff5a}
    .btn{border:none;border-radius:6px;padding:9px 18px;font-weight:700;cursor:pointer;letter-spacing:1px;font-size:13px}
    .btn-basic{background:#39ff5a;color:#040c06}.btn-basic:hover{background:#50ff70}
    .btn-adv{background:#a040ff;color:#fff}.btn-adv:hover{background:#b855ff}
    .dur-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
    .dur-btn{border:none;border-radius:6px;padding:7px 13px;font-weight:700;cursor:pointer;font-size:12px}
    table{width:100%;border-collapse:collapse}
    th{text-align:left;padding:10px;color:#3a6a8a;font-size:11px;letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid #1a2a3a}
    .result{margin-top:12px;padding:12px;background:#0a1a0a;border:1px solid #1a3a1a;border-radius:8px;font-family:monospace;color:#39ff5a;font-size:15px;letter-spacing:2px;display:none}
    .result.adv{background:#1a0a2a;border-color:#4a1a8a;color:#c07fff}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
    .stat{background:#0a1220;border:1px solid #1a2a3a;border-radius:10px;padding:16px;text-align:center}
    .stat .n{font-size:26px;font-weight:700}.stat .l{font-size:11px;color:#3a5a6a;letter-spacing:1px;margin-top:4px}
    .gen-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    @media(max-width:700px){.gen-grid{grid-template-columns:1fr}.stats{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<h1>AGMA SUITE // ADMIN</h1>
<p class="sub">Key management dashboard &nbsp;·&nbsp; Two-tier system</p>

<div class="stats">
    <div class="stat"><div class="n" style="color:#39ff5a">${totalKeys}</div><div class="l">TOTAL KEYS</div></div>
    <div class="stat"><div class="n" style="color:#7fc7ff">${activeBasic}</div><div class="l">BASIC ACTIVE</div></div>
    <div class="stat"><div class="n" style="color:#c07fff">${activeAdv}</div><div class="l">ADVANCED ACTIVE</div></div>
    <div class="stat"><div class="n" style="color:#ff6060">${expiredKeys}</div><div class="l">EXPIRED</div></div>
</div>

<div class="gen-grid">
    <div class="card">
        <h2 class="basic">&#128273; Generate Basic Key</h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input id="note-b" placeholder="Player name" style="flex:1;min-width:120px">
            <input id="days-b" type="number" value="30" min="1" style="width:80px">
            <button class="btn btn-basic" onclick="genKey('b')">Generate</button>
        </div>
        <div class="dur-btns">
            <button class="dur-btn" style="background:#1a3a1a;color:#7fff8c" onclick="setDays('b',1)">1 Day</button>
            <button class="dur-btn" style="background:#1a3a1a;color:#7fff8c" onclick="setDays('b',7)">1 Week</button>
            <button class="dur-btn" style="background:#1a3a1a;color:#7fff8c" onclick="setDays('b',30)">1 Month</button>
            <button class="dur-btn" style="background:#1a3a1a;color:#7fff8c" onclick="setDays('b',90)">3 Months</button>
            <button class="dur-btn" style="background:#1a3a1a;color:#7fff8c" onclick="setDays('b',180)">6 Months</button>
            <button class="dur-btn" style="background:#1a3a1a;color:#7fff8c" onclick="setDays('b',365)">1 Year</button>
        </div>
        <div id="result-b" class="result"></div>
    </div>

    <div class="card">
        <h2 class="adv">&#9889; Generate Advanced Key</h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input id="note-a" placeholder="Player name" style="flex:1;min-width:120px">
            <input id="days-a" type="number" value="30" min="1" style="width:80px">
            <button class="btn btn-adv" onclick="genKey('a')">Generate</button>
        </div>
        <div class="dur-btns">
            <button class="dur-btn" style="background:#2a0a3a;color:#c07fff" onclick="setDays('a',1)">1 Day</button>
            <button class="dur-btn" style="background:#2a0a3a;color:#c07fff" onclick="setDays('a',7)">1 Week</button>
            <button class="dur-btn" style="background:#2a0a3a;color:#c07fff" onclick="setDays('a',30)">1 Month</button>
            <button class="dur-btn" style="background:#2a0a3a;color:#c07fff" onclick="setDays('a',90)">3 Months</button>
            <button class="dur-btn" style="background:#2a0a3a;color:#c07fff" onclick="setDays('a',180)">6 Months</button>
            <button class="dur-btn" style="background:#2a0a3a;color:#c07fff" onclick="setDays('a',365)">1 Year</button>
        </div>
        <div id="result-a" class="result adv"></div>
    </div>
</div>

<div class="card">
    <h2 style="color:#7fc7ff">ALL KEYS</h2>
    <table>
        <thead><tr>
            <th>Key</th><th>Player</th><th>Tier</th><th>Time Left</th><th>Expires</th><th>Device FP</th><th>Actions</th>
        </tr></thead>
        <tbody>${rows}</tbody>
    </table>
</div>

<script>
    const SERVER = '';
    const SECRET = '${ADMIN_SECRET}';

    function setDays(t, d) {
        document.getElementById('days-' + t).value = d;
    }

    async function genKey(t) {
        const days = document.getElementById('days-' + t).value;
        const note = document.getElementById('note-' + t).value.trim();
        const tier = t === 'a' ? 'advanced' : 'basic';
        const r = await fetch(SERVER + '/admin/generate', {
            method: 'POST',
            headers: { 'x-admin-secret': SECRET, 'Content-Type': 'application/json' },
            body: JSON.stringify({ days, note, tier })
        });
        const d = await r.json();
        const el = document.getElementById('result-' + t);
        el.style.display = 'block';
        el.innerHTML = (t === 'a' ? '&#9889; ' : '&#128273; ') + d.key
            + '<br><span style="font-size:12px;opacity:0.7">' + (note || 'no name') + ' &middot; ' + d.timeLeft + ' &middot; ' + tier.toUpperCase() + '</span>';
        setTimeout(() => location.reload(), 2000);
    }

    async function deleteKey(key) {
        if (!confirm('Delete key ' + key + '?')) return;
        await fetch(SERVER + '/admin/keys/' + key, { method: 'DELETE', headers: { 'x-admin-secret': SECRET } });
        location.reload();
    }

    async function extendKey(key, days) {
        await fetch(SERVER + '/admin/extend', {
            method: 'POST',
            headers: { 'x-admin-secret': SECRET, 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, days })
        });
        location.reload();
    }

    async function resetFP(key) {
        await fetch(SERVER + '/admin/reset-fp/' + key, { method: 'POST', headers: { 'x-admin-secret': SECRET } });
        location.reload();
    }
</script>
</body>
</html>`);
});

// ── Public: serve script (tier-aware) ────────────────────────────────────────
app.get('/script', (req, res) => {
    const result = validateKey(req.query.key);
    if (!result.valid) return res.status(403).json({ valid: false, reason: result.reason });

    // Fingerprint check
    const fp = req.query.fp;
    if (fp) {
        const keys = loadKeys();
        const entry = keys[result.key];
        if (!entry.fingerprint) {
            entry.fingerprint = fp;
            saveKeys(keys);
        } else if (entry.fingerprint !== fp) {
            return res.status(403).json({ valid: false, reason: 'Key is already in use on another device. Contact support to reset.' });
        }
    }

    // Tier routing — advanced keys get script-advanced.js, basic get script.js
    const tier = result.entry.tier || 'basic';
    const scriptFile = tier === 'advanced' ? SCRIPT_ADV_FILE : SCRIPT_FILE;

    if (!fs.existsSync(scriptFile)) {
        const missing = tier === 'advanced' ? 'script-advanced.js' : 'script.js';
        return res.status(500).json({ error: `Script not uploaded yet (${missing}).` });
    }

    const code = fs.readFileSync(scriptFile, 'utf8');
    const morphed = morphScript(code);

    res.setHeader('Content-Type', 'text/javascript');
    res.setHeader('X-Time-Left', formatTimeLeft(result.timeLeft));
    res.setHeader('X-Tier', tier);
    res.send(morphed);
});

// ── Public: check key ─────────────────────────────────────────────────────────
app.get('/check', (req, res) => {
    const result = validateKey(req.query.key);
    if (!result.valid) return res.json({ valid: false, reason: result.reason });
    const fp = req.query.fp;
    if (fp && result.entry.fingerprint && result.entry.fingerprint !== fp)
        return res.json({ valid: false, reason: 'Key is already in use on another device.' });
    return res.json({
        valid: true,
        timeLeft: formatTimeLeft(result.timeLeft),
        tier: result.entry.tier || 'basic'
    });
});

// ── Admin: upload basic script ────────────────────────────────────────────────
app.post('/admin/upload', (req, res) => {
    if (!adminCheck(req, res)) return;
    if (!req.body || !req.body.trim()) return res.status(400).json({ error: 'Send script as plain text.' });
    fs.writeFileSync(SCRIPT_FILE, req.body);
    return res.json({ success: true, file: 'script.js', bytes: req.body.length });
});

// ── Admin: upload advanced script ────────────────────────────────────────────
app.post('/admin/upload-advanced', (req, res) => {
    if (!adminCheck(req, res)) return;
    if (!req.body || !req.body.trim()) return res.status(400).json({ error: 'Send script as plain text.' });
    fs.writeFileSync(SCRIPT_ADV_FILE, req.body);
    return res.json({ success: true, file: 'script-advanced.js', bytes: req.body.length });
});

// ── Admin: generate key ───────────────────────────────────────────────────────
app.post('/admin/generate', (req, res) => {
    if (!adminCheck(req, res)) return;
    const { days, note, tier } = req.body;
    if (!days) return res.status(400).json({ error: '"days" required' });
    const validTiers = ['basic', 'advanced'];
    const keyTier = validTiers.includes(tier) ? tier : 'basic';
    const key = generateKey();
    const keys = loadKeys();
    const expires = Date.now() + Number(days) * 86400000;
    keys[key] = { expires, note: note || '', tier: keyTier, createdAt: Date.now() };
    saveKeys(keys);
    return res.json({ success: true, key, tier: keyTier, timeLeft: formatTimeLeft(Number(days) * 86400000) });
});

// ── Admin: add custom key ─────────────────────────────────────────────────────
app.post('/admin/add', (req, res) => {
    if (!adminCheck(req, res)) return;
    const { key, days, note, tier } = req.body;
    if (!key || !days) return res.status(400).json({ error: '"key" and "days" required' });
    const validTiers = ['basic', 'advanced'];
    const keyTier = validTiers.includes(tier) ? tier : 'basic';
    const keys = loadKeys();
    const k = key.trim().toUpperCase();
    const expires = Date.now() + Number(days) * 86400000;
    keys[k] = { expires, note: note || '', tier: keyTier, createdAt: Date.now() };
    saveKeys(keys);
    return res.json({ success: true, key: k, tier: keyTier, timeLeft: formatTimeLeft(Number(days) * 86400000) });
});

// ── Admin: list keys ──────────────────────────────────────────────────────────
app.get('/admin/keys', (req, res) => {
    if (!adminCheck(req, res)) return;
    const keys = loadKeys();
    const now = Date.now();
    return res.json(Object.entries(keys).map(([key, d]) => ({
        key, note: d.note,
        tier: d.tier || 'basic',
        timeLeft: formatTimeLeft(d.expires - now),
        active: d.expires > now,
        fingerprint: d.fingerprint || null
    })));
});

// ── Admin: delete key ─────────────────────────────────────────────────────────
app.delete('/admin/keys/:key', (req, res) => {
    if (!adminCheck(req, res)) return;
    const keys = loadKeys();
    const k = req.params.key.toUpperCase();
    if (!keys[k]) return res.status(404).json({ error: 'Key not found' });
    delete keys[k]; saveKeys(keys);
    return res.json({ success: true });
});

// ── Admin: extend key ─────────────────────────────────────────────────────────
app.post('/admin/extend', (req, res) => {
    if (!adminCheck(req, res)) return;
    const { key, days } = req.body;
    if (!key || !days) return res.status(400).json({ error: '"key" and "days" required' });
    const keys = loadKeys();
    const k = key.trim().toUpperCase();
    if (!keys[k]) return res.status(404).json({ error: 'Key not found' });
    keys[k].expires += Number(days) * 86400000;
    saveKeys(keys);
    return res.json({ success: true, key: k, timeLeft: formatTimeLeft(keys[k].expires - Date.now()) });
});

// ── Admin: upgrade key tier ───────────────────────────────────────────────────
app.post('/admin/upgrade', (req, res) => {
    if (!adminCheck(req, res)) return;
    const { key, tier } = req.body;
    if (!key || !tier) return res.status(400).json({ error: '"key" and "tier" required' });
    const validTiers = ['basic', 'advanced'];
    if (!validTiers.includes(tier)) return res.status(400).json({ error: 'tier must be basic or advanced' });
    const keys = loadKeys();
    const k = key.trim().toUpperCase();
    if (!keys[k]) return res.status(404).json({ error: 'Key not found' });
    keys[k].tier = tier;
    saveKeys(keys);
    return res.json({ success: true, key: k, tier });
});

// ── Admin: reset fingerprint ──────────────────────────────────────────────────
app.post('/admin/reset-fp/:key', (req, res) => {
    if (!adminCheck(req, res)) return;
    const keys = loadKeys();
    const k = req.params.key.toUpperCase();
    if (!keys[k]) return res.status(404).json({ error: 'Key not found' });
    delete keys[k].fingerprint;
    saveKeys(keys);
    return res.json({ success: true, message: 'Fingerprint reset.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✅  Agma Suite Server v7 running on port ${PORT}`);
    console.log(`🔐  Admin secret: ${ADMIN_SECRET === 'changeme123' ? '⚠️  Change via ADMIN_SECRET env var' : 'set'}`);
    console.log(`📦  Basic script:    ${fs.existsSync(SCRIPT_FILE) ? '✅ uploaded' : '❌ not uploaded'}`);
    console.log(`⚡  Advanced script: ${fs.existsSync(SCRIPT_ADV_FILE) ? '✅ uploaded' : '❌ not uploaded'}`);
    console.log(`\n🖥️   Dashboard: http://localhost:${PORT}/admin?secret=${ADMIN_SECRET}\n`);
});