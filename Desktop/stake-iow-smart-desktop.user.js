// ==UserScript==
// @name IOW / Smart
// @namespace http://tampermonkey.net/
// @version 1.9
// @description Adds Manual, IOW (Increase on Win), and Smart bet-sizing modes to Stake Dice and Limbo with live stats and compact HUD overlay.
// @author .
// @match https://stake.us/casino/games/dice*
// @match https://stake.us/casino/games/limbo*
// @match https://stake.com/casino/games/dice*
// @match https://stake.com/casino/games/limbo*
// @grant GM_addStyle
// @run-at document-start
// ==/UserScript==
(function () {
    'use strict';
    let ACTIVE_MODE = 'smart';
    let baseBet = 0.01;
    let winIncreasePercent = 125;
    let lossStreakReset = 3;
    let winsBeforeReset = 5;
    let autoStopBalance = null;
    let minBaseBet = 0.01;
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
    let lastAmount = null;
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
    // --- Lock Aggression State variables ---
    let lockAggressionState = false;
    let lockedGearLevel = 1;

    GM_addStyle(`
        #ratchet-master-container,
        #ratchet-master-container * { box-sizing: border-box !important; }
        #ratchet-master-container {
            --hud-bg: rgba(15, 33, 46, 0.97);
            --hud-panel: linear-gradient(180deg, rgba(26, 44, 56, 0.98), rgba(15, 33, 46, 0.96));
            --hud-border: rgba(82, 109, 130, 0.55);

            --hud-border-soft: rgba(255, 255, 255, 0.06);
            --hud-green: #00ff9d;
            --hud-green-dark: #00cc7a;
            --hud-red: #e11d48;
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
            box-shadow: 0 18px
            50px rgba(0, 0, 0, 0.82) !important;
            z-index: auto !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 8px !important;
            font-family: "Proxima Nova", "Segoe UI", sans-serif !important;
            pointer-events: auto !important;
            overflow: hidden !important;
            backdrop-filter: blur(10px);
            line-height: 1.15;
        }
        #ratchet-master-container::after {
            content: '';
            position: absolute;
            inset: 0;
            border-radius: 0;
            pointer-events: none;
            opacity: 0;
            border: 1px solid transparent;
            box-shadow: inset 0 0 0 0 rgba(74, 222, 128, 0), inset 0 0 0 0 rgba(74, 222, 128, 0);
        }
        #ratchet-master-container.iow-win-reset-pulse::after { animation: ratchet-iow-win-reset-pulse 720ms ease-out 1;
        }
        @keyframes ratchet-iow-win-reset-pulse {
            0% { opacity: 0;
            }
            20% { opacity: 1;
            border-color: rgba(74, 222, 128, 0.9); box-shadow: inset 0 0 0 1px rgba(74, 222, 128, 0.75), inset 0 0 18px rgba(74, 222, 128, 0.35);
            }
            55% { opacity: 1;
            border-color: rgba(74, 222, 128, 0.8); box-shadow: inset 0 0 0 2px rgba(74, 222, 128, 0.85), inset 0 0 24px rgba(74, 222, 128, 0.45);
            }
            100% { opacity: 0; border-color: transparent;
            box-shadow: inset 0 0 0 0 rgba(74, 222, 128, 0), inset 0 0 0 0 rgba(74, 222, 128, 0);
            }
        }
        #ratchet-master-container[data-mode="iow"] { min-height: 0 !important;
        }
        #ratchet-master-container .hud-frame { display: flex; flex: 1 1 0; min-height: 0;
        min-width: 0; gap: 8px; overflow: hidden; }
        #ratchet-master-container .hud-workspace { display: flex;
        flex-direction: column; flex: 1 1 0; min-height: 0; min-width: 0; gap: 8px; overflow: hidden;
        }
        #ratchet-master-container .hud-native-sidebar-slot { display: flex; flex: 0 0 300px; width: 300px;
        min-width: 300px; max-width: 300px; min-height: 0; overflow: hidden; }
        #ratchet-master-container .hud-native-sidebar-slot:empty,
        #ratchet-master-container .hud-native-past-bets-slot:empty,
        #ratchet-master-container .hud-native-game-footer-slot:empty,
        #ratchet-master-container .hud-footer-slot:empty { display: none !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot > .game-sidebar { width: 100% !important; height: 100% !important;
        min-width: 0 !important; min-height: 0 !important; display: flex !important; flex-direction: column !important; gap: 0 !important; padding: 0 !important;
        overflow: auto !important; }
        #ratchet-master-container .hud-native-sidebar-slot .sticky-top,
        #ratchet-master-container .hud-native-sidebar-slot .sticky-bottom { position: relative !important;
        top: auto !important; bottom: auto !important; z-index: auto !important; flex: 0 0 auto !important; padding: 8px 8px 0 !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .sticky-bottom { padding: 0 8px 8px !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .sticky-top { margin-top: 40px !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .scrollable-content { flex: 1 1 0 !important; min-height: 0 !important;
        max-height: none !important; overflow: auto !important; padding: 0 8px !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .game-tabs { margin: 0 !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .tabs-wrapper,
        #ratchet-master-container .hud-native-sidebar-slot .slider,
        #ratchet-master-container .hud-native-sidebar-slot .content-wrapper { width: 100% !important;
        }
        #ratchet-master-container .hud-native-past-bets-slot { display: flex; flex: 0 0 auto; min-height: 42px;
        min-width: 0; overflow: hidden; }
        #ratchet-master-container .hud-native-past-bets-slot > .past-bets { width: 100% !important;
        min-width: 0 !important; display: flex !important; gap: 6px !important; padding: 6px !important; background: var(--hud-panel) !important; border: 1px solid var(--hud-border-soft) !important;
        border-radius: 12px !important; overflow-x: auto !important; overflow-y: hidden !important; }
        #ratchet-master-container .hud-native-past-bets-slot > .past-bets > button { flex: 0 0 auto !important;
        }
        #ratchet-master-container #hud-content { display: flex; flex: 1 1 0; min-height: 0;
        min-width: 0; overflow: hidden; }
        #ratchet-master-container .hud-shell { display: flex; flex-direction: column;
        flex: 1 1 0; min-height: 0; min-width: 0; gap: 8px; overflow: hidden;
        }
        #ratchet-master-container .hud-panel { background: var(--hud-panel); border: 1px solid var(--hud-border-soft); border-radius: 12px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03); }
        #ratchet-master-container .mode-wrap { display: flex;
        flex: 0 0 auto; flex-wrap: nowrap; gap: 5px; background: #13232d; padding: 5px; border-radius: 12px;
        }
        #ratchet-master-container .mode-btn { flex: 1 1 0; min-width: 0; padding: 8px 12px;
        border: none; border-radius: 999px; font-size: 12px; font-weight: 900; cursor: pointer;
        transition: transform 0.18s ease, filter 0.18s ease, background 0.18s ease, color 0.18s ease; text-transform: uppercase; letter-spacing: 0.4px;
        }
        #ratchet-master-container .mode-btn.active { background: #00ff9d; color: #0f212e; box-shadow: 0 0 12px #00ff9d;
        }
        #ratchet-master-container .mode-btn:not(.active) { background: #2f4553; color: #94a3b8;
        }
        #ratchet-master-container .mode-btn:hover { filter: brightness(1.08); transform: translateY(-1px);
        }
        #ratchet-master-container .hud-top-bar, #ratchet-master-container .hud-controls-deck, #ratchet-master-container .hud-body, #ratchet-master-container .hud-split, #ratchet-master-container .input-row, #ratchet-master-container .input-cluster, #ratchet-master-container .btn-group, #ratchet-master-container .hud-stat-rail, #ratchet-master-container .hud-stats-grid, #ratchet-master-container .hud-meta-row, #ratchet-master-container .hud-header { display: flex;
        min-width: 0; }
        #ratchet-master-container .hud-header, #ratchet-master-container .hud-top-bar, #ratchet-master-container .hud-controls-deck { flex: 0 0 auto;
        }
        #ratchet-master-container .hud-top-bar, #ratchet-master-container .hud-controls-deck, #ratchet-master-container .hud-body, #ratchet-master-container .hud-split { gap: 8px;
        align-items: stretch; }
        #ratchet-master-container .hud-body, #ratchet-master-container .hud-split { flex: 1 1 0;
        min-height: 0; min-width: 0; overflow: hidden; flex-wrap: nowrap; }
        #ratchet-master-container .hud-header, #ratchet-master-container .input-row, #ratchet-master-container .hud-meta-row { justify-content: space-between;
        align-items: center; gap: 8px; }
        #ratchet-master-container .hud-pane, #ratchet-master-container .graph-col, #ratchet-master-container .stats-col { flex: 1 1 0;
        min-height: 0; min-width: 0; overflow: hidden; }
        #ratchet-master-container .hud-pane { display: flex;
        flex-direction: column; gap: 8px; }
        #ratchet-master-container .hud-pane.primary { flex: 1.15 1 0;
        }
        #ratchet-master-container .hud-pane.secondary, #ratchet-master-container .stats-col { flex: 0.95 1 0; display: flex;
        flex-direction: column; gap: 8px; }
        #ratchet-master-container .control-section { flex: 1 1 0;
        min-width: 0; padding: 10px; display: flex; flex-direction: column; gap: 8px;
        }
        #ratchet-master-container .input-row { align-items: flex-end; flex-wrap: nowrap;
        }
        #ratchet-master-container .input-cluster { flex: 1 1 0; flex-wrap: wrap; align-items: flex-end;
        gap: 8px; min-width: 0; }
        #ratchet-master-container .input-group { display: flex; align-items: center;
        gap: 5px; flex: 0 0 auto; }
        #ratchet-master-container .quick-btn { padding: 0;
        width: 26px; height: 26px; font-size: 10px; font-weight: 900; background: #1a2c38; border: 1px solid #2f4553; color: #fff; border-radius: 6px; cursor: pointer;
        flex: 0 0 auto; }
        #ratchet-master-container .quick-btn:hover { background: #2f4553;
        }
        #ratchet-master-container input[type="number"] { background: #0b0e17; border: 1px solid #2f4553; color: white;
        padding: 5px 6px; border-radius: 7px; width: 76px; font-size: 12px; font-weight: 700; text-align: center; outline: none;
        }
        #ratchet-master-container input[type="number"]:focus { border-color: var(--hud-green);
        box-shadow: 0 0 0 2px rgba(0, 255, 157, 0.12); }
        #ratchet-master-container .hud-risk-container { display: flex;
        flex: 1 1 100%; flex-wrap: nowrap; gap: 6px; min-width: 0;
        }
        #ratchet-master-container .hud-risk-container label { color: #94a3b8; font-size: 10px; font-weight: 800; display: flex;
        flex-direction: column; justify-content: space-between; gap: 4px; text-transform: uppercase; flex: 1 1 0; min-width: 0;
        }
        #ratchet-master-container .hud-risk-container input[type="number"] { width: 100%; min-width: 0;
        }
        #ratchet-master-container .btn-group { align-items: stretch; gap: 6px; flex-wrap: nowrap; justify-content: flex-end;
        flex: 0 0 auto; }
        #ratchet-master-container .hud-rapid-btn, #ratchet-master-container .hud-reset-btn { min-height: 38px;
        }
        #ratchet-master-container .hud-rapid-btn { border: none; color: #fff; font-size: 12px; font-weight: 900;
        padding: 8px 16px; border-radius: 9px; cursor: pointer; min-width: 108px; letter-spacing: 0.5px; text-transform: uppercase; flex: 1 1 0;
        }
        #ratchet-master-container .hud-rapid-btn.start { background: var(--hud-green); color: #0f212e;
        }
        #ratchet-master-container .hud-rapid-btn.start:hover { background: var(--hud-green-dark);
        }
        #ratchet-master-container .hud-rapid-btn.stop { background: var(--hud-red);
        }
        #ratchet-master-container .hud-rapid-btn.stop:hover { background: #be123c;
        }
        #ratchet-master-container .hud-reset-btn { background: transparent; border: 1px solid var(--hud-red); color: var(--hud-red);
        font-size: 11px; font-weight: 900; padding: 8px 14px; border-radius: 9px; cursor: pointer; flex: 1 1 0;
        }
        #ratchet-master-container .hud-reset-btn:hover { background: var(--hud-red); color: #fff;
        }
        #ratchet-master-container .status-bar { background: var(--hud-panel); padding: 8px 10px; border-radius: 12px; text-align: center;
        font-size: 13px; font-weight: 900; letter-spacing: 0.2px; border: 1px solid var(--hud-border-soft); display: flex; align-items: center; justify-content: center; min-height: 42px;
        flex: 0 0 auto; }
        #ratchet-master-container .hud-graph-box { flex: 1 1 0;
        min-height: 0; height: 100%; background: linear-gradient(180deg, rgba(11, 14, 23, 0.96), rgba(15, 33, 46, 0.98)); border: 1px solid #2f4553; border-radius: 12px;
        overflow: hidden; position: relative; display: flex; }
        #ratchet-master-container .hud-graph-box canvas { width: 100%;
        height: 100%; display: block; flex: 1 1 auto; }
        #ratchet-master-container .hud-header { padding: 0 2px;
        }
        #ratchet-master-container .hud-header h2 { margin: 0; color: #fff; font-size: 14px; font-weight: 900;
        letter-spacing: 0.8px; text-transform: uppercase; }
        #ratchet-master-container .hud-target-text { color: #b1bad3; font-size: 12px;
        font-weight: 800; font-style: italic; letter-spacing: 0.2px; }
        #ratchet-master-container .hud-controls-deck { padding: 10px;
        border-radius: 12px; border: 1px solid var(--hud-border-soft); background: var(--hud-panel); flex-wrap: nowrap;
        }
        #ratchet-master-container .hud-control-group { display: flex; flex-direction: column; gap: 4px;
        flex: 1 1 0; min-width: 0; }
        #ratchet-master-container .hud-control-group label { color: #94a3b8;
        font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.3px; display: flex; justify-content: space-between; gap: 6px;
        }
        #ratchet-master-container .hud-control-group input[type="range"] { width: 100%; height: 6px; accent-color: #00ff9d; cursor: pointer;
        }
        #ratchet-master-container .hud-control-group input[type="number"] { width: 100%;
        }
        /* LOCK OPTION STYLES */
        #ratchet-master-container select { background: #0b0e17;
        border: 1px solid #2f4553; color: white; padding: 4px 6px; border-radius: 7px; font-size: 11px; font-weight: 700; width: 100%; outline: none;
        appearance: auto; }
        #ratchet-master-container select:disabled { opacity: 0.4; cursor: not-allowed;
        }
        #ratchet-master-container input[type="checkbox"] { accent-color: #00ff9d; cursor: pointer; margin: 0; width: 14px;
        height: 14px; }
        #ratchet-master-container .hud-stat-rail { flex: 1 1 0; min-height: 0;
        min-width: 0; flex-direction: column; gap: 8px; overflow: hidden; }
        #ratchet-master-container .hud-stats-grid { flex: 1 1 0;
        min-height: 0; min-width: 0; gap: 8px; flex-wrap: wrap; align-content: stretch; overflow: hidden;
        }
        #ratchet-master-container .stats-col-inner, #ratchet-master-container .hud-stat-card { flex: 1 1 calc(50% - 4px);
        min-height: 0; min-width: 0; background: var(--hud-panel); padding: 10px; border-radius: 12px; border: 1px solid var(--hud-border-soft); display: flex; flex-direction: column; gap: 6px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03); overflow: hidden;
        }
        #ratchet-master-container .hud-row { display: flex; justify-content: space-between; align-items: center; gap: 8px;
        min-width: 0; padding: 6px 8px; background: rgba(255, 255, 255, 0.04); border-radius: 8px; flex: 1 1 0; min-height: 0;
        }
        #ratchet-master-container .hud-label { color: #b1bad3; font-size: 10px; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.3px; }
        #ratchet-master-container .hud-val { color: #fff; font-size: 12px; font-weight: 800;
        font-family: "Roboto Mono", monospace; text-align: right; }
        #ratchet-master-container .hud-meta-row { gap: 8px;
        padding: 0 2px; flex: 0 0 auto; }
        #ratchet-master-container .hud-meta-chip { display: flex;
        align-items: center; justify-content: space-between; gap: 8px; flex: 1 1 0; min-width: 0; padding: 8px 10px; background: var(--hud-panel);
        border: 1px solid var(--hud-border-soft); border-radius: 10px; overflow: hidden; }
        #ratchet-master-container .gear-text { font-style: italic;
        font-weight: 900; text-transform: uppercase; }
        #ratchet-master-container .gear-1-text { color: #94a3b8;
        }
        #ratchet-master-container .gear-2-text { color: #cbd5e1;
        }
        #ratchet-master-container .gear-3-text { color: #facc15;
        }
        #ratchet-master-container .gear-4-text { color: #fb923c;
        }
        #ratchet-master-container .gear-5-text { color: #f43f5e;
        text-shadow: 0 0 8px rgba(244, 63, 94, 0.4); }
        #ratchet-master-container .hud-footer-slot { display: flex;
        flex: 0 0 auto; min-width: 0; min-height: 88px; max-height: 88px; overflow: hidden;
        }
        #ratchet-master-container .hud-footer-slot > .footer, #ratchet-master-container .hud-footer-slot > .footer.svelte-fjwd2n { width: 100%;
        height: 100%; margin: auto !important; position: relative !important; left: auto !important; right: auto !important; bottom: auto !important; border-radius: 10px;
        overflow: hidden; }
        #ratchet-master-container .hud-footer-slot [class*="input-wrap"] { border-radius: 10px !important;
        }
        #ratchet-master-container .hud-footer-slot label:has([data-testid="reverse-roll"]) { min-width: 0 !important;
        }
        #ratchet-master-container .hud-footer-slot label:has([data-testid="reverse-roll"]) [class*="label-content"] { color: #b1bad3 !important; font-size: 12px !important;
        font-weight: 700 !important; letter-spacing: 0 !important; text-transform: none !important; }
        #ratchet-master-container .hud-footer-slot label:has([data-testid="reverse-roll"]) [class*="label-left-wrapper"] { justify-content: flex-start !important;
        width: auto !important; }
        #ratchet-master-container .hud-footer-slot [class*="input-wrap"]:has([data-testid="reverse-roll"]) { border: 1px solid #2f4553 !important;
        border-radius: 10px !important; background: linear-gradient(180deg, rgba(26, 44, 56, 0.98), rgba(15, 33, 46, 0.96)) !important;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04) !important; overflow: hidden !important; padding: 0 10px !important;
        }
        #ratchet-master-container .hud-footer-slot [class*="input-content"]:has([data-testid="reverse-roll"]) { display: flex !important; align-items: center !important;
        gap: 8px !important; width: 100% !important; }
        #ratchet-master-container .hud-footer-slot [class*="input-content"]:has(input[data-testid="reverse-roll"]) [class*="after-icon"] { width: auto !important;
        min-width: 20px !important; height: 100% !important; display: flex !important; align-items: center !important; justify-content: center !important; color: #9fb3c8 !important;
        flex: 0 0 auto !important; margin-left: auto !important; }
        #ratchet-master-container .hud-footer-slot input[data-testid="reverse-roll"] { appearance: none !important;
        -webkit-appearance: none !important; display: block !important; flex: 0 0 96px !important; width: 96px !important; min-width: 96px !important; max-width: 96px !important;
        height: 28px !important; padding: 0 10px !important; border: none !important; border-radius: 7px !important; background: #0b0e17 !important; color: #e2e8f0 !important;
        font-size: 12px !important; font-weight: 800 !important; font-family: "Roboto Mono", monospace !important; text-align: left !important; box-shadow: none !important; white-space: nowrap !important;
        transition: transform 0.18s ease, filter 0.18s ease !important; cursor: pointer !important; outline: none !important;
        }
        #ratchet-master-container .hud-footer-slot input[data-testid="reverse-roll"]:hover { filter: brightness(1.08);
        }
        #ratchet-master-container .hud-footer-slot [class*="input-wrap"]:has([data-testid="reverse-roll"]):hover { border-color: rgba(0, 255, 157, 0.55) !important;
        }
        #ratchet-master-container .hud-footer-slot input[data-testid="reverse-roll"]:active { transform: translateY(1px);
        }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field] { min-width: 0 !important;
        }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field] [class*="label-content"] { color: #b1bad3 !important; font-size: 12px !important;
        font-weight: 700 !important; letter-spacing: 0 !important; text-transform: none !important; }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field] [class*="label-left-wrapper"] { justify-content: flex-start !important;
        width: auto !important; }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field] [class*="input-wrap"] { border: 1px solid #2f4553 !important;
        border-radius: 10px !important; background: linear-gradient(180deg, rgba(26, 44, 56, 0.98), rgba(15, 33, 46, 0.96)) !important;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04) !important; overflow: hidden !important; padding: 0 10px !important;
        }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field] [class*="input-content"] { display: flex !important; align-items: center !important;
        gap: 8px !important; width: 100% !important; }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field] [class*="input-content"] [class*="after-icon"] { width: auto !important;
        min-width: 20px !important; height: 100% !important; display: flex !important; align-items: center !important; justify-content: center !important; color: #9fb3c8 !important;
        flex: 0 0 auto !important; margin-left: auto !important; }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field] input { appearance: none !important;
        -webkit-appearance: none !important; display: block !important; flex: 0 0 96px !important; width: 96px !important; min-width: 96px !important; max-width: 96px !important;
        height: 28px !important; padding: 0 10px !important; border: none !important; border-radius: 7px !important; background: #0b0e17 !important; color: #e2e8f0 !important;
        font-size: 12px !important; font-weight: 800 !important; font-family: "Roboto Mono", monospace !important; text-align: left !important; box-shadow: none !important; white-space: nowrap !important;
        outline: none !important; }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field] input[data-testid="reverse-roll"] { cursor: pointer !important;
        transition: transform 0.18s ease, filter 0.18s ease !important; }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field]:hover [class*="input-wrap"] { border-color: rgba(0, 255, 157, 0.55) !important;
        }
        #ratchet-master-container .hud-native-game-footer-slot { display: flex; flex: 0 0 auto; min-height: 56px;
        min-width: 0; overflow: hidden; }
        #ratchet-master-container .hud-native-game-footer-slot > .game-footer { width: 100% !important;
        height: auto !important; min-height: 56px !important; background: var(--hud-panel) !important; border: 1px solid var(--hud-border-soft) !important; border-radius: 12px !important; overflow: hidden !important;
        }
        #ratchet-master-container .hud-native-game-footer-slot > .game-footer > .stack { width: 100% !important;
        min-height: 56px !important; padding-right: 10px !important; }
        #ratchet-master-container .hud-native-game-footer-slot > .game-footer > .flex.items-center.absolute { display: none !important;
        }
        #ratchet-master-container .hud-native-game-footer-slot > .game-footer .right { margin-left: auto !important;
        }
        @media (max-width: 980px) {
            #ratchet-master-container { padding: 6px !important;
            }
            #ratchet-master-container .hud-frame { flex-direction: column !important;
            }
            #ratchet-master-container .hud-native-sidebar-slot { width: 100% !important;
            min-width: 0 !important; max-width: none !important; flex: 0 0 auto !important; max-height: 330px !important;
            }
        }
        .result.svelte-1oweb16, .multiplier-result, .result-multiplier, .crash-result, .limbo-result, [class*="crash"], [class*="result"][class*="multiplier"], span.result { display: none !important;
        }

        /* UNIFIED STYLING FOR THE SCROLLABLE BETTING AREA */
        #ratchet-master-container .hud-native-sidebar-slot .scrollable-content {
            background: var(--hud-panel) !important;
            border: 1px solid var(--hud-border-soft) !important;
            border-radius: 12px !important;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03) !important;
            margin: 4px 8px !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .scrollable-content .input-wrap,
        #ratchet-master-container .hud-native-sidebar-slot .scrollable-content .state-layer-surface {
            background: #0b0e17 !important;
            border: 1px solid #2f4553 !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .scrollable-content input {
            background: #0b0e17 !important;
            color: #fff !important;
            border: 1px solid #2f4553 !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .scrollable-content button {
            background: #1a2c38 !important;
            color: #b1bad3 !important;
            border: 1px solid #2f4553 !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .scrollable-content button:hover {
            background: #2f4553 !important;
            color: #fff !important;
            filter: brightness(1.1);
        }
        #ratchet-master-container .hud-native-sidebar-slot .scrollable-content .ds-body-md-strong {
            color: #b1bad3 !important;
        }
    `);

    function getUserSetMultiplier() {
        const isDice = window.location.pathname.toLowerCase().includes('/dice');
        if (ACTIVE_MODE !== 'smart') return 2;
        if (isDice) {
            let inp = document.querySelector('input[data-testid="payout"]');
            if (inp) return parseFloat(inp.value) || 1.01;
            const winningsLabels = document.querySelectorAll('span, label, div');
            for (let el of winningsLabels) {
                if ((el.textContent || '').trim() === 'Winnings' || (el.getAttribute && el.getAttribute('slot') === 'label' && el.textContent.trim() === 'Winnings')) {
                    let container = el.closest('label') ||
                    el.parentElement;
                    if (container && container.shadowRoot) {
                        inp = container.shadowRoot.querySelector('input[data-testid="payout"], input[type="number"]');
                        if (inp) return parseFloat(inp.value) || 1.01;
                    }
                    if (container) {
                        inp = container.querySelector('input[data-testid="payout"], input[type="number"]');
                        if (inp) return parseFloat(inp.value) || 1.01;
                    }
                }
            }
            inp = document.querySelector('input[min="1.0102"], input[data-testid="payout"]');
            if (inp) return parseFloat(inp.value) || 1.01;
            return 1.01;
        }
        const mI = document.querySelector('input[data-testid="target-multiplier"]');
        return mI ? parseFloat(mI.value) || 2 : 2;
    }
    function getLatestBetEntry(container = pastBetsContainer || findPastBetsContainer()) {
        if (!container) return null;
        const element = container.querySelector('button[data-last-bet-index="0"]');
        if (!element) return null;
        const id = element.getAttribute('data-past-bet-id') || element.getAttribute('data-bet-id') || element.getAttribute('aria-label') || element.textContent.trim();
        return id ? { element, id } : null;
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
    function syncFooterFieldStyles() {
        const footerSlot = document.getElementById('hud-footer-slot');
        if (!footerSlot) return;
        const footerLabels = footerSlot.querySelectorAll('label');
        footerLabels.forEach(label => {
            label.removeAttribute('data-ratchet-footer-field');
            const labelTextEl = label.querySelector('[slot="label"], [class*="label-content"]');
            const labelText = (labelTextEl ? labelTextEl.textContent : label.textContent || '').replace(/\s+/g, ' ').trim();
            if (labelText === 'Winnings' || labelText === 'Roll Over' || labelText === 'Win Chance') {

                label.setAttribute('data-ratchet-footer-field', 'true');
            }
        });
    }
    function syncModeButtons() {
        document.querySelectorAll('#ratchet-master-container .mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.id === `mode-${ACTIVE_MODE}`);
        });
    }
    function getHudHost() {
        return document.querySelector('div[data-testid="game-frame"]')
            ||
            document.querySelector('.game-frame')
            ||
            document.querySelector('.game-content')
            || document.querySelector('[data-testid="game-view"]');
    }
    function findNativeElement(selector) {
        const host = getHudHost();
        const scope = host || document;
        const scoped = Array.from(scope.querySelectorAll(selector));
        const pick = scoped.find(el => !el.closest('#ratchet-master-container')) || scoped[0];
        if (pick) return pick;
        const fallback = Array.from(document.querySelectorAll(selector));
        return fallback.find(el => !el.closest('#ratchet-master-container')) || fallback[0] || null;
    }
    function mountSingleElement(slot, element) {
        if (!slot || !element) return;
        if (slot.childElementCount === 1 && slot.firstElementChild === element) return;
        slot.replaceChildren(element);
    }
    function syncNativeHudElements() {
        mountSingleElement(document.getElementById('hud-native-sidebar-slot'), findNativeElement('.game-sidebar'));
        mountSingleElement(document.getElementById('hud-native-past-bets-slot'), findNativeElement('.past-bets'));
        mountSingleElement(document.getElementById('hud-footer-slot'), findNativeElement('.footer'));
        mountSingleElement(document.getElementById('hud-native-game-footer-slot'), findNativeElement('.game-footer'));
        syncFooterFieldStyles();
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
                                        <input id="h-base" type="number" step="0.01" value="${baseBet.toFixed(2)}">

         <button id="h-double-base" class="quick-btn">2x</button>
                                        <button id="h-half-base" class="quick-btn">1/2</button>
                                    </div>

                                     <div class="hud-risk-container">
                                        <label>Win increase % <input id="h-win-inc" type="number" min="0" value="${winIncreasePercent}"></label>

         <label>Loss reset <input id="h-loss-reset" type="number" min="1" value="${lossStreakReset}"></label>
                                        <label>Win reset <input id="h-wins-reset" type="number" min="1" value="${winsBeforeReset ||
''}"></label>
                                        <label>Autostop on Balance: <input id="h-autostop" type="number" step="0.01" value="${autoStopBalance !== null ?
autoStopBalance.toFixed(2) : ''}" placeholder="OFF"></label>
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
                            <div class="status-bar" id="h-target"> base bet: 0.01 | Wins: 0 | LossStreak: 0 </div>

             <div class="hud-graph-box" id="h-graph-box">
                                <canvas id="h-custom-graph"></canvas>
                            </div>
                        </div>

                        <div class="hud-pane secondary">
                            <div class="hud-stat-rail">
                                <div class="hud-stat-card">

                                     <div class="hud-row"><span class="hud-label">Starting Balance</span><span id="h-start-bal" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Profit/Loss</span><span id="h-profit" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Balance</span><span id="h-peak-bal" class="hud-val" style="color:#00ff9d;">0.00</span></div>

                                   <div class="hud-row"><span class="hud-label">Peak Profit</span><span id="h-high-profit" class="hud-val" style="color:#00ff9d;">0.00</span></div>
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
                                <input type="checkbox" id="h-lock-agg-chk" ${lockAggressionState ?
'checked' : ''}> Lock State
                            </label>
                            <select id="h-lock-gear-sel" ${lockAggressionState ?
'' : 'disabled'}>
                                <option value="1" ${lockedGearLevel === 1 ?
'selected' : ''}>Conservative</option>
                                <option value="2" ${lockedGearLevel === 2 ?
'selected' : ''}>Steady</option>
                                <option value="3" ${lockedGearLevel === 3 ?
'selected' : ''}>Balanced</option>
                                <option value="4" ${lockedGearLevel === 4 ?
'selected' : ''}>Press</option>
                                <option value="5" ${lockedGearLevel === 5 ?
'selected' : ''}>Aggro</option>
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
                                    <div class="hud-row"><span class="hud-label">Peak Balance</span><span id="h-peak-bal" class="hud-val" style="color:#00ff9d;">0.00</span></div>

                                 <div class="hud-row"><span class="hud-label">Peak Profit</span><span id="h-high-profit" class="hud-val" style="color:#00ff9d;">0.00</span></div>
                                </div>
                                <div class="stats-col-inner">

                                     <div class="hud-row"><span class="hud-label">Total Bets</span><span id="h-total-bets" class="hud-val">0</span></div>
                                    <div class="hud-row"><span class="hud-label">Total Wagered</span><span id="h-wagered" class="hud-val">0.00</span></div>

                                     <div class="hud-row"><span class="hud-label">Wins / Losses</span><span id="h-wl" class="hud-val">0 / 0</span></div>
                                    <div class="hud-row"><span class="hud-label">Session RTP</span><span id="h-rtp" class="hud-val">100.00%</span></div>
                                </div>

                                <div class="stats-col-inner">
                                    <div class="hud-row"><span class="hud-label">Aggression state</span><span id="h-state" class="hud-val gear-text gear-1-text">GEAR 1</span></div>
                                    <div
class="hud-row"><span class="hud-label">Momentum Window</span><span id="h-hot" class="hud-val">0/0</span></div>
                                    <div class="hud-row"><span class="hud-label">Streak (W|L)</span><span id="h-streaks" class="hud-val">0/0 |
0/0</span></div>
                                    <div class="hud-row"><span class="hud-label">Multiplier Performance</span><span id="h-mult-perf" class="hud-val">1 in 0.00</span></div>
                                </div>

                            </div>
                            <div class="hud-meta-row">
                                <div class="hud-meta-chip">

                                     <span class="hud-label">Best Streaks</span>
                                    <span id="h-best-w" class="hud-val" style="color:#00ff9d;">-</span>
                                </div>

                                <div class="hud-meta-chip">
                                    <span class="hud-label">Worst Streaks</span>
                                    <span id="h-worst-l" class="hud-val" style="color:#f87171;">-</span>

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
                                    <div class="hud-row"><span class="hud-label">Peak Balance</span><span id="h-peak-bal" class="hud-val" style="color:#00ff9d;">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Profit</span><span id="h-high-profit" class="hud-val" style="color:#00ff9d;">0.00</span></div>

                                </div>
                                <div class="stats-col-inner">
                                    <div class="hud-row"><span class="hud-label">Total
Bets</span><span id="h-total-bets" class="hud-val">0</span></div>
                                    <div class="hud-row"><span class="hud-label">Total Wagered</span><span id="h-wagered" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Wins / Losses</span><span id="h-wl" class="hud-val">0 / 0</span></div>

                                     <div class="hud-row"><span class="hud-label">Session RTP</span><span id="h-rtp" class="hud-val">100.00%</span></div>
                                    <div class="hud-row"><span class="hud-label">Streak (W|L)</span><span id="h-streaks" class="hud-val">0/0 |
0/0</span></div>
                                </div>
                                <div class="stats-col-inner">
                            <div class="hud-meta-row">

                                <div class="hud-meta-chip">
                                    <span class="hud-label">Best Streaks</span>

                                     <span id="h-best-w" class="hud-val" style="color:#00ff9d;">-</span>
                                </div>
                                <div class="hud-meta-chip">

                                     <span class="hud-label">Worst Streaks</span>
                                    <span id="h-worst-l" class="hud-val" style="color:#f87171;">-</span>
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
    function attachListeners() {
        const rapidBtn = document.getElementById('h-rapid-toggle');
        if (rapidBtn) rapidBtn.onclick = () => { if (!isRapidFiring) startRapidFire(); else stopRapidFire(); };
        const resetBtn = document.getElementById('h-reset');
        if (resetBtn) resetBtn.onclick = resetStats;
        if (ACTIVE_MODE === 'iow') {
            const baseInp = document.getElementById('h-base');
            if (baseInp) {
                baseInp.addEventListener('input', () => { baseBet = parseFloat(baseInp.value) || minBaseBet; });
                baseInp.addEventListener('blur', () => { let v = parseFloat(baseInp.value) || minBaseBet; baseInp.value = v.toFixed(2); baseBet = v; });
            }
            const doubleBtn = document.getElementById('h-double-base');
            if (doubleBtn) doubleBtn.addEventListener('click', () => {
                let val = parseFloat(document.getElementById('h-base').value) || minBaseBet; val *= 2; document.getElementById('h-base').value = val.toFixed(2); baseBet = val;
            });
            const halfBtn = document.getElementById('h-half-base');
            if (halfBtn) halfBtn.addEventListener('click', () => {
                let val = parseFloat(document.getElementById('h-base').value) || minBaseBet; val *= 0.5; val = Math.max(minBaseBet, val); document.getElementById('h-base').value = val.toFixed(2); baseBet = val;
            });
            const winInc = document.getElementById('h-win-inc'); if (winInc) winInc.addEventListener('input', () => { winIncreasePercent = parseFloat(winInc.value) || 125; });
            const lossReset = document.getElementById('h-loss-reset');
            if (lossReset) lossReset.addEventListener('input', () => { lossStreakReset = parseInt(lossReset.value, 10) || 3; });
            const winsReset = document.getElementById('h-wins-reset');
            if (winsReset) winsReset.addEventListener('input', () => { winsBeforeReset = parseInt(winsReset.value, 10) || null; });
            const autostopInp = document.getElementById('h-autostop');
            if (autostopInp) {
                autostopInp.addEventListener('input', () => { autoStopBalance = parseFloat(autostopInp.value) || null; });
                autostopInp.addEventListener('blur', () => { let v = parseFloat(autostopInp.value) || 0; autostopInp.value = v ? v.toFixed(2) : ''; autoStopBalance = v || null; });
            }
        } else {
            const slInp = document.getElementById('h-sl');
            if (slInp) slInp.addEventListener('input', () => { stopLossPct = parseFloat(slInp.value) || 0; });
            const tpInp = document.getElementById('h-tp');
            if (tpInp) tpInp.addEventListener('input', () => { takeProfitPct = parseFloat(tpInp.value) || 0; });
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
        totalWagered = 0; highestProfit = 0; totalWins = 0;
        totalLosses = 0; totalBets = 0;
        lossStreak = 0; counter = 0; lastBetId = null; profitHistory = [0];
        lastAmount = null;
        betHistory = []; recentWins = []; topWinStreaks = []; topLossStreaks = [];
        curLossStreak = 0;
        maxLossStreak = 0; curWinStreak = 0; maxWinStreak = 0;
        multGames = 0; multWins = 0; lastResult = null;
        autoPaused = false; stopLossPct = 0; takeProfitPct = 0;
        rapidBlockedSince = 0; rapidFireStartedAt = 0; lastObservedBetTime = 0;
        if (isRapidFiring) stopRapidFire();
        if (ACTIVE_MODE === 'iow') {
            const baseInp = document.getElementById('h-base');
            if (baseInp) baseInp.value = baseBet.toFixed(2);
        } else if (ACTIVE_MODE === 'smart') {
            const aggInp = document.getElementById('h-agg');
            if (aggInp) aggInp.value = aggressionLevel.toFixed(1);
            const valEl = document.getElementById('h-agg-val'); if (valEl) valEl.textContent = `${aggressionLevel.toFixed(1)}x`;
        }
        const sl = document.getElementById('h-sl'); if (sl) sl.value = '0';
        const tp = document.getElementById('h-tp'); if (tp) tp.value = '0';
        syncLastSeenBet();
        updateUI();
    }
    function getCurrentBalance() {
        const betField = document.getElementById('text-field-container') || document.querySelector('input[data-testid="input-game-amount"]');
        const activeCurrency = (betField && betField.getAttribute('data-bet-amount-active-currency')) || '';
        const iconName = activeCurrency.toUpperCase();
        const parseBalText = (txt) => {
            const cleaned = (txt || '').replace(/[^0-9.]/g, '');
            const val = parseFloat(cleaned);
            return !isNaN(val) ? val : null;
        };
        const balanceElems = document.querySelectorAll('span.text-neutral-default.ds-body-md-strong[data-ds-text="true"][style*="max-width: 16ch"]');
        let fallbackVal = null;
        for (let elem of balanceElems) {
            const val = parseBalText(elem.textContent);
            if (val === null) continue;
            if (fallbackVal === null) fallbackVal = val;
            if (!iconName) continue;
            const sibling = elem.parentElement && elem.parentElement.nextElementSibling;
            if (!sibling) continue;
            const svg = sibling.querySelector('svg[data-ds-icon]');
            const svgIcon = svg && (svg.getAttribute('data-ds-icon') || '').toUpperCase();
            const title = (sibling.getAttribute('title') || '').toUpperCase();
            if (svgIcon === iconName || title === iconName) {
                lastKnownBalance = val;
                return val;
            }
        }
        if (fallbackVal !== null) {
            lastKnownBalance = fallbackVal;
            return fallbackVal;
        }
        return lastKnownBalance || 0;
    }
    function getBetContainer() { return document.getElementById('text-field-container');
    }
    function getCurrentBet() {
        const amountDiv = document.querySelector('#text-field-container #editing-view-port > div');
        if (amountDiv) return parseFloat(amountDiv.textContent.trim().replace(/[^0-9.]/g, '')) || minBaseBet;
        const oldInput = document.querySelector('input[data-testid="input-game-amount"]');
        return oldInput ? parseFloat(oldInput.value.replace(/,/g, '')) || minBaseBet : minBaseBet;
    }
    function setBet(amount) {
        if (ACTIVE_MODE !== 'iow') return false;
        if (!isFinite(amount) || amount < 0) return false;
        const targetStr = Math.min(amount, maxBaseBet).toFixed(2);
        const container = getBetContainer();
        if (container) {
            container.focus(); container.click();
            setTimeout(() => {
                const display = document.querySelector('#editing-view-port > div');
                if (display) { display.focus(); document.execCommand('selectAll', false, null); document.execCommand('insertText', false, targetStr); }
                ['input','change','blur','keydown','keyup','focus'].forEach(type => {
                    const e = new Event(type, { bubbles: true });

                     container.dispatchEvent(e); if (display) display.dispatchEvent(e);
                });
            }, 10);
            return true;
        }
        const input = document.querySelector('input[data-testid="input-game-amount"]');
        if (input) {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, targetStr);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
        return false;
    }
    function getPlayButton() {
        let btn = document.querySelector('button[data-testid="bet-button"]');
        if (btn) return btn;
        const spans = document.querySelectorAll('span.ds-body-md-strong[data-ds-text="true"]');
        for (let span of spans) {
            if (span.textContent.trim() === 'Play') { const button = span.closest('button');
            if (button) return button; }
        }
        return Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('Play') && b.offsetParent !== null);
    }
    function findPastBetsContainer() { return document.querySelector('div.past-bets'); }
    function isWin(betDiv) { return betDiv && betDiv.classList.contains('variant-positive');
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
                lossStreak = 0;
                counter++;
                if (isRapidFiring) { const curBet = getCurrentBet(); let newBet = curBet * (1 + winIncreasePercent / 100);
                newBet = Math.min(newBet, maxBaseBet); setBet(newBet); }
                if (winsBeforeReset && counter >= winsBeforeReset) { counter = 0;
                triggerWinResetPulse(); if (isRapidFiring) setBet(baseBet); }
            } else {
                lossStreak++;
                if (lossStreak >= lossStreakReset) { counter = 0; if (isRapidFiring) setBet(baseBet);
                }
            }
            if (isRapidFiring && autoStopBalance && getCurrentBalance() >= autoStopBalance) stopRapidFire();
        }
        updateUI();
    }
    function handleBetResult(isWinResult, betAmt) {
        if (isWinResult) totalWins++;
        else totalLosses++;
        totalWagered += betAmt || minBaseBet;
        const currentProfit = getCurrentBalance() - initialBalance;
        if (currentProfit > highestProfit) highestProfit = currentProfit;
        profitHistory.push(currentProfit); if (profitHistory.length > MAX_GRAPH_POINTS) profitHistory.shift();
        if (isWinResult) {
            if (lastResult === false && curLossStreak > 0) { topLossStreaks.push(curLossStreak);
            topLossStreaks.sort((a,b)=>b-a); if (topLossStreaks.length > 10) topLossStreaks.pop(); }
            curWinStreak++;
            curLossStreak = 0; multWins++;
        } else {
            if (lastResult === true && curWinStreak > 0) { topWinStreaks.push(curWinStreak);
            topWinStreaks.sort((a,b)=>b-a); if (topWinStreaks.length > 10) topWinStreaks.pop(); }
            curLossStreak++;
            curWinStreak = 0;
        }
        lastResult = isWinResult;
        betHistory.push(isWinResult); recentWins.push(isWinResult);
        if (recentWins.length > 10) recentWins.shift();
        if (betHistory.length > historyWindow) betHistory.shift();
        multGames++;
        maxLossStreak = Math.max(maxLossStreak, curLossStreak);
        maxWinStreak = Math.max(maxWinStreak, curWinStreak);
        if (ACTIVE_MODE === 'smart' || ACTIVE_MODE === 'manual') {
            if (stopLossPct > 0 && currentProfit <= -initialBalance * (stopLossPct / 100)) autoPaused = true;
            if (takeProfitPct > 0 && currentProfit >= initialBalance * (takeProfitPct / 100)) autoPaused = true;
            if (autoPaused && isRapidFiring) stopRapidFire();
        }
    }
    function startRapidFire() {
        if (isRapidFiring) return;
        isRapidFiring = true;
        rapidBlockedSince = 0;
        rapidFireStartedAt = Date.now();
        lastObservedBetTime = 0;
        syncLastSeenBet();
        if (ACTIVE_MODE === 'iow') setBet(baseBet);
        updateUI();
        const keyDown = new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true });
        document.dispatchEvent(keyDown);
        spacePressInterval = setInterval(() => {
            if (isRapidFiring) {
                const repeat = new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true });
                document.dispatchEvent(repeat);
            }
        }, 42);
    }
    function stopRapidFire() {
        isRapidFiring = false;
        rapidBlockedSince = 0;
        rapidFireStartedAt = 0;
        lastObservedBetTime = 0;
        if (spacePressInterval) {
            clearInterval(spacePressInterval);
            spacePressInterval = null;
        }
        const keyUp = new KeyboardEvent('keyup', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true });
        document.dispatchEvent(keyUp);
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
        lineGrad.addColorStop(0, '#00ff9d'); lineGrad.addColorStop(zeroPct, '#00ff9d');
        lineGrad.addColorStop(zeroPct, '#f87171'); lineGrad.addColorStop(1, '#f87171');
        const fillGrad = ctx.createLinearGradient(0, 0, 0, height);
        fillGrad.addColorStop(0, 'rgba(0, 255, 157, 0.2)');
        fillGrad.addColorStop(zeroPct, 'rgba(0, 255, 157, 0.2)'); fillGrad.addColorStop(zeroPct, 'rgba(248, 113, 113, 0.2)'); fillGrad.addColorStop(1, 'rgba(248, 113, 113, 0.2)');
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
        ctx.beginPath();
        ctx.moveTo(0, zeroY); ctx.lineTo(width, zeroY);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    function updateUI() {
        const balance = getCurrentBalance();
        const profit = balance - initialBalance;
        const startBalEl = document.getElementById('h-start-bal'); if (startBalEl) startBalEl.textContent = initialBalance.toFixed(2);
        const profitEl = document.getElementById('h-profit');
        if (profitEl) { profitEl.textContent = profit.toFixed(2); profitEl.style.color = profit > 0 ?
        '#00ff9d' : (profit < 0 ? '#f87171' : '#fff'); }
        const peakBalEl = document.getElementById('h-peak-bal');
        if (peakBalEl) peakBalEl.textContent = sessionPeak.toFixed(2);
        const highProfitEl = document.getElementById('h-high-profit'); if (highProfitEl) highProfitEl.textContent = highestProfit.toFixed(2);
        const wageredEl = document.getElementById('h-wagered');
        if (wageredEl) wageredEl.textContent = totalWagered.toFixed(2);
        const rtp = totalWagered > 0 ?
        ((totalWagered + profit) / totalWagered) * 100 : 100;
        const rtpEl = document.getElementById('h-rtp');
        if (rtpEl) { rtpEl.textContent = rtp.toFixed(2) + '%'; rtpEl.style.color = rtp >= 100 ? '#00ff9d' : '#f87171';
        }
        const totalBetsEl = document.getElementById('h-total-bets'); if (totalBetsEl) totalBetsEl.textContent = totalBets;
        const wlEl = document.getElementById('h-wl'); if (wlEl) wlEl.innerHTML = `<span style="color:#00ff9d;">${totalWins}</span> / <span style="color:#f87171;">${totalLosses}</span>`;
        const rapidBtn = document.getElementById('h-rapid-toggle');
        if (rapidBtn) {
            if (isRapidFiring) { rapidBtn.textContent = 'STOP';
            rapidBtn.className = 'hud-rapid-btn stop'; }
            else { rapidBtn.textContent = 'START';
            rapidBtn.className = 'hud-rapid-btn start'; }
        }
        if (ACTIVE_MODE === 'iow') {
            const targetEl = document.getElementById('h-target');
            if (targetEl) targetEl.innerHTML = `base bet: ${baseBet.toFixed(2)} | Wins: <span style="color:#00ff9d">${counter}</span> | LossStreak: <span style="color:#f87171">${lossStreak}</span>`;
        } else if (ACTIVE_MODE === 'smart') {
            const streaksEl = document.getElementById('h-streaks');
            if (streaksEl) streaksEl.innerHTML = `<span style="color:#00ff9d;">${curWinStreak}/${maxWinStreak}</span> | <span style="color:#f87171;">${curLossStreak}/${maxLossStreak}</span>`;
            const hotEl = document.getElementById('h-hot'); if (hotEl) hotEl.textContent = `${betHistory.filter(Boolean).length}/${betHistory.length}`;
            const perfEl = document.getElementById('h-mult-perf');
            if (perfEl && multWins > 0) {
                const actualRatio = multGames / multWins;
                const recentHit = recentWins.filter(Boolean).length;
                const recentRatio = recentWins.length > 0 ? recentWins.length / Math.max(1, recentHit) : actualRatio;
                const trend = recentWins.length >= 10 ? (recentRatio <= actualRatio ? ' ▲' : ' ▼') : '';
                const trendColor = recentWins.length >= 10 ? (recentRatio <= actualRatio ? '#00ff9d' : '#f87171') : 'inherit';
                perfEl.innerHTML = `1 in ${actualRatio.toFixed(2)}<span style="color:${trendColor}; font-size:12px;">${trend}</span>`;
                perfEl.style.color = actualRatio <= (trackedMultiplier || 1) ? '#00ff9d' : '#f87171';
            }
            const winsCount = betHistory.filter(Boolean).length;
            const progress = winsNeeded > 0 ? winsCount / winsNeeded : 0;
            let gear = 1;
            let label = 'Gear 1 (Cold)';
            if (lockAggressionState) {
                gear = lockedGearLevel;
                if (gear === 1) { label = 'Conservative (LOCKED)'; }
                else if (gear === 2) { label = 'Steady (LOCKED)';
                }
                else if (gear === 3) { label = 'Balanced (LOCKED)';
                }
                else if (gear === 4) { label = 'Press (LOCKED)';
                }
                else { gear = 5;
                label = 'Aggro (LOCKED)'; }
            } else {
                if (progress <= 0.4) { gear = 1;
                label = 'Conservative'; }
                else if (progress <= 0.8) { gear = 2;
                label = 'Steady'; }
                else if (progress <= 1.1) { gear = 3;
                label = 'Balanced'; }
                else if (progress <= 1.45) { gear = 4;
                label = 'Press'; }
                else { gear = 5;
                label = 'Aggro'; }
            }
            const stateEl = document.getElementById('h-state');
            if (stateEl) { stateEl.textContent = label; stateEl.className = `hud-val gear-text gear-${gear}-text`;
            }
            const displayW = topWinStreaks.concat([curWinStreak]).filter(x => x > 0).sort((a, b) => b - a).slice(0, 10);
            const displayL = topLossStreaks.concat([curLossStreak]).filter(x => x > 0).sort((a, b) => b - a).slice(0, 10);
            const bestWEl = document.getElementById('h-best-w');
            if (bestWEl) bestWEl.textContent = displayW.join(', ') || '-';
            const worstLEl = document.getElementById('h-worst-l'); if (worstLEl) worstLEl.textContent = displayL.join(', ') || '-';
            const targetEl = document.getElementById('h-target');
            const targetMult = getUserSetMultiplier();
            if (targetEl) {
                let txt = `Target: ${targetMult.toFixed(2)}x`;
                if (autoPaused) { targetEl.style.color = '#f87171'; txt = 'PAUSED - THRESHOLD TRIGGERED'; } else { targetEl.style.color = '#b1bad3';
                }
                targetEl.innerHTML = txt;
            }
        } else if (ACTIVE_MODE === 'manual') {
            const streaksEl = document.getElementById('h-streaks');
            if (streaksEl) streaksEl.innerHTML = `<span style="color:#00ff9d;">${curWinStreak}/${maxWinStreak}</span> | <span style="color:#f87171;">${curLossStreak}/${maxLossStreak}</span>`;
            const hotEl = document.getElementById('h-hot'); if (hotEl) hotEl.textContent = `${betHistory.filter(Boolean).length}/${betHistory.length}`;
            const displayW = topWinStreaks.concat([curWinStreak]).filter(x => x > 0).sort((a, b) => b - a).slice(0, 10);
            const displayL = topLossStreaks.concat([curLossStreak]).filter(x => x > 0).sort((a, b) => b - a).slice(0, 10);
            const bestWEl = document.getElementById('h-best-w');
            if (bestWEl) bestWEl.textContent = displayW.join(', ') || '-';
            const worstLEl = document.getElementById('h-worst-l'); if (worstLEl) worstLEl.textContent = displayL.join(', ') || '-';
            const targetEl = document.getElementById('h-target');
            if (targetEl) {
                targetEl.textContent = isRapidFiring ?
                '' : '';
                targetEl.style.color = isRapidFiring ? '#00ff9d' : '#b1bad3';
            }
        }
        drawGraph();
    }
    function updateBetAmount() {
        if (ACTIVE_MODE !== 'smart') return;
        const input = document.querySelector('input[data-testid="input-game-amount"]');
        const balance = getCurrentBalance();
        if (!input || !balance) return;
        if (initialBalance === 0) initialBalance = balance;
        sessionPeak = Math.max(sessionPeak, balance);
        const currentMult = getUserSetMultiplier();
        if (currentMult !== trackedMultiplier) { trackedMultiplier = currentMult; multGames = 0;
        multWins = 0; recentWins = []; }
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
        const betStr = targetBet.toFixed(2);
        if (betStr !== lastAmount) {
            lastAmount = betStr;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(input, betStr);
            input.dispatchEvent(new Event('input', { bubbles: true }));
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
        syncNativeHudElements();
        const bal = getCurrentBalance();
        if (bal > 0.01) {
            if (initialBalance === 0) initialBalance = bal;
            sessionPeak = Math.max(sessionPeak, bal);
            lastKnownBalance = bal;

        }
        if (ACTIVE_MODE === 'iow') {
            const baseInp = document.getElementById('h-base'); if (baseInp) baseBet = parseFloat(baseInp.value) || minBaseBet;
            const winIncEl = document.getElementById('h-win-inc'); if (winIncEl) winIncreasePercent = parseFloat(winIncEl.value) || 125;
            const lossResetEl = document.getElementById('h-loss-reset'); if (lossResetEl) lossStreakReset = parseInt(lossResetEl.value, 10) || 3;
            const winsResetEl = document.getElementById('h-wins-reset');
        if (winsResetEl) winsBeforeReset = parseInt(winsResetEl.value, 10) || null;
            const autostopEl = document.getElementById('h-autostop'); if (autostopEl) { const v = parseFloat(autostopEl.value);
        autoStopBalance = !isNaN(v) && v > 0 ? v : null;
        }
        }
        updateUI();
        startObserverWrapper();
        monitorRapidFireHealth();
        if (ACTIVE_MODE === 'smart') updateBetAmount();
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
})();