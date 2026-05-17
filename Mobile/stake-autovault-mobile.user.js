// ==UserScript==
// @name         Stake Auto-Vault Utility (Mobile Userscripts)
// @version      1.02
// @description  Mobile Userscripts counterpart for Stake Auto-Vault — compact overlay, touch drag, safe-area aware. Automatically sends a percentage of profits to the vault on stake.com, its mirror sites, and stake.us.
// @author       Ruby, curtesy of StakeStats
// @website      https://stakestats.net/
// @homepage     https://feli.fyi/
// @match        https://stake.com/*
// @match        https://stake.bet/*
// @match        https://stake.games/*
// @match        https://staketr.com/*
// @match        https://staketr2.com/*
// @match        https://staketr3.com/*
// @match        https://staketr4.com/*
// @match        https://stake.bz/*
// @match        https://stake.us/*
// @match        https://stake.pet/*
// @grant        none
// @inject-into  page
// @run-at       document-end
// @namespace    Stake Auto-Vault Utility
// ==/UserScript==

(function() {
    'use strict';

    // --- Config ---
    const INIT_DELAY = 2000;
    const DEFAULT_CURRENCY = 'bnb';
    const DEFAULT_US_CURRENCY = 'sc';
    const MIN_BALANCE_CHECKS = 2;
    const DEPOSIT_VAULT_PERCENTAGE = 0.2;
    const CURRENCY_CACHE_TIMEOUT = 5000;
    const BALANCE_INIT_RETRIES = 5;
    const RATE_LIMIT_MAX = 50;
    const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour

    // Load config from localStorage or use defaults
    function loadConfig() {
        const saved = localStorage.getItem('autovault-config');
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                log('Failed to load saved config:', e);
            }
        }
        return {
            saveAmount: 0.1,
            bigWinThreshold: 5,
            bigWinMultiplier: 3,
            checkInterval: 90000
        };
    }

    function saveConfig(config) {
        localStorage.setItem('autovault-config', JSON.stringify(config));
    }

    let config = loadConfig();
    let SAVE_AMOUNT = config.saveAmount;
    let BIG_WIN_THRESHOLD = config.bigWinThreshold;
    let BIG_WIN_MULTIPLIER = config.bigWinMultiplier;
    let CHECK_INTERVAL = config.checkInterval;

    // --- Site detection ---
    const hostname = window.location.hostname;
    const isStakeUS = hostname.endsWith('.us');
    let isScriptInitialized = false;

    // --- Activity Log ---
    const activityLog = [];
    const MAX_LOG_ENTRIES = 50;
    let onLogUpdate = null;

    function logActivity(message, type = 'info') {
        const entry = {
            time: new Date(),
            message,
            type
        };
        activityLog.unshift(entry);
        if (activityLog.length > MAX_LOG_ENTRIES) activityLog.pop();
        console.log('[AutoVault]', message);
        if (onLogUpdate) onLogUpdate(entry);
    }
    const log = (...args) => logActivity(args.join(' '), 'info');

    // --- Flavor Text ---
    const FLAVOR = {
        profit: [
            "Positive difference,",
            "Profit detected"
        ],
        bigWin: [
            "Big win detected",
            "Large profit"
        ],
        deposit: [
            "Deposit detected",
        ],
        start: [
            "AutoVault started",
            "Monitoring active"
        ],
        stop: [
            "AutoVault stopped",
            "Monitoring paused"
        ],
        rateLimit: [
            "Rate limited, vaulting paused. Please wait until it resets",
            "Limit reached, vaulting paused. Please wait until it resets"
        ]
    };
    const pickFlavor = (arr) => arr[Math.floor(Math.random() * arr.length)];

    // --- Cookie helper ---
    const getCookie = (name) => {
        const m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
        return m ? m.pop().replace(/"/g, '') : '';
    };

    // --- Balance selectors ---
    const BALANCE_SELECTORS = [
        '[data-testid="coin-toggle"] .content span[data-ds-text="true"]',
        '[data-testid="balance-toggle"] .content span[data-ds-text="true"]',
        '[data-testid="coin-toggle"] .content span',
        '[data-testid="balance-toggle"] span.content span',
        '[data-testid="user-balance"] .numeric',
        '.numeric.variant-highlighted',
        '[data-testid="user-balance"]',
        '.balance-value'
    ];

    // --- Stake API ---
    class StakeApi {
        constructor() {
            this.apiUrl = window.location.origin + '/_api/graphql';
            this._accessToken = getCookie("session");
            this.headers = {
                'content-type': 'application/json',
                'x-access-token': this._accessToken,
                'x-language': 'en'
            };
        }
        async call(body, opName) {
            const headers = {...this.headers};
            if (opName) headers['x-operation-name'] = opName;
            try {
                const res = await fetch(this.apiUrl, {
                    credentials: 'include',
                    headers,
                    referrer: window.location.origin,
                    body: body,
                    method: 'POST',
                    mode: 'cors',
                    cache: 'no-cache'
                });
                if (!res.ok) {
                    log(`API call failed with status ${res.status}: ${res.statusText}`);
                    return { error: true, status: res.status, message: res.statusText };
                }
                return res.json();
            } catch (e) {
                log('API call failed:', e);
                return { error: true, message: e.message, type: 'network' };
            }
        }
        async getBalances() {
            const q = {
                query: `query UserBalances {
                    user { id balances {
                        available { amount currency }
                        vault { amount currency }
                    }}}`,
                variables: {}
            };
            return this.call(JSON.stringify(q), 'UserBalances');
        }
        async depositToVault(currency, amount) {
            const q = {
                query: `mutation CreateVaultDeposit($currency: CurrencyEnum!, $amount: Float!) {
                    createVaultDeposit(currency: $currency, amount: $amount) {
                        id amount currency user {
                            id balances {
                                available { amount currency }
                                vault { amount currency }
                            }
                        }
                        __typename
                    }
                }`,
                variables: { currency, amount }
            };
            return this.call(JSON.stringify(q), 'CreateVaultDeposit');
        }
    }

    // --- Vault Display UI ---
    class VaultDisplay {
        constructor() {
            this._el = document.createElement("span");
            this._el.id = "vaultDisplayElement";
            this._vaulted = 0;
            this._currency = getCurrency();
            this._load();
            this.render();
        }
        _storageKey() {
            const c = (this._currency || getCurrency() || '').toLowerCase();
            return `autovault-vaulted-session:${c}`;
        }
        _load() {
            try {
                const raw = sessionStorage.getItem(this._storageKey());
                const v = parseFloat(raw);
                if (!isNaN(v) && v >= 0) this._vaulted = v;
            } catch (e) {}
        }
        _save() {
            try {
                sessionStorage.setItem(this._storageKey(), String(this._vaulted));
            } catch (e) {}
        }
        setCurrency(currency) {
            this._currency = (currency || getCurrency() || '').toLowerCase();
            this._load();
            this.render();
        }
        render() {
            if (!this._el) return;
            this._el.innerText = (this._vaulted || 0).toFixed(8);
        }
        update(amount) {
            const add = +amount;
            if (isNaN(add) || add <= 0) return;
            this._vaulted = (this._vaulted || 0) + add;
            this._save();
            this.render();
        }
        reset() {
            this._vaulted = 0;
            this._save();
            this.render();
        }
    }

    // --- Currency detection ---
    function parseStakeAmount(text) {
        if (!text) return NaN;
        const raw = String(text).replace(/\u00a0/g, ' ').trim();
        if (!raw) return NaN;
        if (/[•*]+/.test(raw)) return NaN;

        const m = raw.match(/[-+]?\d[\d\s,.'’]*(?:[.,]\d+)?[kmbt]?/i);
        if (!m) return NaN;

        let token = m[0].trim();
        const suffixMatch = token.match(/[kmbt]$/i);
        const suffix = suffixMatch ? suffixMatch[0].toLowerCase() : '';
        token = token.replace(/[kmbt]$/i, '').trim();

        token = token.replace(/[\s'’]/g, '');

        const hasDot = token.includes('.');
        const hasComma = token.includes(',');
        if (hasDot && hasComma) {
            if (token.lastIndexOf('.') > token.lastIndexOf(',')) {
                token = token.replace(/,/g, '');
            } else {
                token = token.replace(/\./g, '').replace(/,/g, '.');
            }
        } else if (hasComma && !hasDot) {
            const parts = token.split(',');
            if (parts.length === 2 && parts[1].length <= 2) token = `${parts[0]}.${parts[1]}`;
            else token = token.replace(/,/g, '');
        } else {
            token = token.replace(/,/g, '');
        }

        const n = parseFloat(token);
        if (isNaN(n)) return NaN;

        const mult =
            suffix === 'k' ? 1e3 :
            suffix === 'm' ? 1e6 :
            suffix === 'b' ? 1e9 :
            suffix === 't' ? 1e12 :
            1;

        return n * mult;
    }

    function detectCurrencyFromBalanceBar() {
        const el =
            document.querySelector('[data-testid="coin-toggle"]') ||
            document.querySelector('[data-testid="balance-toggle"]');
        if (!el) return null;
        const txt = (el.textContent || '').trim();
        const m = txt.match(/\b[A-Z]{2,5}\b/);
        return m ? m[0].toLowerCase() : null;
    }

    function getCurrency() {
        const now = Date.now();
        if (getCurrency.cached && getCurrency.cacheTime && (now - getCurrency.cacheTime < CURRENCY_CACHE_TIMEOUT)) {
            return getCurrency.cached;
        }
        const el = document.querySelector('[data-active-currency]');
        if (el) {
            const c = el.getAttribute('data-active-currency');
            if (c) {
                getCurrency.cached = c.toLowerCase();
                getCurrency.cacheTime = now;
                return getCurrency.cached;
            }
        }
        const fromBar = detectCurrencyFromBalanceBar();
        if (fromBar) {
            getCurrency.cached = fromBar;
            getCurrency.cacheTime = now;
            return getCurrency.cached;
        }
        const defaultCurr = isStakeUS ? DEFAULT_US_CURRENCY : DEFAULT_CURRENCY;
        getCurrency.cached = defaultCurr;
        getCurrency.cacheTime = now;
        return defaultCurr;
    }

    // --- Get balance from UI ---
    function getCurrentBalance() {
        const curCode = (activeCurrency || getCurrency() || '').toLowerCase();
        const uiCode = (detectCurrencyFromBalanceBar() || '').toLowerCase();
        if (curCode && uiCode && uiCode !== curCode) {
            const apiVal = getCurrentBalance._api?.[curCode];
            if (typeof apiVal === 'number' && apiVal >= 0) return apiVal;
        }
        for (const selector of BALANCE_SELECTORS) {
            try {
                const el = document.querySelector(selector);
                if (el) {
                    const val = parseStakeAmount(el.textContent);
                    if (!isNaN(val) && val >= 0) {
                        if (!getCurrentBalance._workingSelector || getCurrentBalance._workingSelector !== selector) {
                            getCurrentBalance._workingSelector = selector;
                            log(`Balance detected using selector: ${selector}`);
                        }
                        getCurrentBalance.lastKnownBalance = val;
                        return val;
                    }
                }
            } catch (e) {}
        }
        if (curCode) {
            const apiVal = getCurrentBalance._api?.[curCode];
            if (typeof apiVal === 'number' && apiVal >= 0) return apiVal;
        }
        if (!getCurrentBalance._warned) {
            getCurrentBalance._warned = true;
            log('Could not detect balance with any known selector. Please check if Stake updated their UI.');
        }
        return getCurrentBalance.lastKnownBalance || 0;
    }

    // --- Vault Rate Limit Tracking ---
    function loadRateLimitData() {
        const saved = sessionStorage.getItem('autovault-ratelimit');
        if (saved) {
            try {
                const data = JSON.parse(saved);
                return data.filter(ts => Date.now() - ts < RATE_LIMIT_WINDOW);
            } catch (e) {
                log('Failed to load rate limit data:', e);
            }
        }
        return [];
    }

    function saveRateLimitData(timestamps) {
        sessionStorage.setItem('autovault-ratelimit', JSON.stringify(timestamps));
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

    // --- Mobile Floaty UI Widget ---
    // View modes: 'full', 'mini', 'stealth'
    let currentViewMode = 'full';

    function addStyle(cssText) {
        const style = document.createElement('style');
        style.id = 'autovault-styles';
        style.textContent = cssText;
        (document.head || document.documentElement).appendChild(style);
        return style;
    }

    function createVaultFloatyUI(startCallback, stopCallback, getParams, setParams, vaultDisplay) {
        if (document.getElementById('autovault-floaty')) {
            document.getElementById('autovault-floaty').remove();
        }
        if (document.getElementById('autovault-stealth')) {
            document.getElementById('autovault-stealth').remove();
        }

        addStyle(`
        /* === FULL PANEL === */
        #autovault-floaty {
            background: #0f212e;
            color: #b1bad3;
            border: 1px solid #2f4553;
            border-radius: 10px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 14px;
            width: min(300px, calc(100vw - 20px));
            max-width: calc(100vw - 20px);
            user-select: none;
            -webkit-user-select: none;
            position: fixed;
            bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);
            right: 10px;
            z-index: 999999;
            display: flex;
            flex-direction: column;
            transition: opacity 0.2s, transform 0.2s;
        }
        #autovault-floaty.hidden { display: none; }
        #autovault-floaty .av-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: #1a2c38;
            padding: 10px 12px;
            border-radius: 10px 10px 0 0;
            border-bottom: 1px solid #2f4553;
            touch-action: none;
        }
        #autovault-floaty .av-title {
            display: flex;
            align-items: center;
            gap: 6px;
            font-weight: 600;
            font-size: 13px;
            color: #fff;
            letter-spacing: 0.3px;
        }
        #autovault-floaty .av-status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #4a5568;
        }
        #autovault-floaty .av-status-dot.running { background: #10b981; }
        #autovault-floaty .av-header-btns {
            display: flex;
            gap: 4px;
        }
        #autovault-floaty .av-header-btn {
            background: none;
            border: none;
            color: #94a3b8;
            cursor: pointer;
            padding: 6px 8px;
            min-width: 32px;
            min-height: 32px;
            border-radius: 6px;
            font-size: 16px;
            line-height: 1;
            transition: color 0.15s, background 0.15s;
            -webkit-tap-highlight-color: rgba(255,255,255,0.1);
        }
        #autovault-floaty .av-header-btn:active {
            color: #fff;
            background: #2f4553;
        }
        #autovault-floaty .av-content {
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        #autovault-floaty .av-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }
        #autovault-floaty .av-label {
            color: #94a3b8;
            font-size: 13px;
        }
        #autovault-floaty input[type="number"] {
            background: #1a2c38;
            color: #e2e8f0;
            border: 1px solid #2f4553;
            border-radius: 6px;
            padding: 8px 10px;
            font-size: 14px;
            width: 80px;
            text-align: right;
            transition: border-color 0.15s;
            -webkit-appearance: none;
            appearance: none;
            min-height: 36px;
        }
        #autovault-floaty input[type="number"]:focus {
            outline: none;
            border-color: #3b82f6;
        }
        #autovault-floaty .av-btn-row {
            display: flex;
            gap: 8px;
            margin-top: 4px;
        }
        #autovault-floaty .av-btn {
            flex: 1;
            background: #1a2c38;
            color: #b1bad3;
            border: 1px solid #2f4553;
            border-radius: 6px;
            padding: 10px 12px;
            font-size: 12px;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.15s;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            min-height: 40px;
            -webkit-tap-highlight-color: transparent;
        }
        #autovault-floaty .av-btn:active:not(:disabled) {
            transform: scale(0.97);
        }
        #autovault-floaty .av-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }
        #autovault-floaty .av-btn.primary {
            background: #10b981;
            border-color: #10b981;
            color: #fff;
        }
        #autovault-floaty .av-btn.danger {
            background: #ef4444;
            border-color: #ef4444;
            color: #fff;
        }
        #autovault-floaty .av-stats {
            display: flex;
            justify-content: space-between;
            padding-top: 10px;
            border-top: 1px solid #2f4553;
            font-size: 12px;
        }
        #autovault-floaty .av-stat {
            display: flex;
            flex-direction: column;
            gap: 3px;
        }
        #autovault-floaty .av-stat-label {
            color: #64748b;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        #autovault-floaty .av-stat-value {
            color: #10b981;
            font-weight: 600;
            font-size: 13px;
        }
        #autovault-floaty .av-footer {
            display: flex;
            justify-content: center;
            padding: 6px;
            border-top: 1px solid #2f4553;
        }
        #autovault-floaty .av-link {
            color: #64748b;
            font-size: 10px;
            text-decoration: none;
        }

        /* === LOG PANEL === */
        #autovault-floaty .av-log-toggle {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 12px;
            background: #1a2c38;
            border-top: 1px solid #2f4553;
            cursor: pointer;
            transition: background 0.15s;
            min-height: 38px;
            -webkit-tap-highlight-color: transparent;
        }
        #autovault-floaty .av-log-toggle:active { background: #243442; }
        #autovault-floaty .av-log-toggle-text {
            font-size: 11px;
            color: #94a3b8;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            font-weight: 600;
        }
        #autovault-floaty .av-log-toggle-icon {
            font-size: 11px;
            color: #64748b;
            transition: transform 0.2s;
        }
        #autovault-floaty .av-log-toggle.open .av-log-toggle-icon {
            transform: rotate(180deg);
        }
        #autovault-floaty .av-log {
            max-height: 0;
            overflow: hidden;
            transition: max-height 0.25s ease-out;
            background: #0a1a24;
        }
        #autovault-floaty .av-log.open {
            max-height: 160px;
        }
        #autovault-floaty .av-log-inner {
            padding: 8px 10px;
            max-height: 160px;
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
            font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
            font-size: 10px;
            line-height: 1.5;
        }
        #autovault-floaty .av-log-entry {
            padding: 2px 0;
            color: #64748b;
            display: flex;
            gap: 6px;
        }
        #autovault-floaty .av-log-entry.success { color: #10b981; }
        #autovault-floaty .av-log-entry.profit { color: #10b981; }
        #autovault-floaty .av-log-entry.bigwin { color: #fbbf24; }
        #autovault-floaty .av-log-entry.warning { color: #f59e0b; }
        #autovault-floaty .av-log-entry.error { color: #ef4444; }
        #autovault-floaty .av-log-time {
            color: #475569;
            flex-shrink: 0;
        }
        #autovault-floaty .av-log-empty {
            color: #475569;
            font-style: italic;
            text-align: center;
            padding: 8px;
        }

        /* === MINI MODE === */
        #autovault-floaty.mini {
            width: auto;
            border-radius: 22px;
        }
        #autovault-floaty.mini .av-header {
            border-radius: 22px;
            padding: 8px 14px;
            border-bottom: none;
        }
        #autovault-floaty.mini .av-content,
        #autovault-floaty.mini .av-log-toggle,
        #autovault-floaty.mini .av-log,
        #autovault-floaty.mini .av-footer { display: none; }
        #autovault-floaty.mini .av-title span { display: none; }

        /* === STEALTH MODE === */
        #autovault-stealth {
            position: fixed;
            bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);
            right: 12px;
            width: 14px;
            height: 14px;
            border-radius: 50%;
            background: #4a5568;
            cursor: pointer;
            z-index: 999999;
            box-shadow: 0 2px 6px rgba(0,0,0,0.4);
            -webkit-tap-highlight-color: transparent;
        }
        #autovault-stealth:active {
            transform: scale(1.3);
        }
        #autovault-stealth.running { background: #10b981; }
        #autovault-stealth.hidden { display: none; }
        `);

        const widget = document.createElement('div');
        widget.id = 'autovault-floaty';

        const stealthDot = document.createElement('div');
        stealthDot.id = 'autovault-stealth';
        stealthDot.className = 'hidden';
        stealthDot.title = 'AutoVault (tap to expand)';
        document.body.appendChild(stealthDot);

        const header = document.createElement('div');
        header.className = 'av-header';
        header.setAttribute('data-drag-handle', 'true');
        header.innerHTML = `
            <div class="av-title">
                <div class="av-status-dot" id="avStatusDot"></div>
                <span>AutoVault</span>
            </div>
            <div class="av-header-btns">
                <button class="av-header-btn" id="avMinBtn" title="Minimize">−</button>
                <button class="av-header-btn" id="avStealthBtn" title="Stealth">○</button>
                <button class="av-header-btn" id="avCloseBtn" title="Close">×</button>
            </div>
        `;
        widget.appendChild(header);

        const content = document.createElement('div');
        content.className = 'av-content';
        content.innerHTML = `
            <div class="av-row">
                <span class="av-label">Save %</span>
                <input type="number" id="vaultSaveAmount" min="0" max="1" step="0.01" value="${getParams().saveAmount}" inputmode="decimal">
            </div>
            <div class="av-row">
                <span class="av-label">Big Win Threshold</span>
                <input type="number" id="vaultBigWinThreshold" min="1" step="0.1" value="${getParams().bigWinThreshold}" inputmode="decimal">
            </div>
            <div class="av-row">
                <span class="av-label">Big Win Multiplier</span>
                <input type="number" id="vaultBigWinMultiplier" min="1" step="0.1" value="${getParams().bigWinMultiplier}" inputmode="decimal">
            </div>
            <div class="av-row">
                <span class="av-label">Check Interval (sec)</span>
                <input type="number" id="vaultCheckInterval" min="10" step="1" value="${getParams().checkInterval}" inputmode="numeric">
            </div>
            <div class="av-btn-row">
                <button class="av-btn primary" id="vaultStartBtn">Start</button>
                <button class="av-btn danger" id="vaultStopBtn" disabled>Stop</button>
            </div>
            <div class="av-stats">
                <div class="av-stat">
                    <span class="av-stat-label">Vaulted</span>
                    <span class="av-stat-value" id="avVaultBal">0.00</span>
                </div>
                <div class="av-stat">
                    <span class="av-stat-label">Actions/hr</span>
                    <span class="av-stat-value" id="avVaultCount">0/50</span>
                </div>
            </div>
        `;
        widget.appendChild(content);

        const logToggle = document.createElement('div');
        logToggle.className = 'av-log-toggle';
        logToggle.innerHTML = `
            <span class="av-log-toggle-text">Activity Log</span>
            <span class="av-log-toggle-icon">▼</span>
        `;
        widget.appendChild(logToggle);

        const logPanel = document.createElement('div');
        logPanel.className = 'av-log';
        logPanel.innerHTML = `<div class="av-log-inner" id="avLogInner"><div class="av-log-empty">No activity yet...</div></div>`;
        widget.appendChild(logPanel);

        const logInner = logPanel.querySelector('#avLogInner');

        logToggle.onclick = () => {
            logToggle.classList.toggle('open');
            logPanel.classList.toggle('open');
        };

        const formatTime = (date) => {
            const h = date.getHours().toString().padStart(2, '0');
            const m = date.getMinutes().toString().padStart(2, '0');
            const s = date.getSeconds().toString().padStart(2, '0');
            return `${h}:${m}:${s}`;
        };

        function addLogEntry(entry) {
            const empty = logInner.querySelector('.av-log-empty');
            if (empty) empty.remove();

            const div = document.createElement('div');
            div.className = `av-log-entry ${entry.type}`;
            div.innerHTML = `<span class="av-log-time">${formatTime(entry.time)}</span><span>${entry.message}</span>`;
            logInner.insertBefore(div, logInner.firstChild);

            while (logInner.children.length > 20) {
                logInner.removeChild(logInner.lastChild);
            }
        }

        onLogUpdate = addLogEntry;

        const footer = document.createElement('div');
        footer.className = 'av-footer';
        footer.innerHTML = `<a href="https://stakestats.net/" target="_blank" class="av-link">stakestats.net</a>`;
        widget.appendChild(footer);

        const vaultBalEl = content.querySelector('#avVaultBal');
        vaultDisplay._el = vaultBalEl;
        vaultDisplay.render();

        const statusDot = widget.querySelector('#avStatusDot');
        const minBtn = widget.querySelector('#avMinBtn');
        const stealthBtn = widget.querySelector('#avStealthBtn');
        const closeBtn = widget.querySelector('#avCloseBtn');

        function setViewMode(mode) {
            currentViewMode = mode;
            if (mode === 'full') {
                widget.classList.remove('mini', 'hidden');
                stealthDot.classList.add('hidden');
            } else if (mode === 'mini') {
                widget.classList.add('mini');
                widget.classList.remove('hidden');
                stealthDot.classList.add('hidden');
            } else if (mode === 'stealth') {
                widget.classList.add('hidden');
                stealthDot.classList.remove('hidden');
            }
        }

        minBtn.onclick = (e) => {
            e.stopPropagation();
            setViewMode(currentViewMode === 'mini' ? 'full' : 'mini');
            minBtn.textContent = currentViewMode === 'mini' ? '+' : '−';
            minBtn.title = currentViewMode === 'mini' ? 'Expand' : 'Minimize';
        };

        stealthBtn.onclick = (e) => {
            e.stopPropagation();
            setViewMode('stealth');
        };

        stealthDot.onclick = () => {
            setViewMode('full');
            minBtn.textContent = '−';
        };

        closeBtn.onclick = () => {
            widget.remove();
            stealthDot.remove();
        };

        // Drag logic (touch + mouse)
        let isDragging = false, currentX = 0, currentY = 0, initialX = 0, initialY = 0;
        let hasDragged = false;
        const isHandle = (target) => {
            if (target.closest('.av-header-btns')) return false;
            return Boolean(target.closest('[data-drag-handle="true"]'));
        };
        const startDrag = (clientX, clientY) => {
            const rect = widget.getBoundingClientRect();
            if (!widget.style.left) {
                currentX = rect.left;
                currentY = rect.top;
            }
            initialX = clientX - currentX;
            initialY = clientY - currentY;
            isDragging = true;
            hasDragged = false;
        };
        const dragMove = (clientX, clientY) => {
            let newX = clientX - initialX;
            let newY = clientY - initialY;
            newX = Math.max(0, Math.min(window.innerWidth - widget.offsetWidth, newX));
            newY = Math.max(0, Math.min(window.innerHeight - widget.offsetHeight, newY));
            currentX = newX;
            currentY = newY;
            widget.style.left = newX + 'px';
            widget.style.top = newY + 'px';
            widget.style.right = 'auto';
            widget.style.bottom = 'auto';
            hasDragged = true;
        };
        header.addEventListener('mousedown', (e) => {
            if (!isHandle(e.target)) return;
            startDrag(e.clientX, e.clientY);
            e.preventDefault();
        });
        header.addEventListener('touchstart', (e) => {
            if (!isHandle(e.target)) return;
            const touch = e.touches[0];
            if (!touch) return;
            startDrag(touch.clientX, touch.clientY);
            e.preventDefault();
        }, { passive: false });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            dragMove(e.clientX, e.clientY);
        });
        document.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            const touch = e.touches[0];
            if (!touch) return;
            dragMove(touch.clientX, touch.clientY);
            e.preventDefault();
        }, { passive: false });
        const endDrag = () => { isDragging = false; };
        document.addEventListener('mouseup', endDrag);
        document.addEventListener('touchend', endDrag, { passive: true });

        const startBtn = content.querySelector('#vaultStartBtn');
        const stopBtn = content.querySelector('#vaultStopBtn');
        const vaultCountEl = content.querySelector('#avVaultCount');

        function updateVaultCountUI() {
            const count = getVaultCountLastHour();
            vaultCountEl.textContent = `${count}/50`;
            vaultCountEl.style.color = count >= 50 ? '#ef4444' : count >= 40 ? '#f59e0b' : '#10b981';
        }
        window.__updateVaultCountUI = updateVaultCountUI;
        updateVaultCountUI();
        setInterval(updateVaultCountUI, 10000);

        function setRunningState(isRunning) {
            statusDot.classList.toggle('running', isRunning);
            stealthDot.classList.toggle('running', isRunning);
            startBtn.disabled = isRunning;
            stopBtn.disabled = !isRunning;
        }

        startBtn.onclick = () => {
            setRunningState(true);
            startCallback();
            updateVaultCountUI();
        };
        stopBtn.onclick = () => {
            setRunningState(false);
            stopCallback();
            updateVaultCountUI();
        };

        content.querySelector('#vaultSaveAmount').onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 0) v = 0;
            if (v > 1) v = 1;
            setParams({saveAmount: v});
            this.value = v;
        };
        content.querySelector('#vaultBigWinThreshold').onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 1) v = 1;
            setParams({bigWinThreshold: v});
            this.value = v;
        };
        content.querySelector('#vaultBigWinMultiplier').onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 1) v = 1;
            setParams({bigWinMultiplier: v});
            this.value = v;
        };
        content.querySelector('#vaultCheckInterval').onchange = function() {
            let v = parseInt(this.value, 10);
            if (isNaN(v) || v < 10) v = 10;
            setParams({checkInterval: v});
            this.value = v;
        };

        document.body.appendChild(widget);

        return {
            setStatus: (txt, color) => {},
            setRunning: setRunningState,
            updateVaultCount: updateVaultCountUI
        };
    }

    // --- Main logic ---
    let vaultInterval = null;
    let vaultDisplay = null;
    let stakeApi = null;
    let activeCurrency = null;
    let apiBalanceInterval = null;
    let oldBalance = 0;
    let isProcessing = false;
    let isInitialized = false;
    let balanceChecks = 0;
    let lastDepositDetected = 0;
    let lastDepositAmount = 0;
    let lastBalance = 0;
    let lastVaultedDeposit = 0;
    let running = false;
    let uiWidget = null;

    async function refreshApiBalance() {
        try {
            if (!stakeApi) stakeApi = new StakeApi();
            const cur = (activeCurrency || getCurrency() || '').toLowerCase();
            if (!cur) return;
            const resp = await stakeApi.getBalances();
            const balances = resp?.data?.user?.balances;
            if (!Array.isArray(balances)) return;
            const bal = balances.find(x => x?.available?.currency?.toLowerCase() === cur);
            const amt = bal?.available?.amount;
            const n = typeof amt === 'number' ? amt : parseFloat(amt);
            if (isNaN(n) || n < 0) return;
            if (!getCurrentBalance._api) getCurrentBalance._api = {};
            getCurrentBalance._api[cur] = n;
        } catch (e) {}
    }

    function startApiBalancePolling() {
        if (apiBalanceInterval) clearInterval(apiBalanceInterval);
        apiBalanceInterval = setInterval(refreshApiBalance, 5000);
        refreshApiBalance();
    }

    function stopApiBalancePolling() {
        if (apiBalanceInterval) clearInterval(apiBalanceInterval);
        apiBalanceInterval = null;
    }

    function getParams() {
        return {
            saveAmount: SAVE_AMOUNT,
            bigWinThreshold: BIG_WIN_THRESHOLD,
            bigWinMultiplier: BIG_WIN_MULTIPLIER,
            checkInterval: Math.round(CHECK_INTERVAL/1000)
        };
    }
    function setParams(obj) {
        if (obj.saveAmount !== undefined) SAVE_AMOUNT = obj.saveAmount;
        if (obj.bigWinThreshold !== undefined) BIG_WIN_THRESHOLD = obj.bigWinThreshold;
        if (obj.bigWinMultiplier !== undefined) BIG_WIN_MULTIPLIER = obj.bigWinMultiplier;
        if (obj.checkInterval !== undefined) CHECK_INTERVAL = obj.checkInterval * 1000;

        config = {
            saveAmount: SAVE_AMOUNT,
            bigWinThreshold: BIG_WIN_THRESHOLD,
            bigWinMultiplier: BIG_WIN_MULTIPLIER,
            checkInterval: CHECK_INTERVAL
        };
        saveConfig(config);

        if (running) {
            stopVaultScript();
            startVaultScript();
        }
    }

    function checkCurrencyChange() {
        getCurrency.cached = null;
        getCurrency.cacheTime = null;
        const newCurrency = getCurrency();
        if (newCurrency !== activeCurrency) {
            log(`Currency changed: ${activeCurrency} → ${newCurrency}`);
            activeCurrency = newCurrency;
            startApiBalancePolling();
            vaultDisplay.setCurrency(activeCurrency);
            vaultDisplay.reset();
            isInitialized = false;
            balanceChecks = 0;
            updateCurrentBalance();
            return true;
        }
        return false;
    }

    function updateCurrentBalance() {
        const cur = getCurrentBalance();
        if (cur > 0) {
            oldBalance = cur;
            if (!isInitialized && balanceChecks++ >= MIN_BALANCE_CHECKS) {
                isInitialized = true;
                log(`Initial balance: ${oldBalance.toFixed(8)} ${activeCurrency}`);
            }
        }
    }

    async function processDeposit(amount, isBigWin) {
        if (amount < 1e-8 || isProcessing) return;
        if (!canVaultNow()) {
            logActivity(`${pickFlavor(FLAVOR.rateLimit)} - Rate limit reached`, 'warning');
            if (uiWidget && typeof uiWidget.updateVaultCount === "function") uiWidget.updateVaultCount();
            return;
        }
        isProcessing = true;
        const pct = (SAVE_AMOUNT * (isBigWin ? BIG_WIN_MULTIPLIER : 1) * 100).toFixed(0);
        const flavor = pickFlavor(isBigWin ? FLAVOR.bigWin : FLAVOR.profit);
        logActivity(`${flavor} Vaulting ${pct}%: ${amount.toFixed(6)} ${activeCurrency.toUpperCase()}`, isBigWin ? 'bigwin' : 'profit');
        try {
            const resp = await stakeApi.depositToVault(activeCurrency, amount);
            isProcessing = false;
            if (resp && resp.data && resp.data.createVaultDeposit) {
                vaultDisplay.update(amount);
                vaultActionTimestamps.push(Date.now());
                saveRateLimitData(vaultActionTimestamps);
                oldBalance = getCurrentBalance();
                if (uiWidget && typeof uiWidget.updateVaultCount === "function") uiWidget.updateVaultCount();
                logActivity(`Secured ${amount.toFixed(6)} ${activeCurrency.toUpperCase()}`, 'success');
            } else {
                logActivity('Vault failed - may be rate limited', 'error');
            }
        } catch (e) {
            isProcessing = false;
            logActivity('Vault error: ' + (e.message || 'unknown'), 'error');
        }
    }

    function initializeBalance() {
        updateCurrentBalance();
        let tries = 0;
        const intv = setInterval(() => {
            updateCurrentBalance();
            if (++tries >= BALANCE_INIT_RETRIES) {
                clearInterval(intv);
                if (oldBalance > 0) {
                    isInitialized = true;
                    log(`Initialized with starting balance: ${oldBalance.toFixed(8)} ${activeCurrency}`);
                } else {
                    log(`Unable to detect starting balance! Using current balance.`);
                    const cur = getCurrentBalance();
                    if (cur > 0) {
                        oldBalance = cur;
                        isInitialized = true;
                        log(`Last attempt balance: ${oldBalance.toFixed(8)} ${activeCurrency}`);
                    }
                }
            }
        }, 1000);
    }

    function detectDepositEvent() {
        let found = false;
        let depositAmount = 0;
        const possibleSelectors = [
            '[data-testid*="notification"]',
            '[class*="notification"]',
            '[class*="transaction"]',
            '[class*="history"]',
            '[class*="activity"]'
        ];
        for (const sel of possibleSelectors) {
            const nodes = document.querySelectorAll(sel);
            for (const node of nodes) {
                const txt = (node.textContent || '');
                const lower = txt.toLowerCase();
                if (lower.includes('deposit') && /\d/.test(lower)) {
                    const amt = parseStakeAmount(txt);
                    if (!isNaN(amt) && amt > 0) {
                        depositAmount = amt;
                        found = true;
                        break;
                    }
                }
            }
            if (found) break;
        }
        if (found) {
            lastDepositDetected = Date.now();
            lastDepositAmount = depositAmount;
            return depositAmount;
        }
        return 0;
    }

    function checkBalanceChanges() {
        if (checkCurrencyChange()) return;
        const cur = getCurrentBalance();
        if (!isInitialized) return updateCurrentBalance();

        let depositAmt = detectDepositEvent();
        if (depositAmt > 0) {
            if (cur - lastBalance >= depositAmt * 0.95 && lastVaultedDeposit !== depositAmt) {
                const toVault = depositAmt * SAVE_AMOUNT;
                logActivity(`${pickFlavor(FLAVOR.deposit)} +${depositAmt.toFixed(4)} ${activeCurrency.toUpperCase()}`, 'info');
                processDeposit(toVault, false);
                lastVaultedDeposit = depositAmt;
                oldBalance = cur;
            }
        } else if (cur > oldBalance) {
            const profit = cur - oldBalance;
            const isBig = cur > oldBalance * BIG_WIN_THRESHOLD;
            const depAmt = profit * SAVE_AMOUNT * (isBig ? BIG_WIN_MULTIPLIER : 1);
            processDeposit(depAmt, isBig);
            oldBalance = cur;
        } else if (cur < oldBalance) {
            oldBalance = cur;
        }
        lastBalance = cur;
        if (uiWidget && typeof uiWidget.updateVaultCount === "function") uiWidget.updateVaultCount();
    }

    function startVaultScript() {
        if (running) return;
        isScriptInitialized = true;
        running = true;
        logActivity(pickFlavor(FLAVOR.start), 'success');
        logActivity(`Watching ${getCurrency().toUpperCase()} on ${isStakeUS ? 'Stake.us' : 'Stake.com'}`, 'info');
        if (!vaultDisplay) vaultDisplay = new VaultDisplay();
        stakeApi = new StakeApi();
        activeCurrency = getCurrency();
        startApiBalancePolling();
        vaultDisplay.setCurrency(activeCurrency);
        vaultDisplay.reset();
        oldBalance = 0;
        isProcessing = false;
        isInitialized = false;
        balanceChecks = 0;
        lastDepositDetected = 0;
        lastDepositAmount = 0;
        lastBalance = getCurrentBalance();
        lastVaultedDeposit = 0;
        vaultActionTimestamps = [];
        initializeBalance();
        vaultInterval = setInterval(checkBalanceChanges, CHECK_INTERVAL);
        if (uiWidget) {
            uiWidget.setStatus('Running', '#00c4a7');
            uiWidget.setRunning(true);
            if (typeof uiWidget.updateVaultCount === "function") uiWidget.updateVaultCount();
        }
    }
    function stopVaultScript() {
        if (!running) return;
        running = false;
        isScriptInitialized = false;
        if (vaultInterval) clearInterval(vaultInterval);
        vaultInterval = null;
        stopApiBalancePolling();
        if (vaultDisplay) vaultDisplay.reset();
        if (uiWidget) {
            uiWidget.setStatus('Stopped', '#fff');
            uiWidget.setRunning(false);
            if (typeof uiWidget.updateVaultCount === "function") uiWidget.updateVaultCount();
        }
        logActivity(pickFlavor(FLAVOR.stop), 'info');
    }

    // --- UI Widget setup ---
    setTimeout(() => {
        if (window.__autovaultMobileLoaded) return;
        window.__autovaultMobileLoaded = true;
        if (!uiWidget) {
            if (!vaultDisplay) vaultDisplay = new VaultDisplay();
            uiWidget = createVaultFloatyUI(
                startVaultScript,
                stopVaultScript,
                getParams,
                setParams,
                vaultDisplay
            );
            vaultDisplay.setCurrency(getCurrency());
        }
    }, INIT_DELAY);

})();
