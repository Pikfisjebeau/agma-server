(function () {
    'use strict';

    // ===========================================================================
    // GUARD — skip in popup windows (alt window opened by Auto R2) and CF challenges
    // ===========================================================================
    if (unsafeWindow.opener ||
        unsafeWindow.top !== unsafeWindow.self ||
        document.querySelector('title')?.textContent?.includes('Just a moment')) return;

    // ===========================================================================
    // INPUT BLOCKER — when our panel is open, swallow keyboard/mouse events
    // before the game's listeners can see them. Registered at document-start so
    // we're first in line during the capture phase. Events that originate inside
    // the panel itself still pass through so the UI's own inputs/buttons work.
    // ===========================================================================
    function blockEventIfPanelOpen(e) {
        const overlay = document.getElementById('fs-overlay');
        if (!overlay || overlay.classList.contains('fs-overlay--hidden')) return;
        const menu = document.querySelector('.fs-menu');
        if (menu && menu.contains(e.target)) return;
        e.stopImmediatePropagation();
        e.preventDefault();
    }
    ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'wheel', 'contextmenu'].forEach(evt => {
        document.addEventListener(evt, blockEventIfPanelOpen, true);
        window.addEventListener(evt, blockEventIfPanelOpen, true);
    });

    const SCRIPT_VERSION = '0.9.16';
    console.log(`%c[FarmSuite v${SCRIPT_VERSION}] loaded`, 'color:#7fc7ff;font-weight:bold');

    // ===========================================================================
    // CONFIG
    // ===========================================================================
    const STORAGE_KEY = 'agma_farm_suite_cfg';
    const BC_NAME = 'agma_farm_suite';

    const ROLES = {
        NONE: 'none',
        FEEDER: 'feeder',
        AUTO_R2: 'auto_r2',
        XP: 'xp',
    };
    const ROLE_LABELS = {
        [ROLES.NONE]: 'None',
        [ROLES.FEEDER]: 'Block Feeder',
        [ROLES.AUTO_R2]: 'Auto R2',
        [ROLES.XP]: 'XP Bot (soon!)',
    };

    // Server X Instant coordinates (from msg 48)
    const R1_PORTAL = [3400, 15300];
    const R2_PORTAL = [12000, 15500];
    const RECOMBINE = [11000, 15000];
    const SPEED = [12800, 14500];
    const LEFT_PELLET = [11300, 14900];
    const RIGHT_PELLET = [12600, 14900];

    const DEFAULTS = {
        role: ROLES.NONE,
        altPrefix: 'alt',
        altPassword: '',
        altCurrent: 1,
        recWanted: 9,
        speedWanted: 7,
        xpTargetMass: 10000,
        // Target spot for the XP bot to sit at while being fed. Default is the center
        // of the (0,0)–(8800,8200) safe square (top-left quadrant on agma's X Instant).
        xpTargetX: 4400,
        xpTargetY: 4100,
        // Map size for the post-feed dispersion "go furthest direction" calculation.
        // X Instant map appears to bottom-out around Y=15500 (R2_PORTAL), so 14000 is
        // a safe lower-bound for the "which is more far" math.
        xpMapHeight: 14000,
        scanRadius: 2000,
        feederKey: '0',
        r2Key: '9',
        xpKey: '8',
        minCellSize: 35,
        // Block Feeder chase config.
        // feederChaseMode — what to chase between blocks:
        //   'none'   = no chase, just wait for next block (most discreet — minimal bot pattern)
        //   'virus'  = chase viruses (default; widely-used pattern)
        //   'coins'  = chase coins spit by consumed blocks (NOTE: this aim pattern got
        //              someone IP-banned previously; less common across known bots)
        //   'both'   = chase viruses first, then coins after viruses are clear
        // feederVirusTiming — when the virus chase happens:
        //   'before' = chase viruses while a block is active too — divert from
        //              feeding when a virus enters scan range, then resume the block;
        //              also do a 2 s pre-chase when a new block appears and a virus
        //              is already nearby
        //   'after'  = ONLY chase viruses after the block goes grey (no divert from
        //              active block, no pre-chase before feeding)
        feederChaseMode: 'virus',
        feederVirusTiming: 'before',
        // feederFeedMode — how W-feed ejects mass per server tick:
        //   'multi'  = max multi-eject (5 cells per press, like gayma's V key) — default,
        //              maximum throughput into the block
        //   'normal' = single eject (1 cell per press, like the normal W key) — slower
        //              but more discreet, less suspicious throughput pattern
        feederFeedMode: 'multi',
        // feederMinMass — stop W-feeding the block once our cell shrinks below this
        // mass. Feeding ejects mass, so without a floor the cell can melt away into
        // nothing while the block keeps draining it. The proximity tick checks this
        // every 200 ms and toggles feed off below the threshold (and back on once
        // pellet pickup grows the cell above it again). Mass = floor(size² / 100).
        feederMinMass: 100,
        // X Instant cycle timings (tunable from Auto R2 tab)
        r2TravelTime: 8,       // seconds at RECOMBINE before freeze
        r2FeedDuration: 0.5,     // seconds of W-feed simultaneous with split
        r2PelletTimeoutMs: 15000,   // (unused — kept so saved configs don't break)
    };

    function loadConfig() {
        try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }; }
        catch (_) { return { ...DEFAULTS }; }
    }
    function saveConfig() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch (_) { }
    }
    const config = loadConfig();

    // ===========================================================================
    // STATE
    // ===========================================================================
    let role = config.role;
    let enabled = false;          // is the active role's bot toggled on?
    let portalMode = null;           // R1 / R2 detected from portal entry
    const Modes = { R1: 0, R2: 1 };

    // Shared cell tracking
    let mainWs = null;
    let cellAttributes = null;
    let allCells = {};
    let imageIdSetupDone = false;

    // Auto R2
    let altWindow = null;
    let altWs = null;
    let allAltCells = {};
    let r2Phase = 'OFF';          // OFF | CYCLING | TRAVELING | WAIT_PELLETS | EATING — R2 cycle only
    let r2StartTime = 0;
    let monitorCellId = null;
    let cycleAbort = false;
    let liveRecCount = 0;
    let liveSpeedCount = 0;
    let cyclesCompleted = 0;
    // Alt's most recent rec/speed counts from its op 80. Updated whenever an alt op 80 arrives.
    let altRecCount = 0;
    let altSpeedCount = 0;
    let altCountsReceived = false;
    let lastReadyLog = 0;     // throttle for "ready, open alt tab" console message
    let lastReadyNotif = 0;     // throttle for desktop notification (10s)
    let pelletDetectedCount = 0;
    let waitingForPellets = false;
    let pelletAtLeft = false;
    let pelletAtRight = false;

    // ===========================================================================
    // AUTO-TRANSFER STATE MACHINE (v0.6.0 rewrite)
    //
    // Every step in the transfer flow is an explicit state. Each state has a
    // bounded timeout (WAITING_FOR_R2 is the one exception — that one waits
    // forever for the R2 cycle to refill main's inventory). Timeouts trip a
    // failure; 3 failures on the same alt advance the chain to the next.
    //
    //   IDLE ── transferStartChain() ──→ LOGGING_IN
    //   LOGGING_IN  (sent login packet)
    //     │
    //     ├── op 95 status=1 ──→ CHECK_COUNTS
    //     └── op 95 status≠1 ──→ FAIL → LOGGING_OUT → 1s → LOGGING_IN
    //   CHECK_COUNTS  (waiting for first alt op 80)
    //     │
    //     ├── counts ≥ 9/7 ──→ SKIP path → LOGGING_OUT → 1s → LOGGING_IN
    //     ├── counts < 9/7, main has deficit covered ──→ SPAWNING
    //     └── counts < 9/7, main empty ──→ WAITING_FOR_R2
    //   WAITING_FOR_R2  (alt sits logged in, not spawned)
    //     │
    //     └── main op 80 shows enough ──→ SPAWNING
    //   SPAWNING  (setNick fired, waiting for op 13)
    //     │
    //     └── alt sends op 13 (spawn request) ──→ (fire drops) → WAITING_DROP_CONFIRM
    //   WAITING_DROP_CONFIRM  (wait for alt op 80 ≥ wanted)
    //     │
    //     └── confirmed ──→ ADVANCE → LOGGING_OUT → 1s → LOGGING_IN
    //   LOGGING_OUT  (sent logoutPacket, waiting before next login)
    //     │
    //     └── 1000 ms elapsed ──→ LOGGING_IN
    //
    // Bail-out: if T_MAX_CONSECUTIVE_FAILS alts in a row all hit 3 strikes,
    // set tPaused = true. tDoLogout no longer schedules the next login, and
    // transferOnMainOp80's IDLE bootstrap is gated. User must toggle R2 off+on
    // (or fix altPassword/altPrefix/altCurrent) to resume.
    // ===========================================================================
    const T_STATE = {
        IDLE: 'IDLE',
        LOGGING_IN: 'LOGGING_IN',
        CHECK_COUNTS: 'CHECK_COUNTS',
        WAITING_FOR_R2: 'WAITING_FOR_R2',
        SPAWNING: 'SPAWNING',
        WAITING_DROP_CONFIRM: 'WAITING_DROP_CONFIRM',
        LOGGING_OUT: 'LOGGING_OUT',
    };
    // Per-state timeouts in ms. WAITING_FOR_R2 is intentionally absent — it waits forever.
    // Tightened in 0.6.1 — typical happy-path durations on a healthy connection
    // are well under these limits; the timeouts only fire on genuine stalls.
    const T_TIMEOUTS = {
        LOGGING_IN: 5000,
        CHECK_COUNTS: 2000,
        SPAWNING: 3000,
        WAITING_DROP_CONFIRM: 4000,
        LOGGING_OUT: 2000,
    };
    const T_MAX_CONSECUTIVE_FAILS = 5;   // after this many alts all fail, pause the chain

    let tState = T_STATE.IDLE;
    let tStateEnteredAt = 0;
    let tAttempts = 0;        // failure count for the CURRENT alt; 3 → advance
    let tDropsSentAt = 0;        // timestamp of the drop burst (filters stale op 80)
    let tDropCoords = null;     // { x, y } where drops landed — for UI
    let tLastStatusLog = 0;        // throttles WAITING_FOR_R2 console reminder
    let tNextLoginTimerId = null;     // handle for the LOGGING_OUT → 1s → next-login timer
    let tSpawnRetryCount = 0;        // retries for SPAWNING setNick if no op 13 arrives
    let tR2WasReady = false;    // for edge-triggered "R2 ready" log when liveRec/Speed crosses threshold
    let tConsecutiveFails = 0;        // number of alts in a row that hit 3 strikes
    let tPaused = false;    // true after T_MAX_CONSECUTIVE_FAILS — chain stops auto-restarting

    // Feeder
    let feederPhase = 'IDLE';      // IDLE | FEEDING | DIVERT | VIRUS | XP_BOOST | OFF
    let feederTargets = new Map();   // gold block id -> cell
    let feederTarget = null;
    let feederFeedOn = false;       // tracks server-side feed state (so the FEEDING-phase
    // proximity loop doesn't re-spam feedOn/feedOff every tick)
    let divertedFromTarget = null;       // block target paused for a virus diversion — resume after virus is gone
    let isFrozen = false;
    let virusInterval = null;
    let xpBoostInterval = null;
    let xpBoostLastRecv = 0;
    let xpBoostTarget = null;

    // XP role
    let xpBroadcastInterval = null;
    let xpCurrentMass = 0;
    let xpCurrentPos = null;
    let xpPhase = 'OFF';      // OFF | POSITIONING | READY | DISPERSING | DONE
    // Tracks whether the previous xpTick saw any own cells. Lets us detect the
    // edge from "had cells" → "no cells" (i.e. death) and broadcast xp_dead so
    // the feeder exits XP_BOOST immediately instead of timing out after 4s.
    let xpHadCells = false;

    // ===========================================================================
    // LAG / HIGH-PING SAFETY
    //
    // High ping is the most common pre-ban condition: outgoing packets pile up
    // in the OS network buffer while the link stalls, then flush all at once
    // when the connection recovers. The server sees a tight burst that no human
    // could produce and bans the account.
    //
    // We track time-since-last-incoming-message as a cheap RTT proxy. After
    // LAG_THRESHOLD_MS of silence we flip `pausedDueToLag = true` and every
    // packet-sending tick short-circuits via `isLaggy()`. The next incoming
    // message clears the flag and operation resumes.
    // ===========================================================================
    const LAG_THRESHOLD_MS = 2000;
    let lastIncomingTime = Date.now();
    let pausedDueToLag = false;
    function isLaggy() { return pausedDueToLag; }
    function noteIncoming() {
        lastIncomingTime = Date.now();
        if (pausedDueToLag) {
            pausedDueToLag = false;
            console.log('%c[FarmSuite] Lag cleared — resuming bot', 'color:#7fffa1');
        }
    }
    setInterval(() => {
        if (pausedDueToLag) return;
        const elapsed = Date.now() - lastIncomingTime;
        if (elapsed > LAG_THRESHOLD_MS) {
            pausedDueToLag = true;
            console.warn(`%c[FarmSuite] No incoming for ${elapsed}ms — PAUSING bot (high ping) to avoid burst-flush ban`, 'color:#ff7a7a;font-weight:bold');
        }
    }, 500);

    // Async helper that suspends a cycle until the lag flag clears (or the bot
    // is turned off / cycle aborted). Used at every packet-send point inside
    // r2Cycle and the transfer state machine so high-ping windows don't
    // accumulate sends.
    async function waitWhileLaggy() {
        while (pausedDueToLag && enabled && !cycleAbort) {
            await wait(0.5);
        }
    }

    // Virus / cellId tracking (from afk feeder)
    const myCellIds = new Set();
    const virusCells = new Map();
    const virusCellTypes = new Map();

    // ===========================================================================
    // CROSS-TAB COMM (XP <-> Feeder)
    // ===========================================================================
    const channel = new BroadcastChannel(BC_NAME);

    function bcSend(msg) {
        try { channel.postMessage(msg); } catch (_) { }
    }

    channel.addEventListener('message', ev => {
        const m = ev.data || {};
        if (role === ROLES.FEEDER) {
            if (m.type === 'xp_active') {
                xpBoostLastRecv = Date.now();
                xpBoostTarget = { x: m.x, y: m.y, mass: m.mass };
                if (enabled && m.mass < config.xpTargetMass) enterXpBoost();
                else if (m.mass >= config.xpTargetMass) exitXpBoost();
                updateUI();
            } else if (m.type === 'xp_dead') {
                console.log('[FarmSuite] Feeder received xp_dead — exiting XP_BOOST immediately');
                xpBoostTarget = null;
                exitXpBoost();
                updateUI();
            } else if (m.type === 'xp_done') {
                xpBoostTarget = null;
                exitXpBoost();
                updateUI();
            }
        }
    });

    // ===========================================================================
    // PACKETS
    // ===========================================================================
    const mousePacket = new DataView(new ArrayBuffer(9));    // op 0
    mousePacket.setUint8(0, 0);
    const virusMousePacket = new DataView(new ArrayBuffer(9));
    virusMousePacket.setUint8(0, 0);
    const xpMousePacket = new DataView(new ArrayBuffer(9));
    xpMousePacket.setUint8(0, 0);
    const splitPacket = new Uint8Array([17]).buffer;
    const splitMinionsPacket = new Uint8Array([32]).buffer;
    const freezePacket = new Uint8Array([35]).buffer;
    const logoutPacket = new Uint8Array([5]).buffer;
    const feedOnPacket = new Uint8Array([21]).buffer;
    const feedOffPacket = new Uint8Array([36]).buffer;
    // op 180 = set ejected-cells-per-W. Gayma sends this when toggling between the
    // W key (single eject, [180,1]) and the V key (max multi-eject, [180,5]). Once
    // set, every subsequent feedOn (op 21) uses that count until changed.
    const normalFeedPacket = new Uint8Array([180, 1]).buffer;
    const multiFeedMaxPacket = new Uint8Array([180, 5]).buffer;
    const dropPowerPacket = new DataView(new ArrayBuffer(10));   // op 72
    dropPowerPacket.setUint8(0, 72);

    // Spawn packets — mirror what gayma's setNick fires (sendSignal(34) + sendPlayerUpdate).
    // We construct and ship these ourselves so we don't depend on setNick's gates
    // (respawnCooldown, mainPlayerCells.length, isWebSocketAccepted), which are
    // sandbox-local and not reachable from our window. Spawn packet bytes:
    //   [0] = 1   (opcode: sendPlayerUpdate)
    //   [1-2] = 0 (skinId uint16 LE — default skin)
    //   [3] = 0   (wearables count)
    // Empty nickname → no trailing bytes. Server falls back to the account name.
    const spawnSignalPacket = new Uint8Array([34]).buffer;
    const spawnRequestPacket = new Uint8Array([1, 0, 0, 0]).buffer;

    // ===========================================================================
    // WEBSOCKET CAPTURE
    // ===========================================================================
    const NativeWS = unsafeWindow.WebSocket;
    const nativeSend = NativeWS.prototype.send;       // captured first

    // hook onmessage so we can parse server packets
    const _origMsg = Object.getOwnPropertyDescriptor(NativeWS.prototype, 'onmessage');
    Object.defineProperty(NativeWS.prototype, 'onmessage', {
        configurable: true, enumerable: true,
        get() { return _origMsg.get.call(this); },
        set(handler) {
            const wrapped = function (event) {
                if (event.data instanceof ArrayBuffer) {
                    try { handleIncoming(this, new DataView(event.data)); } catch (_) { }
                }
                handler.call(this, event);
            };
            _origMsg.set.call(this, wrapped);
        }
    });

    // capture main socket via constructor override
    unsafeWindow.WebSocket = function (url, protocols) {
        const sock = protocols ? new NativeWS(url, protocols) : new NativeWS(url);
        if (typeof url === 'string' && url.includes('agma')) {
            mainWs = sock;
            virusCells.clear();
            myCellIds.clear();
            virusCellTypes.clear();
            updateUI();
        }
        return sock;
    };
    unsafeWindow.WebSocket.prototype = NativeWS.prototype;

    // block game's mouse packets when bot active so we can drive the cell
    const _prevSend = NativeWS.prototype.send;
    NativeWS.prototype.send = function (pkt) {
        if (enabled && (role === ROLES.FEEDER || role === ROLES.AUTO_R2)
            && pkt?.getUint8?.(0) === 0) return;
        return _prevSend.apply(this, arguments);
    };

    // ===========================================================================
    // PACKET HANDLERS
    // ===========================================================================
    function handleIncoming(ws, view) {
        noteIncoming();
        const op = view.getUint8(0);

        // virus / cell-id tracking — only on the relevant socket
        if (ws === mainWs) {
            if (op === 10) handleWorldUpdate(view);
            else if (op === 11) handleCellKilled(view);
            else if (op === 12) handleCellRemoved(view);
            else if (op === 20) handleClearAll();
            else if (op === 32) myCellIds.add(view.getUint32(1, true));
        }

        // R2 / Transfer routing — main op 80 updates inventory + nudges state machine,
        // alt ops 80 / 95 route into the new transfer state machine.
        if (role === ROLES.AUTO_R2 && enabled) {
            if (ws === mainWs && op === 80) {
                liveRecCount = view.getUint32(10, true);
                liveSpeedCount = view.getUint32(14, true);
                transferOnMainOp80();
                updateUI();
            } else if (ws === altWs) {
                if (op === 80) {
                    altRecCount = view.getUint32(10, true);
                    altSpeedCount = view.getUint32(14, true);
                    altCountsReceived = true;
                    transferOnAltOp80();
                } else if (op === 95) {
                    transferOnAltOp95(view.getUint8(1));
                }
            }
        }
    }

    function handleClearAll() {
        myCellIds.clear();
        virusCells.clear();
        // Without this, after a full-clear (map reset, server hop, respawn into a
        // fresh view) the feeder kept old target entries and would aim feedTowards
        // at coords where nothing exists anymore — the "feeding into the void" bug.
        feederTargets.clear();
        if (feederTarget && enabled && role === ROLES.FEEDER && feederPhase !== 'XP_BOOST') {
            feederTarget = null;
            selectNextFeederTarget();
        } else {
            feederTarget = null;
        }
    }

    function handleWorldUpdate(view) {
        let pos = 1;
        try {
            const numProfiles = view.getUint16(pos, true); pos += 2;
            for (let i = 0; i < numProfiles; i++) {
                const flags = view.getUint8(pos); pos += 1;
                if (flags & 2) pos += 1;
                if (flags & 32) pos += 1;
                pos += 4;
                if (flags & 1) pos += 4;
                while (pos + 1 < view.byteLength) {
                    const code = view.getUint16(pos, true); pos += 2;
                    if (code === 0) break;
                }
                pos += 2;
                pos += 1;
                const nw = view.getUint8(pos); pos += 1;
                for (let j = 0; j < nw; j++) { pos += 2; pos += 1; }
            }
            while (pos + 4 <= view.byteLength) {
                const cellId = view.getUint32(pos, true); pos += 4;
                if (!cellId) break;
                if (pos + 10 > view.byteLength) break;
                const x = view.getInt32(pos, true); pos += 4;
                const y = view.getInt32(pos, true); pos += 4;
                const size = view.getUint16(pos, true); pos += 2;
                const flags = view.getUint8(pos); pos += 1;
                const isNew = !!(flags & 1);
                if (isNew) {
                    const type = view.getUint8(pos); pos += 1;
                    if (flags & 8) pos += 1;
                    pos += 3;
                    if (flags & 2) pos += 3;
                    if (type === 0) pos += 2;
                    virusCellTypes.set(cellId, type);
                }
                const type = virusCellTypes.get(cellId) ?? -1;
                const existing = virusCells.get(cellId);
                if (existing) { existing.x = x; existing.y = y; existing.size = size; }
                else { virusCells.set(cellId, { x, y, size, type }); }
            }
        } catch (_) { }
    }

    function handleCellKilled(view) {
        try {
            let pos = 1;
            const n = view.getUint16(pos, true); pos += 2;
            let currentTargetGone = false;
            for (let i = 0; i < n; i++) {
                pos += 4;
                const killedId = view.getUint32(pos, true); pos += 4;
                virusCells.delete(killedId);
                myCellIds.delete(killedId);
                if (feederTargets.delete(killedId) && feederTarget && feederTarget.id === killedId) {
                    currentTargetGone = true;
                }
            }
            if (currentTargetGone && enabled && role === ROLES.FEEDER && feederPhase !== 'XP_BOOST') {
                feederTarget = null;
                selectNextFeederTarget();
            }
        } catch (_) { }
    }

    function handleCellRemoved(view) {
        try {
            let pos = 1;
            const n = view.getUint32(pos, true); pos += 4;
            let currentTargetGone = false;
            for (let i = 0; i < n; i++) {
                const id = view.getUint32(pos, true); pos += 4;
                virusCells.delete(id);
                myCellIds.delete(id);
                if (feederTargets.delete(id) && feederTarget && feederTarget.id === id) {
                    currentTargetGone = true;
                }
            }
            if (currentTargetGone && enabled && role === ROLES.FEEDER && feederPhase !== 'XP_BOOST') {
                feederTarget = null;
                selectNextFeederTarget();
            }
        } catch (_) { }
    }

    // ===========================================================================
    // CELL PUSH HOOK — capture cellAttributes & detect portals/gold blocks
    // ===========================================================================
    const _prevPush = unsafeWindow.Array.prototype.push;
    unsafeWindow.Array.prototype.push = function (cell) {
        if (!imageIdSetupDone && cell?.namePart !== undefined && cell?.id !== undefined) {
            cellAttributes = Object.getOwnPropertyNames(cell);
            imageIdSetupDone = true;
            try {
                Object.defineProperty(cell.constructor.prototype, cellAttributes[41], {
                    configurable: true,
                    get() { return this.__imageId; },
                    set(imageId) {
                        try { handleImageId(this, imageId); } catch (_) { }
                        return this.__imageId = imageId;
                    }
                });
            } catch (_) { }
        }
        return _prevPush.apply(this, arguments);
    };

    function handleImageId(cell, imageId) {
        const x = cell[cellAttributes[31]];
        const y = cell[cellAttributes[32]];

        // Portal detection (any role — needed for Auto R2 cycle gating)
        if (imageId === 1) {
            if (x === R1_PORTAL[0] && y === R1_PORTAL[1]) {
                portalMode = Modes.R1;
                updateUI();
            } else if (x === R2_PORTAL[0] && y === R2_PORTAL[1]) {
                portalMode = Modes.R2;
                updateUI();
            }
        }

        // Pellet detection (Auto R2 cycle's wait-for-pellets phase) — only count pellets
        // that actually appear at one of the two known drop spots
        if (imageId === 3 && waitingForPellets) {
            const TOL = 600;  // tolerance for "near a spot" in game units
            const dl = Math.hypot(x - LEFT_PELLET[0], y - LEFT_PELLET[1]);
            const dr = Math.hypot(x - RIGHT_PELLET[0], y - RIGHT_PELLET[1]);
            if (dl < TOL && dl <= dr) {
                pelletAtLeft = true;
                pelletDetectedCount++;
            } else if (dr < TOL) {
                pelletAtRight = true;
                pelletDetectedCount++;
            }
            // pellets outside the tolerance of either spot are ignored
        }

        // Gold block tracking — Feeder only
        if (role === ROLES.FEEDER && enabled) {
            if (imageId === 10) {
                feederTargets.set(cell.id, cell);
                if (!feederTarget && feederPhase !== 'XP_BOOST') {
                    stopVirusChase();
                    feederTarget = cell;
                    const goldCell = cell;

                    // Pre-chase: if feederVirusTiming === 'before' AND chase mode
                    // includes virus AND a virus is in scan range, briefly aim at it
                    // for 2 s before the normal split-minions + feed sequence. Gives
                    // the cell time to consume the nearby threat before committing.
                    let virusDelay = 0;
                    const chaseMode = config.feederChaseMode || 'virus';
                    if (config.feederVirusTiming === 'before'
                        && (chaseMode === 'virus' || chaseMode === 'both')) {
                        const v = getNearestVirus();
                        if (v) {
                            freeze();                    // virus/coin pickup = frozen
                            virusMousePacket.setInt32(1, Math.round(v.x), true);
                            virusMousePacket.setInt32(5, Math.round(v.y), true);
                            nativeSend.call(mainWs, virusMousePacket.buffer);
                            virusDelay = 2000;
                        }
                    }

                    setTimeout(() => {
                        if (!enabled || feederPhase === 'XP_BOOST') return;
                        unfreeze();                      // block prep = unfrozen
                        const ownCell = Object.values(allCells).find(c => c[cellAttributes[45]]);
                        if (ownCell) {
                            mousePacket.setInt32(1, ownCell[cellAttributes[31]], true);
                            mousePacket.setInt32(5, ownCell[cellAttributes[32]], true);
                            nativeSend.call(mainWs, mousePacket.buffer);
                        }
                    }, virusDelay);
                    setTimeout(() => nativeSend.call(mainWs, splitMinionsPacket), virusDelay + 500);
                    setTimeout(() => nativeSend.call(mainWs, splitMinionsPacket), virusDelay + 1000);
                    setTimeout(() => {
                        if (feederTarget === goldCell && enabled && feederPhase !== 'XP_BOOST') {
                            feedTowards(goldCell);
                        }
                    }, virusDelay + 1500);
                }
            } else if (imageId === 11) {
                feederTargets.delete(cell.id);
                if (cell.id === feederTarget?.id) selectNextFeederTarget();
            }
        }
    }

    // allCells capture
    const _prevHasOwn = unsafeWindow.Object.prototype.hasOwnProperty;
    unsafeWindow.Object.prototype.hasOwnProperty = function () {
        if (allCells !== this && arguments?.[0] > 10000) allCells = this;
        return _prevHasOwn.apply(this, arguments);
    };

    // ===========================================================================
    // FEEDER ROLE
    // ===========================================================================
    function freeze() { if (!isFrozen) { isFrozen = true; nativeSend.call(mainWs, freezePacket); } }
    function unfreeze() { if (isFrozen) { isFrozen = false; nativeSend.call(mainWs, freezePacket); } }

    function getMyPosition() {
        let x = 0, y = 0, count = 0;
        for (const id of myCellIds) {
            const c = virusCells.get(id);
            if (c) { x += c.x; y += c.y; count++; }
        }
        return count ? { x: x / count, y: y / count } : null;
    }
    function getMySize() {
        if (!cellAttributes) return 0;
        let maxSize = 0;
        for (const cell of Object.values(allCells)) {
            if (cell[cellAttributes[45]] && cell.size > maxSize) maxSize = cell.size;
        }
        return maxSize;
    }
    function getNearestVirus() {
        const pos = getMyPosition();
        const mySize = getMySize();
        if (!pos || !mySize) return null;
        const radius = mySize + config.scanRadius;
        let nearest = null, bestDiff = Infinity;
        for (const [, cell] of virusCells) {
            if (cell.type !== 2) continue;
            if (myCellIds.has(cell.id)) continue;
            const dx = cell.x - pos.x;
            const dy = cell.y - pos.y;
            if (Math.sqrt(dx * dx + dy * dy) > radius) continue;
            const diff = Math.abs(cell.size - mySize);
            if (diff < bestDiff) { bestDiff = diff; nearest = cell; }
        }
        return nearest;
    }

    // Coin scanner — all cells with type === 13 are coins spat out by gold blocks.
    // virusCells tracks every cell parsed from world updates regardless of type, so
    // we just filter by type. Returns the closest coin within scan radius (or null).
    function getNearestCoin() {
        const pos = getMyPosition();
        const mySize = getMySize();
        if (!pos || !mySize) return null;
        const radius = mySize + config.scanRadius;
        let nearest = null, bestDist = Infinity;
        for (const [, cell] of virusCells) {
            if (cell.type !== 13) continue;
            if (myCellIds.has(cell.id)) continue;
            const dx = cell.x - pos.x;
            const dy = cell.y - pos.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d > radius) continue;
            if (d < bestDist) { bestDist = d; nearest = cell; }
        }
        return nearest;
    }

    function countCoins() {
        let n = 0;
        for (const [, c] of virusCells) if (c.type === 13) n++;
        return n;
    }

    let lastNoVirusSplit = 0;
    function virusTick() {
        if (!mainWs || !enabled || role !== ROLES.FEEDER || feederPhase === 'XP_BOOST') return;
        if (isLaggy()) return;

        const mode = config.feederChaseMode || 'virus';

        // FEEDING phase — a virus appearing in scan range diverts us off the block
        // briefly. Coins do NOT divert (virus > coin priority by user spec).
        //
        // Gated by feederVirusTiming:
        //   'before' = allow diverting from the block to eat the virus, then resume
        //   'after'  = stay on the block, chase the virus only after it goes grey
        if (feederPhase === 'FEEDING') {
            // Maintain aim on the block's near corner each tick (the corner shifts as
            // the cell drifts) and toggle feed by proximity. Only feed when cell-edge
            // is close to block-edge — feeding from far away just dumps mass into
            // empty space. Threshold is centre-to-centre ≤ ownSize + blockSize + 100 px.
            if (feederTarget && cellAttributes) {
                const ownCell = Object.values(allCells).find(c => c[cellAttributes[45]]);
                if (ownCell) {
                    const bx = feederTarget[cellAttributes[31]];
                    const by = feederTarget[cellAttributes[32]];
                    const bs = feederTarget[cellAttributes[30]] || 0;
                    const ox = ownCell[cellAttributes[31]];
                    const oy = ownCell[cellAttributes[32]];
                    const os = ownCell[cellAttributes[30]] || 0;
                    // Re-aim at the near corner
                    const tx = Math.round(bx + Math.sign(ox - bx) * bs);
                    const ty = Math.round(by + Math.sign(oy - by) * bs);
                    mousePacket.setInt32(1, tx, true);
                    mousePacket.setInt32(5, ty, true);
                    nativeSend.call(mainWs, mousePacket.buffer);
                    // Proximity gate + mass floor. Feed only when:
                    //   1) cell edge is within +100 px of touching the block (so mass lands), AND
                    //   2) own mass is above config.feederMinMass (so we don't melt the cell away).
                    // Mass = floor(size² / 100), per gayma's formula.
                    const d = Math.hypot(ox - bx, oy - by);
                    const closeEnough = d <= os + bs + 100;
                    const ownMass = Math.floor((os * os) / 100);
                    const enoughMass = ownMass >= config.feederMinMass;
                    const shouldFeed = closeEnough && enoughMass;
                    if (shouldFeed && !feederFeedOn) {
                        nativeSend.call(mainWs, feedOnPacket);
                        feederFeedOn = true;
                    } else if (!shouldFeed && feederFeedOn) {
                        nativeSend.call(mainWs, feedOffPacket);
                        feederFeedOn = false;
                    }
                }
            }

            if (config.feederVirusTiming !== 'before') return;
            if (mode !== 'virus' && mode !== 'both') return;
            const virus = getNearestVirus();
            if (!virus) return;                  // no virus in range — stay on the block
            divertedFromTarget = feederTarget;
            nativeSend.call(mainWs, feedOffPacket);
            feederFeedOn = false;
            freeze();                            // virus/coin pickup = frozen (per spec)
            virusMousePacket.setInt32(1, Math.round(virus.x), true);
            virusMousePacket.setInt32(5, Math.round(virus.y), true);
            nativeSend.call(mainWs, virusMousePacket.buffer);
            feederPhase = 'DIVERT';
            updateUI();
            return;
        }

        // DIVERT phase — keep aiming at the nearest virus until none remain in range,
        // then resume the original block feed (or fall back to VIRUS chase if the block
        // went grey while we were away).
        if (feederPhase === 'DIVERT') {
            const virus = (mode === 'virus' || mode === 'both') ? getNearestVirus() : null;
            if (virus) {
                virusMousePacket.setInt32(1, Math.round(virus.x), true);
                virusMousePacket.setInt32(5, Math.round(virus.y), true);
                nativeSend.call(mainWs, virusMousePacket.buffer);
                return;
            }
            // No virus left. Resume block feed if the block is still active.
            if (divertedFromTarget && feederTargets.has(divertedFromTarget.id)) {
                const target = divertedFromTarget;
                divertedFromTarget = null;
                feederTarget = target;
                feedTowards(target);             // sets feederPhase = 'FEEDING'
            } else {
                // Block went grey during diversion — go to chase phase (handles coins).
                divertedFromTarget = null;
                feederTarget = null;
                nativeSend.call(mainWs, feedOffPacket);
                feederFeedOn = false;
                feederPhase = 'VIRUS';
                updateUI();
            }
            return;
        }

        // VIRUS phase — between-blocks chase. Mode dispatches what to chase.
        // 'both' prioritises virus over coin (faster threat first).
        let target = null;
        if (mode === 'virus' || mode === 'both') target = getNearestVirus();
        if (!target && (mode === 'coins' || mode === 'both')) target = getNearestCoin();

        if (target) {
            freeze();                            // virus/coin pickup = frozen (per spec)
            virusMousePacket.setInt32(1, Math.round(target.x), true);
            virusMousePacket.setInt32(5, Math.round(target.y), true);
            nativeSend.call(mainWs, virusMousePacket.buffer);
            return;
        }

        if (mode === 'none') return;

        // No target in range — periodic split-minions to spread cells and surface
        // new viruses / blocks / coins in render range.
        const now = Date.now();
        if (now - lastNoVirusSplit >= 3000 && cellAttributes) {
            const ownCell = Object.values(allCells).find(c => c[cellAttributes[45]]);
            if (ownCell) {
                mousePacket.setInt32(1, ownCell[cellAttributes[31]], true);
                mousePacket.setInt32(5, ownCell[cellAttributes[32]], true);
                nativeSend.call(mainWs, mousePacket.buffer);
                setTimeout(() => { if (enabled) nativeSend.call(mainWs, splitMinionsPacket); }, 200);
                lastNoVirusSplit = now;
            }
        }
    }
    function startVirusChase() {
        // Tick is now lifecycle-managed by feederToggle. This function just transitions
        // phase — kept as a name so old call sites stay readable.
        if (feederPhase !== 'XP_BOOST') feederPhase = 'VIRUS';
    }
    function stopVirusChase() {
        // No-op for the interval (managed by feederToggle). Phase is set by the caller
        // when it transitions to FEEDING / XP_BOOST / DIVERT.
    }

    function selectNextFeederTarget() {
        const next = feederTargets.values().next().value;
        feederTarget = next || null;
        if (feederTarget) {
            feedTowards(feederTarget);
        } else {
            nativeSend.call(mainWs, feedOffPacket);
            feederFeedOn = false;
            freeze();
            feederPhase = 'VIRUS';
            startVirusChase();
            updateUI();
        }
    }
    function applyFeederFeedMode() {
        if (!mainWs) return;
        const pkt = config.feederFeedMode === 'normal' ? normalFeedPacket : multiFeedMaxPacket;
        try { nativeSend.call(mainWs, pkt); } catch (_) { }
    }

    function feedTowards(cell) {
        if (!enabled || role !== ROLES.FEEDER) return;
        if (!cell || !cellAttributes) return;
        stopVirusChase();
        unfreeze();
        nativeSend.call(mainWs, feedOffPacket);
        feederFeedOn = false;

        // Aim at the CORNER of the block closest to our cell, not the block centre.
        // Why a corner instead of centre: the cell is much larger than the block, so
        // a centre aim places the mouse pointer well inside our own cell, which the
        // game treats as "no movement intent" and lets the cell drift off the block.
        // Aiming at the near corner keeps the mouse anchored on the block edge facing
        // us, so our cell stays glued to the block and mass fires consistently into it.
        // Feed itself is NOT turned on here — the FEEDING-phase tick checks proximity
        // and only feeds when the cell is close enough that ejected mass lands on the
        // block. Feeding from far away just wastes mass into empty space.
        const bx = cell[cellAttributes[31]];
        const by = cell[cellAttributes[32]];
        const bs = cell[cellAttributes[30]] || 0;
        let tx = bx, ty = by;
        if (bs > 0) {
            const ownCell = Object.values(allCells).find(c => c[cellAttributes[45]]);
            if (ownCell) {
                const ox = ownCell[cellAttributes[31]];
                const oy = ownCell[cellAttributes[32]];
                tx = Math.round(bx + Math.sign(ox - bx) * bs);
                ty = Math.round(by + Math.sign(oy - by) * bs);
            }
        }
        mousePacket.setInt32(1, tx, true);
        mousePacket.setInt32(5, ty, true);
        nativeSend.call(mainWs, mousePacket.buffer);
        feederPhase = 'FEEDING';
        updateUI();
    }

    // XP-boost (Feeder feeds XP bot)
    function enterXpBoost() {
        if (!enabled || role !== ROLES.FEEDER) return;
        if (feederPhase === 'XP_BOOST') return;
        // Drop any pending block-feed diversion — when XP boost exits we'll re-pick
        // a target from feederTargets, no need to remember the old one.
        divertedFromTarget = null;
        nativeSend.call(mainWs, feedOffPacket);
        feederFeedOn = false;
        freeze();                                       // main cell stays put
        feederPhase = 'XP_BOOST';
        // feedOn is a server-side state — toggled on once and held until feedOff.
        // (The previous version re-sent feedOnPacket inside xpBoostTick every 150ms,
        // which is a "no real player does this" pattern and exactly the kind of
        // thing anti-cheat profiles flag. Send once here instead.)
        nativeSend.call(mainWs, feedOnPacket);
        if (xpBoostInterval) clearInterval(xpBoostInterval);
        xpBoostInterval = setInterval(xpBoostTick, 150);
        updateUI();
    }
    function xpBoostTick() {
        if (!enabled || role !== ROLES.FEEDER || feederPhase !== 'XP_BOOST') return;
        if (isLaggy()) return;
        // timeout if no broadcast for 4 seconds -> exit
        if (Date.now() - xpBoostLastRecv > 4000) { exitXpBoost(); return; }
        if (!xpBoostTarget) return;
        if (xpBoostTarget.mass >= config.xpTargetMass) { exitXpBoost(); return; }
        // Just re-aim — feed is already on (held server-side since enterXpBoost)
        xpMousePacket.setInt32(1, Math.round(xpBoostTarget.x), true);
        xpMousePacket.setInt32(5, Math.round(xpBoostTarget.y), true);
        nativeSend.call(mainWs, xpMousePacket.buffer);
    }
    function exitXpBoost() {
        if (feederPhase !== 'XP_BOOST') return;
        if (xpBoostInterval) { clearInterval(xpBoostInterval); xpBoostInterval = null; }
        nativeSend.call(mainWs, feedOffPacket);
        feederFeedOn = false;
        unfreeze();
        feederPhase = 'IDLE';
        // re-arm: if there are pending gold targets pick one, else go to virus
        if (feederTargets.size) selectNextFeederTarget();
        else { feederPhase = 'VIRUS'; startVirusChase(); }
        updateUI();
    }

    // Cluster-feed token. Each call to feederGiganticStart increments this and
    // captures its value; if a later call (or a toggle-off) bumps it, in-flight
    // async sequences detect the mismatch on their next check and bail. Prevents
    // double-split when the user rapidly toggles off-then-on mid-sequence.
    let clusterRunToken = 0;

    // Gigantic Block-Feeder mode. User has already positioned their cell and
    // aimed at the outer gold block in the row. Bot freezes (preserves the
    // user's aim), splits N times so chunks fan out along the row, then turns
    // on continuous W-feed so every chunk drains its nearest block in parallel.
    //   - splitCount = 5  (→ 32 chunks) if mass <  200 000
    //   - splitCount = 6  (→ 64 chunks) if mass >= 200 000
    // No scanning, no proximity gate, no virus divert here — those don't apply
    // when you're sitting in a tight cluster. Toggle off ends the sequence.
    async function feederGiganticStart() {
        const myToken = ++clusterRunToken;
        const stillRunning = () => myToken === clusterRunToken && enabled;

        feederPhase = 'CLUSTER';
        updateUI();

        let splitCount = 5;
        if (cellAttributes) {
            const ownCell = Object.values(allCells).find(c => c[cellAttributes[45]]);
            if (ownCell) {
                const size = ownCell[cellAttributes[30]] || 0;
                const mass = Math.floor((size * size) / 100);
                if (mass >= 200000) splitCount = 6;
                console.log(`[FarmSuite] Cluster feed: mass=${mass}, splits=${splitCount}`);
            } else {
                console.log(`[FarmSuite] Cluster feed: no own cell yet, defaulting to ${splitCount} splits`);
            }
        }

        // 1. Freeze — preserves the user's manual mouse aim for the upcoming splits.
        freeze();
        await wait(0.1);
        if (!stillRunning()) return;

        // 2. Split N times, 150 ms between presses so each split registers fully.
        for (let i = 0; i < splitCount; i++) {
            try { nativeSend.call(mainWs, splitPacket); } catch (_) { }
            await wait(0.15);
            if (!stillRunning()) return;
        }

        // 3. Brief settle for the chunks to spread, then continuous W-feed until
        //    the user toggles off.
        await wait(0.3);
        if (!stillRunning()) return;
        try { nativeSend.call(mainWs, feedOnPacket); } catch (_) { }
        feederFeedOn = true;
        console.log('[FarmSuite] Cluster feed: W-feed ON');
    }

    function feederToggle(on) {
        if (on) {
            enabled = true;
            isFrozen = false;
            feederPhase = 'IDLE';
            divertedFromTarget = null;
            nativeSend.call(mainWs, feedOffPacket);
            feederFeedOn = false;
            applyFeederFeedMode();

            // Gigantic family: cluster mode. Skip the normal scan/virus tick
            // entirely — user aims manually, bot freezes + splits + W-feeds.
            if (getServerType() === 'gigantic') {
                feederGiganticStart();
                updateUI();
                return;
            }

            // scan for gold blocks already on screen
            if (cellAttributes) {
                feederTargets.clear();
                for (const c of Object.values(allCells)) {
                    if (c.__imageId === 10) feederTargets.set(c.id, c);
                }
            }
            // The chase / divert tick runs continuously while the feeder is on.
            // It branches on feederPhase to do the right thing for each state
            // (chase between blocks, divert off blocks for viruses, etc.).
            if (!virusInterval) virusInterval = setInterval(virusTick, 200);
            selectNextFeederTarget();
        } else {
            const wasGigantic = getServerType() === 'gigantic';
            enabled = false;
            clusterRunToken++;                                // invalidate any in-flight cluster async
            nativeSend.call(mainWs, feedOffPacket);
            feederFeedOn = false;
            if (virusInterval) { clearInterval(virusInterval); virusInterval = null; }
            if (xpBoostInterval) { clearInterval(xpBoostInterval); xpBoostInterval = null; }
            feederTarget = null;
            divertedFromTarget = null;
            feederPhase = 'OFF';
            // Cluster mode froze the cell on entry — unfreeze on exit so the
            // user can move again. Normal mode keeps the cell pinned on exit
            // (matches the legacy behaviour after farming a single block).
            if (wasGigantic) unfreeze();
            else freeze();
        }
        updateUI();
    }

    // ===========================================================================
    // AUTO R2 ROLE
    // ===========================================================================
    function wait(s) { return new Promise(r => setTimeout(r, s * 1000)); }

    // Last-known cell-cluster centers, cached so anti-AFK can keep pinging the sockets
    // even when there are no own cells right now (dead, awaiting respawn, on login screen,
    // between transfers, etc.). Updated by getOwnCenter / getAltCenter whenever they
    // successfully compute a real value.
    let lastOwnCenter = null;
    let lastAltCenter = null;

    // Returns the average position of all own cells, or null if we have none
    function getOwnCenter() {
        if (!cellAttributes) return null;
        let x = 0, y = 0, n = 0;
        for (const c of Object.values(allCells)) {
            if (c[cellAttributes[45]]) {
                x += c[cellAttributes[31]];
                y += c[cellAttributes[32]];
                n++;
            }
        }
        if (!n) return null;
        const center = { x: x / n, y: y / n };
        lastOwnCenter = center;
        return center;
    }

    // Same but for the alt window's cells
    function getAltCenter() {
        if (!cellAttributes) return null;
        let x = 0, y = 0, n = 0;
        for (const c of Object.values(allAltCells)) {
            if (c[cellAttributes[45]]) {
                x += c[cellAttributes[31]];
                y += c[cellAttributes[32]];
                n++;
            }
        }
        if (!n) return null;
        const center = { x: x / n, y: y / n };
        lastAltCenter = center;
        return center;
    }

    // ===========================================================================
    // ANTI-AFK — periodic mouse-position packet to keep both sockets alive against
    // the server's idle-kick. Fires every 25s on both the main socket and (if open)
    // the alt socket, regardless of bot state. Behaves correctly in all the awkward
    // states: dead, awaiting respawn, between transfers, alt sitting on login screen.
    //
    // The packet position alternates by ±1 on each tick so it actually registers as
    // movement (some servers ignore "same-as-last" position pings).
    //
    // On the main socket we skip the ping if the cycle is actively moving the cell
    // toward a target (TRAVELING / EATING phases) — overriding that target with the
    // cell's current position would stop the movement and break the cycle. During
    // those phases the cycle's own packets are keeping the socket alive anyway.
    // ===========================================================================
    const antiAfkPacket = new DataView(new ArrayBuffer(9));
    antiAfkPacket.setUint8(0, 0);
    let antiAfkJiggle = 1;  // toggles between +1 and -1 every tick

    function antiAfkPing(ws, center) {
        if (!ws || ws.readyState !== 1) return;
        // Fallback chain: live center > last-known cached center > arbitrary safe coords.
        // The actual coords matter less than the fact that bytes hit the socket.
        const c = center || { x: 0, y: 0 };
        antiAfkPacket.setInt32(1, Math.round(c.x) + antiAfkJiggle, true);
        antiAfkPacket.setInt32(5, Math.round(c.y), true);
        try { nativeSend.call(ws, antiAfkPacket.buffer); } catch (_) { }
    }

    // Returns true when the bot is in a phase where it's actively driving the cell's
    // mouse aim. During these phases the anti-AFK (which would override the aim with
    // current-cell or last-screen position) must skip — the bot's own outgoing packets
    // are keeping the socket alive anyway. VIRUS-phase feeder is excluded on purpose:
    // the cell is frozen there, so an anti-AFK ping at current position is harmless.
    function botIsActive() {
        if (!enabled) return false;
        if (role === ROLES.AUTO_R2) {
            return r2Phase === 'CYCLING'
                || r2Phase === 'TRAVELING'
                || r2Phase === 'EATING';
        }
        if (role === ROLES.FEEDER) {
            return feederPhase === 'FEEDING'
                || feederPhase === 'XP_BOOST';
        }
        return false;
    }

    function antiAfkTick() {
        if (isLaggy()) return;
        // Main: skip if the bot is actively aiming the main cell — see botIsActive.
        if (!botIsActive()) {
            antiAfkPing(mainWs, getOwnCenter() || lastOwnCenter);
        }

        // Alt: always ping (bot doesn't continuously drive alt movement; the alt sits
        // idle between transfers and gets idle-kicked without this).
        if (altWindow && !altWindow.closed) {
            antiAfkPing(altWs, getAltCenter() || lastAltCenter);
        }

        antiAfkJiggle = -antiAfkJiggle;
    }

    setInterval(antiAfkTick, 25000);

    // ===========================================================================
    // CROSS-WINDOW DOM ANTI-AFK FOR THE ALT TAB
    //
    // Tampermonkey often doesn't inject userscripts into popups opened via
    // window.open(...), which means the alt tab usually has NO local script
    // running its own DOM anti-AFK. The WS-level ping from antiAfkTick above
    // hits altWs every 25s, but raw socket writes aren't always counted as
    // "real activity" by the idle-kick logic — same reason we needed the
    // DOM-level anti-AFK for the main tab.
    //
    // Fix: reach into the alt window's DOM from here (same-origin popup, so
    // it's allowed) and dispatch synthetic mousemove events on its canvas.
    // The alt's own game code picks them up through its normal input pipeline
    // and emits an outbound mouse packet on altWs — which the server treats
    // as live input.
    //
    // We use altWindow.MouseEvent (not the main tab's MouseEvent constructor)
    // so the event's `view` property matches the alt's window — some game
    // handlers check this.
    // ===========================================================================
    let altDomJiggle = 1;

    function altDomAntiAfkTick() {
        if (!altWindow || altWindow.closed) return;
        if (isLaggy()) return;
        try {
            const doc = altWindow.document;
            if (!doc) return;
            const canvas = doc.getElementById('canvas') || doc.querySelector('canvas');
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const ME = altWindow.MouseEvent || MouseEvent;
            for (const offset of [altDomJiggle, -altDomJiggle]) {
                canvas.dispatchEvent(new ME('mousemove', {
                    bubbles: true,
                    cancelable: true,
                    clientX: cx + offset,
                    clientY: cy,
                    view: altWindow,
                }));
            }
            altDomJiggle = -altDomJiggle;
        } catch (_) { /* alt window in a transient state; try again next tick */ }
    }

    // 20s — slightly more aggressive than the 25s of the WS / main-DOM tickers
    // since the alt is what's been disconnecting.
    setInterval(altDomAntiAfkTick, 20000);

    // ===========================================================================
    // AUTO-RESPAWN — if main loses all own cells while the bot is enabled, the
    // farm stops dead until the user notices. This periodic check detects that
    // state and calls setNick('') to respawn, after which the cycle / feeder
    // naturally resumes from its next tick.
    //
    // Guards:
    //  - hasEverSpawned: don't respawn during initial page-load (no spawn yet)
    //  - 2s confirmation window: avoid spurious respawn during the brief frame
    //    between cell death and the server's update packet showing it gone
    //  - cooldown: at most one respawn per 5s so we don't spam setNick if the
    //    new spawn dies instantly (cell appears, dies again, we'd loop)
    // ===========================================================================
    let hasEverSpawned = false;
    let mainDeadSince = 0;
    let lastRespawnAttempt = 0;

    function mainHasOwnCells() {
        if (!cellAttributes) return false;
        for (const c of Object.values(allCells)) {
            if (c[cellAttributes[45]]) return true;
        }
        return false;
    }

    function autoRespawnTick() {
        if (!enabled) { mainDeadSince = 0; return; }
        if (mainHasOwnCells()) {
            hasEverSpawned = true;
            mainDeadSince = 0;
            return;
        }
        if (!hasEverSpawned) return;
        const now = Date.now();
        if (mainDeadSince === 0) { mainDeadSince = now; return; }
        if (now - mainDeadSince < 2000) return;
        if (now - lastRespawnAttempt < 5000) return;
        lastRespawnAttempt = now;
        mainDeadSince = 0;
        console.log('%c[FarmSuite] Main has no cells — triggering respawn', 'color:#ffb74a');
        try { unsafeWindow.setNick(''); }
        catch (e) { console.warn('[FarmSuite] setNick failed:', e); }
    }

    setInterval(autoRespawnTick, 1000);

    // ===========================================================================
    // ALT TRANSFER TICK (v0.6.0 state machine)
    //
    // Runs every 1s. Two responsibilities:
    //
    // 1. Bounded timeouts — if a state has been active longer than its allowed
    //    window (T_TIMEOUTS), tOnFailure() counts a strike. After 3 strikes on
    //    the same alt, tAdvance() skips to the next alt. WAITING_FOR_R2 has
    //    no timeout — it sits forever (logging status every 30s) until main
    //    has enough powers.
    //
    // 2. Alt-tab-closed recovery — if the alt window was closed mid-flow, snap
    //    state back to IDLE so a future "open alt" click can restart cleanly.
    // ===========================================================================

    function transferTick() {
        if (!enabled || role !== ROLES.AUTO_R2) return;
        if (!altWindow || altWindow.closed) {
            // If the alt tab got closed mid-flow, snap back to IDLE so a future
            // "open alt tab" click can restart cleanly.
            if (tState !== T_STATE.IDLE) {
                console.warn(`[FarmSuite][Transfer] Alt tab closed during ${tState} — resetting to IDLE`);
                tClearTimers();
                tState = T_STATE.IDLE;
                tStateEnteredAt = Date.now();
                updateUI();
            }
            return;
        }

        // WAITING_FOR_R2 — no timeout, just a periodic reminder log.
        if (tState === T_STATE.WAITING_FOR_R2) {
            const now = Date.now();
            if (now - tLastStatusLog > 30000) {
                tLastStatusLog = now;
                const recDef = Math.max(0, config.recWanted - altRecCount);
                const speedDef = Math.max(0, config.speedWanted - altSpeedCount);
                console.log(
                    `[FarmSuite][Transfer] ${currentAltName()} still WAITING_FOR_R2 — needs ${recDef}/${speedDef}, main has ${liveRecCount}/${liveSpeedCount}`
                );
            }
            return;
        }

        // IDLE — nothing to time out.
        if (tState === T_STATE.IDLE) return;

        // Every other state has a bounded timeout.
        const elapsed = Date.now() - tStateEnteredAt;
        const limit = T_TIMEOUTS[tState];
        if (limit && elapsed > limit) {
            console.warn(`[FarmSuite][Transfer] State ${tState} timed out after ${elapsed}ms`);
            tOnFailure(`${tState} timeout`);
        }
    }

    setInterval(transferTick, 1000);

    // ===========================================================================
    // DOM-LEVEL ANTI-AFK — ported from the OP super script's createAntiAfk.
    //
    // The WS-level ping above is a backup; this is the primary defense. Instead of
    // writing a raw mouse packet to the socket, this dispatches a synthetic mousemove
    // on the game canvas every 25s. The game's own input handler catches the event
    // and produces a "real" outbound packet through its normal pipeline — which the
    // server treats as live user input and resets the idle-kick timer for.
    //
    // Two events with ±1 px offset are dispatched per tick so the position actually
    // changes (servers commonly ignore "same as last" pings as not-really-activity).
    //
    // This runs in every tab the userscript loads in (main and alt tab independently),
    // because the userscript @match covers both. We don't reach into the alt window's
    // DOM from the main tab — the alt's own instance handles itself.
    // ===========================================================================
    (function createDomAntiAfk() {
        let mouseX = 0, mouseY = 0;
        let hasMoved = false;

        function getCanvas() {
            return document.getElementById('canvas') || document.querySelector('canvas');
        }
        function onRealMouseMove(ev) {
            mouseX = ev.clientX;
            mouseY = ev.clientY;
            hasMoved = true;
        }
        function fakeMove() {
            // Skip the synthetic mousemove if the bot is actively aiming the cell
            // or if we're paused for high ping. Either way, dispatching now would
            // contribute to a burst-flush after the network recovers.
            if (botIsActive() || isLaggy()) {
                setTimeout(fakeMove, 25000);
                return;
            }
            const canvas = getCanvas();
            if (canvas) {
                // No real mousemove yet (alt tab the user never focused, page just opened,
                // etc.) — fall back to the canvas center so the dispatch still uses valid
                // coords inside the canvas.
                if (!hasMoved) {
                    const r = canvas.getBoundingClientRect();
                    mouseX = r.left + r.width / 2;
                    mouseY = r.top + r.height / 2;
                }
                for (const offset of [1, -1]) {
                    canvas.dispatchEvent(new MouseEvent('mousemove', {
                        bubbles: true,
                        cancelable: true,
                        clientX: mouseX + offset,
                        clientY: mouseY,
                    }));
                }
            }
            setTimeout(fakeMove, 25000);
        }
        function attach() {
            if (!document.body) { setTimeout(attach, 50); return; }
            document.body.addEventListener('mousemove', onRealMouseMove, true);
            fakeMove();
        }
        attach();
    })();

    // Fire a desktop notification (if permission granted) — used to ping the user
    // when powers are ready but the alt tab is closed.
    function showReadyNotification() {
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'granted') return;
        try {
            const n = new Notification('FarmSuite — Ready to Transfer', {
                body: `Main has ${liveRecCount} rec / ${liveSpeedCount} speed. Open the alt tab to start.`,
                tag: 'farmsuite-ready',
                renotify: true,
                silent: false,
            });
            setTimeout(() => { try { n.close(); } catch (_) { } }, 8000);
        } catch (_) { }
    }

    // Poll until own-cell center is within `tolerance` of `target`, or timeout (ms).
    // Returns true if arrived, false if timed out.
    async function r2WaitUntilNear(target, tolerance, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (cycleAbort || !enabled) return false;
            const c = getOwnCenter();
            if (c) {
                const d = Math.hypot(c.x - target[0], c.y - target[1]);
                if (d < tolerance) return true;
            }
            await wait(0.2);
        }
        return false;
    }

    // Count pellet cells (imageId === 3) within `tolerance` of `spot`.
    function countPelletsAt(spot, tolerance = 600) {
        if (!cellAttributes) return 0;
        let count = 0;
        for (const c of Object.values(allCells)) {
            if (c.__imageId === 3) {
                const x = c[cellAttributes[31]];
                const y = c[cellAttributes[32]];
                if (Math.hypot(x - spot[0], y - spot[1]) < tolerance) count++;
            }
        }
        return count;
    }

    // Wait until no pellets remain at `spot`, or timeout. Returns true if eaten,
    // false on timeout / abort.
    async function waitUntilPelletGone(spot, timeoutMs = 5000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (cycleAbort || !enabled) return false;
            if (countPelletsAt(spot) === 0) return true;
            await wait(0.15);
        }
        return false;
    }

    // ===========================================================================
    // PER-SERVER SPLIT CYCLE
    // ===========================================================================
    // Server identification by WebSocket URL. Reads the cached server list from
    // localStorage (same source gayma uses) and matches our `mainWs.url` against
    // `wss://${address}/`. Substring-matching the server name is more reliable
    // than gayma's currentServerName var because gayma may update display names.
    // Server identification by WebSocket URL. Builds per-type URL sets once from
    // localStorage.gameservers (the same source gayma uses), then it's just a
    // `set.has(url)` lookup at runtime — no per-call JSON.parse, no per-call
    // string matching, name capitalisation can't bite us. Rebuilds the sets on a
    // cache miss so a freshly-fetched server list or a switch to a new server
    // gets picked up without restarting the script.
    let serverUrlSets = null;
    function buildServerUrlSets() {
        try {
            const raw = unsafeWindow.localStorage.gameservers;
            if (!raw) return null;
            const list = JSON.parse(raw);
            const urlsMatching = pred => new Set(list
                .filter(s => s && s.name && s.address && pred(s.name.toLowerCase()))
                .map(s => 'wss://' + s.address + '/'));
            return {
                xy_insta: urlsMatching(n => n.includes('xy-insta')),
                crazy: urlsMatching(n => n.includes('crazy')),
                gigantic: urlsMatching(n => n.includes('gig') || n.includes('giant')),
                instant: urlsMatching(n => n.includes('instant')),
            };
        } catch (_) { return null; }
    }
    function getServerType() {
        if (!mainWs || typeof mainWs.url !== 'string') return 'unknown';
        const u = mainWs.url;
        const check = sets => {
            if (!sets) return null;
            if (sets.xy_insta.has(u)) return 'xy_insta';
            if (sets.crazy.has(u)) return 'crazy';
            if (sets.gigantic.has(u)) return 'gigantic';
            if (sets.instant.has(u)) return 'instant';
            return null;
        };
        if (!serverUrlSets) serverUrlSets = buildServerUrlSets();
        let result = check(serverUrlSets);
        if (result) return result;
        // Cache miss — rebuild once in case localStorage was updated since last build
        serverUrlSets = buildServerUrlSets();
        result = check(serverUrlSets);
        if (result) return result;
        // URL match failed (URL format quirks, port differences, etc.) — fall back to
        // matching by currentServerName, which is what gayma stamps on the active
        // server. Name-based match is what the status row already shows the user.
        try {
            const name = (unsafeWindow.currentServerName || '').toLowerCase();
            if (name.includes('xy-insta')) return 'xy_insta';
            if (name.includes('crazy')) return 'crazy';
            if (name.includes('gig') || name.includes('giant')) return 'gigantic';
            if (name.includes('instant')) return 'instant';
        } catch (_) { }
        return 'unknown';
    }

    // The middle of r2Cycle — the actual split that disperses mass into pellet
    // spots. Different servers want different patterns. Called once per cycle,
    // already on RECOMBINE, with the travel + arrival waits done. Returns when
    // the split sequence has fired; the caller takes over the WAIT_PELLETS phase.
    async function doSplitCycle() {
        const type = getServerType();

        if (type === 'xy_insta') {
            // NA | XY-Insta. After arriving at RECOMBINE:
            //   1) Freeze.
            //   2) Aim at SPEED.
            //   3) Wait 0.1 s (server registers freeze + aim before split fires).
            //   4) Split.
            //   5) Wait 1 s (cell stays frozen, aim is sticky).
            //   6) Split again.
            // End state: frozen. WAIT_PELLETS / EATING expect that.
            // No W-feed — XY-Insta generates pellets at LEFT/RIGHT_PELLET from the
            // split alone; the shared EATING phase walks to both spots after.
            nativeSend.call(mainWs, freezePacket);
            mousePacket.setInt32(1, SPEED[0], true);
            mousePacket.setInt32(5, SPEED[1], true);
            nativeSend.call(mainWs, mousePacket.buffer);
            await wait(0.1);
            if (cycleAbort || !enabled) return;
            console.log('[FarmSuite] xy_insta: first split toward SPEED');
            nativeSend.call(mainWs, splitPacket);
            await wait(1);
            if (cycleAbort || !enabled) return;
            console.log('[FarmSuite] xy_insta: second split toward SPEED');
            nativeSend.call(mainWs, splitPacket);
            return;
        }

        // 'instant' (EU | Instant) and the safe 'unknown' fallback: freeze cell,
        // aim toward SPEED, split + W-feed.
        nativeSend.call(mainWs, freezePacket);
        mousePacket.setInt32(1, SPEED[0], true);
        mousePacket.setInt32(5, SPEED[1], true);
        nativeSend.call(mainWs, mousePacket.buffer);
        await wait(0.1);
        await waitWhileLaggy();
        if (cycleAbort || !enabled) return;
        console.log('[FarmSuite] instant: firing split + W-feed');
        nativeSend.call(mainWs, splitPacket);
        await wait(0.05);
        nativeSend.call(mainWs, feedOnPacket);
        await wait(config.r2FeedDuration);
        nativeSend.call(mainWs, feedOffPacket);
    }

    async function r2Cycle() {
        if (!mainWs) { console.warn('[FarmSuite] r2Cycle bail — no mainWs'); return; }
        cycleAbort = false;

        const type = getServerType();
        console.log(`%c[FarmSuite] r2Cycle — detected server type: ${type}`, 'color:#7fc7ff');

        // Crazy EU / NA / Asia: R2 cycle is a no-op. The cell stays wherever the
        // user has it; no freeze, no aim, no split, nothing. The transfer state
        // machine keeps firing on op 80 independently and handles alt logins +
        // drops regardless of where main is.
        if (type === 'crazy') {
            r2Phase = 'STAYING';
            updateUI();
            console.log('[FarmSuite] R2 on Crazy — no-op cycle, transfers continue');
            return;
        }

        // Gigantic family (Gigantic / Gigantic 2 / Giant / Giant 2 / Giant 3 / Giga /
        // Giga 2 / Gig 4 / AS Giga). Cycle TBD — placeholder no-op for now so detection
        // can be verified via the status tag. Transfers still run on op 80.
        if (type === 'gigantic') {
            r2Phase = 'STAYING';
            updateUI();
            console.log('[FarmSuite] R2 on Gigantic — placeholder no-op, transfers continue');
            return;
        }

        r2Phase = 'CYCLING';
        updateUI();
        console.log(`%c[FarmSuite] r2Cycle start — heading to RECOMBINE [${RECOMBINE[0]},${RECOMBINE[1]}]`, 'color:#7fc7ff');

        // 1. Move toward RECOMBINE so cell drifts into the drop zone
        await waitWhileLaggy();
        if (cycleAbort || !enabled) return;
        mousePacket.setInt32(1, RECOMBINE[0], true);
        mousePacket.setInt32(5, RECOMBINE[1], true);
        nativeSend.call(mainWs, mousePacket.buffer);

        // 2. Wait BOTH: until cell arrives near RECOMBINE, AND total time >= r2TravelTime
        //    (so the cell sits at the drop zone gathering powers for the full duration)
        r2Phase = 'TRAVELING';
        updateUI();
        const travelStart = Date.now();
        const minWaitMs = config.r2TravelTime * 1000;
        const arrived = await r2WaitUntilNear(RECOMBINE, 800, minWaitMs * 2);
        if (cycleAbort || !enabled) return;
        if (!arrived) {
            console.warn(`[FarmSuite] Cell did not reach RECOMBINE within ${config.r2TravelTime * 2}s — proceeding anyway`);
        }
        const elapsedMs = Date.now() - travelStart;
        if (elapsedMs < minWaitMs) {
            await wait((minWaitMs - elapsedMs) / 1000);
        }
        if (cycleAbort || !enabled) return;
        await waitWhileLaggy();
        if (cycleAbort || !enabled) return;

        // 3. Per-server split cycle — see doSplitCycle() above for server-specific
        //    sequences. Returns when the split + (optional) W-feed has fired.
        await doSplitCycle();
        if (cycleAbort || !enabled) return;

        // 5. Wait for both pellets to spawn (poll current state — no timeout, cell stays frozen).
        //    Exception: if main is no longer near RECOMBINE (died and respawned elsewhere,
        //    or got knocked away somehow), pellets at LEFT/RIGHT_PELLET aren't in render
        //    range and countPelletsAt always returns 0. Break out and restart the cycle.
        r2Phase = 'WAIT_PELLETS';
        updateUI();
        while (countPelletsAt(LEFT_PELLET) === 0 || countPelletsAt(RIGHT_PELLET) === 0) {
            const c = getOwnCenter();
            if (c) {
                const distFromRecombine = Math.hypot(c.x - RECOMBINE[0], c.y - RECOMBINE[1]);
                if (distFromRecombine > 3000) {
                    console.warn(`[FarmSuite] Main is ${Math.round(distFromRecombine)}px from RECOMBINE during WAIT_PELLETS — restarting cycle`);
                    return r2Cycle();
                }
            }
            await wait(0.2);
            if (cycleAbort || !enabled) return;
        }

        // 6. Eat them. Single attempt — whatever happens, cycle back to RECOMBINE afterward.
        r2Phase = 'EATING';
        updateUI();
        nativeSend.call(mainWs, freezePacket);  // toggle: unfreeze
        const ateRight = await eatAtSpot(RIGHT_PELLET, 'RIGHT');
        if (cycleAbort || !enabled) return;
        const ateLeft = await eatAtSpot(LEFT_PELLET, 'LEFT');
        if (cycleAbort || !enabled) return;
        if (ateRight && ateLeft) {
            console.log('[FarmSuite] Ate both pellets — cycling');
        } else {
            console.warn(`[FarmSuite] Pellet eat: right=${ateRight} left=${ateLeft} — cycling anyway`);
        }

        // back to top of cycle
        r2Cycle();
    }

    // Kept around in case a fallback to msg-48 size-based monitor is wanted; not called by new cycle.
    function r2MonitorCell() {
        if (!enabled || role !== ROLES.AUTO_R2) { clearInterval(monitorCellId); monitorCellId = null; return; }
        if (!cellAttributes) return;
        const ownCells = Object.values(allCells).filter(c => c[cellAttributes[45]]);
        if (!ownCells.length) return;
        if (!ownCells.every(c => c[cellAttributes[30]] > config.minCellSize)) {
            clearInterval(monitorCellId);
            monitorCellId = null;
        }
    }

    // Move to a pellet spot, wait for arrival, then verify we ATE the pellet (count was > 0 on
    // arrival and is now 0). Returns true on confirmed eat, false if the pellet vanished before
    // we got there (or anything else went wrong).
    async function eatAtSpot(spot, name) {
        mousePacket.setInt32(1, spot[0], true);
        mousePacket.setInt32(5, spot[1], true);
        nativeSend.call(mainWs, mousePacket.buffer);

        const arrived = await r2WaitUntilNear(spot, 600, 8000);
        if (cycleAbort || !enabled) return false;
        if (!arrived) {
            console.warn(`[FarmSuite] Could not reach ${name}_PELLET within 8s`);
            return false;
        }

        const arrivalCount = countPelletsAt(spot);
        if (arrivalCount === 0) {
            // pellet vanished before we got here (eaten by someone else, despawned, etc.)
            return false;
        }

        // Wait for count to drop to 0 — if we're at the spot, very likely it's us eating
        const t0 = Date.now();
        while (countPelletsAt(spot) > 0 && Date.now() - t0 < 8000) {
            await wait(0.15);
            if (cycleAbort || !enabled) return false;
        }
        return countPelletsAt(spot) === 0;
    }

    // Alt window management
    function ensureAltWindow() {
        if (altWindow && !altWindow.closed) return true;
        try { altWindow = unsafeWindow.open('.', '', 'width=700,height=500'); }
        catch (_) { altWindow = null; }
        if (!altWindow) return false;

        // hook altWindow's WS
        const AltWS = altWindow.WebSocket;
        if (AltWS && AltWS.prototype) {
            // capture send so we can know about its socket
            const altOrigSend = AltWS.prototype.send;
            AltWS.prototype.send = function (pkt) {
                if (altWs !== this && typeof this.url === 'string' && this.url.includes('agma')) {
                    altWs = this;
                    allAltCells = {};
                    this.addEventListener('message', message => {
                        if (!enabled || role !== ROLES.AUTO_R2) return;
                        try { handleIncoming(this, new DataView(message.data)); } catch (_) { }
                    });
                }
                if (enabled && role === ROLES.AUTO_R2 && pkt?.getUint8?.(0) === 0) return;
                if (enabled && role === ROLES.AUTO_R2 && pkt?.getUint8?.(0) === 13) {
                    // op 13 = sendSignal(13) — gayma fires this when mainPlayerCells
                    // hits length 1, i.e. the alt's first cell has landed on the map
                    // after spawn. This is the real "spawn confirmed" signal.
                    transferOnAltSpawnRequest();
                }
                return altOrigSend.apply(this, arguments);
            };
        }

        // mirror our hasOwnProperty / push hooks to alt window so allAltCells is captured
        try {
            const _altHasOwn = altWindow.Object.prototype.hasOwnProperty;
            altWindow.Object.prototype.hasOwnProperty = function () {
                if (allAltCells !== this && arguments?.[0] > 10000) allAltCells = this;
                return _altHasOwn.apply(this, arguments);
            };
        } catch (_) { }

        return true;
    }

    // =======================================================================
    // TRANSFER STATE MACHINE FUNCTIONS (v0.6.0)
    //
    // Every state transition goes through tSetState() so it's logged. Every
    // bounded state has an entry in T_TIMEOUTS and transferTick() catches
    // stuck states by elapsed time. Failures count per-alt; 3 → advance.
    // =======================================================================

    function currentAltName() { return config.altPrefix + config.altCurrent; }

    function tSetState(newState) {
        if (tState === newState) return;
        console.log(`%c[FarmSuite][Transfer] ${tState} → ${newState}`, 'color:#9ab8ff');
        tState = newState;
        tStateEnteredAt = Date.now();
        updateUI();
    }

    function tClearTimers() {
        if (tNextLoginTimerId) {
            clearTimeout(tNextLoginTimerId);
            tNextLoginTimerId = null;
        }
    }

    // Read the alt's own cell coords. Two strategies:
    //
    // (1) Direct read from gayma's `mainPlayerCells`. This is a top-level `var`
    //     in the alt window's gayma instance (line 549), and cells in it have
    //     unobfuscated `.x` / `.y` properties (line 2879). Works whenever
    //     Tampermonkey doesn't sandbox the script, which is the typical
    //     `@grant unsafeWindow` configuration. This is the reliable path.
    //
    // (2) Fallback via `allAltCells` + `cellAttributes` — the v0.5.x approach.
    //     This depends on a hasOwnProperty hook firing on the alt window's
    //     cell table, which doesn't happen in gayma 0.7.3 because its only
    //     hasOwnProperty call uses the static form. Kept as a fallback in
    //     case a future build re-introduces the instance form.
    function getAltOwnCoords() {
        try {
            const cells = altWindow && altWindow.mainPlayerCells;
            if (cells && cells.length > 0) {
                const cell = cells[0];
                if (cell && typeof cell.x === 'number' && typeof cell.y === 'number') {
                    return { x: Math.round(cell.x), y: Math.round(cell.y) };
                }
            }
        } catch (_) { /* sandbox or var not on window — fall through */ }

        if (!cellAttributes) return null;
        const own = Object.values(allAltCells).filter(c => c && c[cellAttributes[45]]);
        if (!own.length) return null;
        const cell = own[0];
        const x = cell[cellAttributes[31]];
        const y = cell[cellAttributes[32]];
        if (typeof x !== 'number' || typeof y !== 'number') return null;
        return { x, y };
    }

    // ----- ENTRY: send a login packet for the current alt -----
    function sendAltLogin() {
        if (!enabled || role !== ROLES.AUTO_R2) return;
        if (!altWindow || altWindow.closed) {
            console.warn('[FarmSuite][Transfer] sendAltLogin: alt tab is closed');
            tSetState(T_STATE.IDLE);
            return;
        }
        if (!altWs) {
            console.warn('[FarmSuite][Transfer] sendAltLogin: altWs not captured yet — retrying in 500ms');
            setTimeout(sendAltLogin, 500);
            return;
        }
        if (!config.altPassword) {
            console.warn('[FarmSuite][Transfer] sendAltLogin: alt password not configured');
            tSetState(T_STATE.IDLE);
            return;
        }
        const md5Fn = altWindow.md5 || unsafeWindow.md5;
        if (typeof md5Fn !== 'function') {
            console.warn('[FarmSuite][Transfer] sendAltLogin: md5 not available yet — retrying in 500ms');
            setTimeout(sendAltLogin, 500);
            return;
        }

        // Fresh-session reset so a stale op 80 from the previous session can't pollute
        // the new alt's CHECK_COUNTS decision.
        altCountsReceived = false;
        altRecCount = 0;
        altSpeedCount = 0;
        tDropsSentAt = 0;
        tDropCoords = null;
        tSpawnRetryCount = 0;

        const username = currentAltName();
        const password = md5Fn(config.altPassword);
        const buf = new ArrayBuffer(5 + 2 * username.length + 2 * password.length);
        const v = new DataView(buf);
        v.setUint8(0, 2);
        let pos = 1;
        for (let i = 0; i < username.length; i++) { v.setUint16(pos, username.charCodeAt(i), true); pos += 2; }
        pos += 2;
        for (let i = 0; i < password.length; i++) { v.setUint16(pos, password.charCodeAt(i), true); pos += 2; }

        r2StartTime = Date.now();
        try {
            nativeSend.call(altWs, buf);
        } catch (e) {
            console.warn('[FarmSuite][Transfer] sendAltLogin: send failed', e);
            tOnFailure('send login failed');
            return;
        }
        console.log(`[FarmSuite][Transfer] Logging in ${username}`);
        tSetState(T_STATE.LOGGING_IN);
    }

    // ----- HANDLERS for incoming packets, called from handleIncoming -----

    function transferOnAltOp95(status) {
        if (tState !== T_STATE.LOGGING_IN) return;
        if (status === 1) {
            // Login accepted; wait for the first op 80 to learn counts
            tSetState(T_STATE.CHECK_COUNTS);
        } else {
            console.warn(`[FarmSuite][Transfer] Login refused for ${currentAltName()} (op 95 status=${status})`);
            tOnFailure(`login refused (status=${status})`);
        }
    }

    function transferOnAltOp80() {
        if (tState === T_STATE.CHECK_COUNTS) {
            // Decision point: skip / spawn / wait
            if (altRecCount >= config.recWanted && altSpeedCount >= config.speedWanted) {
                console.log(`%c[FarmSuite][Transfer] ${currentAltName()} already at ${altRecCount}/${altSpeedCount} — SKIPPING`, 'color:#7aa7ff');
                tAdvance(true);
                tDoLogout();
                return;
            }
            const recDef = config.recWanted - altRecCount;
            const speedDef = config.speedWanted - altSpeedCount;
            console.log(`[FarmSuite][Transfer] ${currentAltName()} needs ${recDef}/${speedDef} (has ${altRecCount}/${altSpeedCount})`);
            if (liveRecCount >= recDef && liveSpeedCount >= speedDef) {
                // Main has the deficit covered — spawn now
                tDoSpawn();
            } else {
                // Main empty (or not enough) — alt stays logged in, no spawn
                console.log(`[FarmSuite][Transfer] Main has ${liveRecCount}/${liveSpeedCount}, need ${recDef}/${speedDef} — WAITING for R2 to refill`);
                tLastStatusLog = Date.now();
                tSetState(T_STATE.WAITING_FOR_R2);
            }
            return;
        }
        if (tState === T_STATE.WAITING_DROP_CONFIRM) {
            // Filter out the op 80 that arrives WITH the spawn/world-update burst — that one
            // shows pre-drop counts. Only count op 80s arriving >=250ms after drops.
            if (Date.now() - tDropsSentAt < 250) return;
            if (altRecCount >= config.recWanted && altSpeedCount >= config.speedWanted) {
                const ms = Date.now() - r2StartTime;
                const m = Math.floor(ms / 60000);
                const s = Math.floor((ms % 60000) / 1000);
                console.log(`%c[FarmSuite][Transfer] ${currentAltName()} CONFIRMED at ${altRecCount}/${altSpeedCount} — done in ${m}m ${s}s`, 'color:#7fffa1;font-weight:bold');
                cyclesCompleted++;
                tAdvance(true);
                tDoLogout();
            }
            // else: keep waiting; transferTick's timeout (10s) catches a permanent stall
        }
        // Other states ignore op 80
    }

    function transferOnMainOp80() {
        // R2_READY edge-trigger: log + broadcast when main crosses the wanted threshold
        const hasEnough = liveRecCount >= config.recWanted && liveSpeedCount >= config.speedWanted;
        if (hasEnough && !tR2WasReady) {
            tR2WasReady = true;
            console.log(`%c[FarmSuite][R2] READY — main has ${liveRecCount}/${liveSpeedCount}`, 'color:#7fffa1');
            try { bcSend({ type: 'r2_ready', rec: liveRecCount, speed: liveSpeedCount }); } catch (_) { }
        } else if (!hasEnough && tR2WasReady) {
            tR2WasReady = false;
        }

        // Chain is paused — don't auto-restart anything from main op 80
        if (tPaused) return;

        // (A) IDLE + alt tab open → start the chain
        if (tState === T_STATE.IDLE) {
            if (altWindow && !altWindow.closed && altWs) {
                sendAltLogin();
                return;
            }
            // Alt tab is closed but we're ready — nudge the user (throttled)
            if (hasEnough) {
                const now = Date.now();
                if (now - lastReadyLog > 10000) {
                    lastReadyLog = now;
                    console.log('%c[FarmSuite] READY TO TRANSFER — open the alt tab to start.', 'color:#ffd47a;font-weight:bold;font-size:13px');
                }
            }
            return;
        }

        // (B) WAITING_FOR_R2 → wake up if main now has the deficit covered
        if (tState === T_STATE.WAITING_FOR_R2) {
            const recDef = config.recWanted - altRecCount;
            const speedDef = config.speedWanted - altSpeedCount;
            if (liveRecCount >= recDef && liveSpeedCount >= speedDef) {
                console.log(`%c[FarmSuite][Transfer] R2 has ${liveRecCount}/${liveSpeedCount} ≥ deficit ${recDef}/${speedDef} — spawning ${currentAltName()}`, 'color:#7fffa1;font-weight:bold');
                tDoSpawn();
            }
        }
    }

    // ----- ACTIONS -----

    function tDoSpawn() {
        tSetState(T_STATE.SPAWNING);
        if (!altWs) {
            console.warn('[FarmSuite][Transfer] tDoSpawn: altWs not captured');
            return;
        }
        // Bypass gayma's setNick gates entirely. setNick is locked behind:
        //   1. respawnCooldown that grows +100 ms per spawn (and resets only on
        //      full server disconnect, not on logout)
        //   2. mainPlayerCells.length === 0 check
        //   3. isWebSocketAccepted flag
        // All three live in gayma's sandbox-local `var`s that we can't reach
        // from this window. So we ship the same packets setNick would ship,
        // straight through the alt's WebSocket via the native send. Sequence
        // mirrors window.setNick (gayma line 1257): sendSignal(34) then
        // sendPlayerUpdate (op 1).
        try {
            nativeSend.call(altWs, spawnSignalPacket);
            nativeSend.call(altWs, spawnRequestPacket);
        } catch (e) {
            console.warn('[FarmSuite][Transfer] spawn packet send failed:', e);
            return;
        }
        // We just shipped the spawn request. Drive the coord-wait → drop sequence
        // directly — no need to wait for an outgoing-op detection since we
        // know we sent it.
        transferOnAltSpawnRequest();
    }

    // Called from the alt window's WebSocket send patch when an outgoing op 13
    // (spawn request) is intercepted — i.e. the alt just clicked spawn.
    function transferOnAltSpawnRequest() {
        if (tState !== T_STATE.SPAWNING) return;
        // Wait for the spawn worldUpdate so allAltCells has the alt's own cell coords.
        // Retry a few times if needed since op 13 fires before the server's first world
        // update for the new cell.
        setTimeout(tFireDropsWhenReady, 150);
    }

    function tFireDropsWhenReady() {
        if (tState !== T_STATE.SPAWNING) return;
        const coords = getAltOwnCoords();
        if (!coords) {
            tSpawnRetryCount++;
            if (tSpawnRetryCount > 10) {
                console.warn(`[FarmSuite][Transfer] No alt coords after ${tSpawnRetryCount} retries — letting SPAWNING timeout fire`);
                return;
            }
            setTimeout(tFireDropsWhenReady, 100);
            return;
        }
        // Got coords. Compute deficit and clamp to what main actually has.
        const recDef = Math.max(0, config.recWanted - altRecCount);
        const speedDef = Math.max(0, config.speedWanted - altSpeedCount);
        const recDrop = Math.min(recDef, liveRecCount);
        const speedDrop = Math.min(speedDef, liveSpeedCount);
        if (recDrop === 0 && speedDrop === 0) {
            console.warn(`[FarmSuite][Transfer] Drop math zero (def=${recDef}/${speedDef}, main=${liveRecCount}/${liveSpeedCount}) — failing`);
            tOnFailure('drop math zero');
            return;
        }
        tDropCoords = coords;
        try { bcSend({ type: 'alt_spawned', x: coords.x, y: coords.y, alt: currentAltName() }); } catch (_) { }
        console.log(`[FarmSuite][Transfer] Got alt coords (${coords.x}, ${coords.y}) — dropping ${recDrop}/${speedDrop}`);
        // Fire drops, then ONLY transition to WAITING_DROP_CONFIRM on success. If the
        // drop burst can't run (no mainWs / link laggy), tOnFailure cleanly routes us
        // through LOGGING_OUT without leaving the state machine in a phantom-wait state.
        const fired = fireDropsAtAlt(coords.x, coords.y, recDrop, speedDrop);
        if (!fired) {
            tOnFailure('drop send aborted');
            return;
        }
        tDropsSentAt = Date.now();
        tSetState(T_STATE.WAITING_DROP_CONFIRM);
    }

    // Fire all drop packets in one burst, per user spec. Returns true if the burst
    // shipped, false if it couldn't (no mainWs or link laggy). Lag-gated only — once
    // the burst starts, every packet ships in the same tick (no inter-packet wait).
    function fireDropsAtAlt(x, y, recCount, speedCount) {
        if (!mainWs) {
            console.warn('[FarmSuite][Transfer] fireDropsAtAlt: no mainWs');
            return false;
        }
        if (isLaggy()) {
            console.warn('[FarmSuite][Transfer] fireDropsAtAlt: link laggy — aborting drop');
            return false;
        }
        dropPowerPacket.setInt32(1, x, true);
        dropPowerPacket.setInt32(5, y, true);
        dropPowerPacket.setUint8(9, 1, true);                                 // recombine
        for (let i = 0; i < recCount; i++) nativeSend.call(mainWs, dropPowerPacket);
        dropPowerPacket.setUint8(9, 2, true);                                 // speed
        for (let i = 0; i < speedCount; i++) nativeSend.call(mainWs, dropPowerPacket);
        return true;
    }

    function tDoLogout() {
        tSetState(T_STATE.LOGGING_OUT);
        try { nativeSend.call(altWs, logoutPacket); } catch (_) { }
        tClearTimers();
        if (tPaused) {
            // Chain is paused (too many consecutive alt failures). Don't schedule
            // the next login. Drop back to IDLE after a moment so the state machine
            // is in a sane resting state; the IDLE bootstrap in transferOnMainOp80
            // is also gated on tPaused so we won't auto-restart.
            tNextLoginTimerId = setTimeout(() => {
                tNextLoginTimerId = null;
                if (tPaused) tSetState(T_STATE.IDLE);
            }, 1000);
            return;
        }
        // 1 second between logout and next login (per user spec)
        tNextLoginTimerId = setTimeout(() => {
            tNextLoginTimerId = null;
            if (!enabled || role !== ROLES.AUTO_R2) { tSetState(T_STATE.IDLE); return; }
            if (!altWindow || altWindow.closed) { tSetState(T_STATE.IDLE); return; }
            sendAltLogin();
        }, 1000);
    }

    function tAdvance(isSuccess) {
        config.altCurrent++;
        saveConfig();
        tAttempts = 0;
        if (isSuccess) {
            tConsecutiveFails = 0;
        } else {
            tConsecutiveFails++;
            if (tConsecutiveFails >= T_MAX_CONSECUTIVE_FAILS) {
                tPaused = true;
                console.warn(
                    `%c[FarmSuite][Transfer] ${tConsecutiveFails} alts in a row all failed — PAUSING chain. `
                    + `Check altPassword / altPrefix / altCurrent. Toggle R2 off then on to resume.`,
                    'color:#ff8888;font-weight:bold;font-size:13px'
                );
            }
        }
        updateUI();
    }

    function tOnFailure(reason) {
        tAttempts++;
        const who = currentAltName();
        console.warn(`[FarmSuite][Transfer] FAIL on ${who}: ${reason} (attempt ${tAttempts}/3)`);
        if (tAttempts >= 3) {
            console.warn(`[FarmSuite][Transfer] 3 failures on ${who} — skipping to next alt`);
            tAdvance(false);
        }
        tDoLogout();
    }

    function r2Toggle(on) {
        if (on) {
            if (!mainWs) {
                console.warn('[FarmSuite] R2 toggle ignored — mainWs not captured yet. Refresh the page or wait until you spawn.');
                return;
            }
            if (getServerType() === 'gigantic') {
                alert("Auto R2 isn't supported on Gigantic / Giant / Giga servers.\nUse Block Feeder or XP Bot here.");
                return;
            }
            enabled = true;
            r2StartTime = Date.now();
            r2Phase = 'CYCLING';
            cycleAbort = false;
            // Clear any prior chain-paused state from a previous session
            tPaused = false;
            tConsecutiveFails = 0;
            tAttempts = 0;
            const altOpen = altWindow && !altWindow.closed;
            console.log(`%c[FarmSuite] R2 ON — server=${mainWs.url} portalMode=${portalMode || 'unknown'} altTab=${altOpen ? 'open' : 'closed'}`, 'color:#7fc7ff;font-weight:bold');
            if (portalMode === Modes.R1) {
                console.warn('[FarmSuite] portalMode is R1 — cycle coords are for R2 on X Instant. If your cell drifts to nothing, you are on the wrong portal/server.');
            }
            // Start the R2 cycle (main-side farming). On Crazy servers this returns
            // immediately without sending any packets — see r2Cycle's early branch.
            r2Cycle();
            // Bootstrap the transfer state machine if the alt tab is already open.
            // If it isn't, the chain will start later on a main op 80 once the user
            // opens the alt tab (transferOnMainOp80 has the IDLE→sendAltLogin path).
            if (altOpen && altWs && tState === T_STATE.IDLE) {
                sendAltLogin();
            }
        } else {
            enabled = false;
            cycleAbort = true;
            if (monitorCellId) { clearInterval(monitorCellId); monitorCellId = null; }

            // Clean up the transfer state machine
            tClearTimers();
            if (tState !== T_STATE.IDLE && altWs) {
                try { nativeSend.call(altWs, logoutPacket); } catch (_) { }
            }
            tState = T_STATE.IDLE;
            tStateEnteredAt = Date.now();
            tAttempts = 0;
            tDropsSentAt = 0;
            tDropCoords = null;
            tSpawnRetryCount = 0;
            tR2WasReady = false;
            tConsecutiveFails = 0;
            tPaused = false;

            // Reset transfer-related alt state
            altCountsReceived = false;
            altRecCount = 0;
            altSpeedCount = 0;

            r2Phase = 'OFF';
        }
        updateUI();
    }

    // ===========================================================================
    // XP ROLE — state machine
    //
    //   OFF
    //     │ xpToggle(on) + first spawn
    //     ▼
    //   POSITIONING ──► aim mouse at (xpTargetX, xpTargetY); cell drifts there
    //     │             when within 1000 px of target:
    //     ▼
    //   READY ────────► freeze cell, broadcast xp_active{x,y,mass} every 300ms.
    //     │             feeder receives, enters XP_BOOST, feeds toward us.
    //     │             when xpCurrentMass >= config.xpTargetMass:
    //     ▼
    //   DISPERSING ──► unfreeze, mouse → far right edge, split×4 (full split into
    //     │            a 16-cell line going right), wait 1s, then aim up or down
    //     │            depending on which direction has more room from current Y.
    //     ▼
    //   DONE          broadcast xp_done; bot keeps drifting in the chosen direction
    //                 collecting pellets. User toggles off to fully stop.
    //
    // Death detection: if xpHadCells transitions true→false while phase != OFF,
    // we broadcast xp_dead so the feeder exits XP_BOOST immediately rather than
    // waiting 4s for its silence-timeout to fire.
    // ===========================================================================
    function xpTick() {
        if (!cellAttributes) return;

        // compute total mass + average position
        let totalMass = 0, x = 0, y = 0, n = 0;
        for (const cell of Object.values(allCells)) {
            if (cell[cellAttributes[45]]) {
                const size = cell[cellAttributes[30]] || cell.size || 0;
                totalMass += (size * size) / 100;
                x += cell[cellAttributes[31]];
                y += cell[cellAttributes[32]];
                n++;
            }
        }

        // Death edge: had cells last tick, now have none — notify feeder
        if (!n) {
            if (xpHadCells && xpPhase !== 'OFF' && xpPhase !== 'DONE') {
                bcSend({ type: 'xp_dead' });
                console.log('[FarmSuite] XP died — broadcasting xp_dead');
            }
            xpHadCells = false;
            xpCurrentMass = 0;
            xpCurrentPos = null;
            // stay in same phase — autoRespawnTick will respawn us; positioning
            // logic resumes on the next tick that sees cells again.
            return;
        }
        const justSpawned = !xpHadCells;
        xpHadCells = true;
        xpCurrentMass = Math.round(totalMass);
        xpCurrentPos = { x: Math.round(x / n), y: Math.round(y / n) };

        // Just (re)spawned and bot is on — kick off positioning
        if (justSpawned && (xpPhase === 'OFF' || xpPhase === 'POSITIONING' || xpPhase === 'READY')) {
            xpPhase = 'POSITIONING';
            if (isFrozen) {
                try { nativeSend.call(mainWs, freezePacket); isFrozen = false; } catch (_) { }
            }
        }

        if (xpPhase === 'POSITIONING') {
            // aim toward target spot
            mousePacket.setInt32(1, config.xpTargetX, true);
            mousePacket.setInt32(5, config.xpTargetY, true);
            try { nativeSend.call(mainWs, mousePacket.buffer); } catch (_) { }
            const dist = Math.hypot(xpCurrentPos.x - config.xpTargetX, xpCurrentPos.y - config.xpTargetY);
            if (dist < 1000) {
                xpPhase = 'READY';
                try { nativeSend.call(mainWs, freezePacket); isFrozen = true; } catch (_) { }
                console.log(`[FarmSuite] XP positioned at (${xpCurrentPos.x}, ${xpCurrentPos.y}) — frozen, broadcasting for feeder`);
            }
            updateUI();
            return;
        }

        if (xpPhase === 'READY') {
            bcSend({
                type: 'xp_active',
                x: xpCurrentPos.x,
                y: xpCurrentPos.y,
                mass: xpCurrentMass,
            });
            if (xpCurrentMass >= config.xpTargetMass) {
                xpPhase = 'DISPERSING';
                startXpDispersion();
            }
            updateUI();
            return;
        }

        // DISPERSING and DONE: nothing to broadcast each tick; startXpDispersion
        // owns the timed sequence and the final xp_done broadcast.
        updateUI();
    }

    async function startXpDispersion() {
        if (!mainWs || !cellAttributes) return;
        const startY = xpCurrentPos ? xpCurrentPos.y : config.xpTargetY;
        console.log(`%c[FarmSuite] XP target mass reached (${xpCurrentMass}) — starting dispersion`, 'color:#7fffa1;font-weight:bold');

        // 1. Unfreeze so the cell can move
        try { nativeSend.call(mainWs, freezePacket); isFrozen = false; } catch (_) { }

        // 2. Aim at the far right edge at current Y, so the split chunks all fly right
        mousePacket.setInt32(1, 14000, true);
        mousePacket.setInt32(5, Math.round(startY), true);
        try { nativeSend.call(mainWs, mousePacket.buffer); } catch (_) { }

        // 3. Full split — 4 presses turns 1 cell into 16, all aimed right.
        //    120 ms between presses lets each split's recharge clear.
        for (let i = 0; i < 4; i++) {
            await wait(0.12);
            try { nativeSend.call(mainWs, splitPacket); } catch (_) { }
        }

        // 4. Let the cells spread out into a line
        await wait(1);

        // 5. Pick whichever vertical direction has more room from the current Y
        const myY = (xpCurrentPos && xpCurrentPos.y) || startY;
        const distUp = myY;
        const distDown = config.xpMapHeight - myY;
        const targetY = distUp > distDown ? 0 : config.xpMapHeight;
        console.log(`[FarmSuite] XP at Y=${myY} → distUp=${distUp} distDown=${distDown} → going to Y=${targetY}`);

        // 6. Aim at (right edge, chosen Y) so the cell-line travels that way
        mousePacket.setInt32(1, 14000, true);
        mousePacket.setInt32(5, targetY, true);
        try { nativeSend.call(mainWs, mousePacket.buffer); } catch (_) { }

        xpPhase = 'DONE';
        bcSend({ type: 'xp_done' });
        updateUI();
    }

    function xpToggle(on) {
        if (on) {
            enabled = true;
            xpPhase = 'POSITIONING';
            xpHadCells = false;
            if (xpBroadcastInterval) clearInterval(xpBroadcastInterval);
            xpBroadcastInterval = setInterval(xpTick, 300);
            xpTick();                                  // fire once immediately so feeder hears us asap
            console.log('[FarmSuite] XP ON — heading to target spot, then will broadcast for feeder');
        } else {
            enabled = false;
            if (xpBroadcastInterval) { clearInterval(xpBroadcastInterval); xpBroadcastInterval = null; }
            bcSend({ type: 'xp_done' });
            if (isFrozen) {
                try { nativeSend.call(mainWs, freezePacket); isFrozen = false; } catch (_) { }
            }
            xpPhase = 'OFF';
        }
        updateUI();
    }

    // ===========================================================================
    // UI
    // ===========================================================================
    const CSS = `
.fs-ui { font-family: Inter, system-ui, Arial, sans-serif; color: #eaf4ff; }

.fs-launcher {
    position: fixed; right: 18px; bottom: 165px;
    width: 92px; height: 44px;
    border: 1px solid rgba(110,180,255,0.22);
    border-radius: 14px;
    background: linear-gradient(180deg, rgba(21,29,48,0.92), rgba(13,18,30,0.94));
    color: #eaf4ff; cursor: pointer; z-index: 999999;
    font-size: 13px; font-weight: 700; letter-spacing: 0.4px;
    box-shadow: 0 12px 28px rgba(0,0,0,0.34), 0 0 0 1px rgba(120,190,255,0.08) inset;
    backdrop-filter: blur(10px);
}
.fs-launcher:hover {
    border-color: rgba(135,205,255,0.34);
    background: linear-gradient(180deg, rgba(27,38,62,0.96), rgba(16,23,37,0.98));
}

.fs-overlay {
    position: fixed; inset: 0; z-index: 1000000;
    display: flex; align-items: center; justify-content: center;
    background: rgba(2,8,18,0.42);
}
.fs-overlay--hidden { display: none; }

.fs-menu {
    width: 720px; max-width: calc(100vw - 40px);
    height: 580px; max-height: calc(100vh - 40px);
    background:
        radial-gradient(circle at top left, rgba(77,154,255,0.12), transparent 28%),
        linear-gradient(180deg, rgba(17,24,39,0.96), rgba(9,14,24,0.97));
    border: 1px solid rgba(120,190,255,0.14);
    border-radius: 22px;
    box-shadow: 0 22px 80px rgba(0,0,0,0.48), 0 0 0 1px rgba(255,255,255,0.03) inset;
    overflow: hidden; display: flex; flex-direction: column;
}

.fs-menu__header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 18px; border-bottom: 1px solid rgba(255,255,255,0.06);
}
.fs-menu__title { font-size: 17px; font-weight: 700; color: #edf6ff; letter-spacing: 0.3px; }
.fs-menu__title span { color: #7fc7ff; font-weight: 600; font-size: 12px; margin-left: 8px; opacity: 0.7; }
.fs-menu__close {
    width: 32px; height: 32px;
    border: 1px solid rgba(130,200,255,0.12); border-radius: 10px;
    background: rgba(255,255,255,0.04); color: #dbeeff;
    cursor: pointer; font-size: 20px; line-height: 1;
    display: grid; place-items: center;
}
.fs-menu__close:hover { background: rgba(88,162,255,0.12); border-color: rgba(130,200,255,0.24); }

.fs-tabs { display: flex; gap: 8px; padding: 14px 18px 0; }
.fs-tab {
    min-width: 100px;
    border: 1px solid rgba(130,200,255,0.1);
    background: rgba(255,255,255,0.035);
    color: #d7ebff; padding: 10px 14px;
    border-radius: 12px; cursor: pointer;
    font-weight: 600; font-size: 13px;
    transition: 120ms ease;
}
.fs-tab:hover { background: rgba(88,162,255,0.08); }
.fs-tab--active {
    background: linear-gradient(180deg, rgba(79,157,255,0.18), rgba(58,126,222,0.12));
    border-color: rgba(130,200,255,0.22); color: #f4fbff;
}

.fs-menu__body { flex: 1; padding: 18px; overflow: auto; }
.fs-tab-panel { display: none; }
.fs-tab-panel--active { display: block; }

.fs-section-title { font-size: 16px; font-weight: 700; color: #eef7ff; margin-bottom: 12px; }
.fs-section-sub   { font-size: 12px; color: #98b6d6; margin-bottom: 14px; }

.fs-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; margin-bottom: 10px;
    padding: 10px 12px;
    border: 1px solid rgba(130,200,255,0.08);
    border-radius: 12px;
    background: rgba(255,255,255,0.03);
}
.fs-row__label { font-size: 13px; color: #d6eaff; flex-shrink: 0; }
.fs-row__value { font-size: 13px; color: #ffe; font-family: ui-monospace, Menlo, Consolas, monospace; }

.fs-input, .fs-select {
    height: 34px;
    border: 1px solid rgba(130,200,255,0.12);
    border-radius: 9px;
    background: rgba(255,255,255,0.045);
    color: #eaf4ff;
    padding: 0 10px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 12px;
    outline: none;
    text-align: right;
    min-width: 110px;
}
.fs-input:focus, .fs-select:focus {
    border-color: rgba(130,200,255,0.32);
    box-shadow: 0 0 0 3px rgba(80,150,255,0.1);
}
.fs-select { text-align: left; }
/* Native <select> popups inherit color/background from the <select>, and OS
   rendering can override that, so set them explicitly here. Dark background +
   light text matches the rest of the panel theme. */
.fs-input option, .fs-select option {
    color: #eaf4ff;
    background: #11182a;
}
.fs-input option:checked, .fs-select option:checked,
.fs-input option:hover,   .fs-select option:hover {
    color: #ffffff;
    background: #1f4ea8;
}

.fs-toggle-btn {
    width: 100%;
    margin-top: 10px;
    padding: 12px;
    border: 1px solid rgba(130,200,255,0.18);
    border-radius: 12px;
    background: rgba(255,255,255,0.05);
    color: #eaf4ff;
    cursor: pointer;
    font-weight: 700;
    font-size: 14px;
    letter-spacing: 0.4px;
    transition: 120ms ease;
}
.fs-toggle-btn--on {
    background: linear-gradient(180deg, rgba(64,200,120,0.22), rgba(40,150,90,0.16));
    border-color: rgba(120,255,170,0.35);
    color: #d6ffe6;
}
.fs-toggle-btn:hover { background: rgba(80,150,255,0.1); }
.fs-toggle-btn--on:hover { background: linear-gradient(180deg, rgba(64,200,120,0.3), rgba(40,150,90,0.22)); }

.fs-status-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 10px;
}
.fs-status-cell {
    padding: 10px 12px;
    border: 1px solid rgba(130,200,255,0.08);
    border-radius: 10px;
    background: rgba(255,255,255,0.025);
}
.fs-status-cell__label { font-size: 10px; color: #7c97b8; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 4px; }
.fs-status-cell__value { font-size: 14px; color: #eaf4ff; font-family: ui-monospace, Menlo, Consolas, monospace; font-weight: 600; }

.fs-status-badge {
    position: fixed; top: 70px; left: 8px; z-index: 999998;
    padding: 6px 10px;
    border: 1px solid rgba(130,200,255,0.14);
    border-radius: 9px;
    background: rgba(13,18,30,0.88);
    color: #ffb4b4;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 11px; font-weight: 700;
    pointer-events: none;
}
.fs-status-badge--on { color: #b9ffcf; border-color: rgba(120,255,170,0.35); }
.fs-status-badge--ready {
    color: #ffe27a;
    border-color: rgba(255,212,122,0.6);
    background: rgba(60, 45, 10, 0.92);
    animation: fs-badge-pulse 1.2s ease-in-out infinite;
}
@keyframes fs-badge-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255,212,122,0.0); }
    50%      { box-shadow: 0 0 0 6px rgba(255,212,122,0.18); }
}

.fs-hint { font-size: 11px; color: #6b87a6; margin-top: 8px; }
.fs-fieldhint {
    font-size: 11px;
    color: #5a7188;
    font-style: italic;
    text-align: right;
    margin: -6px 0 6px 0;
    padding-right: 2px;
    opacity: 0.85;
}
.fs-warn { color: #ffb15c; }
`;

    const HTML = `
<div class="fs-ui">
  <button id="fs-launcher" class="fs-launcher" type="button">FARM</button>

  <div id="fs-status-badge" class="fs-status-badge">FARM: OFF</div>

  <div id="fs-overlay" class="fs-overlay fs-overlay--hidden">
    <div class="fs-menu" role="dialog" aria-modal="true">
      <div class="fs-menu__header">
        <div class="fs-menu__title">Farm Suite <span>v0.1.0</span></div>
        <button id="fs-close" class="fs-menu__close" type="button">×</button>
      </div>

      <div class="fs-tabs">
        <button class="fs-tab fs-tab--active" data-tab="role">Role</button>
        <button class="fs-tab" data-tab="feeder">Feeder</button>
        <button class="fs-tab" data-tab="r2">Auto R2</button>
        <button class="fs-tab" data-tab="xp">XP Bot (soon!)</button>
      </div>

      <div class="fs-menu__body">

        <section class="fs-tab-panel fs-tab-panel--active" data-panel="role">
          <div class="fs-section-title">Role</div>
          <div class="fs-section-sub">Pick what this tab does. Settings live in the role's tab.</div>

          <div class="fs-row">
            <span class="fs-row__label">Active role</span>
            <select id="fs-role" class="fs-select">
              <option value="none">None</option>
              <option value="feeder">Block Feeder</option>
              <option value="auto_r2">Auto R2</option>
              <option value="xp">XP Bot (soon!)</option>
            </select>
          </div>

          <div class="fs-status-grid">
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">Socket</div>
              <div id="fs-st-socket" class="fs-status-cell__value">disconnected</div>
            </div>
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">Server</div>
              <div id="fs-st-server" class="fs-status-cell__value">—</div>
            </div>
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">Bot</div>
              <div id="fs-st-enabled" class="fs-status-cell__value">OFF</div>
            </div>
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">Portal mode</div>
              <div id="fs-st-portal" class="fs-status-cell__value">—</div>
            </div>
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">Hotkey</div>
              <div id="fs-st-hotkey" class="fs-status-cell__value">—</div>
            </div>
          </div>

          <div class="fs-hint">Same hotkey toggles the active role. Defaults: Feeder = 0, Auto R2 = 9, XP = 8.</div>
        </section>

        <section class="fs-tab-panel" data-panel="feeder">
          <div class="fs-section-title">Block Feeder</div>
          <div class="fs-section-sub">Farms gold blocks. Chases viruses between blocks. Diverts to XP bot when it broadcasts coords.</div>

          <div class="fs-row">
            <span class="fs-row__label">Scan radius (+ own size)</span>
            <input id="fs-feeder-radius" class="fs-input" type="number" min="0" step="500" />
          </div>
          <div class="fs-row">
            <span class="fs-row__label">Between-block chase</span>
            <select id="fs-feeder-chase" class="fs-input">
              <option value="none">Nothing (safest)</option>
              <option value="virus">Viruses only</option>
              <option value="coins">Coins only</option>
              <option value="both">Both (viruses first, then coins)</option>
            </select>
          </div>
          <div class="fs-row">
            <span class="fs-row__label">Virus timing</span>
            <select id="fs-feeder-virustiming" class="fs-input">
              <option value="before">Before + during feeding (divert)</option>
              <option value="after">After block grey only</option>
            </select>
          </div>
          <div class="fs-row">
            <span class="fs-row__label">Stop feeding below mass</span>
            <input id="fs-feeder-min-mass" class="fs-input" type="number" min="0" step="50" />
          </div>
          <div class="fs-row">
            <span class="fs-row__label">Feed mode</span>
            <select id="fs-feeder-feedmode" class="fs-input">
              <option value="multi">Max multi-eject (V, 5 per press)</option>
              <option value="normal">Normal (W, 1 per press)</option>
            </select>
          </div>
          <div class="fs-fieldhint">ⓘ V multi-eject only works on accounts that have it unlocked — use Normal otherwise.</div>
          <div class="fs-row">
            <span class="fs-row__label">Hotkey</span>
            <input id="fs-feeder-key" class="fs-input" maxlength="3" />
          </div>

          <div class="fs-status-grid">
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">State</div>
              <div id="fs-feeder-state" class="fs-status-cell__value">IDLE</div>
            </div>
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">Gold blocks</div>
              <div id="fs-feeder-blocks" class="fs-status-cell__value">0</div>
            </div>
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">Viruses tracked</div>
              <div id="fs-feeder-viruses" class="fs-status-cell__value">0</div>
            </div>
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">Coins on map</div>
              <div id="fs-feeder-coins" class="fs-status-cell__value">0</div>
            </div>
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">My size</div>
              <div id="fs-feeder-size" class="fs-status-cell__value">0</div>
            </div>
          </div>

          <button id="fs-feeder-toggle" class="fs-toggle-btn" type="button">Toggle Feeder</button>
        </section>

        <section class="fs-tab-panel" data-panel="r2">
          <div class="fs-section-title">Auto R2 + Transfer</div>
          <div class="fs-section-sub">Cycles main on Server X Instant until N recs + M speeds, then logs an alt to receive the drop.</div>

          <div class="fs-row">
            <span class="fs-row__label">Alt username</span>
            <input id="fs-r2-prefix" class="fs-input" type="text" />
          </div>
          <div class="fs-row">
            <span class="fs-row__label">Alt password</span>
            <input id="fs-r2-password" class="fs-input" type="password" />
          </div>
          <div class="fs-row">
            <span class="fs-row__label">Current alt #</span>
            <input id="fs-r2-current" class="fs-input" type="number" min="1" />
          </div>
          <div class="fs-row">
            <span class="fs-row__label">Recombines wanted</span>
            <input id="fs-r2-rec" class="fs-input" type="number" min="1" max="32" />
          </div>
          <div class="fs-row">
            <span class="fs-row__label">Speeds wanted</span>
            <input id="fs-r2-speed" class="fs-input" type="number" min="1" max="32" />
          </div>
          <div class="fs-row">
            <span class="fs-row__label">Hotkey</span>
            <input id="fs-r2-key" class="fs-input" maxlength="3" />
          </div>

          <div class="fs-status-grid">
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">Phase</div>
              <div id="fs-r2-phase" class="fs-status-cell__value">OFF</div>
            </div>
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">Live rec / speed</div>
              <div id="fs-r2-live" class="fs-status-cell__value">0 / 0</div>
            </div>
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">Alt coords</div>
              <div id="fs-r2-altpos" class="fs-status-cell__value">—</div>
            </div>
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">Alt tab</div>
              <div id="fs-r2-altwin" class="fs-status-cell__value">closed</div>
            </div>
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">Alt socket</div>
              <div id="fs-r2-altsock" class="fs-status-cell__value">—</div>
            </div>
          </div>

          <button id="fs-r2-open-alt" class="fs-toggle-btn" type="button" style="margin-top:14px">Open alt tab</button>
          <button id="fs-r2-toggle" class="fs-toggle-btn" type="button">Toggle Auto R2</button>
        </section>

        <section class="fs-tab-panel" data-panel="xp">
          <div class="fs-section-title">XP Bot (soon!)</div>
          <div class="fs-section-sub">Logs in manually, then broadcasts its position to the Feeder until target mass is reached.</div>

          <div class="fs-row">
            <span class="fs-row__label">Target mass</span>
            <input id="fs-xp-mass" class="fs-input" type="number" min="1000" step="1000" />
          </div>
          <div class="fs-row">
            <span class="fs-row__label">Hotkey</span>
            <input id="fs-xp-key" class="fs-input" maxlength="3" />
          </div>

          <div class="fs-status-grid">
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">Phase</div>
              <div id="fs-xp-phase" class="fs-status-cell__value">OFF</div>
            </div>
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">Current mass</div>
              <div id="fs-xp-curmass" class="fs-status-cell__value">0</div>
            </div>
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">Position</div>
              <div id="fs-xp-pos" class="fs-status-cell__value">—</div>
            </div>
            <div class="fs-status-cell">
              <div class="fs-status-cell__label">Broadcast</div>
              <div id="fs-xp-bc" class="fs-status-cell__value">silent</div>
            </div>
          </div>

          <button id="fs-xp-toggle" class="fs-toggle-btn" type="button">Toggle XP</button>
        </section>

      </div>
    </div>
  </div>
</div>
`;

    let uiBuilt = false;

    function buildUI() {
        if (uiBuilt) return;
        uiBuilt = true;

        const styleEl = document.createElement('style');
        styleEl.textContent = CSS;
        document.head.appendChild(styleEl);

        const wrap = document.createElement('div');
        wrap.innerHTML = HTML.trim();
        document.body.appendChild(wrap);

        // Stop key events from leaking out of UI inputs into the game. Without this,
        // typing the alt password, an alt name, or a hotkey field also fires the game's
        // own keybindings (W to feed, space to split, digits for slots, etc), which can
        // both blow up the run and submit unintended chat. Use capture phase so we
        // intercept before the game's window-level listeners run.
        const stopFromUiField = e => {
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) {
                e.stopPropagation();
            }
        };
        // Wheel events too — scrolling inside the panel was reaching the game's
        // window-level wheel listener (zoom in/out). Stop unconditionally for any
        // wheel inside the panel: panel itself still scrolls, number inputs still
        // spin, the event just doesn't bubble out to the game.
        const stopWheel = e => { e.stopPropagation(); };
        const menuRoot = document.querySelector('.fs-menu');
        if (menuRoot) {
            menuRoot.addEventListener('keydown', stopFromUiField, true);
            menuRoot.addEventListener('keyup', stopFromUiField, true);
            menuRoot.addEventListener('keypress', stopFromUiField, true);
            menuRoot.addEventListener('wheel', stopWheel, true);
            menuRoot.addEventListener('mousewheel', stopWheel, true);
        }

        // open / close / tab switching
        const overlay = document.getElementById('fs-overlay');
        document.getElementById('fs-launcher').addEventListener('click', () => {
            overlay.classList.remove('fs-overlay--hidden');
            // first time someone opens the panel — ask for desktop notification permission
            // (we use a user gesture so the browser actually prompts)
            if ('Notification' in window && Notification.permission === 'default') {
                Notification.requestPermission().catch(() => { });
            }
        });
        document.getElementById('fs-close').addEventListener('click', () => {
            overlay.classList.add('fs-overlay--hidden');
        });
        document.querySelectorAll('.fs-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const id = tab.dataset.tab;
                document.querySelectorAll('.fs-tab').forEach(t => t.classList.toggle('fs-tab--active', t.dataset.tab === id));
                document.querySelectorAll('.fs-tab-panel').forEach(p => p.classList.toggle('fs-tab-panel--active', p.dataset.panel === id));
            });
        });

        // role selector
        const roleSel = document.getElementById('fs-role');
        roleSel.value = role;
        roleSel.addEventListener('change', () => {
            if (roleSel.value === ROLES.XP) {
                alert("This feature isn't ready yet");
                roleSel.value = role;
                return;
            }
            if (roleSel.value === ROLES.AUTO_R2 && getServerType() === 'gigantic') {
                alert("Auto R2 isn't supported on Gigantic / Giant / Giga servers.\nUse Block Feeder or XP Bot here.");
                roleSel.value = role;
                return;
            }
            // turn off whatever was running
            if (enabled) toggleActiveRole(false);
            role = config.role = roleSel.value;
            saveConfig();
            updateUI();
        });

        // feeder inputs
        const fr = document.getElementById('fs-feeder-radius');
        fr.value = config.scanRadius;
        fr.addEventListener('change', () => {
            const v = parseInt(fr.value);
            if (!isNaN(v) && v >= 0) { config.scanRadius = v; saveConfig(); }
        });
        const fk = document.getElementById('fs-feeder-key');
        fk.value = config.feederKey;
        fk.addEventListener('change', () => { config.feederKey = (fk.value || '').slice(0, 3); saveConfig(); updateUI(); });

        const fcm = document.getElementById('fs-feeder-chase');
        fcm.value = config.feederChaseMode;
        fcm.addEventListener('change', () => {
            const v = fcm.value;
            if (['none', 'virus', 'coins', 'both'].includes(v)) {
                config.feederChaseMode = v;
                saveConfig();
            }
        });

        const fvt = document.getElementById('fs-feeder-virustiming');
        fvt.value = config.feederVirusTiming;
        fvt.addEventListener('change', () => {
            const v = fvt.value;
            if (v === 'after' || v === 'before') {
                config.feederVirusTiming = v;
                saveConfig();
            }
        });

        const fmm = document.getElementById('fs-feeder-min-mass');
        fmm.value = config.feederMinMass;
        fmm.addEventListener('change', () => {
            const v = parseInt(fmm.value);
            if (!isNaN(v) && v >= 0) { config.feederMinMass = v; saveConfig(); }
        });

        const ffm = document.getElementById('fs-feeder-feedmode');
        ffm.value = config.feederFeedMode;
        ffm.addEventListener('change', () => {
            const v = ffm.value;
            if (v === 'normal' || v === 'multi') {
                config.feederFeedMode = v;
                saveConfig();
                // Push the new setting to the server immediately if the feeder is
                // active, so the next eject uses the new count without needing a
                // toggle off/on.
                if (enabled && role === ROLES.FEEDER) applyFeederFeedMode();
            }
        });

        document.getElementById('fs-feeder-toggle').addEventListener('click', () => {
            if (role !== ROLES.FEEDER) { roleSel.value = ROLES.FEEDER; role = config.role = ROLES.FEEDER; saveConfig(); }
            toggleActiveRole(!enabled);
        });

        // r2 inputs
        const bind = (id, key, parser = v => v) => {
            const el = document.getElementById(id);
            el.value = config[key];
            el.addEventListener('change', () => {
                const v = parser(el.value);
                if (v !== null && v !== undefined && !(typeof v === 'number' && isNaN(v))) {
                    config[key] = v; saveConfig(); updateUI();
                }
            });
        };
        bind('fs-r2-prefix', 'altPrefix');
        bind('fs-r2-password', 'altPassword');
        bind('fs-r2-current', 'altCurrent', v => parseInt(v));
        bind('fs-r2-rec', 'recWanted', v => parseInt(v));
        bind('fs-r2-speed', 'speedWanted', v => parseInt(v));
        bind('fs-r2-key', 'r2Key', v => (v || '').slice(0, 3));

        document.getElementById('fs-r2-open-alt').addEventListener('click', () => {
            const ok = ensureAltWindow();
            if (!ok) console.warn('[FarmSuite] Could not open alt tab — popup blocked?');
            updateUI();
        });

        document.getElementById('fs-r2-toggle').addEventListener('click', () => {
            if (role !== ROLES.AUTO_R2) { roleSel.value = ROLES.AUTO_R2; role = config.role = ROLES.AUTO_R2; saveConfig(); }
            toggleActiveRole(!enabled);
        });

        // xp inputs
        bind('fs-xp-mass', 'xpTargetMass', v => parseInt(v));
        bind('fs-xp-key', 'xpKey', v => (v || '').slice(0, 3));
        document.getElementById('fs-xp-toggle').addEventListener('click', () => {
            alert("This feature isn't ready yet");
        });

        updateUI();
    }

    function updateUI() {
        if (!uiBuilt) return;

        // role tab status
        const socketEl = document.getElementById('fs-st-socket');
        const enabledEl = document.getElementById('fs-st-enabled');
        const portalEl = document.getElementById('fs-st-portal');
        const hotkeyEl = document.getElementById('fs-st-hotkey');
        const serverEl = document.getElementById('fs-st-server');
        if (socketEl) {
            socketEl.textContent = mainWs ? 'connected' : 'disconnected';
            socketEl.style.color = mainWs ? '#b9ffcf' : '#ffb4b4';
        }
        if (serverEl) {
            // currentServerName is a top-level var inside gayma (line 705). With
            // @grant unsafeWindow and the user's Tampermonkey config it lives on
            // the page window. Fall back to deriving from the socket URL if it's
            // unreachable or not yet set. Append the server-type tag so the user
            // can see at a glance which split-cycle logic is active.
            let name = '';
            try { name = unsafeWindow.currentServerName || ''; } catch (_) { }
            if (!name && mainWs && typeof mainWs.url === 'string') {
                const m = mainWs.url.match(/s(\d+)\.agma\.io/);
                if (m) name = `s${m[1]}`;
            }
            let display = name || '—';
            if (mainWs) {
                const type = getServerType();
                if (type === 'instant') display += ' (instant)';
                else if (type === 'xy_insta') display += ' (XY-Insta)';
                else if (type === 'crazy') display += ' (crazy)';
                else if (type === 'gigantic') display += ' (gigantic)';
                else if (name) display += ' (unsupported)';
                // Disable the Auto R2 option in the role dropdown on Gigantic
                // family — only Block Feeder + XP Bot are available there.
                const r2Opt = document.querySelector('#fs-role option[value="' + ROLES.AUTO_R2 + '"]');
                if (r2Opt) {
                    if (type === 'gigantic') {
                        r2Opt.disabled = true;
                        if (!r2Opt.dataset.origLabel) r2Opt.dataset.origLabel = r2Opt.textContent;
                        r2Opt.textContent = r2Opt.dataset.origLabel + ' (unavailable on Gigantic)';
                    } else {
                        r2Opt.disabled = false;
                        if (r2Opt.dataset.origLabel) r2Opt.textContent = r2Opt.dataset.origLabel;
                    }
                }
            }
            serverEl.textContent = display;
            serverEl.style.color = name ? '#b9ffcf' : '#7c97b8';
        }
        if (enabledEl) {
            enabledEl.textContent = enabled ? 'ON' : 'OFF';
            enabledEl.style.color = enabled ? '#b9ffcf' : '#7c97b8';
        }
        if (portalEl)
            portalEl.textContent = portalMode === Modes.R1 ? 'R1' : portalMode === Modes.R2 ? 'R2' : '—';
        if (hotkeyEl) {
            const k = role === ROLES.FEEDER ? config.feederKey
                : role === ROLES.AUTO_R2 ? config.r2Key
                    : role === ROLES.XP ? config.xpKey
                        : '—';
            hotkeyEl.textContent = k;
        }

        // feeder
        const fSt = document.getElementById('fs-feeder-state');
        if (fSt) {
            let phaseText = role === ROLES.FEEDER ? (enabled ? feederPhase : 'OFF') : '(inactive)';
            if (role === ROLES.FEEDER && enabled && feederPhase === 'XP_BOOST' && xpBoostTarget) {
                phaseText += ` → ${xpBoostTarget.mass}/${config.xpTargetMass} @ (${xpBoostTarget.x}, ${xpBoostTarget.y})`;
            }
            fSt.textContent = phaseText;
            fSt.style.color = !enabled || role !== ROLES.FEEDER ? '#7c97b8'
                : feederPhase === 'FEEDING' ? '#b9ffcf'
                    : feederPhase === 'CLUSTER' ? '#ffd700'
                        : feederPhase === 'VIRUS' ? '#7fc7ff'
                            : feederPhase === 'XP_BOOST' ? '#ffd47a'
                                : '#eaf4ff';
        }
        const fBl = document.getElementById('fs-feeder-blocks');
        if (fBl) {
            fBl.textContent = feederTargets.size;
            fBl.style.color = feederTargets.size > 0 ? '#ffd700' : '#7c97b8';
        }
        const fVi = document.getElementById('fs-feeder-viruses');
        if (fVi) {
            let c = 0; for (const [, v] of virusCells) if (v.type === 2) c++;
            fVi.textContent = c;
        }
        const fCo = document.getElementById('fs-feeder-coins');
        if (fCo) {
            const n = countCoins();
            fCo.textContent = n;
            fCo.style.color = n > 0 ? '#ffd700' : '#7c97b8';
        }
        const fSi = document.getElementById('fs-feeder-size');
        if (fSi) fSi.textContent = Math.round(getMySize() || 0);

        const fBtn = document.getElementById('fs-feeder-toggle');
        if (fBtn) fBtn.classList.toggle('fs-toggle-btn--on', enabled && role === ROLES.FEEDER);

        // r2
        const r2Ph = document.getElementById('fs-r2-phase');
        if (r2Ph) {
            // Show transfer state alongside R2 cycle phase so both are visible.
            // When the chain is paused after too many consecutive failures, annotate it.
            const stateLabel = tPaused ? `${tState} (PAUSED)` : tState;
            const txt = role === ROLES.AUTO_R2
                ? (enabled ? `${r2Phase} | ${stateLabel}` : 'OFF')
                : '(inactive)';
            r2Ph.textContent = txt;
            r2Ph.style.color = !enabled || role !== ROLES.AUTO_R2 ? '#7c97b8'
                : tPaused ? '#ff8888'
                    : tState === T_STATE.WAITING_FOR_R2 ? '#ffd47a'
                        : tState === T_STATE.WAITING_DROP_CONFIRM ? '#b9ffcf'
                            : r2Phase === 'CYCLING' ? '#7fc7ff'
                                : r2Phase === 'TRAVELING' ? '#7fc7ff'
                                    : r2Phase === 'STAYING' ? '#b9ffcf'
                                        : r2Phase === 'WAIT_PELLETS' ? '#ffd47a'
                                            : r2Phase === 'EATING' ? '#b9ffcf'
                                                : '#eaf4ff';
        }
        const r2Lv = document.getElementById('fs-r2-live');
        if (r2Lv) r2Lv.textContent = `${liveRecCount} / ${liveSpeedCount}`;
        const r2Co = document.getElementById('fs-r2-altpos');
        if (r2Co) r2Co.textContent = tDropCoords ? `${tDropCoords.x}, ${tDropCoords.y}` : '—';

        const r2Aw = document.getElementById('fs-r2-altwin');
        if (r2Aw) {
            const open = altWindow && !altWindow.closed;
            r2Aw.textContent = open ? 'open' : 'closed';
            r2Aw.style.color = open ? '#b9ffcf' : '#ffb4b4';
        }
        const r2As = document.getElementById('fs-r2-altsock');
        if (r2As) {
            r2As.textContent = altWs ? 'connected' : '—';
            r2As.style.color = altWs ? '#b9ffcf' : '#7c97b8';
        }

        const r2Btn = document.getElementById('fs-r2-toggle');
        if (r2Btn) r2Btn.classList.toggle('fs-toggle-btn--on', enabled && role === ROLES.AUTO_R2);

        // xp
        const xPh = document.getElementById('fs-xp-phase');
        if (xPh) {
            xPh.textContent = role === ROLES.XP ? (enabled ? xpPhase : 'OFF') : '(inactive)';
            xPh.style.color = !enabled || role !== ROLES.XP ? '#7c97b8'
                : xpPhase === 'ACTIVE' ? '#7fc7ff'
                    : xpPhase === 'DONE' ? '#b9ffcf'
                        : '#eaf4ff';
        }
        const xMa = document.getElementById('fs-xp-curmass');
        if (xMa) xMa.textContent = xpCurrentMass;
        const xPo = document.getElementById('fs-xp-pos');
        if (xPo) xPo.textContent = xpCurrentPos ? `${xpCurrentPos.x}, ${xpCurrentPos.y}` : '—';
        const xBc = document.getElementById('fs-xp-bc');
        if (xBc) xBc.textContent = (role === ROLES.XP && enabled) ? 'broadcasting' : 'silent';

        const xBtn = document.getElementById('fs-xp-toggle');
        if (xBtn) xBtn.classList.toggle('fs-toggle-btn--on', enabled && role === ROLES.XP);

        // top-left badge
        const badge = document.getElementById('fs-status-badge');
        if (badge) {
            const altOpen = altWindow && !altWindow.closed;
            const readyToTransfer = enabled
                && role === ROLES.AUTO_R2
                && tState === T_STATE.IDLE
                && !altOpen
                && liveRecCount >= config.recWanted
                && liveSpeedCount >= config.speedWanted;
            if (readyToTransfer) {
                badge.textContent = 'READY — OPEN ALT TAB';
                badge.classList.remove('fs-status-badge--on');
                badge.classList.add('fs-status-badge--ready');
                // throttled desktop notification every 10s
                const now = Date.now();
                if (now - lastReadyNotif > 10000) {
                    lastReadyNotif = now;
                    showReadyNotification();
                }
            } else {
                const label = role === ROLES.NONE ? 'NO ROLE'
                    : `${ROLE_LABELS[role]}: ${enabled ? 'ON' : 'OFF'}`;
                badge.textContent = label;
                badge.classList.remove('fs-status-badge--ready');
                badge.classList.toggle('fs-status-badge--on', enabled);
            }
        }
    }

    setInterval(updateUI, 1000);

    // ===========================================================================
    // ROLE TOGGLE DISPATCH
    // ===========================================================================
    function toggleActiveRole(on) {
        if (role === ROLES.FEEDER) feederToggle(on);
        else if (role === ROLES.AUTO_R2) r2Toggle(on);
        else if (role === ROLES.XP) xpToggle(on);
        else { /* no role selected */ }
    }

    // ===========================================================================
    // HOTKEY HANDLER
    // ===========================================================================
    function isTypingFocus() {
        const ae = document.activeElement;
        if (!ae) return false;
        const tag = ae.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable;
    }
    unsafeWindow.addEventListener('keyup', e => {
        if (isTypingFocus()) return;
        const k = (e.key || '').toLowerCase();
        if (role === ROLES.FEEDER && k === config.feederKey.toLowerCase()) toggleActiveRole(!enabled);
        else if (role === ROLES.AUTO_R2 && k === config.r2Key.toLowerCase()) toggleActiveRole(!enabled);
        else if (role === ROLES.XP && k === config.xpKey.toLowerCase()) toggleActiveRole(!enabled);
    });

    // ===========================================================================
    // BOOT
    // ===========================================================================
    if (document.body) buildUI();
    else document.addEventListener('DOMContentLoaded', buildUI);

})();