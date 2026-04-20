// ==UserScript==
// @name         Nuts.gg Auto-Vault Utility (Floaty UI)
// @namespace    Nuts Auto-Vault Utility
// @version      1.0
// @description  Automatically moves a percentage of your play-balance profits into the vault on nuts.gg. Piggybacks on the site's existing GraphQL WebSocket — no extra auth required.
// @author       inspired by Ruby from StakeStats
// @match        https://nuts.gg/*
// @match        https://*.nuts.gg/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // === Constants ===
    const UNIT = 1_000_000_000; // 1 SOL = 1,000,000,000 lamports
    const MIN_BALANCE_CHECKS = 2;
    const RATE_LIMIT_MAX = 50;
    const RATE_LIMIT_WINDOW = 60 * 60 * 1000;
    const WS_URL_MATCH = 'nuts.tools/graphql';

    // === Config ===
    function loadConfig() {
        try {
            const saved = localStorage.getItem('nuts-autovault-config');
            if (saved) return { ...defaults(), ...JSON.parse(saved) };
        } catch (e) {}
        return defaults();
    }
    function defaults() {
        return {
            saveAmount: 0.1,
            bigWinThreshold: 5,
            bigWinMultiplier: 3,
            checkInterval: 90000,
            minDepositSol: 0.001
        };
    }
    function saveConfig() {
        localStorage.setItem('nuts-autovault-config', JSON.stringify(config));
    }

    let config = loadConfig();
    let SAVE_AMOUNT = config.saveAmount;
    let BIG_WIN_THRESHOLD = config.bigWinThreshold;
    let BIG_WIN_MULTIPLIER = config.bigWinMultiplier;
    let CHECK_INTERVAL = config.checkInterval;
    let MIN_DEPOSIT_SOL = config.minDepositSol;

    // === Activity log ===
    const activityLog = [];
    const MAX_LOG_ENTRIES = 50;
    let onLogUpdate = null;

    function logActivity(message, type = 'info') {
        const entry = { time: new Date(), message, type };
        activityLog.unshift(entry);
        if (activityLog.length > MAX_LOG_ENTRIES) activityLog.pop();
        console.log('[NutsAutoVault]', message);
        if (onLogUpdate) onLogUpdate(entry);
    }
    const log = (...args) => logActivity(args.join(' '), 'info');

    const FLAVOR = {
        profit: ['Positive difference,', 'Profit detected'],
        bigWin: ['Big win detected', 'Large profit'],
        start: ['AutoVault started', 'Monitoring active'],
        stop: ['AutoVault stopped', 'Monitoring paused'],
        rateLimit: ['Rate limited, vaulting paused', 'Limit reached, vaulting paused']
    };
    const pickFlavor = arr => arr[Math.floor(Math.random() * arr.length)];

    // === WebSocket hook — patches prototype.send so it catches sockets opened before this script ===
    let nutsSocket = null;
    let socketAuthenticated = false;
    const attachedSockets = new WeakSet();

    function onIncoming(raw) {
        try {
            const msg = JSON.parse(raw);
            // Any incoming response implies the socket is authenticated
            if (msg.type === 'connection_ack' || msg.type === 'next' || msg.type === 'data') {
                if (!socketAuthenticated) {
                    socketAuthenticated = true;
                    log('Socket authenticated with nuts.tools');
                }
            }
            if (msg.type === 'next' && msg.payload?.data) handleSubscriptionPayload(msg);
        } catch {}
    }

    function attachToSocket(ws) {
        if (!ws || attachedSockets.has(ws)) return;
        attachedSockets.add(ws);
        nutsSocket = ws;
        ws.addEventListener('message', (evt) => onIncoming(evt.data));
        ws.addEventListener('close', () => {
            if (nutsSocket === ws) { nutsSocket = null; socketAuthenticated = false; }
        });
        ws.addEventListener('error', () => {});
        log('Hooked nuts.tools socket (readyState=' + ws.readyState + ')');
    }

    try {
        const OriginalSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function(data) {
            try {
                if (this && typeof this.url === 'string' && this.url.includes(WS_URL_MATCH)) {
                    attachToSocket(this);
                }
            } catch (e) {}
            return OriginalSend.apply(this, arguments);
        };
    } catch (e) {
        console.error('[NutsAutoVault] Failed to patch WebSocket.prototype.send:', e);
    }

    // Also hook the constructor so we catch fresh sockets earlier
    try {
        const OriginalWebSocket = window.WebSocket;
        function HookedWebSocket(url, protocols) {
            const ws = protocols !== undefined ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
            try { if (String(url).includes(WS_URL_MATCH)) attachToSocket(ws); } catch {}
            return ws;
        }
        HookedWebSocket.prototype = OriginalWebSocket.prototype;
        HookedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
        HookedWebSocket.OPEN = OriginalWebSocket.OPEN;
        HookedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
        HookedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
        window.WebSocket = HookedWebSocket;
    } catch (e) {}

    // === State ===
    let playBalance = null;
    let vaultBalance = null;
    let oldBalance = null;
    let lastBalance = null;
    let isInitialized = false;
    let balanceChecks = 0;
    let isProcessing = false;
    let running = false;
    let vaultInterval = null;
    let pendingMutation = null;
    let uiWidget = null;
    let vaultedThisSession = 0;

    function handleSubscriptionPayload(msg) {
        const d = msg.payload.data;
        if (!d) return;
        if ('balance' in d && d.balance && d.balance.after !== undefined) {
            playBalance = Number(d.balance.after);
            if (playBalance > 0 && oldBalance === null) oldBalance = playBalance;
            if (!isInitialized && ++balanceChecks >= MIN_BALANCE_CHECKS && playBalance > 0) {
                isInitialized = true;
                oldBalance = playBalance;
                log(`Initial balance: ${unitToSol(playBalance).toFixed(6)} SOL`);
            }
            if (uiWidget) uiWidget.render();
        }
        if ('vaultBalance' in d && d.vaultBalance && d.vaultBalance.after !== undefined) {
            vaultBalance = Number(d.vaultBalance.after);
            if (uiWidget) uiWidget.render();
        }
        if ('depositToVault' in d && pendingMutation && msg.id === pendingMutation.id) {
            pendingMutation.resolve(msg);
            pendingMutation = null;
        }
    }

    // === Deposit mutation ===
    function sendVaultDeposit(amountUnits) {
        return new Promise((resolve, reject) => {
            if (!nutsSocket || nutsSocket.readyState !== 1 || !socketAuthenticated) {
                return reject(new Error('Nuts socket not ready'));
            }
            const id = uuid();
            const payload = {
                id,
                type: 'subscribe',
                payload: {
                    query: 'mutation depositToVault($amount: Float!) {\n  depositToVault(amount: $amount)\n}',
                    operationName: 'depositToVault',
                    variables: { amount: Math.floor(amountUnits) }
                }
            };
            const timeout = setTimeout(() => {
                if (pendingMutation && pendingMutation.id === id) {
                    pendingMutation = null;
                    reject(new Error('Deposit timed out'));
                }
            }, 15000);
            pendingMutation = {
                id,
                resolve: (msg) => { clearTimeout(timeout); resolve(msg); },
                reject
            };
            try {
                nutsSocket.send(JSON.stringify(payload));
            } catch (e) {
                clearTimeout(timeout);
                pendingMutation = null;
                reject(e);
            }
        });
    }

    function uuid() {
        if (crypto?.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
    }

    const unitToSol = u => (Number(u) || 0) / UNIT;
    const solToUnit = s => Math.floor(Number(s) * UNIT);

    function findBalanceContainer() {
        const titled = document.querySelectorAll('div[title$=" SOL"]');
        for (const el of titled) {
            if (/^[\d.,]+\s+SOL$/.test((el.getAttribute('title') || '').trim())) return el;
        }
        return null;
    }
    function detectDisplayCurrency() {
        const bal = findBalanceContainer();
        if (!bal) return 'SOL';
        if (bal.querySelector('span[title*="$"]')) return 'USD';
        return (bal.textContent || '').trim().startsWith('$') ? 'USD' : 'SOL';
    }
    function getSolToUsdRate() {
        const bal = findBalanceContainer();
        if (!bal) return null;
        const innerSpan = bal.querySelector('span[title*="$"][title*="SOL"]');
        const t = innerSpan ? (innerSpan.getAttribute('title') || '') : '';
        const m = t.match(/\$\s*([\d,]+\.?\d*)\s*\(([\d,]+\.?\d*)\s*SOL\)/);
        if (m) {
            const usd = parseFloat(m[1].replace(/,/g, ''));
            const sol = parseFloat(m[2].replace(/,/g, ''));
            if (sol > 0 && isFinite(usd) && isFinite(sol)) return usd / sol;
        }
        return null;
    }
    function formatBalanceForDisplay(units) {
        if (units === null || units === undefined) return '—';
        const sol = unitToSol(units);
        if (detectDisplayCurrency() === 'USD') {
            const rate = getSolToUsdRate();
            if (rate !== null) return `$${(sol * rate).toFixed(2)}`;
        }
        return `${sol.toFixed(6)} SOL`;
    }
    function formatSolAmountForDisplay(solAmount) {
        if (detectDisplayCurrency() === 'USD') {
            const rate = getSolToUsdRate();
            if (rate !== null) return `$${(solAmount * rate).toFixed(2)}`;
        }
        return `${solAmount.toFixed(6)} SOL`;
    }

    // === Rate limiting ===
    function loadRateLimitData() {
        try {
            const saved = sessionStorage.getItem('nuts-autovault-ratelimit');
            if (saved) {
                const data = JSON.parse(saved);
                return data.filter(ts => Date.now() - ts < RATE_LIMIT_WINDOW);
            }
        } catch {}
        return [];
    }
    function saveRateLimitData(ts) {
        sessionStorage.setItem('nuts-autovault-ratelimit', JSON.stringify(ts));
    }
    let vaultActionTimestamps = loadRateLimitData();
    function canVaultNow() {
        const now = Date.now();
        vaultActionTimestamps = vaultActionTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);
        saveRateLimitData(vaultActionTimestamps);
        return vaultActionTimestamps.length < RATE_LIMIT_MAX;
    }
    function getVaultCountLastHour() {
        const now = Date.now();
        vaultActionTimestamps = vaultActionTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);
        return vaultActionTimestamps.length;
    }

    // === Floaty UI ===
    let currentViewMode = 'full';

    function createUI() {
        if (document.getElementById('nuts-autovault-floaty')) {
            document.getElementById('nuts-autovault-floaty').remove();
        }
        if (document.getElementById('nuts-autovault-stealth')) {
            document.getElementById('nuts-autovault-stealth').remove();
        }

        const style = document.createElement('style');
        style.id = 'nuts-autovault-styles';
        style.textContent = `
        #nuts-autovault-floaty {
            background: #1a1a2a;
            color: #d0d0e0;
            border: 1px solid #3a3a4a;
            border-radius: 10px;
            box-shadow: 0 6px 20px rgba(0,0,0,0.5);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 13px;
            min-width: 250px;
            max-width: 290px;
            user-select: none;
            position: fixed;
            top: 90px;
            right: 20px;
            z-index: 999999;
            display: flex;
            flex-direction: column;
        }
        #nuts-autovault-floaty.hidden { display: none; }
        #nuts-autovault-floaty .nv-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: linear-gradient(135deg, #2a2a3a, #1e1e2e);
            padding: 8px 12px;
            border-radius: 10px 10px 0 0;
            border-bottom: 1px solid #3a3a4a;
            cursor: grab;
        }
        #nuts-autovault-floaty .nv-header:active { cursor: grabbing; }
        #nuts-autovault-floaty .nv-title {
            display: flex;
            align-items: center;
            gap: 6px;
            font-weight: 700;
            font-size: 12px;
            color: #bb86fc;
            letter-spacing: 0.3px;
        }
        #nuts-autovault-floaty .nv-dot {
            width: 7px; height: 7px; border-radius: 50%; background: #4a5568;
        }
        #nuts-autovault-floaty .nv-dot.running { background: #03dac6; }
        #nuts-autovault-floaty .nv-dot.socket-bad { background: #ff0266; }
        #nuts-autovault-floaty .nv-header-btns { display: flex; gap: 2px; }
        #nuts-autovault-floaty .nv-header-btn {
            background: none; border: none; color: #7a7a8a; cursor: pointer;
            padding: 4px 6px; border-radius: 4px; font-size: 14px; line-height: 1;
        }
        #nuts-autovault-floaty .nv-header-btn:hover { color: #fff; background: #3a3a4a; }
        #nuts-autovault-floaty .nv-content { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
        #nuts-autovault-floaty .nv-row {
            display: flex; align-items: center; justify-content: space-between;
        }
        #nuts-autovault-floaty .nv-label { color: #a0a0b0; font-size: 12px; }
        #nuts-autovault-floaty input[type="number"] {
            background: #0f0f1a; color: #e0e0f0; border: 1px solid #4a4a5a;
            border-radius: 4px; padding: 4px 6px; font-size: 12px; width: 72px;
            text-align: right;
        }
        #nuts-autovault-floaty input[type="number"]:focus { outline: none; border-color: #bb86fc; }
        #nuts-autovault-floaty .nv-btn-row { display: flex; gap: 6px; margin-top: 4px; }
        #nuts-autovault-floaty .nv-btn {
            flex: 1; background: #2a2a3a; color: #d0d0e0; border: 1px solid #3a3a4a;
            border-radius: 4px; padding: 6px 10px; font-size: 11px; font-weight: 600;
            cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px;
        }
        #nuts-autovault-floaty .nv-btn:hover:not(:disabled) { background: #3a3a4a; color: #fff; }
        #nuts-autovault-floaty .nv-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        #nuts-autovault-floaty .nv-btn.primary { background: linear-gradient(135deg, #bb86fc, #8e63c4); border-color: #bb86fc; color: #fff; }
        #nuts-autovault-floaty .nv-btn.danger { background: linear-gradient(135deg, #ff0266, #c2185b); border-color: #ff0266; color: #fff; }
        #nuts-autovault-floaty .nv-stats {
            display: flex; justify-content: space-between; gap: 6px;
            padding-top: 8px; border-top: 1px solid #3a3a4a; font-size: 11px;
        }
        #nuts-autovault-floaty .nv-stat { display: flex; flex-direction: column; gap: 2px; }
        #nuts-autovault-floaty .nv-stat-label { color: #7a7a8a; font-size: 10px; text-transform: uppercase; }
        #nuts-autovault-floaty .nv-stat-value { color: #bb86fc; font-weight: 700; }
        #nuts-autovault-floaty .nv-log-toggle {
            display: flex; align-items: center; justify-content: space-between;
            padding: 6px 12px; background: #1e1e2e; border-top: 1px solid #3a3a4a;
            cursor: pointer;
        }
        #nuts-autovault-floaty .nv-log-toggle:hover { background: #24243a; }
        #nuts-autovault-floaty .nv-log-toggle-text { font-size: 10px; color: #7a7a8a; text-transform: uppercase; }
        #nuts-autovault-floaty .nv-log-toggle-icon { font-size: 10px; color: #7a7a8a; transition: transform 0.2s; }
        #nuts-autovault-floaty .nv-log-toggle.open .nv-log-toggle-icon { transform: rotate(180deg); }
        #nuts-autovault-floaty .nv-log {
            max-height: 0; overflow: hidden; transition: max-height 0.25s ease-out; background: #0f0f1a;
        }
        #nuts-autovault-floaty .nv-log.open { max-height: 130px; }
        #nuts-autovault-floaty .nv-log-inner {
            padding: 8px; max-height: 130px; overflow-y: auto;
            font-family: 'Menlo', 'Monaco', 'Consolas', monospace; font-size: 10px; line-height: 1.4;
        }
        #nuts-autovault-floaty .nv-log-entry { padding: 2px 0; color: #7a7a8a; display: flex; gap: 6px; }
        #nuts-autovault-floaty .nv-log-entry.success,
        #nuts-autovault-floaty .nv-log-entry.profit { color: #03dac6; }
        #nuts-autovault-floaty .nv-log-entry.bigwin { color: #fbbf24; }
        #nuts-autovault-floaty .nv-log-entry.warning { color: #f59e0b; }
        #nuts-autovault-floaty .nv-log-entry.error { color: #ff0266; }
        #nuts-autovault-floaty .nv-log-time { color: #4a4a5a; flex-shrink: 0; }
        #nuts-autovault-floaty .nv-log-empty {
            color: #4a4a5a; font-style: italic; text-align: center; padding: 8px;
        }
        #nuts-autovault-floaty.mini { min-width: auto; max-width: none; border-radius: 20px; }
        #nuts-autovault-floaty.mini .nv-header { border-radius: 20px; padding: 6px 12px; border-bottom: none; }
        #nuts-autovault-floaty.mini .nv-content,
        #nuts-autovault-floaty.mini .nv-log-toggle,
        #nuts-autovault-floaty.mini .nv-log { display: none; }
        #nuts-autovault-floaty.mini .nv-title span { display: none; }
        #nuts-autovault-stealth {
            position: fixed; bottom: 10px; right: 10px; width: 9px; height: 9px;
            border-radius: 50%; background: #4a5568; cursor: pointer; z-index: 999999;
            box-shadow: 0 1px 3px rgba(0,0,0,0.4);
        }
        #nuts-autovault-stealth.running { background: #03dac6; }
        #nuts-autovault-stealth.hidden { display: none; }
        @media (max-width: 500px) {
            #nuts-autovault-floaty { right: 10px !important; left: 10px !important; max-width: none; min-width: auto; }
        }
        `;
        document.head.appendChild(style);

        const widget = document.createElement('div');
        widget.id = 'nuts-autovault-floaty';

        const stealthDot = document.createElement('div');
        stealthDot.id = 'nuts-autovault-stealth';
        stealthDot.className = 'hidden';
        stealthDot.title = 'Nuts AutoVault (click to expand)';
        document.body.appendChild(stealthDot);

        const header = document.createElement('div');
        header.className = 'nv-header';
        header.innerHTML = `
            <div class="nv-title">
                <div class="nv-dot" id="nvStatusDot"></div>
                <span>Nuts AutoVault</span>
            </div>
            <div class="nv-header-btns">
                <button class="nv-header-btn" id="nvMinBtn" title="Minimize">−</button>
                <button class="nv-header-btn" id="nvStealthBtn" title="Stealth">○</button>
                <button class="nv-header-btn" id="nvCloseBtn" title="Close">×</button>
            </div>
        `;
        widget.appendChild(header);

        const content = document.createElement('div');
        content.className = 'nv-content';
        content.innerHTML = `
            <div class="nv-row">
                <span class="nv-label">Save % of profit</span>
                <input type="number" id="nvSavePct" min="0" max="1" step="0.01" value="${SAVE_AMOUNT}">
            </div>
            <div class="nv-row">
                <span class="nv-label">Big-win threshold (×)</span>
                <input type="number" id="nvBigWin" min="1" step="0.1" value="${BIG_WIN_THRESHOLD}">
            </div>
            <div class="nv-row">
                <span class="nv-label">Big-win multiplier</span>
                <input type="number" id="nvBigMult" min="1" step="0.1" value="${BIG_WIN_MULTIPLIER}">
            </div>
            <div class="nv-row">
                <span class="nv-label">Check interval (s)</span>
                <input type="number" id="nvCheck" min="10" step="1" value="${Math.round(CHECK_INTERVAL/1000)}">
            </div>
            <div class="nv-row">
                <span class="nv-label">Min deposit (SOL)</span>
                <input type="number" id="nvMinDep" min="0" step="0.0001" value="${MIN_DEPOSIT_SOL}">
            </div>
            <div class="nv-btn-row">
                <button class="nv-btn primary" id="nvStart">Start</button>
                <button class="nv-btn danger" id="nvStop" disabled>Stop</button>
            </div>
            <div class="nv-stats">
                <div class="nv-stat"><span class="nv-stat-label">Balance</span><span class="nv-stat-value" id="nvBal">—</span></div>
                <div class="nv-stat"><span class="nv-stat-label">Vault</span><span class="nv-stat-value" id="nvVault">—</span></div>
                <div class="nv-stat"><span class="nv-stat-label">Actions/hr</span><span class="nv-stat-value" id="nvCount">0/${RATE_LIMIT_MAX}</span></div>
            </div>
        `;
        widget.appendChild(content);

        const logToggle = document.createElement('div');
        logToggle.className = 'nv-log-toggle';
        logToggle.innerHTML = `<span class="nv-log-toggle-text">Activity</span><span class="nv-log-toggle-icon">▼</span>`;
        widget.appendChild(logToggle);

        const logPanel = document.createElement('div');
        logPanel.className = 'nv-log';
        logPanel.innerHTML = `<div class="nv-log-inner" id="nvLogInner"><div class="nv-log-empty">No activity yet...</div></div>`;
        widget.appendChild(logPanel);
        const logInner = logPanel.querySelector('#nvLogInner');

        logToggle.onclick = () => { logToggle.classList.toggle('open'); logPanel.classList.toggle('open'); };

        const fmt = (d) => [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
        onLogUpdate = (entry) => {
            const empty = logInner.querySelector('.nv-log-empty');
            if (empty) empty.remove();
            const div = document.createElement('div');
            div.className = `nv-log-entry ${entry.type}`;
            div.innerHTML = `<span class="nv-log-time">${fmt(entry.time)}</span><span></span>`;
            div.lastChild.textContent = entry.message;
            logInner.insertBefore(div, logInner.firstChild);
            while (logInner.children.length > 25) logInner.removeChild(logInner.lastChild);
        };

        const statusDot = widget.querySelector('#nvStatusDot');
        const balEl = content.querySelector('#nvBal');
        const vaultEl = content.querySelector('#nvVault');
        const countEl = content.querySelector('#nvCount');
        const startBtn = content.querySelector('#nvStart');
        const stopBtn = content.querySelector('#nvStop');
        const minBtn = widget.querySelector('#nvMinBtn');
        const stealthBtn = widget.querySelector('#nvStealthBtn');
        const closeBtn = widget.querySelector('#nvCloseBtn');

        function setViewMode(mode) {
            currentViewMode = mode;
            widget.classList.toggle('mini', mode === 'mini');
            widget.classList.toggle('hidden', mode === 'stealth');
            stealthDot.classList.toggle('hidden', mode !== 'stealth');
        }
        minBtn.onclick = (e) => {
            e.stopPropagation();
            setViewMode(currentViewMode === 'mini' ? 'full' : 'mini');
            minBtn.textContent = currentViewMode === 'mini' ? '+' : '−';
        };
        stealthBtn.onclick = (e) => { e.stopPropagation(); setViewMode('stealth'); };
        stealthDot.onclick = () => { setViewMode('full'); minBtn.textContent = '−'; };
        closeBtn.onclick = () => { widget.remove(); stealthDot.remove(); };

        // Drag
        let isDragging = false, dx = 0, dy = 0;
        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('.nv-header-btns')) return;
            isDragging = true;
            const rect = widget.getBoundingClientRect();
            dx = e.clientX - rect.left; dy = e.clientY - rect.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            let nl = e.clientX - dx, nt = e.clientY - dy;
            nl = Math.max(0, Math.min(window.innerWidth - widget.offsetWidth, nl));
            nt = Math.max(0, Math.min(window.innerHeight - widget.offsetHeight, nt));
            widget.style.left = nl + 'px'; widget.style.top = nt + 'px'; widget.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { isDragging = false; });

        // Parameter bindings
        content.querySelector('#nvSavePct').onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 0) v = 0;
            if (v > 1) v = 1;
            SAVE_AMOUNT = config.saveAmount = v;
            this.value = v; saveConfig();
        };
        content.querySelector('#nvBigWin').onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 1) v = 1;
            BIG_WIN_THRESHOLD = config.bigWinThreshold = v;
            this.value = v; saveConfig();
        };
        content.querySelector('#nvBigMult').onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 1) v = 1;
            BIG_WIN_MULTIPLIER = config.bigWinMultiplier = v;
            this.value = v; saveConfig();
        };
        content.querySelector('#nvCheck').onchange = function() {
            let v = parseInt(this.value, 10);
            if (isNaN(v) || v < 10) v = 10;
            CHECK_INTERVAL = v * 1000; config.checkInterval = CHECK_INTERVAL;
            this.value = v; saveConfig();
            if (running) { stopVault(); startVault(); }
        };
        content.querySelector('#nvMinDep').onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 0) v = 0;
            MIN_DEPOSIT_SOL = config.minDepositSol = v;
            this.value = v; saveConfig();
        };

        startBtn.onclick = () => { startVault(); };
        stopBtn.onclick = () => { stopVault(); };

        function render() {
            balEl.textContent = formatBalanceForDisplay(playBalance);
            vaultEl.textContent = formatBalanceForDisplay(vaultBalance);
            const c = getVaultCountLastHour();
            countEl.textContent = `${c}/${RATE_LIMIT_MAX}`;
            countEl.style.color = c >= RATE_LIMIT_MAX ? '#ff0266' : c >= RATE_LIMIT_MAX*0.8 ? '#f59e0b' : '#03dac6';
            statusDot.classList.toggle('running', running);
            statusDot.classList.toggle('socket-bad', !socketAuthenticated);
            stealthDot.classList.toggle('running', running);
            startBtn.disabled = running;
            stopBtn.disabled = !running;
        }
        setInterval(render, 3000);
        document.body.appendChild(widget);
        return { render };
    }

    // === Vault logic ===
    async function processDeposit(amountUnits, isBigWin) {
        if (amountUnits < solToUnit(MIN_DEPOSIT_SOL) || isProcessing) return;
        if (!canVaultNow()) {
            logActivity(`${pickFlavor(FLAVOR.rateLimit)} — rate limit reached`, 'warning');
            return;
        }
        if (!socketAuthenticated) {
            logActivity('Socket not authenticated — waiting', 'warning');
            return;
        }
        isProcessing = true;
        const pct = (SAVE_AMOUNT * (isBigWin ? BIG_WIN_MULTIPLIER : 1) * 100).toFixed(0);
        const flavor = pickFlavor(isBigWin ? FLAVOR.bigWin : FLAVOR.profit);
        logActivity(`${flavor} vaulting ${pct}%: ${formatSolAmountForDisplay(unitToSol(amountUnits))}`, isBigWin ? 'bigwin' : 'profit');
        try {
            const resp = await sendVaultDeposit(amountUnits);
            isProcessing = false;
            // depositToVault returns null on success; vaultBalance subscription auto-updates
            vaultedThisSession += amountUnits;
            vaultActionTimestamps.push(Date.now());
            saveRateLimitData(vaultActionTimestamps);
            oldBalance = playBalance;
            logActivity(`Secured ${formatSolAmountForDisplay(unitToSol(amountUnits))}`, 'success');
            if (uiWidget) uiWidget.render();
        } catch (e) {
            isProcessing = false;
            logActivity(`Vault error: ${e.message}`, 'error');
        }
    }

    function checkBalanceChanges() {
        if (playBalance === null || !isInitialized) return;
        if (oldBalance === null) { oldBalance = playBalance; return; }
        if (playBalance > oldBalance) {
            const profit = playBalance - oldBalance;
            const ratio = oldBalance > 0 ? playBalance / oldBalance : 1;
            const isBig = ratio >= BIG_WIN_THRESHOLD;
            const dep = Math.floor(profit * SAVE_AMOUNT * (isBig ? BIG_WIN_MULTIPLIER : 1));
            if (dep > 0) processDeposit(dep, isBig);
            oldBalance = playBalance;
        } else if (playBalance < oldBalance) {
            oldBalance = playBalance;
        }
        lastBalance = playBalance;
        if (uiWidget) uiWidget.render();
    }

    function startVault() {
        if (running) return;
        running = true;
        logActivity(pickFlavor(FLAVOR.start), 'success');
        oldBalance = playBalance;
        isProcessing = false;
        vaultedThisSession = 0;
        vaultInterval = setInterval(checkBalanceChanges, CHECK_INTERVAL);
        if (uiWidget) uiWidget.render();
    }
    function stopVault() {
        if (!running) return;
        running = false;
        if (vaultInterval) clearInterval(vaultInterval);
        vaultInterval = null;
        logActivity(pickFlavor(FLAVOR.stop), 'info');
        if (uiWidget) uiWidget.render();
    }

    // === Init ===
    function onDomReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn);
        } else {
            fn();
        }
    }

    onDomReady(() => {
        setTimeout(() => {
            if (!uiWidget) uiWidget = createUI();
        }, 2000);
    });

})();
