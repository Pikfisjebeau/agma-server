const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.text({ limit: '10mb', type: '*/*' }));

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme123';
const KEYS_FILE    = path.join(__dirname, 'keys.json');
const SCRIPT_FILE  = path.join(__dirname, 'script.js');

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
    const key   = (raw || '').trim().toUpperCase();
    const keys  = loadKeys();
    const entry = keys[key];
    if (!entry) return { valid: false, reason: 'Invalid key' };
    const timeLeft = entry.expires - Date.now();
    if (timeLeft <= 0) return { valid: false, reason: 'Key expired' };
    return { valid: true, key, timeLeft, entry };
}
// ── Code morphing — every user gets a unique copy ─────────────────────────────
function rndHex(n) {
    return crypto.randomBytes(n).toString('hex');
}
function morphScript(code) {
    // Add a unique ID comment at the top
    const uid = rndHex(8).toUpperCase();
    const ts  = Date.now();

    // Inject random fake variable declarations at random positions
    const fakeVars = Array.from({length: 8}, () =>
        `var _${rndHex(4)} = ${Math.floor(Math.random()*9999)};`
    ).join(' ');

    // Inject random dead comments throughout
    const comments = Array.from({length: 5}, () =>
        `/* ${rndHex(6)} */`
    );

    let morphed = `// uid:${uid} ts:${ts}\n`;
    morphed += `(function(){${fakeVars}})();\n`;

    // Sprinkle comments into the code at random line positions
    const lines = code.split('\n');
    let ci = 0;
    const result = lines.map((line, i) => {
        if (ci < comments.length && i > 0 && i % Math.floor(lines.length / comments.length) === 0) {
            return comments[ci++] + '\n' + line;
        }
        return line;
    });

    morphed += result.join('\n');
    return morphed;
}



// ── AES-256-CBC encryption — keyed to user's fingerprint ─────────────────────
// Key = SHA256(fingerprint). Without the fingerprint the cached blob is garbage.
function encryptScript(code, fingerprint) {
    const key = crypto.createHash('sha256').update(fingerprint).digest(); // 32 bytes
    const iv  = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(code, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return {
        iv:   iv.toString('base64'),
        data: encrypted
    };
}

// ── Admin Dashboard ───────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
    const secret = req.query.secret;
    if (secret !== ADMIN_SECRET) {
        return res.status(403).send('<h1>Forbidden</h1>');
    }
    const keys = loadKeys();
    const now  = Date.now();
    // Escape HTML to prevent XSS in admin dashboard
    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    const rows = Object.entries(keys).map(([key, d]) => {
        const tl     = d.expires - now;
        const active = tl > 0;
        const fp     = d.fingerprint ? `<span style="color:#7fc7ff;font-size:11px">${d.fingerprint.slice(0,16)}...</span>` : '<span style="color:#555">none</span>';
        const expDate = new Date(d.expires).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        return `<tr style="border-bottom:1px solid #1a2a3a">
            <td style="padding:10px;font-family:monospace;color:#39ff5a">${esc(key)}</td>
            <td style="padding:10px;color:#aaa">${esc(d.note || '-')}</td>
            <td style="padding:10px;color:${active ? '#7fff8c' : '#ff6060'}">${active ? formatTimeLeft(tl) : 'EXPIRED'}</td>
            <td style="padding:10px;color:#7fc7ff;font-size:13px">${expDate}</td>
            <td style="padding:10px">${fp}</td>
            <td style="padding:10px">
                <button onclick="resetFP('${key}')" style="background:#1a3a5a;color:#7fc7ff;border:none;padding:5px 10px;border-radius:5px;cursor:pointer;margin-right:5px">Reset FP</button>
                <button onclick="extendKey('${key}')" style="background:#1a5a2a;color:#7fff8c;border:none;padding:5px 10px;border-radius:5px;cursor:pointer;margin-right:5px">+30d</button>
                <button onclick="deleteKey('${key}')" style="background:#5a1a1a;color:#ff6060;border:none;padding:5px 10px;border-radius:5px;cursor:pointer">Delete</button>
            </td>
        </tr>`;
    }).join('');

    res.send(`<!DOCTYPE html>
<html>
<head>
    <title>Agma Suite — Admin</title>
    <meta charset="utf-8">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #060c14; color: #cde; font-family: sans-serif; padding: 30px; }
        h1 { color: #39ff5a; letter-spacing: 2px; margin-bottom: 6px; }
        .sub { color: #3a5a3a; font-size: 13px; margin-bottom: 30px; }
        .card { background: #0a1220; border: 1px solid #1a2a3a; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        .card h2 { color: #7fc7ff; font-size: 14px; letter-spacing: 1px; margin-bottom: 14px; }
        input { background: #0f1a28; border: 1px solid #1a2a3a; border-radius: 6px; color: #cde; padding: 8px 12px; font-size: 13px; outline: none; }
        input:focus { border-color: #39ff5a; }
        button.gen { background: #39ff5a; color: #040c06; border: none; border-radius: 6px; padding: 9px 18px; font-weight: 700; cursor: pointer; letter-spacing: 1px; }
        button.gen:hover { background: #50ff70; }
        .dur-btns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
        .dur-btn { border: none; border-radius: 6px; padding: 8px 14px; font-weight: 700; cursor: pointer; font-size: 12px; letter-spacing: 1px; transition: opacity .15s; }
        .dur-btn:hover { opacity: 0.8; }
        table { width: 100%; border-collapse: collapse; }
        th { text-align: left; padding: 10px; color: #3a6a8a; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; border-bottom: 1px solid #1a2a3a; }
        .result { margin-top: 12px; padding: 12px; background: #0a1a0a; border: 1px solid #1a3a1a; border-radius: 8px; font-family: monospace; color: #39ff5a; font-size: 15px; letter-spacing: 2px; display: none; }
        .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
        .stat { background: #0a1220; border: 1px solid #1a2a3a; border-radius: 10px; padding: 16px; text-align: center; }
        .stat .n { font-size: 28px; font-weight: 700; color: #39ff5a; }
        .stat .l { font-size: 11px; color: #3a5a6a; letter-spacing: 1px; margin-top: 4px; }
    </style>
</head>
<body>
    <h1>AGMA SUITE // ADMIN</h1>
    <p class="sub">Key management dashboard</p>

    <div class="stats">
        <div class="stat"><div class="n">${Object.keys(keys).length}</div><div class="l">TOTAL KEYS</div></div>
        <div class="stat"><div class="n">${Object.values(keys).filter(d => d.expires > now).length}</div><div class="l">ACTIVE</div></div>
        <div class="stat"><div class="n">${Object.values(keys).filter(d => d.expires <= now).length}</div><div class="l">EXPIRED</div></div>
    </div>

    <div class="card">
        <h2>GENERATE NEW KEY</h2>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <input id="note" type="text" style="width:220px" placeholder="Player name (e.g. Beau)" />
        </div>
        <div class="dur-btns">
            <button class="dur-btn" style="background:#1a3a1a;color:#39ff5a;border:1px solid #2a5a2a" onclick="genKey(1)">1 Day</button>
            <button class="dur-btn" style="background:#1a3a2a;color:#50ff90;border:1px solid #2a5a3a" onclick="genKey(7)">1 Week</button>
            <button class="dur-btn" style="background:#1a4a2a;color:#7fffa1;border:1px solid #2a6a3a" onclick="genKey(30)">1 Month</button>
            <button class="dur-btn" style="background:#1a5a3a;color:#7fffc0;border:1px solid #2a7a4a" onclick="genKey(90)">3 Months</button>
            <button class="dur-btn" style="background:#1a6a4a;color:#7fffd4;border:1px solid #2a8a5a" onclick="genKey(180)">6 Months</button>
            <button class="dur-btn" style="background:#39ff5a;color:#040c06" onclick="genKey(365)">12 Months</button>
        </div>
        <div class="result" id="result"></div>
    </div>

    <div class="card">
        <h2>ALL KEYS</h2>
        <table>
            <thead><tr>
                <th>Key</th><th>Player</th><th>Time Left</th><th>Expires</th><th>Fingerprint</th><th>Actions</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </div>

    <script>
        const SECRET = '${ADMIN_SECRET}';
        const SERVER = window.location.origin;

        async function genKey(days) {
            const note = document.getElementById('note').value.trim();
            if (!note) { alert('Please enter a player name first!'); document.getElementById('note').focus(); return; }
            const r = await fetch(SERVER + '/admin/generate', {
                method: 'POST',
                headers: { 'x-admin-secret': SECRET, 'Content-Type': 'application/json' },
                body: JSON.stringify({ days, note })
            });
            const d = await r.json();
            const el = document.getElementById('result');
            el.style.display = 'block';
            el.innerHTML = '&#128273; ' + d.key + '<br><span style="font-size:12px;color:#7fffa1">' + note + ' &middot; ' + d.timeLeft + '</span>';
            setTimeout(() => location.reload(), 2000);
        }

        async function deleteKey(key) {
            if (!confirm('Delete key ' + key + '?')) return;
            await fetch(SERVER + '/admin/keys/' + key, {
                method: 'DELETE',
                headers: { 'x-admin-secret': SECRET }
            });
            location.reload();
        }

        async function extendKey(key) {
            await fetch(SERVER + '/admin/extend', {
                method: 'POST',
                headers: { 'x-admin-secret': SECRET, 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, days: 30 })
            });
            location.reload();
        }

        async function resetFP(key) {
            await fetch(SERVER + '/admin/reset-fp/' + key, {
                method: 'POST',
                headers: { 'x-admin-secret': SECRET }
            });
            location.reload();
        }
    </script>
</body>
</html>`);
});

// ── Public: serve script + hardware fingerprint check ─────────────────────────
app.get('/script', (req, res) => {
    const result = validateKey(req.query.key);
    if (!result.valid) return res.status(403).json({ valid: false, reason: result.reason });

    if (!fs.existsSync(SCRIPT_FILE)) return res.status(500).json({ error: 'Script not uploaded yet.' });

    // Hardware fingerprint check
    const fp = req.query.fp;
    if (fp) {
        const keys = loadKeys();
        const entry = keys[result.key];
        if (!entry.fingerprint) {
            // First time — save this fingerprint
            entry.fingerprint = fp;
            saveKeys(keys);
        } else if (entry.fingerprint !== fp) {
            // Different device — reject
            return res.status(403).json({ valid: false, reason: 'Key is already in use on another device. Contact support to reset.' });
        }
    }

    const scriptCode = fs.readFileSync(SCRIPT_FILE, 'utf8');
    const morphed    = morphScript(scriptCode);

    // Encrypt with the user's fingerprint as the key
    // Cached code in GM storage is AES-encrypted — useless without the fingerprint
    const encrypted = fp ? encryptScript(morphed, fp) : { iv: '', data: Buffer.from(morphed).toString('base64') };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Time-Left', formatTimeLeft(result.timeLeft));
    res.json({ iv: encrypted.iv, data: encrypted.data, timeLeft: formatTimeLeft(result.timeLeft) });
});

// ── Public: check key only ─────────────────────────────────────────────────────
app.get('/check', (req, res) => {
    const result = validateKey(req.query.key);
    if (!result.valid) return res.json({ valid: false, reason: result.reason });

    // Also verify fingerprint if provided — catches revoked devices
    const fp = req.query.fp;
    if (fp && result.entry.fingerprint && result.entry.fingerprint !== fp) {
        return res.json({ valid: false, reason: 'Key is already in use on another device.' });
    }

    return res.json({ valid: true, timeLeft: formatTimeLeft(result.timeLeft) });
});

// ── Admin: upload script ──────────────────────────────────────────────────────
app.post('/admin/upload', (req, res) => {
    if (!adminCheck(req, res)) return;
    if (!req.body || !req.body.trim()) return res.status(400).json({ error: 'Send script as plain text.' });
    fs.writeFileSync(SCRIPT_FILE, req.body);
    return res.json({ success: true, bytes: req.body.length });
});

// ── Admin: generate key ───────────────────────────────────────────────────────
app.post('/admin/generate', (req, res) => {
    if (!adminCheck(req, res)) return;
    const { days, note } = req.body;
    if (!days) return res.status(400).json({ error: '"days" required' });
    const key     = generateKey();
    const keys    = loadKeys();
    const expires = Date.now() + Number(days) * 86400000;
    keys[key] = { expires, note: note || '', createdAt: Date.now() };
    saveKeys(keys);
    return res.json({ success: true, key, timeLeft: formatTimeLeft(Number(days) * 86400000) });
});

// ── Admin: add custom key ─────────────────────────────────────────────────────
app.post('/admin/add', (req, res) => {
    if (!adminCheck(req, res)) return;
    const { key, days, note } = req.body;
    if (!key || !days) return res.status(400).json({ error: '"key" and "days" required' });
    const keys    = loadKeys();
    const k       = key.trim().toUpperCase();
    const expires = Date.now() + Number(days) * 86400000;
    keys[k] = { expires, note: note || '', createdAt: Date.now() };
    saveKeys(keys);
    return res.json({ success: true, key: k, timeLeft: formatTimeLeft(Number(days) * 86400000) });
});

// ── Admin: list keys ──────────────────────────────────────────────────────────
app.get('/admin/keys', (req, res) => {
    if (!adminCheck(req, res)) return;
    const keys = loadKeys();
    const now  = Date.now();
    return res.json(Object.entries(keys).map(([key, d]) => ({
        key, note: d.note,
        timeLeft: formatTimeLeft(d.expires - now),
        active: d.expires > now,
        fingerprint: d.fingerprint || null
    })));
});

// ── Admin: delete key ─────────────────────────────────────────────────────────
app.delete('/admin/keys/:key', (req, res) => {
    if (!adminCheck(req, res)) return;
    const keys = loadKeys();
    const k    = req.params.key.toUpperCase();
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
    const k    = key.trim().toUpperCase();
    if (!keys[k]) return res.status(404).json({ error: 'Key not found' });
    keys[k].expires += Number(days) * 86400000;
    saveKeys(keys);
    return res.json({ success: true, key: k, timeLeft: formatTimeLeft(keys[k].expires - Date.now()) });
});

// ── Admin: reset fingerprint ──────────────────────────────────────────────────
app.post('/admin/reset-fp/:key', (req, res) => {
    if (!adminCheck(req, res)) return;
    const keys = loadKeys();
    const k    = req.params.key.toUpperCase();
    if (!keys[k]) return res.status(404).json({ error: 'Key not found' });
    delete keys[k].fingerprint;
    saveKeys(keys);
    return res.json({ success: true, message: 'Fingerprint reset. User can activate on a new device.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✅  Agma Suite Server running on port ${PORT}`);
    console.log(`🔐  Admin secret: ${ADMIN_SECRET === 'changeme123' ? '⚠️  Change via ADMIN_SECRET env var' : 'set'}`);
    console.log(`\n🖥️   Dashboard: http://localhost:${PORT}/admin?secret=${ADMIN_SECRET}\n`);
});
