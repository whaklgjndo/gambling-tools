// ==UserScript==
// @name IOW / Smart - Nuts
// @namespace http://tampermonkey.net/
// @version 3.6
// @description Adds Manual, IOW (Increase on Win), and Smart bet-sizing modes to Nuts.gg Dice and Target with live stats and dynamic progression.
// @author .
// @match https://nuts.gg/target*
// @match https://nuts.gg/dice*
// @match https://*.nuts.gg/target*
// @match https://*.nuts.gg/dice*
// @grant GM_addStyle
// @run-at document-start
// ==/UserScript==
(function () {
    'use strict';
    // ================== SETTINGS & STATE ==================
    let ACTIVE_MODE = 'smart';
    let baseBet = 0.00000001;
    let winIncreasePercent = 125;
    let lossStreakReset = 3;
    let winsBeforeReset = 5;
    let autoStopBalance = null;
    let minBaseBet = 0.00000001;
    let maxBaseBet = 99999999999999;
    let lastBetId = null;
    let lossStreak = 0;
    let counter = 0;
    let isRapidFiring = false;
    let sessionPeak = 0;
    let initialBalance = 0;
    let lastKnownBalance = 0;
    let totalWagered = 0;
    let highestProfit = 0;
    let totalWins = 0;
    let totalLosses = 0;
    let totalBets = 0;
    let observer = null;
    let pastBetsContainer = null;
    let profitHistory = [0];
    const MAX_GRAPH_POINTS = 10000;
    const RAPID_BLOCKED_STOP_MS = 1200;
    const RAPID_STALL_STOP_MS = 3000;
    let aggressionLevel = 1.0;
    let historyWindow = 30;
    let safeDivisor = 300;
    let aggressiveDivisor = 150;
    let winsNeeded = 15;
    let lastAmount = 0;
    let curLossStreak = 0;
    let maxLossStreak = 0;
    let curWinStreak = 0;
    let maxWinStreak = 0;
    let betHistory = [];
    let recentWins = [];
    let topWinStreaks = [];
    let topLossStreaks = [];
    let trackedMultiplier = 0;
    let multGames = 0;
    let multWins = 0;
    let lastResult = null;
    let stopLossPct = 0;
    let takeProfitPct = 0;
    let autoPaused = false;
    let winResetPulseTimer = null;
    let rapidBlockedSince = 0;
    let rapidFireStartedAt = 0;
    let lastObservedBetTime = 0;
    let spacePressInterval = null;
    let lockAggressionState = false;
    let lockedGearLevel = 1;
    // === BET LOCK STATE ===
    let desiredBetAmount = null;
    let betGuardObserver = null;
    // === IOW RELIABLE PROGRESSION ===
    let lastPlacedBet = 0.00000010;
    // === ADVANCED RAPID STATE ===
    let clickInterval = null;
    let spaceTimeout = null;
    let spaceInterval = null;
    let isSpaceHeldDown = false;
    let playButton = null;
    // === IOW ENFORCER ===
    let iowEnforcerInterval = null;

    GM_addStyle(`
[]        #ratchet-master-container,
        #ratchet-master-container * { box-sizing: border-box !important; }
        #ratchet-master-container {
            --hud-bg:
                radial-gradient(circle at 8% 10%, rgba(122, 124, 255, 0.18), transparent 22%),
                radial-gradient(circle at 94% 4%, rgba(255, 79, 216, 0.2), transparent 24%),
                radial-gradient(circle at 50% 100%, rgba(24, 240, 255, 0.09), transparent 34%),
                linear-gradient(135deg, rgba(7, 10, 18, 0.96), rgba(18, 24, 35, 0.94) 42%, rgba(10, 12, 18, 0.98));
            --hud-panel: linear-gradient(160deg, rgba(36, 42, 56, 0.54), rgba(14, 18, 28, 0.76));
            --hud-border: rgba(128, 202, 255, 0.28);
            --hud-border-soft: rgba(255, 255, 255, 0.1);
            --hud-green: #19f3ff;
            --hud-green-dark: #8f63ff;
            --hud-red: #ff4c94;
            --hud-accent-a: #19f3ff;
            --hud-accent-b: #8f63ff;
            --hud-accent-c: #ff4fd8;
            --hud-positive: #43f6ff;
            --hud-negative: #ff6bb0;
            --hud-text: #f5fbff;
            --hud-text-soft: #aab6c9;
            position: absolute !important;
            inset: 0 !important;
            width: 100% !important;
            max-width: none !important;
            height: 100% !important;
            max-height: none !important;
            background: var(--hud-bg) !important;
            border: 1px solid var(--hud-border) !important;
            border-radius: 0 !important;
            padding: 8px !important;
            box-shadow: 0 28px 80px rgba(0, 0, 0, 0.62), inset 0 1px 0 rgba(255, 255, 255, 0.04) !important;
            z-index: auto !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 8px !important;
            font-family: "Proxima Nova", "Segoe UI", sans-serif !important;
            pointer-events: auto !important;
            overflow: hidden !important;
            backdrop-filter: blur(24px) saturate(1.32);
            line-height: 1.15;
            color: var(--hud-text) !important;
        }
        #ratchet-master-container::before {
            content: '';
            position: absolute;
            inset: 0;
            pointer-events: none;
            background:
                linear-gradient(120deg, rgba(255, 255, 255, 0.05), transparent 22%, transparent 78%, rgba(255, 255, 255, 0.03)),
                radial-gradient(circle at 15% 18%, rgba(25, 243, 255, 0.08), transparent 18%),
                radial-gradient(circle at 82% 14%, rgba(255, 79, 216, 0.1), transparent 20%);
            opacity: 0.95;
        }
        #ratchet-master-container::after {
            content: '';
            position: absolute;
            inset: 0;
            border-radius: 0;
            pointer-events: none;
            opacity: 0;
            border: 1px solid transparent;
            box-shadow: inset 0 0 0 0 rgba(25, 243, 255, 0), inset 0 0 0 0 rgba(255, 79, 216, 0);
        }
        #ratchet-master-container.iow-win-reset-pulse::after { animation: ratchet-iow-win-reset-pulse 720ms ease-out 1; }
        @keyframes ratchet-iow-win-reset-pulse {
            0% { opacity: 0; }
            20% { opacity: 1; border-color: rgba(25, 243, 255, 0.88); box-shadow: inset 0 0 0 1px rgba(25, 243, 255, 0.74), inset 0 0 18px rgba(143, 99, 255, 0.26); }
            55% { opacity: 1; border-color: rgba(255, 79, 216, 0.78); box-shadow: inset 0 0 0 2px rgba(255, 79, 216, 0.72), inset 0 0 24px rgba(25, 243, 255, 0.24); }
            100% { opacity: 0; border-color: transparent; box-shadow: inset 0 0 0 0 rgba(25, 243, 255, 0), inset 0 0 0 0 rgba(255, 79, 216, 0); }
        }
        #ratchet-master-container[data-mode="iow"] { min-height: 0 !important; }
        #ratchet-master-container .hud-frame { display: flex; flex: 1 1 0; min-height: 0; min-width: 0; gap: 8px; overflow: hidden; position: relative; z-index: 2; }
        #ratchet-master-container .hud-workspace { display: flex; flex-direction: column; flex: 1 1 0; min-height: 0; min-width: 0; gap: 8px; overflow: hidden; position: relative; z-index: 3; }
        #ratchet-master-container .hud-native-sidebar-slot { display: flex; flex: 0 0 300px; width: 300px; min-width: 300px; max-width: 300px; min-height: 0; overflow: hidden; position: relative; z-index: 4; }
        #ratchet-master-container .hud-native-sidebar-slot:empty,
        #ratchet-master-container .hud-native-past-bets-slot:empty,
        #ratchet-master-container .hud-native-game-footer-slot:empty,
        #ratchet-master-container .hud-footer-slot:empty { display: none !important; }
        #ratchet-master-container .hud-native-sidebar-slot > .sc-8d275cfe-1 {
            width: 100% !important;
            height: 100% !important;
            min-width: 0 !important;
            min-height: 0 !important;
            display: flex !important;
            flex-direction: column !important;
            padding: 10px !important;
            background: var(--hud-panel) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            border-radius: 12px !important;
            overflow: auto !important;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.05) !important;
            backdrop-filter: blur(22px) saturate(1.28) !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot > .sc-8d275cfe-1 > .sc-8d275cfe-2 {
            width: 100% !important;
            min-width: 0 !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot > .sc-8d275cfe-1 .sc-fe9b8b64-1,
        #ratchet-master-container .hud-native-sidebar-slot > .sc-8d275cfe-1 .sc-80ffdcd5-0,
        #ratchet-master-container .hud-native-sidebar-slot > .sc-8d275cfe-1 .sc-9e158b58-0 {
            width: 100% !important;
            max-width: 100% !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot > .sc-9b1418e2-1,
        #ratchet-master-container .hud-native-sidebar-slot > .sc-9b1418e2-0 {
            width: 100% !important;
            height: 100% !important;
            min-width: 0 !important;
            min-height: 0 !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 6px !important;
            padding: 10px !important;
            background: var(--hud-panel) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            border-radius: 12px !important;
            overflow: auto !important;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.05) !important;
            backdrop-filter: blur(22px) saturate(1.28) !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot > .sc-9b1418e2-1 {
            padding-top: 10px !important;
            margin-top: 0 !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .styles-module___IID9a__game {
            width: 100% !important;
            min-height: 28px !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            border-radius: 8px !important;
        }
        #ratchet-master-container .hud-native-past-bets-slot { display: flex; flex: 0 0 auto; min-height: 42px; min-width: 0; overflow: hidden; position: relative; z-index: 5; }
        #ratchet-master-container .hud-native-past-bets-slot > .sc-9b1418e2-1,
        #ratchet-master-container .hud-native-past-bets-slot > .sc-9b1418e2-0 {
            width: 100% !important;
            min-width: 0 !important;
            display: flex !important;
            align-items: center !important;
            gap: 6px !important;
            padding: 6px !important;
            background: var(--hud-panel) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            border-radius: 12px !important;
            overflow-x: auto !important;
            overflow-y: hidden !important;
            box-shadow: 0 14px 30px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.05) !important;
            backdrop-filter: blur(20px) saturate(1.22) !important;
        }
        #ratchet-master-container .hud-native-past-bets-slot > .sc-9b1418e2-1 {
            height: auto !important;
            width: 100% !important;
            padding-left: 6px !important;
            margin-left: 0 !important;
            flex-direction: row !important;
            align-items: center !important;
            padding-top: 0 !important;
            margin-top: 0 !important;
        }
        #ratchet-master-container .hud-native-past-bets-slot .styles-module___IID9a__game { flex: 0 0 auto !important; }
        #ratchet-master-container #hud-content { display: flex; flex: 1 1 0; min-height: 0; min-width: 0; overflow: hidden; position: relative; z-index: 4; }
        #ratchet-master-container .hud-shell { display: flex; flex-direction: column; flex: 1 1 0; min-height: 0; min-width: 0; gap: 8px; overflow: hidden; position: relative; z-index: 4; }
        #ratchet-master-container .hud-panel { background: var(--hud-panel); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; box-shadow: 0 16px 34px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.05); backdrop-filter: blur(20px) saturate(1.24); }
        #ratchet-master-container .mode-wrap { display: flex; flex: 0 0 auto; flex-wrap: nowrap; gap: 5px; background: linear-gradient(180deg, rgba(23, 29, 42, 0.7), rgba(14, 18, 27, 0.82)); padding: 6px; border-radius: 14px; border: 1px solid rgba(255, 255, 255, 0.09); box-shadow: 0 18px 36px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.05); position: relative; z-index: 3; backdrop-filter: blur(22px) saturate(1.26); }
        #ratchet-master-container .mode-btn { flex: 1 1 0; min-width: 0; padding: 8px 12px; border: none; border-radius: 999px; font-size: 12px; font-weight: 900; cursor: pointer; transition: transform 0.18s ease, filter 0.18s ease, background 0.18s ease, color 0.18s ease; text-transform: uppercase; letter-spacing: 0.4px; }
        #ratchet-master-container .mode-btn.active { background: linear-gradient(135deg, var(--hud-accent-a), var(--hud-accent-b) 45%, var(--hud-accent-c)); color: #070911; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.2) inset, 0 0 18px rgba(25, 243, 255, 0.22), 0 0 26px rgba(255, 79, 216, 0.18); }
        #ratchet-master-container .mode-btn:not(.active) { background: rgba(77, 97, 123, 0.45); color: #c1cbda; }
        #ratchet-master-container .mode-btn:hover { filter: brightness(1.08); transform: translateY(-1px); }
        #ratchet-master-container .hud-top-bar, #ratchet-master-container .hud-controls-deck, #ratchet-master-container .hud-body, #ratchet-master-container .hud-split, #ratchet-master-container .input-row, #ratchet-master-container .input-cluster, #ratchet-master-container .btn-group, #ratchet-master-container .hud-stat-rail, #ratchet-master-container .hud-stats-grid, #ratchet-master-container .hud-meta-row, #ratchet-master-container .hud-header { display: flex; min-width: 0; }
        #ratchet-master-container .hud-header, #ratchet-master-container .hud-top-bar, #ratchet-master-container .hud-controls-deck { flex: 0 0 auto; }
        #ratchet-master-container .hud-top-bar, #ratchet-master-container .hud-controls-deck, #ratchet-master-container .hud-body, #ratchet-master-container .hud-split { gap: 8px; align-items: stretch; }
        #ratchet-master-container .hud-body, #ratchet-master-container .hud-split { flex: 1 1 0; min-height: 0; min-width: 0; overflow: hidden; flex-wrap: nowrap; position: relative; z-index: 4; }
        #ratchet-master-container .hud-body { justify-content: space-between; }
        #ratchet-master-container .hud-header, #ratchet-master-container .input-row, #ratchet-master-container .hud-meta-row { justify-content: space-between; align-items: center; gap: 8px; }
        #ratchet-master-container .hud-pane, #ratchet-master-container .graph-col, #ratchet-master-container .stats-col { flex: 1 1 0; min-height: 0; min-width: 0; overflow: hidden; position: relative; z-index: 4; }
        #ratchet-master-container .hud-pane { display: flex; flex-direction: column; gap: 8px; }
        #ratchet-master-container .hud-pane.primary { flex: 1.15 1 0; }
        #ratchet-master-container .hud-pane.secondary, #ratchet-master-container .stats-col { flex: 0 0 340px; width: 340px; min-width: 340px; max-width: 340px; display: flex; flex-direction: column; gap: 8px; }
        #ratchet-master-container .graph-col { display: flex; flex: 1 1 auto; min-width: 320px; }
        #ratchet-master-container .control-section { flex: 1 1 0; min-width: 0; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
        #ratchet-master-container .input-row { align-items: flex-end; flex-wrap: nowrap; }
        #ratchet-master-container .input-cluster { flex: 1 1 0; flex-wrap: wrap; align-items: flex-end; gap: 8px; min-width: 0; }
        #ratchet-master-container .input-group { display: flex; align-items: center; gap: 5px; flex: 0 0 auto; }
        #ratchet-master-container .quick-btn { padding: 0; width: 26px; height: 26px; font-size: 10px; font-weight: 900; background: linear-gradient(180deg, rgba(39, 48, 63, 0.88), rgba(17, 22, 33, 0.94)); border: 1px solid rgba(142, 174, 212, 0.18); color: var(--hud-text); border-radius: 8px; cursor: pointer; flex: 0 0 auto; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05); }
        #ratchet-master-container .quick-btn:hover { background: linear-gradient(180deg, rgba(78, 96, 123, 0.7), rgba(24, 29, 43, 0.94)); }
        #ratchet-master-container input[type="number"] { background: rgba(8, 11, 18, 0.78); border: 1px solid rgba(142, 174, 212, 0.18); color: var(--hud-text); padding: 5px 6px; border-radius: 9px; width: 76px; font-size: 12px; font-weight: 700; text-align: center; outline: none; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04); }
        #ratchet-master-container input[type="number"]:focus { border-color: rgba(25, 243, 255, 0.72); box-shadow: 0 0 0 2px rgba(25, 243, 255, 0.12), 0 0 18px rgba(255, 79, 216, 0.12); }
        #ratchet-master-container .hud-risk-container { display: flex; flex: 1 1 100%; flex-wrap: nowrap; gap: 6px; min-width: 0; }
        #ratchet-master-container .hud-risk-container label { color: var(--hud-text-soft); font-size: 10px; font-weight: 800; display: flex; flex-direction: column; justify-content: space-between; gap: 4px; text-transform: uppercase; flex: 1 1 0; min-width: 0; }
        #ratchet-master-container .hud-risk-container input[type="number"] { width: 100%; min-width: 0; }
        #ratchet-master-container .btn-group { align-items: stretch; gap: 6px; flex-wrap: nowrap; justify-content: flex-end; flex: 0 0 auto; }
        #ratchet-master-container .hud-rapid-btn, #ratchet-master-container .hud-reset-btn { min-height: 38px; }
        #ratchet-master-container .hud-rapid-btn { border: none; color: #fff; font-size: 12px; font-weight: 900; padding: 8px 16px; border-radius: 9px; cursor: pointer; min-width: 108px; letter-spacing: 0.5px; text-transform: uppercase; flex: 1 1 0; }
        #ratchet-master-container .hud-rapid-btn.start { background: linear-gradient(135deg, var(--hud-accent-a), var(--hud-accent-b) 44%, var(--hud-accent-c)); color: #070911; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.18) inset, 0 0 20px rgba(25, 243, 255, 0.2), 0 0 28px rgba(255, 79, 216, 0.16); }
        #ratchet-master-container .hud-rapid-btn.start:hover { filter: brightness(1.05) saturate(1.04); }
        #ratchet-master-container .hud-rapid-btn.stop { background: linear-gradient(135deg, rgba(255, 79, 216, 0.94), rgba(255, 76, 148, 0.94)); box-shadow: 0 0 18px rgba(255, 79, 216, 0.18); }
        #ratchet-master-container .hud-rapid-btn.stop:hover { filter: brightness(1.05); }
        #ratchet-master-container .hud-reset-btn { background: rgba(255, 79, 216, 0.06); border: 1px solid rgba(255, 79, 216, 0.58); color: #ff78bf; font-size: 11px; font-weight: 900; padding: 8px 14px; border-radius: 11px; cursor: pointer; flex: 1 1 0; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04); }
        #ratchet-master-container .hud-reset-btn:hover { background: linear-gradient(135deg, rgba(255, 79, 216, 0.18), rgba(255, 76, 148, 0.22)); color: #fff; }
        #ratchet-master-container .status-bar { background: var(--hud-panel); padding: 8px 10px; border-radius: 14px; text-align: center; font-size: 13px; font-weight: 900; letter-spacing: 0.2px; border: 1px solid rgba(255, 255, 255, 0.1); display: flex; align-items: center; justify-content: center; min-height: 42px; flex: 0 0 auto; box-shadow: 0 16px 34px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.05); backdrop-filter: blur(20px) saturate(1.24); }
        #ratchet-master-container .hud-graph-box { flex: 1 1 0; min-height: 0; height: 100%; background: radial-gradient(circle at top left, rgba(25, 243, 255, 0.08), transparent 24%), radial-gradient(circle at top right, rgba(255, 79, 216, 0.1), transparent 24%), linear-gradient(180deg, rgba(8, 10, 17, 0.95), rgba(14, 17, 25, 0.98)); border: 1px solid rgba(146, 184, 224, 0.16); border-radius: 16px; overflow: hidden; position: relative; display: flex; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 20px 40px rgba(0, 0, 0, 0.28); }
        #ratchet-master-container .hud-graph-box canvas { width: 100%; height: 100%; display: block; flex: 1 1 auto; }
        #ratchet-master-container .hud-header { padding: 8px 12px; background: var(--hud-panel); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 14px; box-shadow: 0 16px 34px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.05); position: relative; z-index: 4; backdrop-filter: blur(20px) saturate(1.24); }
        #ratchet-master-container .hud-header h2 { margin: 0; color: #fff; font-size: 14px; font-weight: 900; letter-spacing: 0.8px; text-transform: uppercase; }
        #ratchet-master-container .hud-target-text { color: #eef8ff; font-size: 12px; font-weight: 800; font-style: italic; letter-spacing: 0.2px; text-shadow: 0 0 14px rgba(25, 243, 255, 0.14); }
        #ratchet-master-container .hud-controls-deck { padding: 10px; border-radius: 14px; border: 1px solid rgba(255, 255, 255, 0.1); background: var(--hud-panel); flex-wrap: nowrap; box-shadow: 0 16px 34px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.05); position: relative; z-index: 2; backdrop-filter: blur(20px) saturate(1.24); }
        #ratchet-master-container .hud-control-group { display: flex; flex-direction: column; gap: 4px; flex: 1 1 0; min-width: 0; }
        #ratchet-master-container .hud-control-group label { color: var(--hud-text-soft); font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.3px; display: flex; justify-content: space-between; gap: 6px; }
        #ratchet-master-container .hud-control-group input[type="range"] { width: 100%; height: 6px; accent-color: var(--hud-green); cursor: pointer; }
        #ratchet-master-container .hud-control-group input[type="number"] { width: 100%; }
        #ratchet-master-container select { background: rgba(8, 11, 18, 0.78); border: 1px solid rgba(142, 174, 212, 0.18); color: var(--hud-text); padding: 4px 6px; border-radius: 9px; font-size: 11px; font-weight: 700; width: 100%; outline: none; appearance: auto; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04); }
        #ratchet-master-container select:disabled { opacity: 0.4; cursor: not-allowed; }
        #ratchet-master-container input[type="checkbox"] { accent-color: var(--hud-green); cursor: pointer; margin: 0; width: 14px; height: 14px; }
        #ratchet-master-container .hud-stat-rail { flex: 1 1 0; min-height: 0; min-width: 0; flex-direction: column; gap: 8px; overflow: hidden; }
        #ratchet-master-container .hud-stats-grid { flex: 1 1 0; min-height: 0; min-width: 0; display: grid; grid-template-columns: 1fr; grid-auto-rows: minmax(0, 1fr); gap: 6px; align-content: stretch; overflow: hidden; position: relative; z-index: 4; }
        #ratchet-master-container .stats-col-inner, #ratchet-master-container .hud-stat-card { min-height: 0; min-width: 0; background: var(--hud-panel); padding: 6px; border-radius: 14px; border: 1px solid rgba(255, 255, 255, 0.1); display: flex; flex-direction: column; gap: 3px; box-shadow: 0 18px 36px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.05); overflow: hidden; position: relative; z-index: 4; backdrop-filter: blur(20px) saturate(1.24); }
        #ratchet-master-container .hud-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-width: 0; padding: 3px 8px; background: rgba(255, 255, 255, 0.045); border: 1px solid rgba(148, 177, 214, 0.08); border-radius: 999px; flex: 1 1 0; min-height: 0; }
        #ratchet-master-container .hud-label { color: var(--hud-text-soft); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.34px; }
        #ratchet-master-container .hud-val { color: var(--hud-text); font-size: 12px; font-weight: 800; font-family: "Roboto Mono", monospace; text-align: right; }
        #ratchet-master-container .hud-meta-row { gap: 8px; padding: 0 2px; flex: 0 0 auto; position: relative; z-index: 4; }
        #ratchet-master-container .hud-meta-chip { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: 1 1 0; min-width: 0; padding: 8px 10px; background: var(--hud-panel); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 14px; overflow: hidden; box-shadow: 0 16px 34px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.05); backdrop-filter: blur(20px) saturate(1.24); }
        #ratchet-master-container .gear-text { font-style: italic; font-weight: 900; text-transform: uppercase; }
        #ratchet-master-container .gear-1-text { color: #94a3b8; }
        #ratchet-master-container .gear-2-text { color: #cbd5e1; }
        #ratchet-master-container .gear-3-text { color: #facc15; }
        #ratchet-master-container .gear-4-text { color: #fb923c; }
        #ratchet-master-container .gear-5-text { color: #f43f5e; text-shadow: 0 0 8px rgba(244, 63, 94, 0.4); }
        #ratchet-master-container .hud-footer-slot { display: flex; flex: 0 0 auto; min-width: 0; min-height: 88px; max-height: 88px; overflow: hidden; position: relative; z-index: 5; }
        #ratchet-master-container .hud-footer-slot > .sc-1d9445d-1 {
            width: 100% !important;
            height: 100% !important;
            display: flex !important;
            gap: 8px !important;
            align-items: stretch !important;
            background: transparent !important;
            overflow: hidden !important;
        }
        #ratchet-master-container .hud-footer-slot > .sc-1d9445d-1 > * {
            flex: 1 1 0 !important;
            min-width: 0 !important;
            display: flex !important;
            flex-direction: column !important;
            justify-content: space-between !important;
            gap: 8px !important;
            padding: 10px 12px !important;
            background: var(--hud-panel) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            border-radius: 14px !important;
            box-shadow: 0 16px 34px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.05) !important;
            overflow: hidden !important;
            backdrop-filter: blur(20px) saturate(1.24) !important;
        }
        #ratchet-master-container .hud-footer-slot > .sc-1d9445d-1 > * > span {
            color: var(--hud-text-soft) !important;
            font-size: 12px !important;
            font-weight: 700 !important;
            text-transform: none !important;
            text-align: left !important;
        }
        #ratchet-master-container .hud-footer-slot .sc-7201bf1a-0,
        #ratchet-master-container .hud-footer-slot .sc-7201bf1a-1,
        #ratchet-master-container .hud-footer-slot .sc-7201bf1a-2 { width: 100% !important; }
        #ratchet-master-container .hud-footer-slot .sc-7201bf1a-1 {
            background: rgba(8, 11, 18, 0.78) !important;
            border: 1px solid rgba(142, 174, 212, 0.18) !important;
            border-radius: 11px !important;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04) !important;
            padding: 0 10px !important;
        }
        #ratchet-master-container .hud-footer-slot .sc-7201bf1a-2 { display: flex !important; align-items: center !important; gap: 8px !important; }
        #ratchet-master-container .hud-footer-slot .sc-941e0ad-0,
        #ratchet-master-container .hud-footer-slot .sc-4932c000-0 {
            display: block !important;
            width: 100% !important;
            min-width: 0 !important;
            background: rgba(8, 11, 18, 0.78) !important;
            border: 1px solid rgba(142, 174, 212, 0.18) !important;
            border-radius: 9px !important;
            color: var(--hud-text) !important;
            font-size: 12px !important;
            font-weight: 800 !important;
            font-family: "Roboto Mono", monospace !important;
            padding: 6px 10px !important;
            box-shadow: none !important;
        }
        #ratchet-master-container .hud-footer-slot .sc-4932c000-1 {
            color: var(--hud-text) !important;
            font-size: 12px !important;
            font-weight: 800 !important;
            font-family: "Roboto Mono", monospace !important;
        }
        #ratchet-master-container .hud-footer-slot .sc-7201bf1a-4 {
            margin-left: auto !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            min-width: 20px !important;
            color: var(--hud-text-soft) !important;
        }
        #ratchet-master-container .hud-footer-slot .sc-7201bf1a-4 svg path { fill: var(--hud-text-soft) !important; }
        #ratchet-master-container .hud-footer-slot .sc-7201bf1a-1:hover { border-color: rgba(25, 243, 255, 0.52) !important; box-shadow: 0 0 0 1px rgba(255, 79, 216, 0.16) inset !important; }
        #ratchet-master-container .hud-native-game-footer-slot { display: flex; flex: 0 0 auto; min-height: 0; min-width: 0; overflow: hidden; }
        @media (max-width: 980px) {
            #ratchet-master-container { padding: 6px !important; }
            #ratchet-master-container .hud-frame { flex-direction: column !important; }
            #ratchet-master-container .hud-native-sidebar-slot {
                width: 100% !important;
                min-width: 0 !important;
                max-width: none !important;
                flex: 0 0 auto !important;
                max-height: 240px !important;
            }
            #ratchet-master-container .hud-footer-slot {
                min-height: 0 !important;
                max-height: none !important;
            }
            #ratchet-master-container .hud-footer-slot > .sc-1d9445d-1 {
                flex-direction: column !important;
                height: auto !important;
            }
        }
        .result.svelte-1oweb16, .multiplier-result, .result-multiplier, .crash-result, .limbo-result, [class*="crash"], [class*="result"][class*="multiplier"], span.result { display: none !important; }
        /* === HIDE DICE SLIDER (thumb/track) that bleeds through HUD === */
        .sc-1d9445d-12.dVJOJA,
        .sc-1d9445d-5.dWEMRV,
        .sc-1d9445d-13.ktRmlk {
            display: none !important;
        }
    `);

    function getUserSetMultiplier() {
        const inpTarget = document.querySelector('input[aria-label="payout selector"]');
        if (inpTarget) return parseFloat(inpTarget.value) || 2.00;
        const inpDice = document.querySelector('input.sc-941e0ad-0.eaPPXw');
        if (inpDice) return parseFloat(inpDice.value) || 1.98;
        return 2;
    }
    function findBalanceContainer() {
        const titled = document.querySelectorAll('div[title$=" SOL"]');
        for (const el of titled) {
            if (/^[\d.,]+\s+SOL$/.test((el.getAttribute('title') || '').trim())) return el;
        }
        return document.querySelector('.sc-cfbf8337-1.eaQLvl') || null;
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
    function getCurrentBalance() {
        // Always returns SOL. Outer title "X SOL" is invariant to display mode.
        const bal = findBalanceContainer();
        if (!bal) return lastKnownBalance || 0;
        const title = bal.getAttribute('title') || '';
        const match = title.match(/([\d.]+)/);
        if (match) {
            const val = parseFloat(match[1]);
            if (isFinite(val)) {
                lastKnownBalance = val;
                return val;
            }
        }
        return lastKnownBalance || 0;
    }
    function getCurrentBet() {
        // Returns SOL-equivalent. Input value is in active display unit.
        const wagerInp = document.querySelector('input[aria-label="wager"]');
        if (!wagerInp) return minBaseBet;
        const rawVal = parseFloat(wagerInp.value.replace(/[^0-9.]/g, ''));
        if (!isFinite(rawVal) || rawVal <= 0) return minBaseBet;
        return displayToSol(rawVal);
    }
    function formatBetForInput(solAmount) {
        if (!isUSDDisplayMode()) return solAmount.toFixed(8);
        const usd = solToDisplay(solAmount);
        const twoDp = usd.toFixed(2);
        // 2dp USD for clean display, but keep 8dp when 2dp would round to 0
        return (parseFloat(twoDp) === 0 && solAmount > 0) ? usd.toFixed(8) : twoDp;
    }
    function typeIntoInput(inp, value) {
        inp.focus();
        try {
            inp.select();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, value);
        } catch (e) {
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(inp, value);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.blur();
    }
    function setBet(amount) {
        if (!isFinite(amount) || amount < minBaseBet) return false;
        const clamped = Math.min(Math.max(amount, minBaseBet), maxBaseBet);
        desiredBetAmount = clamped;
        lastPlacedBet = clamped;
        const inp = document.querySelector('input[aria-label="wager"]');
        if (!inp) return false;
        typeIntoInput(inp, formatBetForInput(clamped));
        setTimeout(() => {
            if (desiredBetAmount) {
                const currentDisplay = parseFloat(inp.value) || 0;
                const targetDisplay = solToDisplay(desiredBetAmount);
                const tol = isUSDDisplayMode() ? 0.005 : 0.00000005;
                if (Math.abs(currentDisplay - targetDisplay) > tol) {
                    typeIntoInput(inp, formatBetForInput(desiredBetAmount));
                }
            }
        }, 50);
        return true;
    }
    function forceSetBet(amount) {
        setBet(amount);
        setTimeout(() => setBet(amount), 8);
        setTimeout(() => setBet(amount), 25);
        setTimeout(() => setBet(amount), 60);
        setTimeout(() => setBet(amount), 120);
    }
    function startBetGuardian() {
        if (betGuardObserver) return;
        const inp = document.querySelector('input[aria-label="wager"]');
        if (!inp) return;
        betGuardObserver = new MutationObserver(() => {
            if (!desiredBetAmount || !isRapidFiring) return;
            const currentDisplay = parseFloat(inp.value) || 0;
            const targetDisplay = solToDisplay(desiredBetAmount);
            const tol = isUSDDisplayMode() ? 0.005 : 0.00000005;
            if (Math.abs(currentDisplay - targetDisplay) > tol) {
                typeIntoInput(inp, formatBetForInput(desiredBetAmount));
            }
        });
        betGuardObserver.observe(inp, { attributes: true, attributeFilter: ['value'] });
    }
    function stopBetGuardian() {
        if (betGuardObserver) {
            betGuardObserver.disconnect();
            betGuardObserver = null;
        }
        desiredBetAmount = null;
    }
    function getPlayButton() {
        let btn = document.querySelector('.sc-fe9b8b64-1.fmKmkj button.sc-67df7f38-0.kkdRMi');
        if (btn) return btn;
        return Array.from(document.querySelectorAll('button')).find(b =>
            (b.textContent || '').trim().includes('PLAY') || (b.textContent || '').trim().includes('ROLL')
        );
    }
    function findPastBetsContainer() {
        return document.querySelector('.sc-9b1418e2-1') || document.querySelector('.sc-9b1418e2-0');
    }
    function isWin(betDiv) {
        if (!betDiv) return false;
        const style = window.getComputedStyle(betDiv);
        return style.backgroundColor.includes('40, 67, 50');
    }
    function getLatestBetEntry(container) {
        if (!container) return null;
        const elements = container.querySelectorAll('.styles-module___IID9a__game');
        if (elements.length === 0) return null;
        const latest = elements[0];
        const id = latest.textContent.trim() + elements.length;
        return { element: latest, id };
    }
    function getLowestCommonAncestor(a, b) {
        if (!a || !b) return null;
        const ancestors = new Set();
        let node = a;
        while (node) {
            ancestors.add(node);
            node = node.parentElement;
        }
        node = b;
        while (node) {
            if (ancestors.has(node)) return node;
            node = node.parentElement;
        }
        return null;
    }
    function getHudHost() {
        const nativeSidebar = findNativeElement('.sc-8d275cfe-1.eGfUZM') || findNativeElement('.sc-8d275cfe-1');
        const nativeStage = findNativeElement('.sc-8d275cfe-3.eertbI') || findNativeElement('.sc-8d275cfe-3');
        const sharedHost = getLowestCommonAncestor(nativeSidebar, nativeStage);
        if (sharedHost && sharedHost !== document.body && sharedHost !== document.documentElement) {
            return sharedHost;
        }
        return nativeStage
            || nativeSidebar
            || document.querySelector('.sc-1d9445d-0.cCJWrI')
            || document.querySelector('.sc-1d9445d-0')
            || document.body;
    }
    function findNativeElement(selector) {
        const elements = Array.from(document.querySelectorAll(selector));
        return elements.find(el => !el.closest('#ratchet-master-container')) || elements[0] || null;
    }
    function mountSingleElement(slot, element) {
        if (!slot || !element) return;
        if (slot.childElementCount === 1 && slot.firstElementChild === element) return;
        slot.replaceChildren(element);
    }
    function syncNativeHudElements() {
        const nativeSidebar = findNativeElement('.sc-8d275cfe-1.eGfUZM') || findNativeElement('.sc-8d275cfe-1');
        const recentBets = findNativeElement('.sc-9b1418e2-1') || findNativeElement('.sc-9b1418e2-0');
        const sidebarSlot = document.getElementById('hud-native-sidebar-slot');
        const pastBetsSlot = document.getElementById('hud-native-past-bets-slot');
        mountSingleElement(sidebarSlot, nativeSidebar);
        mountSingleElement(pastBetsSlot, recentBets);
        mountSingleElement(
            document.getElementById('hud-footer-slot'),
            findNativeElement('.sc-1d9445d-1.hFwXoL') || findNativeElement('.sc-1d9445d-1')
        );
    }
    function buildHUD() {
        const gameDisplay = getHudHost();
        if (!gameDisplay) return;
        let hud = document.getElementById('ratchet-master-container');
        if (window.getComputedStyle(gameDisplay).position === 'static') gameDisplay.style.position = 'relative';
        if (hud && hud.parentElement !== gameDisplay) gameDisplay.appendChild(hud);
        if (!hud) {
            hud = document.createElement('div');
            hud.id = 'ratchet-master-container';
            hud.innerHTML = `
                <div class="hud-frame">
                    <div id="hud-native-sidebar-slot" class="hud-native-sidebar-slot"></div>
                    <div class="hud-workspace">
                        <div id="hud-native-past-bets-slot" class="hud-native-past-bets-slot"></div>
                        <div class="mode-wrap">
                            <button id="mode-manual" class="mode-btn">Manual</button>
                            <button id="mode-iow" class="mode-btn">IOW</button>
                            <button id="mode-smart" class="mode-btn">Smart</button>
                        </div>
                        <div id="hud-content"></div>
                        <div id="hud-footer-slot" class="hud-footer-slot"></div>
                    </div>
                </div>
                <div id="hud-native-game-footer-slot" class="hud-native-game-footer-slot"></div>
            `;
            gameDisplay.appendChild(hud);
            document.getElementById('mode-manual').onclick = () => switchMode('manual');
            document.getElementById('mode-iow').onclick = () => switchMode('iow');
            document.getElementById('mode-smart').onclick = () => switchMode('smart');
            buildHUDContent();
        }
        hud.dataset.mode = ACTIVE_MODE;
        hud.style.removeProperty('height');
        syncModeButtons();
        syncNativeHudElements();
        setTimeout(syncNativeHudElements, 350);
    }
    function buildHUDContent() {
        const content = document.getElementById('hud-content');
        const hud = document.getElementById('ratchet-master-container');
        if (!content) return;
        if (hud) hud.dataset.mode = ACTIVE_MODE;
        syncModeButtons();
        content.innerHTML = '';
        let html = '';
        if (ACTIVE_MODE === 'iow') {
            html = `
                <div class="hud-shell">
                    <div class="hud-top-bar">
                        <div class="control-section hud-panel">
                            <div class="input-row">
                                <div class="input-cluster">
                                    <label style="color:#94a3b8;font-size:10px;font-weight:800;white-space:nowrap;">Base bet</label>
                                    <div class="input-group">
                                        <input id="h-base" type="number" step="0.00000001" value="${baseBet.toFixed(8)}">
                                        <button id="h-double-base" class="quick-btn">2x</button>
                                        <button id="h-half-base" class="quick-btn">1/2</button>
                                    </div>
                                    <div class="hud-risk-container">
                                        <label>Win increase % <input id="h-win-inc" type="number" min="0" value="${winIncreasePercent}"></label>
                                        <label>Loss reset <input id="h-loss-reset" type="number" min="1" value="${lossStreakReset}"></label>
                                        <label>Win reset <input id="h-wins-reset" type="number" min="1" value="${winsBeforeReset || ''}"></label>
                                        <label>Autostop on Balance: <input id="h-autostop" type="number" step="0.00000001" value="${autoStopBalance !== null ? autoStopBalance.toFixed(8) : ''}" placeholder="OFF"></label>
                                    </div>
                                </div>
                                <div class="btn-group">
                                    <button id="h-reset" class="hud-reset-btn">RESET STATS</button>
                                    <button id="h-rapid-toggle" class="hud-rapid-btn start">START</button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="hud-split">
                        <div class="hud-pane primary">
                            <div class="status-bar" id="h-target"> base bet: 0.00000010 | Wins: 0 | LossStreak: 0 </div>
                            <div class="hud-graph-box" id="h-graph-box">
                                <canvas id="h-custom-graph"></canvas>
                            </div>
                        </div>
                        <div class="hud-pane secondary">
                            <div class="hud-stat-rail">
                                <div class="hud-stat-card">
                                    <div class="hud-row"><span class="hud-label">Starting Balance</span><span id="h-start-bal" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Profit/Loss</span><span id="h-profit" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Balance</span><span id="h-peak-bal" class="hud-val" style="color:var(--hud-positive);">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Profit</span><span id="h-high-profit" class="hud-val" style="color:var(--hud-positive);">0.00</span></div>
                                </div>
                                <div class="hud-stat-card">
                                    <div class="hud-row"><span class="hud-label">Session RTP</span><span id="h-rtp" class="hud-val">100.00%</span></div>
                                    <div class="hud-row"><span class="hud-label">Total Wagered</span><span id="h-wagered" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Total Bets</span><span id="h-total-bets" class="hud-val">0</span></div>
                                    <div class="hud-row"><span class="hud-label">Wins / Losses</span><span id="h-wl" class="hud-val">0 / 0</span></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        } else if (ACTIVE_MODE === 'smart') {
            html = `
                <div class="hud-shell">
                    <div class="hud-header">
                        <span id="h-target" class="hud-target-text">Initializing Data Link...</span>
                    </div>
                    <div class="hud-controls-deck hud-panel">
                        <div class="hud-control-group">
                            <label>Aggression <span id="h-agg-val" style="color:#fff;">${aggressionLevel.toFixed(1)}x</span></label>
                            <input type="range" id="h-agg" min="0.5" max="3.0" step="0.1" value="${aggressionLevel.toFixed(1)}">
                        </div>
                        <div class="hud-control-group">
                            <label style="flex-direction: row; justify-content: flex-start; gap: 6px; cursor: pointer; color: #94a3b8;">
                                <input type="checkbox" id="h-lock-agg-chk" ${lockAggressionState ? 'checked' : ''}> Lock State
                            </label>
                            <select id="h-lock-gear-sel" ${lockAggressionState ? '' : 'disabled'}>
                                <option value="1" ${lockedGearLevel === 1 ? 'selected' : ''}>Conservative</option>
                                <option value="2" ${lockedGearLevel === 2 ? 'selected' : ''}>Steady</option>
                                <option value="3" ${lockedGearLevel === 3 ? 'selected' : ''}>Balanced</option>
                                <option value="4" ${lockedGearLevel === 4 ? 'selected' : ''}>Press</option>
                                <option value="5" ${lockedGearLevel === 5 ? 'selected' : ''}>Aggro</option>
                            </select>
                        </div>
                        <div class="hud-control-group">
                            <label>Stop Loss %</label>
                            <input id="h-sl" type="number" min="0" max="50" value="0" step="0.5">
                        </div>
                        <div class="hud-control-group">
                            <label>Take Profit %</label>
                            <input id="h-tp" type="number" min="0" max="100" value="0" step="0.5">
                        </div>
                        <div class="btn-group">
                            <button id="h-reset" class="hud-reset-btn">RESET</button>
                            <button id="h-rapid-toggle" class="hud-rapid-btn start">START</button>
                        </div>
                    </div>
                    <div class="hud-body">
                        <div class="graph-col">
                            <div class="hud-graph-box">
                                <canvas id="h-custom-graph"></canvas>
                            </div>
                        </div>
                        <div class="stats-col">
                            <div class="hud-stats-grid">
                                <div class="stats-col-inner">
                                    <div class="hud-row"><span class="hud-label">Starting Balance</span><span id="h-start-bal" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Profit/Loss</span><span id="h-profit" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Balance</span><span id="h-peak-bal" class="hud-val" style="color:var(--hud-positive);">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Profit</span><span id="h-high-profit" class="hud-val" style="color:var(--hud-positive);">0.00</span></div>
                                </div>
                                <div class="stats-col-inner">
                                    <div class="hud-row"><span class="hud-label">Total Bets</span><span id="h-total-bets" class="hud-val">0</span></div>
                                    <div class="hud-row"><span class="hud-label">Total Wagered</span><span id="h-wagered" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Wins / Losses</span><span id="h-wl" class="hud-val">0 / 0</span></div>
                                    <div class="hud-row"><span class="hud-label">Session RTP</span><span id="h-rtp" class="hud-val">100.00%</span></div>
                                </div>
                                <div class="stats-col-inner">
                                    <div class="hud-row"><span class="hud-label">Aggression state</span><span id="h-state" class="hud-val gear-text gear-1-text">GEAR 1</span></div>
                                    <div class="hud-row"><span class="hud-label">Momentum Window</span><span id="h-hot" class="hud-val">0/0</span></div>
                                    <div class="hud-row"><span class="hud-label">Streak (W|L)</span><span id="h-streaks" class="hud-val">0/0 | 0/0</span></div>
                                    <div class="hud-row"><span class="hud-label">Multiplier Performance</span><span id="h-mult-perf" class="hud-val">1 in 0.00</span></div>
                                </div>
                            </div>
                            <div class="hud-meta-row">
                                <div class="hud-meta-chip">
                                    <span class="hud-label">Best Streaks</span>
                                    <span id="h-best-w" class="hud-val" style="color:var(--hud-positive);">-</span>
                                </div>
                                <div class="hud-meta-chip">
                                    <span class="hud-label">Worst Streaks</span>
                                    <span id="h-worst-l" class="hud-val" style="color:var(--hud-negative);">-</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        } else {
            html = `
                <div class="hud-shell">
                    <div class="hud-header">
                        <span id="h-target" class="hud-target-text">Manual • Full Stats • Spacebar Rapid</span>
                    </div>
                    <div class="hud-controls-deck hud-panel">
                        <div class="hud-control-group">
                            <label>Stop Loss %</label>
                            <input id="h-sl" type="number" min="0" max="50" value="0" step="0.5">
                        </div>
                        <div class="hud-control-group">
                            <label>Take Profit %</label>
                            <input id="h-tp" type="number" min="0" max="100" value="0" step="0.5">
                        </div>
                        <div class="btn-group">
                            <button id="h-reset" class="hud-reset-btn">RESET</button>
                            <button id="h-rapid-toggle" class="hud-rapid-btn start">START</button>
                        </div>
                    </div>
                    <div class="hud-body">
                        <div class="graph-col">
                            <div class="hud-graph-box">
                                <canvas id="h-custom-graph"></canvas>
                            </div>
                        </div>
                        <div class="stats-col">
                            <div class="hud-stats-grid">
                                <div class="stats-col-inner">
                                    <div class="hud-row"><span class="hud-label">Starting Balance</span><span id="h-start-bal" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Profit/Loss</span><span id="h-profit" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Balance</span><span id="h-peak-bal" class="hud-val" style="color:var(--hud-positive);">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Profit</span><span id="h-high-profit" class="hud-val" style="color:var(--hud-positive);">0.00</span></div>
                                </div>
                                <div class="stats-col-inner">
                                    <div class="hud-row"><span class="hud-label">Total Bets</span><span id="h-total-bets" class="hud-val">0</span></div>
                                    <div class="hud-row"><span class="hud-label">Total Wagered</span><span id="h-wagered" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Wins / Losses</span><span id="h-wl" class="hud-val">0 / 0</span></div>
                                    <div class="hud-row"><span class="hud-label">Session RTP</span><span id="h-rtp" class="hud-val">100.00%</span></div>
                                    <div class="hud-row"><span class="hud-label">Streak (W|L)</span><span id="h-streaks" class="hud-val">0/0 | 0/0</span></div>
                                </div>
                                <div class="stats-col-inner">
                                    <div class="hud-meta-row">
                                        <div class="hud-meta-chip">
                                            <span class="hud-label">Best Streaks</span>
                                            <span id="h-best-w" class="hud-val" style="color:var(--hud-positive);">-</span>
                                        </div>
                                        <div class="hud-meta-chip">
                                            <span class="hud-label">Worst Streaks</span>
                                            <span id="h-worst-l" class="hud-val" style="color:var(--hud-negative);">-</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }
        content.innerHTML = html;
        attachListeners();
    }
    function switchMode(newMode) {
        if (newMode === ACTIVE_MODE) return;
        ACTIVE_MODE = newMode;
        syncModeButtons();
        if (isRapidFiring) stopRapidFire();
        buildHUDContent();
        resetStats();
    }
    function syncModeButtons() {
        document.querySelectorAll('#ratchet-master-container .mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.id === `mode-${ACTIVE_MODE}`);
        });
    }
    function attachListeners() {
        const rapidBtn = document.getElementById('h-rapid-toggle');
        if (rapidBtn) rapidBtn.onclick = () => { if (!isRapidFiring) startRapidFire(); else stopRapidFire(); };
        const resetBtn = document.getElementById('h-reset');
        if (resetBtn) resetBtn.onclick = resetStats;
        if (ACTIVE_MODE === 'iow') {
            const baseInp = document.getElementById('h-base');
            if (baseInp) {
                baseInp.addEventListener('input', () => { baseBet = parseFloat(baseInp.value) || minBaseBet; });
                baseInp.addEventListener('blur', () => { let v = parseFloat(baseInp.value) || minBaseBet; baseInp.value = v.toFixed(8); baseBet = v; });
            }
            const doubleBtn = document.getElementById('h-double-base');
            if (doubleBtn) doubleBtn.addEventListener('click', () => {
                let val = parseFloat(document.getElementById('h-base').value) || minBaseBet;
                val *= 2;
                document.getElementById('h-base').value = val.toFixed(8);
                baseBet = val;
                if (isRapidFiring) forceSetBet(val);
            });
            const halfBtn = document.getElementById('h-half-base');
            if (halfBtn) halfBtn.addEventListener('click', () => {
                let val = parseFloat(document.getElementById('h-base').value) || minBaseBet;
                val *= 0.5;
                val = Math.max(minBaseBet, val);
                document.getElementById('h-base').value = val.toFixed(8);
                baseBet = val;
                if (isRapidFiring) forceSetBet(val);
            });
            const winInc = document.getElementById('h-win-inc'); if (winInc) winInc.addEventListener('input', () => { winIncreasePercent = parseFloat(winInc.value) || 125; });
            const lossReset = document.getElementById('h-loss-reset'); if (lossReset) lossReset.addEventListener('input', () => { lossStreakReset = parseInt(lossReset.value, 10) || 3; });
            const winsReset = document.getElementById('h-wins-reset'); if (winsReset) winsReset.addEventListener('input', () => { winsBeforeReset = parseInt(winsReset.value, 10) || null; });
            const autostopInp = document.getElementById('h-autostop');
            if (autostopInp) {
                autostopInp.addEventListener('input', () => { autoStopBalance = parseFloat(autostopInp.value) || null; });
                autostopInp.addEventListener('blur', () => { let v = parseFloat(autostopInp.value) || 0; autostopInp.value = v ? v.toFixed(8) : ''; autoStopBalance = v || null; });
            }
        } else {
            const slInp = document.getElementById('h-sl'); if (slInp) slInp.addEventListener('input', () => { stopLossPct = parseFloat(slInp.value) || 0; });
            const tpInp = document.getElementById('h-tp'); if (tpInp) tpInp.addEventListener('input', () => { takeProfitPct = parseFloat(tpInp.value) || 0; });
            if (ACTIVE_MODE === 'smart') {
                const aggInp = document.getElementById('h-agg');
                if (aggInp) aggInp.addEventListener('input', e => { aggressionLevel = parseFloat(e.target.value); const valEl = document.getElementById('h-agg-val'); if (valEl) valEl.textContent = `${aggressionLevel.toFixed(1)}x`; });
                const lockChk = document.getElementById('h-lock-agg-chk');
                const gearSel = document.getElementById('h-lock-gear-sel');
                if (lockChk && gearSel) {
                    lockChk.addEventListener('change', (e) => {
                        lockAggressionState = e.target.checked;
                        gearSel.disabled = !lockAggressionState;
                        updateUI();
                    });
                    gearSel.addEventListener('change', (e) => {
                        lockedGearLevel = parseInt(e.target.value, 10);
                        updateUI();
                    });
                }
            }
        }
    }
    function resetStats() {
        const bal = getCurrentBalance();
        sessionPeak = bal; initialBalance = bal; lastKnownBalance = bal;
        totalWagered = 0; highestProfit = 0; totalWins = 0; totalLosses = 0; totalBets = 0;
        lossStreak = 0; counter = 0; lastBetId = null; profitHistory = [0]; lastAmount = 0;
        betHistory = []; recentWins = []; topWinStreaks = []; topLossStreaks = [];
        curLossStreak = 0; maxLossStreak = 0; curWinStreak = 0; maxWinStreak = 0;
        multGames = 0; multWins = 0; lastResult = null; autoPaused = false; stopLossPct = 0; takeProfitPct = 0;
        rapidBlockedSince = 0; rapidFireStartedAt = 0; lastObservedBetTime = 0;
        lastPlacedBet = baseBet;
        if (isRapidFiring) stopRapidFire();
        if (ACTIVE_MODE === 'iow') {
            const baseInp = document.getElementById('h-base'); if (baseInp) baseInp.value = baseBet.toFixed(8);
        } else if (ACTIVE_MODE === 'smart') {
            const aggInp = document.getElementById('h-agg'); if (aggInp) aggInp.value = aggressionLevel.toFixed(1);
            const valEl = document.getElementById('h-agg-val'); if (valEl) valEl.textContent = `${aggressionLevel.toFixed(1)}x`;
        }
        const sl = document.getElementById('h-sl'); if (sl) sl.value = '0';
        const tp = document.getElementById('h-tp'); if (tp) tp.value = '0';
        syncLastSeenBet();
        updateUI();
    }
    function syncLastSeenBet(container = pastBetsContainer || findPastBetsContainer()) {
        const latestBet = getLatestBetEntry(container);
        lastBetId = latestBet ? latestBet.id : null;
    }
    function triggerWinResetPulse() {
        const hud = document.getElementById('ratchet-master-container');
        if (!hud || ACTIVE_MODE !== 'iow') return;
        if (winResetPulseTimer) clearTimeout(winResetPulseTimer);
        hud.classList.remove('iow-win-reset-pulse');
        void hud.offsetWidth;
        hud.classList.add('iow-win-reset-pulse');
        winResetPulseTimer = setTimeout(() => {
            hud.classList.remove('iow-win-reset-pulse');
            winResetPulseTimer = null;
        }, 800);
    }
    function startObserver() {
        pastBetsContainer = findPastBetsContainer();
        if (!pastBetsContainer) { setTimeout(startObserver, 500); return; }
        if (observer) observer.disconnect();
        syncLastSeenBet(pastBetsContainer);
        observer = new MutationObserver(() => processNewBet(pastBetsContainer));
        observer.observe(pastBetsContainer, { childList: true, subtree: true });
    }
    function processNewBet(container) {
        const latestBet = getLatestBetEntry(container);
        if (!latestBet || latestBet.id === lastBetId) return;
        lastBetId = latestBet.id;
        lastObservedBetTime = Date.now();
        rapidBlockedSince = 0;
        totalBets++;
        const betAmt = getCurrentBet();
        const won = isWin(latestBet.element);
        handleBetResult(won, betAmt);
        if (ACTIVE_MODE === 'iow') {
            if (won) {
                lossStreak = 0; counter++;
                if (isRapidFiring) {
                    const curBet = lastPlacedBet;
                    let newBet = curBet * (1 + winIncreasePercent / 100);
                    newBet = Math.min(newBet, maxBaseBet);
                    forceSetBet(newBet);
                    lastPlacedBet = newBet;
                }
                if (winsBeforeReset && counter >= winsBeforeReset) {
                    counter = 0;
                    triggerWinResetPulse();
                    if (isRapidFiring) {
                        forceSetBet(baseBet);
                        lastPlacedBet = baseBet;
                    }
                }
            } else {
                lossStreak++;
                if (lossStreak >= lossStreakReset) {
                    counter = 0;
                    if (isRapidFiring) {
                        forceSetBet(baseBet);
                        lastPlacedBet = baseBet;
                    }
                }
            }
            if (isRapidFiring && autoStopBalance && getCurrentBalance() >= autoStopBalance) stopRapidFire();
        }
        updateUI();
    }
    function handleBetResult(isWinResult, betAmt) {
        if (isWinResult) totalWins++; else totalLosses++;
        totalWagered += betAmt || minBaseBet;
        const currentProfit = getCurrentBalance() - initialBalance;
        if (currentProfit > highestProfit) highestProfit = currentProfit;
        profitHistory.push(currentProfit); if (profitHistory.length > MAX_GRAPH_POINTS) profitHistory.shift();
        if (isWinResult) {
            if (lastResult === false && curLossStreak > 0) { topLossStreaks.push(curLossStreak); topLossStreaks.sort((a,b)=>b-a); if (topLossStreaks.length > 10) topLossStreaks.pop(); }
            curWinStreak++; curLossStreak = 0; multWins++;
        } else {
            if (lastResult === true && curWinStreak > 0) { topWinStreaks.push(curWinStreak); topWinStreaks.sort((a,b)=>b-a); if (topWinStreaks.length > 10) topWinStreaks.pop(); }
            curLossStreak++; curWinStreak = 0;
        }
        lastResult = isWinResult;
        betHistory.push(isWinResult); recentWins.push(isWinResult);
        if (recentWins.length > 10) recentWins.shift();
        if (betHistory.length > historyWindow) betHistory.shift();
        multGames++;
        maxLossStreak = Math.max(maxLossStreak, curLossStreak);
        maxWinStreak = Math.max(maxWinStreak, curWinStreak);
        if ((ACTIVE_MODE === 'smart' || ACTIVE_MODE === 'manual')) {
            if (stopLossPct > 0 && currentProfit <= -initialBalance * (stopLossPct / 100)) autoPaused = true;
            if (takeProfitPct > 0 && currentProfit >= initialBalance * (takeProfitPct / 100)) autoPaused = true;
            if (autoPaused && isRapidFiring) stopRapidFire();
        }
    }
    function updateClicks(cps) {
        if (clickInterval) { clearInterval(clickInterval); clickInterval = null; }
        if (cps > 0 && playButton) {
            const clickIntervalTime = 1000 / cps;
            clickInterval = setInterval(() => { playButton.click(); }, clickIntervalTime);
        }
    }
    function updateSpacePWM(duty) {
        if (spaceTimeout) { clearTimeout(spaceTimeout); spaceTimeout = null; }
        if (spaceInterval) { clearInterval(spaceInterval); spaceInterval = null; }
        if (isSpaceHeldDown && duty !== 100) {
            simulateKeyUp(32);
            isSpaceHeldDown = false;
        }
        if (duty <= 0) { if (!isSpaceHeldDown) simulateKeyUp(32); return; }
        if (duty === 100) {
            if (!isSpaceHeldDown) {
                simulateKeyDown(32, false);
                isSpaceHeldDown = true;
                spaceTimeout = setTimeout(() => {
                    spaceInterval = setInterval(() => { simulateKeyDown(32, true); }, 30);
                }, 400);
            }
            return;
        }
        const period = 100;
        const downTime = (duty / 100) * period;
        const upTime = period - downTime;
        function pulse() {
            simulateKeyDown(32, false);
            spaceTimeout = setTimeout(() => {
                simulateKeyUp(32);
                spaceTimeout = setTimeout(pulse, upTime);
            }, downTime);
        }
        pulse();
    }
    function simulateKeyDown(keyCode, repeat = false) {
        const downEvent = new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true, repeat: repeat });
        document.dispatchEvent(downEvent);
        const pressEvent = new KeyboardEvent('keypress', { key: ' ', code: 'Space', keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true, repeat: repeat });
        document.dispatchEvent(pressEvent);
    }
    function simulateKeyUp(keyCode) {
        const event = new KeyboardEvent('keyup', { key: ' ', code: 'Space', keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true });
        document.dispatchEvent(event);
    }
    function startRapidFire() {
        if (isRapidFiring) return;
        isRapidFiring = true;
        rapidBlockedSince = 0;
        rapidFireStartedAt = Date.now();
        lastObservedBetTime = 0;
        syncLastSeenBet();
        lastPlacedBet = baseBet;
        if (ACTIVE_MODE === 'iow') forceSetBet(baseBet);
        startBetGuardian();
        updateUI();
        playButton = getPlayButton();
        if (!playButton) {
            console.error('Play button not found!');
            stopRapidFire();
            return;
        }
        updateClicks(30);
        updateSpacePWM(70);
        if (ACTIVE_MODE === 'iow' && !iowEnforcerInterval) {
            iowEnforcerInterval = setInterval(() => {
                if (isRapidFiring && ACTIVE_MODE === 'iow') {
                    const current = getCurrentBet();
                    if (Math.abs(current - lastPlacedBet) > 0.00000005) {
                        forceSetBet(lastPlacedBet);
                    }
                }
            }, 80);
        }
    }
    function stopRapidFire() {
        isRapidFiring = false;
        updateClicks(0);
        if (spaceTimeout) { clearTimeout(spaceTimeout); spaceTimeout = null; }
        if (spaceInterval) { clearInterval(spaceInterval); spaceInterval = null; }
        simulateKeyUp(32);
        isSpaceHeldDown = false;
        if (iowEnforcerInterval) {
            clearInterval(iowEnforcerInterval);
            iowEnforcerInterval = null;
        }
        stopBetGuardian();
        updateUI();
    }
    function monitorRapidFireHealth() {
        if (!isRapidFiring) return;
        const now = Date.now();
        const betBtn = getPlayButton();
        if (!betBtn || betBtn.disabled) {
            if (!rapidBlockedSince) rapidBlockedSince = now;
            if (now - rapidBlockedSince >= RAPID_BLOCKED_STOP_MS) stopRapidFire();
            return;
        }
        rapidBlockedSince = 0;
        const lastSeenBetTime = lastObservedBetTime || rapidFireStartedAt;
        if (lastSeenBetTime && now - lastSeenBetTime >= RAPID_STALL_STOP_MS) stopRapidFire();
    }
    function drawGraph() {
        const canvas = document.getElementById('h-custom-graph');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const width = canvas.width = canvas.offsetWidth;
        const height = canvas.height = canvas.offsetHeight;
        ctx.clearRect(0, 0, width, height);
        if (profitHistory.length < 2) return;
        let maxVal = Math.max(...profitHistory, 0);
        let minVal = Math.min(...profitHistory, 0);
        const range = (maxVal - minVal) || 1;
        const padding = range * 0.15;
        maxVal += padding; minVal -= padding;
        const totalRange = maxVal - minVal;
        const zeroY = height - ((0 - minVal) / totalRange) * height;
        const zeroPct = Math.max(0, Math.min(1, zeroY / height));
        const lineGrad = ctx.createLinearGradient(0, 0, 0, height);
        lineGrad.addColorStop(0, '#43f6ff'); lineGrad.addColorStop(zeroPct, '#43f6ff'); lineGrad.addColorStop(zeroPct, '#ff6bb0'); lineGrad.addColorStop(1, '#ff6bb0');
        const fillGrad = ctx.createLinearGradient(0, 0, 0, height);
        fillGrad.addColorStop(0, 'rgba(67, 246, 255, 0.22)'); fillGrad.addColorStop(zeroPct, 'rgba(67, 246, 255, 0.22)'); fillGrad.addColorStop(zeroPct, 'rgba(255, 107, 176, 0.22)'); fillGrad.addColorStop(1, 'rgba(255, 107, 176, 0.22)');
        const stepX = width / (profitHistory.length - 1);
        ctx.beginPath();
        profitHistory.forEach((val, i) => {
            const x = i * stepX;
            const y = height - ((val - minVal) / totalRange) * height;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = lineGrad; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
        ctx.lineTo(width, zeroY); ctx.lineTo(0, zeroY); ctx.closePath();
        ctx.fillStyle = fillGrad; ctx.fill();
        ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(width, zeroY);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    function formatCurrency(solAmount) {
        if (!isFinite(solAmount)) return '0.00';
        if (isUSDDisplayMode()) {
            const rate = getSolToUsdRate();
            if (rate && rate > 0) {
                const usd = solAmount * rate;
                const sign = usd < 0 ? '-$' : '$';
                return `${sign}${Math.abs(usd).toFixed(2)}`;
            }
        }
        return solAmount.toFixed(8);
    }
    function updateUI() {
        const balance = getCurrentBalance();
        const profit = balance - initialBalance;
        const startBalEl = document.getElementById('h-start-bal'); if (startBalEl) startBalEl.textContent = formatCurrency(initialBalance);
        const profitEl = document.getElementById('h-profit'); if (profitEl) { profitEl.textContent = formatCurrency(profit); profitEl.style.color = profit > 0 ? 'var(--hud-positive)' : (profit < 0 ? 'var(--hud-negative)' : 'var(--hud-text)'); }
        const peakBalEl = document.getElementById('h-peak-bal'); if (peakBalEl) peakBalEl.textContent = formatCurrency(sessionPeak);
        const highProfitEl = document.getElementById('h-high-profit'); if (highProfitEl) highProfitEl.textContent = formatCurrency(highestProfit);
        const wageredEl = document.getElementById('h-wagered'); if (wageredEl) wageredEl.textContent = formatCurrency(totalWagered);
        const rtp = totalWagered > 0 ? ((totalWagered + profit) / totalWagered) * 100 : 100;
        const rtpEl = document.getElementById('h-rtp'); if (rtpEl) { rtpEl.textContent = rtp.toFixed(2) + '%'; rtpEl.style.color = rtp >= 100 ? 'var(--hud-positive)' : 'var(--hud-negative)'; }
        const totalBetsEl = document.getElementById('h-total-bets'); if (totalBetsEl) totalBetsEl.textContent = totalBets;
        const wlEl = document.getElementById('h-wl'); if (wlEl) wlEl.innerHTML = `<span style="color:var(--hud-positive);">${totalWins}</span> / <span style="color:var(--hud-negative);">${totalLosses}</span>`;
        const rapidBtn = document.getElementById('h-rapid-toggle');
        if (rapidBtn) {
            if (isRapidFiring) { rapidBtn.textContent = 'STOP'; rapidBtn.className = 'hud-rapid-btn stop'; }
            else { rapidBtn.textContent = 'START'; rapidBtn.className = 'hud-rapid-btn start'; }
        }
        if (ACTIVE_MODE === 'iow') {
            const targetEl = document.getElementById('h-target');
            if (targetEl) targetEl.innerHTML = `base bet: ${formatCurrency(baseBet)} | Wins: <span style="color:var(--hud-positive)">${counter}</span> | LossStreak: <span style="color:var(--hud-negative)">${lossStreak}</span>`;
        } else if (ACTIVE_MODE === 'smart') {
            const streaksEl = document.getElementById('h-streaks'); if (streaksEl) streaksEl.innerHTML = `<span style="color:var(--hud-positive);">${curWinStreak}/${maxWinStreak}</span> | <span style="color:var(--hud-negative);">${curLossStreak}/${maxLossStreak}</span>`;
            const hotEl = document.getElementById('h-hot'); if (hotEl) hotEl.textContent = `${betHistory.filter(Boolean).length}/${betHistory.length}`;
            const perfEl = document.getElementById('h-mult-perf');
            if (perfEl && multWins > 0) {
                const actualRatio = multGames / multWins;
                const recentHit = recentWins.filter(Boolean).length;
                const recentRatio = recentWins.length > 0 ? recentWins.length / Math.max(1, recentHit) : actualRatio;
                const trend = recentWins.length >= 10 ? (recentRatio <= actualRatio ? ' ▲' : ' ▼') : '';
                const trendColor = recentWins.length >= 10 ? (recentRatio <= actualRatio ? 'var(--hud-positive)' : 'var(--hud-negative)') : 'inherit';
                perfEl.innerHTML = `1 in ${actualRatio.toFixed(2)}<span style="color:${trendColor}; font-size:12px;">${trend}</span>`;
                perfEl.style.color = actualRatio <= (trackedMultiplier || 1) ? 'var(--hud-positive)' : 'var(--hud-negative)';
            }
            const winsCount = betHistory.filter(Boolean).length;
            const progress = winsNeeded > 0 ? winsCount / winsNeeded : 0;
            let gear = 1; let label = 'Gear 1 (Cold)';
            if (lockAggressionState) {
                gear = lockedGearLevel;
                if (gear === 1) label = 'Conservative (LOCKED)';
                else if (gear === 2) label = 'Steady (LOCKED)';
                else if (gear === 3) label = 'Balanced (LOCKED)';
                else if (gear === 4) label = 'Press (LOCKED)';
                else { gear = 5; label = 'Aggro (LOCKED)'; }
            } else {
                if (progress <= 0.4) { gear = 1; label = 'Conservative'; }
                else if (progress <= 0.8) { gear = 2; label = 'Steady'; }
                else if (progress <= 1.1) { gear = 3; label = 'Balanced'; }
                else if (progress <= 1.45) { gear = 4; label = 'Press'; }
                else { gear = 5; label = 'Aggro'; }
            }
            const stateEl = document.getElementById('h-state');
            if (stateEl) { stateEl.textContent = label; stateEl.className = `hud-val gear-text gear-${gear}-text`; }
            const displayW = topWinStreaks.concat([curWinStreak]).filter(x => x > 0).sort((a, b) => b - a).slice(0, 10);
            const displayL = topLossStreaks.concat([curLossStreak]).filter(x => x > 0).sort((a, b) => b - a).slice(0, 10);
            const bestWEl = document.getElementById('h-best-w'); if (bestWEl) bestWEl.textContent = displayW.join(', ') || '-';
            const worstLEl = document.getElementById('h-worst-l'); if (worstLEl) worstLEl.textContent = displayL.join(', ') || '-';
            const targetEl = document.getElementById('h-target');
            const targetMult = getUserSetMultiplier();
            if (targetEl) {
                let txt = `Target: ${targetMult.toFixed(2)}x`;
                if (autoPaused) { targetEl.style.color = 'var(--hud-negative)'; txt = 'PAUSED - THRESHOLD TRIGGERED'; } else { targetEl.style.color = 'var(--hud-text-soft)'; }
                targetEl.innerHTML = txt;
            }
        } else if (ACTIVE_MODE === 'manual') {
            const streaksEl = document.getElementById('h-streaks');
            if (streaksEl) streaksEl.innerHTML = `<span style="color:var(--hud-positive);">${curWinStreak}/${maxWinStreak}</span> | <span style="color:var(--hud-negative);">${curLossStreak}/${maxLossStreak}</span>`;
            const hotEl = document.getElementById('h-hot'); if (hotEl) hotEl.textContent = `${betHistory.filter(Boolean).length}/${betHistory.length}`;
            const displayW = topWinStreaks.concat([curWinStreak]).filter(x => x > 0).sort((a, b) => b - a).slice(0, 10);
            const displayL = topLossStreaks.concat([curLossStreak]).filter(x => x > 0).sort((a, b) => b - a).slice(0, 10);
            const bestWEl = document.getElementById('h-best-w'); if (bestWEl) bestWEl.textContent = displayW.join(', ') || '-';
            const worstLEl = document.getElementById('h-worst-l'); if (worstLEl) worstLEl.textContent = displayL.join(', ') || '-';
            const targetEl = document.getElementById('h-target');
            if (targetEl) {
                targetEl.textContent = isRapidFiring ? '' : '';
                targetEl.style.color = isRapidFiring ? 'var(--hud-positive)' : 'var(--hud-text-soft)';
            }
        }
        drawGraph();
    }
    function updateBetAmount() {
        if (ACTIVE_MODE !== 'smart') return;
        const input = document.querySelector('input[aria-label="wager"]');
        const balance = getCurrentBalance();
        if (!input || !balance) return;
        if (initialBalance === 0) initialBalance = balance;
        sessionPeak = Math.max(sessionPeak, balance);
        const currentMult = getUserSetMultiplier();
        if (currentMult !== trackedMultiplier) {
            trackedMultiplier = currentMult;
            multGames = 0;
            multWins = 0;
            recentWins = [];
        }
        const wins = betHistory.filter(Boolean).length;
        let progress = winsNeeded > 0 ? wins / winsNeeded : 0;
        if (lockAggressionState) {
            if (lockedGearLevel === 1) progress = 0.2;
            else if (lockedGearLevel === 2) progress = 0.6;
            else if (lockedGearLevel === 3) progress = 0.95;
            else if (lockedGearLevel === 4) progress = 1.3;
            else if (lockedGearLevel === 5) progress = 1.6;
        }
        const baseWindow = 30 + Math.round(trackedMultiplier * 8);
        const baseDivisor = 300 + Math.round(trackedMultiplier * 6);
        historyWindow = Math.max(5, Math.round(baseWindow / aggressionLevel));
        safeDivisor = Math.max(15, Math.round(baseDivisor / aggressionLevel));
        winsNeeded = Math.max(1, Math.floor(historyWindow / (trackedMultiplier * 0.8)));
        aggressiveDivisor = Math.max(1, Math.round(safeDivisor * (0.6 / aggressionLevel)));
        const dynamicDivisor = safeDivisor - ((safeDivisor - aggressiveDivisor) * Math.min(1, progress / 1.5));
        let targetBet = (sessionPeak / dynamicDivisor) * aggressionLevel;
        const maxBetPct = Math.min(0.18, 0.05 + aggressionLevel * 0.04);
        targetBet = Math.max(minBaseBet, Math.min(targetBet, balance * maxBetPct));
        if (Math.abs(targetBet - lastAmount) > 0.00000005) {
            lastAmount = targetBet;
            setBet(targetBet);
        }
    }
    function startObserverWrapper() {
        if (!pastBetsContainer || !pastBetsContainer.isConnected) {
            if (observer) observer.disconnect();
            startObserver();
        }
    }
    setInterval(() => {
        buildHUD();
        const bal = getCurrentBalance();
        if (bal > 0.00000001) {
            if (initialBalance === 0) initialBalance = bal;
            sessionPeak = Math.max(sessionPeak, bal);
            lastKnownBalance = bal;
        }
        if (ACTIVE_MODE === 'iow') {
            const baseInp = document.getElementById('h-base'); if (baseInp) baseBet = parseFloat(baseInp.value) || minBaseBet;
            const winIncEl = document.getElementById('h-win-inc'); if (winIncEl) winIncreasePercent = parseFloat(winIncEl.value) || 125;
            const lossResetEl = document.getElementById('h-loss-reset'); if (lossResetEl) lossStreakReset = parseInt(lossResetEl.value, 10) || 3;
            const winsResetEl = document.getElementById('h-wins-reset'); if (winsResetEl) winsBeforeReset = parseInt(winsResetEl.value, 10) || null;
            const autostopEl = document.getElementById('h-autostop'); if (autostopEl) { const v = parseFloat(autostopEl.value); autoStopBalance = !isNaN(v) && v > 0 ? v : null; }
        }
        updateUI();
        startObserverWrapper();
        monitorRapidFireHealth();
        if (ACTIVE_MODE === 'smart') updateBetAmount();
        if (isRapidFiring) startBetGuardian();
        else stopBetGuardian();
    }, 500);
    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key.toLowerCase() === 'r') resetStats();
        if (ACTIVE_MODE === 'smart') {
            if (e.key === ']' || e.key === '[') {
                if (!lockAggressionState) {
                    lockAggressionState = true;
                    const chk = document.getElementById('h-lock-agg-chk');
                    if (chk) chk.checked = true;
                    const sel = document.getElementById('h-lock-gear-sel');
                    if (sel) sel.disabled = false;
                }
                if (e.key === ']') lockedGearLevel = Math.min(5, lockedGearLevel + 1);
                if (e.key === '[') lockedGearLevel = Math.max(1, lockedGearLevel - 1);
                const gearSel = document.getElementById('h-lock-gear-sel');
                if (gearSel) gearSel.value = lockedGearLevel;
                updateUI();
            }
        }
    });
    setTimeout(() => { buildHUD(); startObserver(); }, 800);
    console.log('%c✅ IOW / Smart v3.5 loaded - DICE SLIDER THUMB/TRACK NOW FULLY HIDDEN', 'color:#43f6ff;font-weight:900;font-size:14px');
})();
