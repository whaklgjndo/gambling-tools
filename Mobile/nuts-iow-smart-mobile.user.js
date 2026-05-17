// ==UserScript==
// @name         IOW / Smart - Nuts (Mobile Userscripts)
// @namespace    http://tampermonkey.net/
// @version      3.5.1
// @description  Userscripts-app mobile counterpart for Nuts dice/target with Manual / IOW / Smart modes, compact controls, and stats.
// @author       .
// @match        https://nuts.gg/target*
// @match        https://nuts.gg/dice*
// @match        https://*.nuts.gg/target*
// @match        https://*.nuts.gg/dice*
// @grant        none
// @inject-into  page
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_ID = 'iow-smart-nuts-mobile-userscripts';
    const MOBILE_BREAKPOINT = 980;
    const RAPID_INTERVAL_MS = 180;
    const HEALTH_CHECK_MS = 500;
    const MAX_HISTORY_POINTS = 5000;
    const MONEY_DIGITS = 8;

    const state = {
        activeMode: 'manual',
        isRapidFiring: false,
        rapidTimer: null,
        healthTimer: null,
        lastObservedBetTime: 0,
        rapidStartedAt: 0,
        rapidBlockedSince: 0,
        lastBetId: null,
        observer: null,

        initialBalance: 0,
        lastKnownBalance: 0,
        sessionPeak: 0,
        highestProfit: 0,
        totalWagered: 0,
        totalWins: 0,
        totalLosses: 0,
        totalBets: 0,
        currentProfit: 0,

        curWinStreak: 0,
        curLossStreak: 0,
        maxWinStreak: 0,
        maxLossStreak: 0,
        topWinStreaks: [],
        topLossStreaks: [],
        lastResult: null,

        profitHistory: [0],

        baseBet: 0.00000001,
        winIncreasePercent: 125,
        lossStreakReset: 3,
        winsBeforeReset: 5,
        autoStopBalance: null,

        iowWinCounter: 0,
        iowLossCounter: 0,

        aggressionLevel: 1.0,
        lockAggressionState: false,
        lockedGearLevel: 1,

        stopLossPct: 0,
        takeProfitPct: 0,
        autoPaused: false,

        settingsOpen: false,
        statsOpen: false,

        minBaseBet: 0.00000001,
        maxBaseBet: 99999999999999,
        betHistory: [],
        recentWins: [],
        trackedMultiplier: 0,
        multGames: 0,
        multWins: 0,
        historyWindow: 30,
        safeDivisor: 300,
        aggressiveDivisor: 150,
        winsNeeded: 15,
        lastAmount: null,
        winResetPulseTimer: null
    };

    function addStyle(cssText) {
        const style = document.createElement('style');
        style.textContent = cssText;
        (document.head || document.documentElement).appendChild(style);
        return style;
    }

    addStyle(`
        #${SCRIPT_ID},
        #${SCRIPT_ID} * {
            box-sizing: border-box !important;
        }

        #${SCRIPT_ID} {
            position: relative !important;
            width: 100% !important;
            margin: 8px 0 !important;
            padding: 10px !important;
            border-radius: 14px !important;
            background: linear-gradient(180deg, rgba(15,33,46,0.98), rgba(19,35,45,0.98)) !important;
            border: 1px solid rgba(82,109,130,0.45) !important;
            box-shadow: 0 10px 28px rgba(0,0,0,0.32) !important;
            color: #e2e8f0 !important;
            font-family: "Proxima Nova", "Segoe UI", sans-serif !important;
            z-index: 30 !important;
        }

        #${SCRIPT_ID} .sm-top {
            display: grid !important;
            grid-template-columns: 1fr 1fr 1fr !important;
            gap: 8px !important;
            margin-bottom: 8px !important;
        }

        #${SCRIPT_ID} .sm-mode-btn,
        #${SCRIPT_ID} .sm-action-btn,
        #${SCRIPT_ID} .sm-toggle-btn,
        #${SCRIPT_ID} .sm-small-btn {
            border: none !important;
            outline: none !important;
            cursor: pointer !important;
            border-radius: 12px !important;
            min-height: 44px !important;
            font-size: 13px !important;
            font-weight: 900 !important;
            letter-spacing: 0.2px !important;
            transition: transform 0.15s ease, filter 0.15s ease, background 0.15s ease !important;
        }

        #${SCRIPT_ID} .sm-mode-btn {
            background: #2f4553 !important;
            color: #b6c2d1 !important;
        }

        #${SCRIPT_ID} .sm-mode-btn.active {
            background: #00ff9d !important;
            color: #0f212e !important;
            box-shadow: 0 0 14px rgba(0,255,157,0.35) !important;
        }

        #${SCRIPT_ID} .sm-bar {
            display: grid !important;
            grid-template-columns: 1.15fr 1fr 1fr 1fr !important;
            gap: 8px !important;
            margin-bottom: 8px !important;
        }

        #${SCRIPT_ID} .sm-action-btn.start {
            background: #00ff9d !important;
            color: #0f212e !important;
        }

        #${SCRIPT_ID} .sm-action-btn.stop {
            background: #e11d48 !important;
            color: #ffffff !important;
        }

        #${SCRIPT_ID} .sm-action-btn.reset {
            background: transparent !important;
            color: #fda4af !important;
            border: 1px solid rgba(253,164,175,0.4) !important;
        }

        #${SCRIPT_ID} .sm-toggle-btn {
            background: #1a2c38 !important;
            color: #dbe5ef !important;
            border: 1px solid rgba(82,109,130,0.35) !important;
        }

        #${SCRIPT_ID} .sm-status {
            display: flex !important;
            align-items: center !important;
            justify-content: space-between !important;
            gap: 8px !important;
            padding: 10px 12px !important;
            border-radius: 12px !important;
            background: rgba(255,255,255,0.04) !important;
            border: 1px solid rgba(255,255,255,0.06) !important;
            margin-bottom: 8px !important;
        }

        #${SCRIPT_ID} .sm-status-main {
            min-width: 0 !important;
            font-size: 12px !important;
            font-weight: 800 !important;
            color: #f8fafc !important;
            white-space: nowrap !important;
            overflow: hidden !important;
            text-overflow: ellipsis !important;
        }

        #${SCRIPT_ID} .sm-status-side {
            flex: 0 0 auto !important;
            font-size: 11px !important;
            font-weight: 800 !important;
            color: #93c5fd !important;
        }

        #${SCRIPT_ID} .sm-drawer {
            display: none !important;
            margin-top: 8px !important;
            padding: 10px !important;
            border-radius: 12px !important;
            background: rgba(255,255,255,0.04) !important;
            border: 1px solid rgba(255,255,255,0.06) !important;
        }

        #${SCRIPT_ID} .sm-drawer.open {
            display: block !important;
        }

        #${SCRIPT_ID} .sm-section-title {
            margin: 0 0 8px 0 !important;
            font-size: 12px !important;
            font-weight: 900 !important;
            color: #e2e8f0 !important;
            text-transform: uppercase !important;
            letter-spacing: 0.4px !important;
        }

        #${SCRIPT_ID} .sm-grid {
            display: grid !important;
            grid-template-columns: 1fr 1fr !important;
            gap: 8px !important;
        }

        #${SCRIPT_ID} .sm-field {
            display: flex !important;
            flex-direction: column !important;
            gap: 5px !important;
        }

        #${SCRIPT_ID} .sm-field label {
            font-size: 10px !important;
            font-weight: 800 !important;
            color: #9fb3c8 !important;
            text-transform: uppercase !important;
            letter-spacing: 0.3px !important;
        }

        #${SCRIPT_ID} .sm-field input,
        #${SCRIPT_ID} .sm-field select {
            width: 100% !important;
            min-height: 42px !important;
            border-radius: 10px !important;
            border: 1px solid #2f4553 !important;
            background: #0b0e17 !important;
            color: #ffffff !important;
            padding: 0 12px !important;
            font-size: 14px !important;
            font-weight: 800 !important;
            outline: none !important;
        }

        #${SCRIPT_ID} .sm-inline {
            display: flex !important;
            align-items: center !important;
            gap: 8px !important;
        }

        #${SCRIPT_ID} .sm-inline input[type="checkbox"] {
            width: 16px !important;
            height: 16px !important;
            accent-color: #00ff9d !important;
        }

        #${SCRIPT_ID} .sm-stats {
            display: grid !important;
            grid-template-columns: 1fr 1fr !important;
            gap: 8px !important;
        }

        #${SCRIPT_ID} .sm-stat {
            padding: 10px !important;
            border-radius: 10px !important;
            background: rgba(255,255,255,0.04) !important;
            border: 1px solid rgba(255,255,255,0.05) !important;
        }

        #${SCRIPT_ID} .sm-stat-label {
            display: block !important;
            margin-bottom: 4px !important;
            color: #9fb3c8 !important;
            font-size: 10px !important;
            font-weight: 800 !important;
            text-transform: uppercase !important;
        }

        #${SCRIPT_ID} .sm-stat-val {
            display: block !important;
            color: #ffffff !important;
            font-size: 13px !important;
            font-weight: 900 !important;
            font-family: "Roboto Mono", monospace !important;
        }

        #${SCRIPT_ID} .sm-footer-note {
            margin-top: 8px !important;
            font-size: 10px !important;
            color: #8ea4bb !important;
            line-height: 1.35 !important;
        }

        #${SCRIPT_ID} .sm-hidden {
            display: none !important;
        }

        #${SCRIPT_ID}::after {
            content: '';
            position: absolute;
            inset: 0;
            border-radius: 14px;
            pointer-events: none;
            opacity: 0;
            border: 1px solid transparent;
            box-shadow: inset 0 0 0 0 rgba(74, 222, 128, 0), inset 0 0 0 0 rgba(74, 222, 128, 0);
        }

        #${SCRIPT_ID}.iow-win-reset-pulse::after {
            animation: iow-win-reset-pulse 720ms ease-out 1;
        }

        @keyframes iow-win-reset-pulse {
            0% { opacity: 0; }
            20% { opacity: 1; border-color: rgba(74, 222, 128, 0.9); box-shadow: inset 0 0 0 1px rgba(74, 222, 128, 0.75), inset 0 0 18px rgba(74, 222, 128, 0.35); }
            55% { opacity: 1; border-color: rgba(74, 222, 128, 0.8); box-shadow: inset 0 0 0 2px rgba(74, 222, 128, 0.85), inset 0 0 24px rgba(74, 222, 128, 0.45); }
            100% { opacity: 0; border-color: transparent; box-shadow: inset 0 0 0 0 rgba(74, 222, 128, 0), inset 0 0 0 0 rgba(74, 222, 128, 0); }
        }

        #${SCRIPT_ID} .sm-graph-container {
            margin-top: 8px !important;
            padding: 8px !important;
            border-radius: 12px !important;
            background: rgba(255,255,255,0.04) !important;
            border: 1px solid rgba(255,255,255,0.06) !important;
        }

        #${SCRIPT_ID} .sm-graph-container canvas {
            width: 100% !important;
            height: 160px !important;
            display: block !important;
        }

        @media (max-width: 480px) {
            #${SCRIPT_ID} .sm-bar {
                grid-template-columns: 1fr 1fr !important;
            }

            #${SCRIPT_ID} .sm-grid,
            #${SCRIPT_ID} .sm-stats {
                grid-template-columns: 1fr !important;
            }
        }
    `);

    function isMobileViewport() {
        return window.innerWidth <= MOBILE_BREAKPOINT || matchMedia('(pointer: coarse)').matches;
    }

    function isDice() {
        return location.pathname.toLowerCase().includes('/dice');
    }

    function getPlayButton() {
        const direct = document.querySelector('.sc-fe9b8b64-1.fmKmkj button.sc-67df7f38-0.kkdRMi')
            || document.querySelector('.sc-fe9b8b64-1 button.sc-67df7f38-0')
            || document.querySelector('button[aria-label="play"]');
        if (direct && direct.offsetParent !== null) return direct;

        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(btn => {
            const text = (btn.textContent || '').trim().toLowerCase();
            return btn.offsetParent !== null && (text.includes('play') || text.includes('roll'));
        }) || null;
    }

    function getAmountInput() {
        return document.querySelector('input[aria-label="wager"]');
    }

    function findBalanceContainer() {
        const titled = document.querySelectorAll('div[title$=" SOL"]');
        for (const el of titled) {
            if (/^[\d.,]+\s+SOL$/.test((el.getAttribute('title') || '').trim())) return el;
        }
        return document.querySelector('.sc-cfbf8337-1.eaQLvl') || document.querySelector('.sc-cfbf8337-1') || null;
    }
    function isUSDDisplayMode() {
        const bal = findBalanceContainer();
        if (!bal) return false;
        if (bal.querySelector('span[title*="$"]')) return true;
        return (bal.textContent || '').trim().startsWith('$');
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
    function displayToSol(displayVal) {
        if (!isUSDDisplayMode()) return displayVal;
        const rate = getSolToUsdRate();
        return (rate && rate > 0) ? displayVal / rate : displayVal;
    }
    function solToDisplay(solVal) {
        if (!isUSDDisplayMode()) return solVal;
        const rate = getSolToUsdRate();
        return (rate && rate > 0) ? solVal * rate : solVal;
    }

    function getCurrentBet() {
        const input = getAmountInput();
        if (input) {
            const value = parseFloat(String(input.value || '').replace(/,/g, '').replace(/[^\d.]/g, ''));
            if (Number.isFinite(value) && value > 0) return displayToSol(value);
        }
        return state.baseBet;
    }

    function setBet(amount) {
        if (!Number.isFinite(amount) || amount <= 0) return false;
        amount = Math.max(state.minBaseBet, Math.min(amount, state.maxBaseBet));

        let target;
        if (isUSDDisplayMode()) {
            const usd = solToDisplay(amount);
            const twoDp = usd.toFixed(2);
            target = (parseFloat(twoDp) === 0 && amount > 0) ? usd.toFixed(MONEY_DIGITS) : twoDp;
        } else {
            target = amount.toFixed(MONEY_DIGITS);
        }
        const input = getAmountInput();
        if (!input) return false;
        input.focus();
        try {
            input.select();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, target);
        } catch (e) {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            descriptor?.set?.call(input, target);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
        return true;
    }

    function getCurrentBalance() {
        // Always returns SOL. Outer title "X SOL" is invariant to display mode.
        const bal = findBalanceContainer();
        if (!bal) return state.lastKnownBalance || 0;
        const title = bal.getAttribute('title') || '';
        const match = title.match(/([\d.]+)/);
        if (match) {
            const value = parseFloat(match[1]);
            if (Number.isFinite(value)) {
                state.lastKnownBalance = value;
                return value;
            }
        }
        return state.lastKnownBalance || 0;
    }

    function getLatestBetEntry(container = findPastBetsContainer()) {
        if (!container) return null;
        const entries = container.querySelectorAll('.styles-module___IID9a__game');
        if (!entries.length) return null;
        const latest = entries[0];
        return { element: latest, id: `${latest.textContent?.trim() || 'bet'}:${entries.length}` };
    }

    function findPastBetsContainer() {
        return document.querySelector('.sc-9b1418e2-1') || document.querySelector('.sc-9b1418e2-0');
    }

    function isWinElement(el) {
        if (!el) return false;
        if (el.classList.contains('variant-positive') || /\bwin\b/i.test(el.className)) return true;
        return (getComputedStyle(el).backgroundColor || '').includes('40, 67, 50');
    }

    function getUserSetMultiplier() {
        if (state.activeMode !== 'smart') return 2;
        const targetInput = document.querySelector('input[aria-label="payout selector"]');
        if (targetInput) return parseFloat(targetInput.value) || 2;
        const diceInput = document.querySelector('input.sc-941e0ad-0.eaPPXw');
        if (diceInput) return parseFloat(diceInput.value) || 1.98;
        const generic = document.querySelector('input[aria-label="payout"], input[aria-label="multiplier"]');
        return generic ? parseFloat(generic.value) || 2 : 2;
    }

    function normalizeResultArrays() {
        state.topWinStreaks = state.topWinStreaks.sort((a, b) => b - a).slice(0, 10);
        state.topLossStreaks = state.topLossStreaks.sort((a, b) => b - a).slice(0, 10);
        state.profitHistory = state.profitHistory.slice(-MAX_HISTORY_POINTS);
        state.betHistory = state.betHistory.slice(-200);
        state.recentWins = state.recentWins.slice(-10);
    }

    function pushCompletedStreak(previousWasWin) {
        if (previousWasWin === true && state.curWinStreak > 0) {
            state.topWinStreaks.push(state.curWinStreak);
        }
        if (previousWasWin === false && state.curLossStreak > 0) {
            state.topLossStreaks.push(state.curLossStreak);
        }
        normalizeResultArrays();
    }

    function handleBetResult(won, betAmount) {
        state.totalBets += 1;
        state.totalWagered += betAmount || 0;

        if (won) {
            state.totalWins += 1;
            if (state.lastResult === false) pushCompletedStreak(false);
            state.curWinStreak += 1;
            state.curLossStreak = 0;
            state.maxWinStreak = Math.max(state.maxWinStreak, state.curWinStreak);
        } else {
            state.totalLosses += 1;
            if (state.lastResult === true) pushCompletedStreak(true);
            state.curLossStreak += 1;
            state.curWinStreak = 0;
            state.maxLossStreak = Math.max(state.maxLossStreak, state.curLossStreak);
        }

        state.lastResult = won;

        state.betHistory.push(won);
        if (state.betHistory.length > state.historyWindow) state.betHistory.shift();
        state.recentWins.push(won);
        if (state.recentWins.length > 10) state.recentWins.shift();
        state.multGames++;
        if (won) state.multWins++;

        const balance = getCurrentBalance();
        state.sessionPeak = Math.max(state.sessionPeak, balance);
        state.currentProfit = balance - state.initialBalance;
        state.highestProfit = Math.max(state.highestProfit, state.currentProfit);
        state.profitHistory.push(state.currentProfit);

        if (state.stopLossPct > 0 && state.currentProfit <= -(state.initialBalance * (state.stopLossPct / 100))) {
            state.autoPaused = true;
        }
        if (state.takeProfitPct > 0 && state.currentProfit >= (state.initialBalance * (state.takeProfitPct / 100))) {
            state.autoPaused = true;
        }

        if (state.activeMode === 'iow') {
            processIowAfterResult(won);
        }

        normalizeResultArrays();
        updateUI();

        if (state.autoPaused && state.isRapidFiring) {
            stopRapidFire();
        }
    }

    function processIowAfterResult(won) {
        if (won) {
            state.iowLossCounter = 0;
            state.iowWinCounter += 1;

            if (state.isRapidFiring) {
                const currentBet = getCurrentBet();
                let nextBet = currentBet * (1 + state.winIncreasePercent / 100);
                nextBet = Math.min(nextBet, state.maxBaseBet);
                setBet(nextBet);
            }

            if (state.winsBeforeReset > 0 && state.iowWinCounter >= state.winsBeforeReset) {
                state.iowWinCounter = 0;
                if (state.isRapidFiring) setBet(state.baseBet);
                triggerWinResetPulse();
            }
        } else {
            state.iowLossCounter += 1;
            state.iowWinCounter = 0;

            if (state.iowLossCounter >= state.lossStreakReset) {
                state.iowLossCounter = 0;
                if (state.isRapidFiring) setBet(state.baseBet);
            }
        }

        if (state.autoStopBalance !== null && getCurrentBalance() >= state.autoStopBalance && state.isRapidFiring) {
            stopRapidFire();
        }
    }

    function getSmartGearLabel() {
        const wins = state.betHistory.filter(Boolean).length;
        let progress = state.winsNeeded > 0 ? wins / state.winsNeeded : 0;

        let label;
        if (state.lockAggressionState) {
            switch (state.lockedGearLevel) {
                case 1: label = 'Conservative (LOCKED)'; break;
                case 2: label = 'Steady (LOCKED)'; break;
                case 3: label = 'Balanced (LOCKED)'; break;
                case 4: label = 'Press (LOCKED)'; break;
                case 5: label = 'Aggro (LOCKED)'; break;
                default: label = 'Conservative (LOCKED)';
            }
        } else {
            if (progress <= 0.4) label = 'Conservative';
            else if (progress <= 0.8) label = 'Steady';
            else if (progress <= 1.1) label = 'Balanced';
            else if (progress <= 1.45) label = 'Press';
            else label = 'Aggro';
        }
        return label;
    }

    function updateSmartBet() {
        if (state.activeMode !== 'smart') return;
        const input = getAmountInput();
        const balance = getCurrentBalance();
        if (!input || !balance) return;
        if (state.initialBalance === 0) state.initialBalance = balance;
        state.sessionPeak = Math.max(state.sessionPeak, balance);
        const currentMult = getUserSetMultiplier();
        if (currentMult !== state.trackedMultiplier) {
            state.trackedMultiplier = currentMult;
            state.multGames = 0;
            state.multWins = 0;
            state.recentWins = [];
        }
        const wins = state.betHistory.filter(Boolean).length;
        let progress = state.winsNeeded > 0 ? wins / state.winsNeeded : 0;
        if (state.lockAggressionState) {
            if (state.lockedGearLevel === 1) progress = 0.2;
            else if (state.lockedGearLevel === 2) progress = 0.6;
            else if (state.lockedGearLevel === 3) progress = 0.95;
            else if (state.lockedGearLevel === 4) progress = 1.3;
            else if (state.lockedGearLevel === 5) progress = 1.6;
        }
        const baseWindow = 30 + Math.round(state.trackedMultiplier * 8);
        const baseDivisor = 300 + Math.round(state.trackedMultiplier * 6);
        state.historyWindow = Math.max(5, Math.round(baseWindow / state.aggressionLevel));
        state.safeDivisor = Math.max(15, Math.round(baseDivisor / state.aggressionLevel));
        state.winsNeeded = Math.max(1, Math.floor(state.historyWindow / (state.trackedMultiplier * 0.8)));
        state.aggressiveDivisor = Math.max(1, Math.round(state.safeDivisor * (0.6 / state.aggressionLevel)));
        const dynamicDivisor = state.safeDivisor - ((state.safeDivisor - state.aggressiveDivisor) * Math.min(1, progress / 1.5));
        let targetBet = (state.sessionPeak / dynamicDivisor) * state.aggressionLevel;
        const maxBetPct = Math.min(0.18, 0.05 + state.aggressionLevel * 0.04);
        targetBet = Math.max(state.minBaseBet, Math.min(targetBet, balance * maxBetPct));
        const betStr = targetBet.toFixed(MONEY_DIGITS);
        if (betStr !== state.lastAmount) {
            state.lastAmount = betStr;
            setBet(targetBet);
        }
    }

    function triggerWinResetPulse() {
        const root = document.getElementById(SCRIPT_ID);
        if (!root || state.activeMode !== 'iow') return;
        if (state.winResetPulseTimer) clearTimeout(state.winResetPulseTimer);
        root.classList.remove('iow-win-reset-pulse');
        void root.offsetWidth;
        root.classList.add('iow-win-reset-pulse');
        state.winResetPulseTimer = setTimeout(() => {
            root.classList.remove('iow-win-reset-pulse');
            state.winResetPulseTimer = null;
        }, 800);
    }

    function pressPlayButton() {
        const btn = getPlayButton();
        if (!btn || btn.disabled) return false;

        if (typeof PointerEvent === 'function') {
            btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        }
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        btn.click();
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        if (typeof PointerEvent === 'function') {
            btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        }
        return true;
    }

    function updateStartStopButton() {
        const button = document.getElementById(`${SCRIPT_ID}-startstop`);
        if (!button) return;

        button.className = `sm-action-btn ${state.isRapidFiring ? 'stop' : 'start'}`;
        button.textContent = state.isRapidFiring ? 'STOP' : 'START';
    }

    function getStatusText() {
        if (state.activeMode === 'manual') {
            return state.autoPaused ? 'MANUAL • PAUSED' : 'MANUAL • NATIVE UI';
        }

        if (state.activeMode === 'iow') {
            return `IOW • Base ${state.baseBet.toFixed(MONEY_DIGITS)} | Wins: ${state.iowWinCounter} | LossStreak: ${state.iowLossCounter}`;
        }

        return `SMART • ${getSmartGearLabel()} • Agg ${state.aggressionLevel.toFixed(1)}x`;
    }

    function calculateRtp() {
        if (state.totalWagered <= 0) return 100;
        const balance = getCurrentBalance();
        const realized = balance - state.initialBalance;
        return ((state.totalWagered + realized) / state.totalWagered) * 100;
    }

    function formatNum(value, digits = MONEY_DIGITS) {
        return Number.isFinite(value) ? value.toFixed(digits) : `0.${'0'.repeat(digits)}`;
    }

    function formatCurrency(solAmount) {
        if (!Number.isFinite(solAmount)) return '0.00';
        if (isUSDDisplayMode()) {
            const rate = getSolToUsdRate();
            if (rate && rate > 0) {
                const usd = solAmount * rate;
                const sign = usd < 0 ? '-$' : '$';
                return `${sign}${Math.abs(usd).toFixed(2)}`;
            }
        }
        return solAmount.toFixed(MONEY_DIGITS);
    }

    function drawProfitGraph() {
        const canvas = document.getElementById(`${SCRIPT_ID}-profit-graph`);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        let width = canvas.offsetWidth;
        let height = canvas.offsetHeight;
        if (width === 0 || height === 0) return;
        canvas.width = width;
        canvas.height = height;
        ctx.clearRect(0, 0, width, height);
        if (state.profitHistory.length < 2) return;
        let maxVal = Math.max(...state.profitHistory, 0);
        let minVal = Math.min(...state.profitHistory, 0);
        const range = (maxVal - minVal) || 1;
        const padding = range * 0.15;
        maxVal += padding; minVal -= padding;
        const totalRange = maxVal - minVal;
        const zeroY = height - ((0 - minVal) / totalRange) * height;
        const zeroPct = Math.max(0, Math.min(1, zeroY / height));
        const lineGrad = ctx.createLinearGradient(0, 0, 0, height);
        lineGrad.addColorStop(0, '#00ff9d'); lineGrad.addColorStop(zeroPct, '#00ff9d');
        lineGrad.addColorStop(zeroPct, '#f87171'); lineGrad.addColorStop(1, '#f87171');
        const fillGrad = ctx.createLinearGradient(0, 0, 0, height);
        fillGrad.addColorStop(0, 'rgba(0, 255, 157, 0.2)');
        fillGrad.addColorStop(zeroPct, 'rgba(0, 255, 157, 0.2)'); fillGrad.addColorStop(zeroPct, 'rgba(248, 113, 113, 0.2)'); fillGrad.addColorStop(1, 'rgba(248, 113, 113, 0.2)');
        const stepX = width / (state.profitHistory.length - 1);
        ctx.beginPath();
        state.profitHistory.forEach((val, i) => {
            const x = i * stepX;
            const y = height - ((val - minVal) / totalRange) * height;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = lineGrad; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
        ctx.lineTo(width, zeroY); ctx.lineTo(0, zeroY); ctx.closePath();
        ctx.fillStyle = fillGrad; ctx.fill();
        ctx.beginPath();
        ctx.moveTo(0, zeroY); ctx.lineTo(width, zeroY);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    }

    function updateUI() {
        if (state.activeMode === 'smart') {
            updateSmartBet();
        }

        const root = document.getElementById(SCRIPT_ID);
        if (!root) return;

        root.querySelectorAll('.sm-mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === state.activeMode);
        });

        updateStartStopButton();

        const statusMain = document.getElementById(`${SCRIPT_ID}-status-main`);
        const statusSide = document.getElementById(`${SCRIPT_ID}-status-side`);
        if (statusMain) statusMain.textContent = getStatusText();
        if (statusSide) statusSide.textContent = state.autoPaused ? 'AUTO-PAUSED' : (state.isRapidFiring ? 'RUNNING' : 'IDLE');

        const settings = document.getElementById(`${SCRIPT_ID}-settings`);
        const stats = document.getElementById(`${SCRIPT_ID}-stats`);
        if (settings) settings.classList.toggle('open', state.settingsOpen);
        if (stats) stats.classList.toggle('open', state.statsOpen);

        const modeIow = root.querySelectorAll('.mode-iow-only');
        const modeSmart = root.querySelectorAll('.mode-smart-only');
        const stopTake = root.querySelectorAll('.mode-stop-take');

        modeIow.forEach(el => el.classList.toggle('sm-hidden', state.activeMode !== 'iow'));
        modeSmart.forEach(el => el.classList.toggle('sm-hidden', state.activeMode !== 'smart'));
        stopTake.forEach(el => el.classList.toggle('sm-hidden', state.activeMode === 'iow'));

        const rtp = calculateRtp();
        const bestWins = state.topWinStreaks.length ? state.topWinStreaks.join(' / ') : '-';
        const worstLosses = state.topLossStreaks.length ? state.topLossStreaks.join(' / ') : '-';

        const fields = {
            startBalance: formatCurrency(state.initialBalance),
            profit: formatCurrency(state.currentProfit),
            peakBalance: formatCurrency(state.sessionPeak),
            peakProfit: formatCurrency(state.highestProfit),
            totalBets: String(state.totalBets),
            wagered: formatCurrency(state.totalWagered),
            wl: `${state.totalWins} / ${state.totalLosses}`,
            rtp: `${formatNum(rtp)}%`,
            gear: state.activeMode === 'smart' ? getSmartGearLabel() : '-',
            bestWins,
            worstLosses
        };

        for (const [key, value] of Object.entries(fields)) {
            const el = document.getElementById(`${SCRIPT_ID}-${key}`);
            if (el) el.textContent = value;
        }

        const streaksEl = document.getElementById(`${SCRIPT_ID}-streaks`);
        if (streaksEl) {
            streaksEl.innerHTML = `<span style="color:#00ff9d;">${state.curWinStreak}/${state.maxWinStreak}</span> | <span style="color:#f87171;">${state.curLossStreak}/${state.maxLossStreak}</span>`;
        }

        if (state.activeMode === 'smart') {
            const hotEl = document.getElementById(`${SCRIPT_ID}-hot`);
            if (hotEl) {
                const winCount = state.betHistory.filter(b => b).length;
                hotEl.textContent = `${winCount}/${state.betHistory.length || 1}`;
            }
            const multEl = document.getElementById(`${SCRIPT_ID}-multPerf`);
            if (multEl) {
                if (state.multWins > 0) {
                    const actualRatio = state.multGames / state.multWins;
                    const recentHit = state.recentWins.filter(Boolean).length;
                    const recentRatio = state.recentWins.length > 0 ? state.recentWins.length / Math.max(1, recentHit) : actualRatio;
                    const trend = state.recentWins.length >= 10 ? (recentRatio <= actualRatio ? ' ▲' : ' ▼') : '';
                    const trendColor = state.recentWins.length >= 10 ? (recentRatio <= actualRatio ? '#00ff9d' : '#f87171') : '#b1bad3';
                    multEl.innerHTML = `1 in ${actualRatio.toFixed(2)}<span style="color:${trendColor};font-size:11px;">${trend}</span>`;
                    multEl.style.color = actualRatio <= (state.trackedMultiplier || 1) ? '#00ff9d' : '#f87171';
                } else {
                    multEl.innerHTML = '1 in 0.00';
                    multEl.style.color = '#b1bad3';
                }
            }
        }

        const syncNumber = (id, value, digits = null) => {
            const el = document.getElementById(id);
            if (!el) return;
            const stringValue = digits === null ? String(value ?? '') : formatNum(Number(value || 0), digits);
            if (el !== document.activeElement) el.value = stringValue;
        };

        syncNumber(`${SCRIPT_ID}-baseBet`, state.baseBet, MONEY_DIGITS);
        syncNumber(`${SCRIPT_ID}-winIncreasePercent`, state.winIncreasePercent);
        syncNumber(`${SCRIPT_ID}-lossStreakReset`, state.lossStreakReset);
        syncNumber(`${SCRIPT_ID}-winsBeforeReset`, state.winsBeforeReset);
        syncNumber(`${SCRIPT_ID}-autoStopBalance`, state.autoStopBalance ?? '', null);
        syncNumber(`${SCRIPT_ID}-aggressionLevel`, state.aggressionLevel, 1);
        syncNumber(`${SCRIPT_ID}-stopLossPct`, state.stopLossPct, 1);
        syncNumber(`${SCRIPT_ID}-takeProfitPct`, state.takeProfitPct, 1);

        const lockCheckbox = document.getElementById(`${SCRIPT_ID}-lockAggressionState`);
        const gearSelect = document.getElementById(`${SCRIPT_ID}-lockedGearLevel`);
        if (lockCheckbox) lockCheckbox.checked = state.lockAggressionState;
        if (gearSelect) {
            gearSelect.value = String(state.lockedGearLevel);
            gearSelect.disabled = !state.lockAggressionState;
        }

        const settingsBtn = document.getElementById(`${SCRIPT_ID}-settings-toggle`);
        const statsBtn = document.getElementById(`${SCRIPT_ID}-stats-toggle`);
        if (settingsBtn) settingsBtn.textContent = state.settingsOpen ? 'HIDE SETTINGS' : 'SETTINGS';
        if (statsBtn) statsBtn.textContent = state.statsOpen ? 'HIDE STATS' : 'STATS';

        drawProfitGraph();
    }

    function readNumberInput(id, fallback) {
        const el = document.getElementById(id);
        if (!el) return fallback;
        const value = parseFloat(el.value);
        return Number.isFinite(value) ? value : fallback;
    }

    function bindInputHandlers() {
        const on = (id, event, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(event, handler);
        };

        on(`${SCRIPT_ID}-baseBet`, 'input', () => {
            state.baseBet = Math.max(state.minBaseBet, readNumberInput(`${SCRIPT_ID}-baseBet`, state.baseBet));
        });

        on(`${SCRIPT_ID}-winIncreasePercent`, 'input', () => {
            state.winIncreasePercent = Math.max(0, readNumberInput(`${SCRIPT_ID}-winIncreasePercent`, state.winIncreasePercent));
        });

        on(`${SCRIPT_ID}-lossStreakReset`, 'input', () => {
            state.lossStreakReset = Math.max(1, Math.floor(readNumberInput(`${SCRIPT_ID}-lossStreakReset`, state.lossStreakReset)));
        });

        on(`${SCRIPT_ID}-winsBeforeReset`, 'input', () => {
            state.winsBeforeReset = Math.max(1, Math.floor(readNumberInput(`${SCRIPT_ID}-winsBeforeReset`, state.winsBeforeReset)));
        });

        on(`${SCRIPT_ID}-autoStopBalance`, 'input', () => {
            const value = document.getElementById(`${SCRIPT_ID}-autoStopBalance`)?.value.trim() || '';
            state.autoStopBalance = value === '' ? null : Math.max(0, parseFloat(value) || 0);
        });

        on(`${SCRIPT_ID}-aggressionLevel`, 'input', () => {
            state.aggressionLevel = Math.max(0.5, Math.min(3.0, readNumberInput(`${SCRIPT_ID}-aggressionLevel`, state.aggressionLevel)));
            updateUI();
        });

        on(`${SCRIPT_ID}-stopLossPct`, 'input', () => {
            state.stopLossPct = Math.max(0, readNumberInput(`${SCRIPT_ID}-stopLossPct`, state.stopLossPct));
        });

        on(`${SCRIPT_ID}-takeProfitPct`, 'input', () => {
            state.takeProfitPct = Math.max(0, readNumberInput(`${SCRIPT_ID}-takeProfitPct`, state.takeProfitPct));
        });

        on(`${SCRIPT_ID}-lockAggressionState`, 'change', (e) => {
            state.lockAggressionState = Boolean(e.target.checked);
            updateUI();
        });

        on(`${SCRIPT_ID}-lockedGearLevel`, 'change', (e) => {
            const nextGear = parseInt(e.target.value, 10);
            state.lockedGearLevel = Number.isFinite(nextGear) ? nextGear : 1;
            updateUI();
        });
    }

    function resetStats() {
        const balance = getCurrentBalance();
        state.initialBalance = balance;
        state.lastKnownBalance = balance;
        state.sessionPeak = balance;
        state.highestProfit = 0;
        state.totalWagered = 0;
        state.totalWins = 0;
        state.totalLosses = 0;
        state.totalBets = 0;
        state.currentProfit = 0;

        state.curWinStreak = 0;
        state.curLossStreak = 0;
        state.maxWinStreak = 0;
        state.maxLossStreak = 0;
        state.topWinStreaks = [];
        state.topLossStreaks = [];
        state.lastResult = null;

        state.profitHistory = [0];
        state.iowWinCounter = 0;
        state.iowLossCounter = 0;
        state.autoPaused = false;
        state.lastBetId = null;

        state.betHistory = [];
        state.recentWins = [];
        state.trackedMultiplier = 0;
        state.multGames = 0;
        state.multWins = 0;
        state.historyWindow = 30;
        state.safeDivisor = 300;
        state.aggressiveDivisor = 150;
        state.winsNeeded = 15;
        state.lastAmount = null;

        updateUI();
    }

    function startRapidFire() {
        if (state.isRapidFiring) return;
        if (state.autoPaused) state.autoPaused = false;

        state.isRapidFiring = true;
        state.rapidStartedAt = Date.now();
        state.lastObservedBetTime = 0;
        state.rapidBlockedSince = 0;

        if (state.activeMode === 'iow') {
            setBet(state.baseBet);
        }

        state.rapidTimer = setInterval(() => {
            if (!state.isRapidFiring) return;

            const ok = pressPlayButton();
            if (!ok) {
                if (!state.rapidBlockedSince) state.rapidBlockedSince = Date.now();
            } else {
                state.rapidBlockedSince = 0;
            }
        }, RAPID_INTERVAL_MS);

        updateUI();
    }

    function stopRapidFire() {
        state.isRapidFiring = false;
        state.rapidStartedAt = 0;
        state.lastObservedBetTime = 0;
        state.rapidBlockedSince = 0;

        if (state.rapidTimer) {
            clearInterval(state.rapidTimer);
            state.rapidTimer = null;
        }

        updateUI();
    }

    function monitorRapidFireHealth() {
        if (!state.isRapidFiring) return;

        const now = Date.now();
        const playButton = getPlayButton();

        if (!playButton || playButton.disabled) {
            if (!state.rapidBlockedSince) state.rapidBlockedSince = now;
            if (now - state.rapidBlockedSince >= 1500) {
                stopRapidFire();
            }
            return;
        }

        state.rapidBlockedSince = 0;

        const lastSeen = state.lastObservedBetTime || state.rapidStartedAt;
        if (lastSeen && now - lastSeen >= 4000) {
            stopRapidFire();
        }
    }

    function processNewBet(container) {
        const latest = getLatestBetEntry(container);
        if (!latest) return;
        if (latest.id === state.lastBetId) return;

        state.lastBetId = latest.id;
        state.lastObservedBetTime = Date.now();

        const won = isWinElement(latest.element);
        const betAmount = getCurrentBet();
        handleBetResult(won, betAmount);
    }

    function startObserver() {
        const connect = () => {
            const container = findPastBetsContainer();
            if (!container) {
                setTimeout(connect, 700);
                return;
            }

            state.lastBetId = getLatestBetEntry(container)?.id || null;

            if (state.observer) {
                state.observer.disconnect();
            }

            state.observer = new MutationObserver(() => processNewBet(container));
            state.observer.observe(container, { childList: true, subtree: true });
        };

        connect();
    }

    function createUiHtml() {
        return `
            <div class="sm-top">
                <button class="sm-mode-btn active" data-mode="manual">MANUAL</button>
                <button class="sm-mode-btn" data-mode="iow">IOW</button>
                <button class="sm-mode-btn" data-mode="smart">SMART</button>
            </div>

            <div class="sm-bar">
                <button id="${SCRIPT_ID}-startstop" class="sm-action-btn start">START</button>
                <button id="${SCRIPT_ID}-reset" class="sm-action-btn reset">RESET</button>
                <button id="${SCRIPT_ID}-settings-toggle" class="sm-toggle-btn">SETTINGS</button>
                <button id="${SCRIPT_ID}-stats-toggle" class="sm-toggle-btn">STATS</button>
            </div>

            <div class="sm-status">
                <div id="${SCRIPT_ID}-status-main" class="sm-status-main">MANUAL • NATIVE UI</div>
                <div id="${SCRIPT_ID}-status-side" class="sm-status-side">IDLE</div>
            </div>

            <div id="${SCRIPT_ID}-settings" class="sm-drawer">
                <h3 class="sm-section-title">Settings</h3>

                <div class="sm-grid mode-stop-take">
                    <div class="sm-field">
                        <label>Stop Loss %</label>
                        <input id="${SCRIPT_ID}-stopLossPct" type="number" min="0" step="0.5" value="0.0">
                    </div>

                    <div class="sm-field">
                        <label>Take Profit %</label>
                        <input id="${SCRIPT_ID}-takeProfitPct" type="number" min="0" step="0.5" value="0.0">
                    </div>
                </div>

                <div class="mode-iow-only sm-grid sm-hidden" style="margin-top:8px;">
                    <div class="sm-field">
                        <label>Base Bet</label>
                        <input id="${SCRIPT_ID}-baseBet" type="number" min="0.00000001" step="0.00000001" value="0.00000001">
                    </div>

                    <div class="sm-field">
                        <label>Win Increase %</label>
                        <input id="${SCRIPT_ID}-winIncreasePercent" type="number" min="0" step="1" value="125">
                    </div>

                    <div class="sm-field">
                        <label>Loss Reset</label>
                        <input id="${SCRIPT_ID}-lossStreakReset" type="number" min="1" step="1" value="3">
                    </div>

                    <div class="sm-field">
                        <label>Wins Before Reset</label>
                        <input id="${SCRIPT_ID}-winsBeforeReset" type="number" min="1" step="1" value="5">
                    </div>

                    <div class="sm-field">
                        <label>Autostop Balance</label>
                        <input id="${SCRIPT_ID}-autoStopBalance" type="number" min="0" step="0.00000001" placeholder="OFF">
                    </div>
                </div>

                <div class="mode-smart-only sm-grid sm-hidden" style="margin-top:8px;">
                    <div class="sm-field">
                        <label>Aggression</label>
                        <input id="${SCRIPT_ID}-aggressionLevel" type="number" min="0.5" max="3.0" step="0.1" value="1.0">
                    </div>

                    <div class="sm-field">
                        <label>Locked Gear</label>
                        <select id="${SCRIPT_ID}-lockedGearLevel">
                            <option value="1">Conservative</option>
                            <option value="2">Steady</option>
                            <option value="3">Balanced</option>
                            <option value="4">Press</option>
                            <option value="5">Aggro</option>
                        </select>
                    </div>

                    <div class="sm-field" style="grid-column: 1 / -1;">
                        <label>Lock State</label>
                        <div class="sm-inline">
                            <input id="${SCRIPT_ID}-lockAggressionState" type="checkbox">
                            <span style="font-size:12px;font-weight:800;color:#dbe5ef;">Use locked gear instead of adaptive gear</span>
                        </div>
                    </div>
                </div>

                <div class="sm-footer-note">
                    Mobile script keeps the native Nuts controls visible and adds compact mode control, settings, and stats with the desktop smart progression logic.
                </div>
            </div>

            <div id="${SCRIPT_ID}-stats" class="sm-drawer">
                <h3 class="sm-section-title">Stats</h3>
                <div class="sm-stats">
                    <div class="sm-stat"><span class="sm-stat-label">Starting Balance</span><span id="${SCRIPT_ID}-startBalance" class="sm-stat-val">0.00</span></div>
                    <div class="sm-stat"><span class="sm-stat-label">Profit / Loss</span><span id="${SCRIPT_ID}-profit" class="sm-stat-val">0.00</span></div>
                    <div class="sm-stat"><span class="sm-stat-label">Peak Balance</span><span id="${SCRIPT_ID}-peakBalance" class="sm-stat-val">0.00</span></div>
                    <div class="sm-stat"><span class="sm-stat-label">Peak Profit</span><span id="${SCRIPT_ID}-peakProfit" class="sm-stat-val">0.00</span></div>
                    <div class="sm-stat"><span class="sm-stat-label">Total Bets</span><span id="${SCRIPT_ID}-totalBets" class="sm-stat-val">0</span></div>
                    <div class="sm-stat"><span class="sm-stat-label">Total Wagered</span><span id="${SCRIPT_ID}-wagered" class="sm-stat-val">0.00</span></div>
                    <div class="sm-stat"><span class="sm-stat-label">Wins / Losses</span><span id="${SCRIPT_ID}-wl" class="sm-stat-val">0 / 0</span></div>
                    <div class="sm-stat"><span class="sm-stat-label">Session RTP</span><span id="${SCRIPT_ID}-rtp" class="sm-stat-val">100.00%</span></div>
                    <div class="sm-stat"><span class="sm-stat-label">Current Streak</span><span id="${SCRIPT_ID}-streaks" class="sm-stat-val">0W / 0L</span></div>
                    <div class="sm-stat"><span class="sm-stat-label">Aggression State</span><span id="${SCRIPT_ID}-gear" class="sm-stat-val">Conservative</span></div>
                    <div class="sm-stat"><span class="sm-stat-label">Best Win Streaks</span><span id="${SCRIPT_ID}-bestWins" class="sm-stat-val">-</span></div>
                    <div class="sm-stat"><span class="sm-stat-label">Worst Loss Streaks</span><span id="${SCRIPT_ID}-worstLosses" class="sm-stat-val">-</span></div>
                    <div class="sm-stat mode-smart-only"><span class="sm-stat-label">Momentum</span><span id="${SCRIPT_ID}-hot" class="sm-stat-val">0/0</span></div>
                    <div class="sm-stat mode-smart-only"><span class="sm-stat-label">Mult Perf</span><span id="${SCRIPT_ID}-multPerf" class="sm-stat-val">1 in 0.00</span></div>
                </div>
                <div class="sm-graph-container">
                    <canvas id="${SCRIPT_ID}-profit-graph"></canvas>
                </div>
            </div>
        `;
    }

    function getInsertionTarget() {
        const candidates = [
            document.querySelector('.sc-8d275cfe-1'),
            document.querySelector('.sc-fe9b8b64-1'),
            document.querySelector('.sc-9b1418e2-1'),
            document.querySelector('main')
        ].filter(Boolean);

        return candidates[0] || null;
    }

    function attachUi() {
        if (!isMobileViewport()) {
            const existing = document.getElementById(SCRIPT_ID);
            if (existing) existing.remove();
            return;
        }

        const target = getInsertionTarget();
        if (!target) return;

        let root = document.getElementById(SCRIPT_ID);
        if (!root) {
            root = document.createElement('div');
            root.id = SCRIPT_ID;
            root.innerHTML = createUiHtml();

            if (target.firstElementChild) {
                target.insertBefore(root, target.firstElementChild);
            } else {
                target.appendChild(root);
            }

            root.querySelectorAll('.sm-mode-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    state.activeMode = btn.dataset.mode;
                    if (state.isRapidFiring) stopRapidFire();
                    updateUI();
                });
            });

            document.getElementById(`${SCRIPT_ID}-startstop`)?.addEventListener('click', () => {
                if (state.isRapidFiring) stopRapidFire();
                else startRapidFire();
            });

            document.getElementById(`${SCRIPT_ID}-reset`)?.addEventListener('click', () => {
                resetStats();
            });

            document.getElementById(`${SCRIPT_ID}-settings-toggle`)?.addEventListener('click', () => {
                state.settingsOpen = !state.settingsOpen;
                updateUI();
            });

            document.getElementById(`${SCRIPT_ID}-stats-toggle`)?.addEventListener('click', () => {
                state.statsOpen = !state.statsOpen;
                updateUI();
            });

            bindInputHandlers();
        }

        updateUI();
    }

    function bootstrap() {
        if (window.__nutsMobileIowSmartLoaded) return;
        window.__nutsMobileIowSmartLoaded = true;

        const initWhenReady = () => {
            attachUi();
            if (!state.healthTimer) {
                state.healthTimer = setInterval(() => {
                    attachUi();
                    monitorRapidFireHealth();
                    updateUI();
                }, HEALTH_CHECK_MS);
            }
            resetStats();
            startObserver();
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initWhenReady, { once: true });
        } else {
            initWhenReady();
        }

        window.addEventListener('resize', () => {
            attachUi();
            updateUI();
        });
    }

    bootstrap();
})();
