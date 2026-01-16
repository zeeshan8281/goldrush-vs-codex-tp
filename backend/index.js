const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
// Using raw graphql-ws instead of SDKs
const { createClient } = require('graphql-ws');
require('dotenv').config();
const logger = require('./utils/logger');
const RollingStats = require('./utils/stats');

const grStats = new RollingStats();
const cxStats = new RollingStats();
const mbStats = new RollingStats();

// Global Interval Buckets for Raw Jitter (Reset every 5s)
let intervalLatencies = {
    goldrush: [],
    codex: [],
    mobula: []
};

// Per-Interval Event Counters (Reset every 5s snapshot)
let intervalEvents = {
    goldrush: 0,
    codex: 0,
    mobula: 0
};

// Carry-Forward Stats (Prevent 0-flicker)
let lastIntervalStats = {
    goldrush: { p50: 0, p95: 0, p99: 0, jitter: 0, stdDev: 0, eventCount: 0 },
    codex: { p50: 0, p95: 0, p99: 0, jitter: 0, stdDev: 0, eventCount: 0 },
    mobula: { p50: 0, p95: 0, p99: 0, jitter: 0, stdDev: 0, eventCount: 0 }
};

// Track last value of previous interval for Delta calculation
let lastIntervalEndVal = {
    goldrush: 0,
    codex: 0,
    mobula: 0
};

let codexLatestStats = { p50: 0, p95: 0, jitter: 0 };
let mobulaLatestStats = { p50: 0, p95: 0, jitter: 0 };

global.getSymbol = () => SYMBOL;

global.updatePairs = (symbol, data) => {
    if (pairs[symbol]) {
        // Merge data into pairs state
        Object.assign(pairs[symbol], data);

        // Capture Stats if provided (from Codex)
        if (data.stats) {
            codexLatestStats = data.stats;
        }
    }
};

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3002;
// Default to VIRTUAL (Base), but allow dynamic updates
let SYMBOL = 'VIRTUAL';
let VIRTUALS_ADDRESS = '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b'; // Token address if needed, but we use PAIR for events
let PAIR_ADDRESS = '0x9c087Eb773291e50CF6c6a90ef0F4500e349B903';
// TOKEN_ADDRESS Removed as requested
let CURRENT_CHAIN = 'BASE_MAINNET';

const CHAIN_CONFIG = {
    SOLANA_MAINNET: {
        name: 'SOLANA',
        codexNetworkId: '1399811149',
        goldrushChain: 'SOLANA_MAINNET'
    },
    BASE_MAINNET: {
        name: 'BASE',
        codexNetworkId: '8453',
        goldrushChain: 'BASE_MAINNET'
    }
};

let CODEX_NETWORK_ID = CHAIN_CONFIG.SOLANA_MAINNET.codexNetworkId;

// --- STATE MANAGEMENT ---
let pairs = {
    [SYMBOL]: {
        price: 0,
        fastPrice: 0,
        slowPrice: 0
    }
};

// Store OHLCV candle arrays for charts (independent)
let goldrushCandles = [];
let codexCandles = [];
let mobulaCandles = [];

let clients = new Set();
let isRunning = true;
let streamsStartTime = 0; // Global start time for fair comparison

// Log history buffer (replayed to new clients)
let logHistory = {
    goldrush: [],
    codex: [],
    mobula: []
};

// Event counters for numbered logging
let eventCounters = {
    goldrushOHLCV: 0,
    goldrush: 0,
    codex: 0,
    codexBars: 0,
    mobula: 0,
    mobulaOHLCV: 0
};

// --- SERVER SETUP ---
const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint for Railway
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'GoldRush vs Codex Trading Bot (SOLANA)' });
});

// Endpoint to update the token dynamically
app.post('/update-token', async (req, res) => {
    const { address, symbol, pairAddress } = req.body;
    if (!address) return res.status(400).json({ error: 'Address is required' });

    // CHAIN DETECTION
    // Solana addresses are Base58 (no '0x'), Base (EVM) addresses start with '0x'
    const isEVM = address.startsWith('0x');
    const newChain = isEVM ? 'BASE_MAINNET' : 'SOLANA_MAINNET';
    const config = CHAIN_CONFIG[newChain];

    // Only restart if chain changed OR pair changed
    // We treat 'address' in body as PAIR ADDRESS if pairAddress is not explicitly provided
    const targetPair = pairAddress || address;
    const needsFullRestart = newChain !== CURRENT_CHAIN || targetPair !== PAIR_ADDRESS;

    if (needsFullRestart) {
        console.log(`\n🔄 SWITCHING TO ${newChain} NETWORK...`);
        CURRENT_CHAIN = newChain;
        PAIR_ADDRESS = targetPair;
        SYMBOL = symbol || (isEVM ? 'TOKEN' : 'BONK');
        CODEX_NETWORK_ID = config.codexNetworkId;

        // Reset Global State
        pairs = { [SYMBOL]: { price: 0, fastPrice: 0, slowPrice: 0 } };
        goldrushCandles = [];
        codexCandles = [];
        mobulaCandles = [];

        performanceHistory = []; // Reset history on token switch

        broadcast({ type: 'RESET', data: { symbol: SYMBOL, chain: newChain } });

        // Reset Metrics & Stats
        metricsHistory = [];
        throughputCounters = { goldrush: 0, codex: 0, mobula: 0 };
        currentThroughput = { goldrush: 0, codex: 0, mobula: 0 };
        throughputHistory = { goldrush: [], codex: [], mobula: [] };
        avgCandlesPerSecond = { goldrush: 0, codex: 0, mobula: 0 };

        latencyStats = {
            goldrush: { sum: 0, count: 0 },
            codex: { sum: 0, count: 0 },
            mobula: { sum: 0, count: 0 }
        };

        // Reset Rolling Stats (Fixes stale P95/Jitter)
        grStats.reset();
        cxStats.reset();
        mbStats.reset();

        latency300 = {
            goldrush: { samples: [], sum: 0 },
            codex: { samples: [], sum: 0 },
            mobula: { samples: [], sum: 0 }
        };

        connectionMetrics = {
            goldrush: {
                ringBufferStart: 0,
                ringBufferTTFD: 0,
                ringBufferReceived: false,
                liveDataTTFD: 0,
                connects: 0,
                errors: 0,
                lastError: null
            },
            codex: {
                liveDataStart: 0,
                liveDataTTFD: 0,
                connects: 0,
                errors: 0,
                lastError: null
            },
            mobula: {
                ringBufferStart: 0,
                ringBufferTTFD: 0,
                ringBufferReceived: false,
                liveDataStart: 0,
                liveDataTTFD: 0,
                connects: 0,
                errors: 0,
                lastError: null
            }
        };

        // Reset Event Counters
        eventCounters = { goldrush: 0, codex: 0, mobula: 0, goldrushOHLCV: 0, codexBars: 0, mobulaOHLCV: 0 };

        latencyDelta = {
            goldrush: { prevLatency: null, deltas: [], sum: 0 },
            codex: { prevLatency: null, deltas: [], sum: 0 },
            mobula: { prevLatency: null, deltas: [], sum: 0 }
        };

        // Reset Global Interval Buckets
        intervalLatencies = {
            goldrush: [],
            codex: [],
            mobula: []
        };

        // Reset Per-Interval Event Counters
        intervalEvents = {
            goldrush: 0,
            codex: 0,
            mobula: 0
        };

        // Reset Log History
        logHistory = {
            goldrush: [],
            codex: [],
            mobula: []
        };

        // Reset Carry-Forward Stats
        lastIntervalStats = {
            goldrush: { p50: 0, p95: 0, p99: 0, jitter: 0, stdDev: 0, eventCount: 0 },
            codex: { p50: 0, p95: 0, p99: 0, jitter: 0, stdDev: 0, eventCount: 0 },
            mobula: { p50: 0, p95: 0, p99: 0, jitter: 0, stdDev: 0, eventCount: 0 }
        };

        lastIntervalEndVal = {
            goldrush: 0,
            codex: 0,
            mobula: 0
        };

        codexLatestStats = { p50: 0, p95: 0, jitter: 0 };
        mobulaLatestStats = { p50: 0, p95: 0, jitter: 0 };

        // Reset Timestamps for fair comparison restart
        streamsStartTime = Date.now();
        console.log("⚠️ FULL BACKEND STATE RESET TRIGGERED ⚠️");

        // Broadcast System Restart Message to UI Logs
        const restartTime = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const restartMsg = {
            id: `restart-${Date.now()}`,
            eventNum: 'SYS',
            eventType: 'RESTART',
            time: restartTime,
            timestamp: Date.now(),
            details: `🔄 Switching to ${SYMBOL} on ${newChain}`
        };

        broadcast({ type: 'LOG_EVENT', provider: 'goldrush', data: restartMsg });
        broadcast({ type: 'LOG_EVENT', provider: 'codex', data: { ...restartMsg, timestamp: restartMsg.timestamp / 1000 } });

        // Update Providers
        // 1. GoldRush
        // We aren't using the external provider module instances in index.js yet, 
        // but we can call startStream() which now uses CURRENT_CHAIN config.
        startStream();

        // 2. Codex
        // Codex polling uses global CODEX_NETWORK_ID, which is updated above.
        // Subscription would need potential restart if we had one.
        // For now, relies on startCodexPolling() loop which reads the global var/
        // But better to restart services if needed.
        if (codexCleanup) {
            codexCleanup();
            // Start Codex (History + Subscription)
            await initCodexProvider();
        }
    }

    res.json({ success: true, symbol: SYMBOL, chain: newChain });
});

// --- TIMEFRAME API ---
let currentTimeframe = '1m';

app.get('/api/timeframe', (req, res) => {
    res.json({
        current: currentTimeframe,
        available: ['1m', '5m', '15m']
    });
});

app.post('/api/timeframe', (req, res) => {
    const { timeframe } = req.body;
    if (!timeframe || !['1m', '5m', '15m'].includes(timeframe)) {
        return res.status(400).json({ error: 'Invalid timeframe. Use 1m, 5m, or 15m.' });
    }

    console.log(`🕐 Switching all providers to ${timeframe} timeframe`);
    currentTimeframe = timeframe;

    // Reset trading state


    // Broadcast reset
    broadcast({ type: 'TIMEFRAME_CHANGE', data: { timeframe } });

    res.json({ success: true, timeframe });
});

// --- THROUGHPUT TRACKING (Hz) ---
// Count updates per second
let throughputCounters = { goldrush: 0, codex: 0, mobula: 0 };
let currentThroughput = { goldrush: 0, codex: 0, mobula: 0 };
let throughputHistory = { goldrush: [], codex: [], mobula: [] };
let avgCandlesPerSecond = { goldrush: 0, codex: 0, mobula: 0 };

let latencyStats = {
    goldrush: { sum: 0, count: 0 },
    codex: { sum: 0, count: 0 },
    mobula: { sum: 0, count: 0 }
};

// Rolling latency over last 300 candles per provider
let latency300 = {
    goldrush: { samples: [], sum: 0 },
    codex: { samples: [], sum: 0 },
    mobula: { samples: [], sum: 0 }
};

// --- METRICS HISTORY FOR COMPARISON CHARTS ---
// Track connection/load time for each provider
// GoldRush: ringBufferTTFD (last candle of initial buffer) + liveDataTTFD (first live event after buffer)
// Codex: liveDataTTFD (onEventsCreated)
let connectionMetrics = {
    goldrush: {
        connectTime: 0,           // When OHLCV WS connects
        ringBufferStart: 0,       // Legacy - kept for compatibility
        ringBufferTTFD: 0,        // Time until ALL initial buffer candles arrive
        ringBufferReceived: false,// Flag: has initial buffer been fully received?
        liveDataTTFD: 0,          // Time to first LIVE candle (after buffer)
        connects: 0,
        errors: 0,
        lastError: null
    },
    codex: {
        connectTime: 0,       // When onBarsUpdated WS connects
        liveDataStart: 0,     // Legacy - kept for compatibility
        liveDataTTFD: 0,      // Time to first onBarsUpdated data (OHLCV)
        connects: 0,
        errors: 0,
        lastError: null
    },
    mobula: {
        connectTime: 0,
        liveDataTTFD: 0,
        connects: 0,
        errors: 0,
        lastError: null
    }
};

// --- LATENCY DELTA TRACKING (for stability score) ---
// Track previous latency and deltas for each provider
let latencyDelta = {
    goldrush: { prevLatency: null, deltas: [], sum: 0 },
    codex: { prevLatency: null, deltas: [], sum: 0 },
    mobula: { prevLatency: null, deltas: [], sum: 0 }
};

const MAX_ACCEPTABLE_DELTA = 50000; // 50 seconds max delta for 0% stability

// Helper to add a latency delta sample
function addLatencyDelta(provider, currentLatency) {
    const data = latencyDelta[provider];
    if (!data) return;

    if (data.prevLatency !== null) {
        const delta = Math.abs(currentLatency - data.prevLatency);
        data.deltas.push(delta);
        data.sum += delta;

        // Keep only last 100 deltas
        if (data.deltas.length > 100) {
            const removed = data.deltas.shift();
            data.sum -= removed;
        }
    }
    data.prevLatency = currentLatency;
}

// Get stability score (0-100, higher = more stable AND fast)
// Combines: consistency (low delta variance) + speed (low avg latency)
function getStabilityScore(provider) {
    const data = latencyDelta[provider];

    // 1. Delta Score (consistency) - max 100 points
    let deltaScore = 100; // Default to perfect if no data
    if (data && data.deltas.length > 0) {
        const avgDelta = data.sum / data.deltas.length;
        deltaScore = Math.max(0, 100 - (avgDelta / MAX_ACCEPTABLE_DELTA * 100));
    }

    // 2. Latency Penalty (speed) - max 30 point penalty
    // ALWAYS apply this, even if no delta samples
    const MAX_LATENCY_FOR_PENALTY = 60000; // 60 seconds
    const PENALTY_WEIGHT = 30; // Max points to deduct
    const avgLatency = getAvgLatency300(provider);
    const latencyPenalty = Math.min(PENALTY_WEIGHT, (avgLatency / MAX_LATENCY_FOR_PENALTY) * PENALTY_WEIGHT);

    // Final score = consistency - speed penalty
    const score = Math.max(0, deltaScore - latencyPenalty);
    return Math.round(score);
}

// Get raw average delta (latency variance in ms) - lower is better
function getAvgDelta(provider) {
    const data = latencyDelta[provider];
    if (!data || data.deltas.length === 0) return 0;
    return Math.round(data.sum / data.deltas.length);
}

// Time-series history for charts (last 5 min, sampled every 5s = 60 points)
let metricsHistory = [];

// Helper to add a latency sample (rolling window of 300)
function addLatencySample(provider, latency) {
    const data = latency300[provider];
    if (!data) return;

    data.samples.push(latency);
    data.sum += latency;

    // Keep only last 300 samples
    if (data.samples.length > 300) {
        const removed = data.samples.shift();
        data.sum -= removed;
    }
}

function getAvgLatency300(provider) {
    const data = latency300[provider];
    if (!data || data.samples.length === 0) return 0;
    return Math.round(data.sum / data.samples.length);
}

// Reset counters every second and calculate rolling average
setInterval(() => {
    currentThroughput = { ...throughputCounters };

    // Update rolling history (last 60 seconds)
    ['goldrush', 'codex', 'mobula'].forEach(p => {
        throughputHistory[p].push(currentThroughput[p]);
        if (throughputHistory[p].length > 60) throughputHistory[p].shift();

        // Calculate average
        const sum = throughputHistory[p].reduce((a, b) => a + b, 0);
        avgCandlesPerSecond[p] = throughputHistory[p].length > 0
            ? parseFloat((sum / throughputHistory[p].length).toFixed(2))
            : 0;
    });

    throughputCounters = { goldrush: 0, codex: 0, mobula: 0 };

    if (isRunning) {
        broadcast({
            type: 'METRICS_UPDATE',
            data: {
                current: currentThroughput,
                average: avgCandlesPerSecond
            }
        });
    }
}, 1000);

// Store latest averages for the API
let latestLatency = { goldrush: 0, codex: 0, mobula: 0 };

// Snapshot History every 5 seconds (Fast for testing, normally 1m or 10m)
setInterval(() => {
    if (!isRunning) return;

    const getAvg = (provider) => {
        const s = latencyStats[provider];
        if (s.count === 0) return latestLatency[provider] || 0; // Carry forward last known value
        const avg = Math.round(s.sum / s.count);
        // Reset
        s.sum = 0; s.count = 0;
        return avg;
    };

    // Calculate averages
    const grAvg = getAvg('goldrush');
    const cxAvg = getAvg('codex');
    const mbAvg = getAvg('mobula');

    // Update global state for /stats
    latestLatency = { goldrush: grAvg, codex: cxAvg, mobula: mbAvg };

    const snapshot = {
        time: Date.now(),
        goldrush: { avgLatency: grAvg },
        codex: { avgLatency: cxAvg },
        mobula: { avgLatency: mbAvg }
    };

    performanceHistory.push(snapshot);
    if (performanceHistory.length > 1000) performanceHistory.shift(); // Keep last 1000

    broadcast({ type: 'HISTORY_UPDATE', data: performanceHistory });

    // Broadcast full stats via WebSocket (replaces HTTP polling)
    broadcast({
        type: 'STATS_UPDATE',
        data: {
            uptime: Date.now() - startedAt,
            throughput: currentThroughput,
            avgLatency: { goldrush: grAvg, codex: cxAvg, mobula: mbAvg },
            metricsHistory: metricsHistory
        }
    });

    // --- METRICS HISTORY SNAPSHOT (for comparison charts) ---
    const grCurrentStats = grStats.getStats();
    const mbCurrentStats = mbStats.getStats();

    // Calculate Raw Jitter (Max Delta)
    // Use Max Delta (biggest jump) to show volatility even with low throughput

    function calculateMaxIntervalDelta(samples, prevVal) {
        if (!samples || samples.length === 0) return 0;
        let maxD = 0;
        let prev = prevVal;

        // If prev is 0 (first run), use first sample as baseline (delta 0)
        if (prev === 0 && samples.length > 0) prev = samples[0];

        for (const val of samples) {
            const diff = Math.abs(val - prev);
            if (diff > maxD) maxD = diff;
            prev = val;
        }
        return maxD;
    }

    if (intervalLatencies.goldrush.length > 0) {
        lastIntervalStats.goldrush.stdDev = calculateMaxIntervalDelta(intervalLatencies.goldrush, lastIntervalEndVal.goldrush);
        lastIntervalEndVal.goldrush = intervalLatencies.goldrush[intervalLatencies.goldrush.length - 1]; // Update last val
    }
    if (intervalLatencies.codex.length > 0) {
        lastIntervalStats.codex.stdDev = calculateMaxIntervalDelta(intervalLatencies.codex, lastIntervalEndVal.codex);
        lastIntervalEndVal.codex = intervalLatencies.codex[intervalLatencies.codex.length - 1];
    }
    if (intervalLatencies.mobula.length > 0) {
        lastIntervalStats.mobula.stdDev = calculateMaxIntervalDelta(intervalLatencies.mobula, lastIntervalEndVal.mobula);
        lastIntervalEndVal.mobula = intervalLatencies.mobula[intervalLatencies.mobula.length - 1];
    }

    const metricsSnapshot = {
        time: Date.now(),
        goldrush: {
            ringBufferTTFD: connectionMetrics.goldrush.ringBufferTTFD, // OHLCV stream
            liveDataTTFD: connectionMetrics.goldrush.liveDataTTFD,     // updatePairs stream
            candlesPerSec: avgCandlesPerSecond.goldrush,
            jitter: grCurrentStats.jitter,              // Rolling Jitter (for Table)
            stdDev: lastIntervalStats.goldrush.stdDev,  // Max Delta (for Chart)
            p95: grCurrentStats.p95,
            p99: grCurrentStats.p99,
            eventCount: eventCounters.goldrush,  // Actual total events (not capped)
            intervalEventCount: intervalEvents.goldrush,  // Events in this 60s interval
            avgLatency: grAvg
        },
        codex: {
            liveDataTTFD: connectionMetrics.codex.liveDataTTFD,     // onBarsUpdated (OHLCV)
            candlesPerSec: avgCandlesPerSecond.codex,
            jitter: codexLatestStats.jitter,            // Rolling Jitter (for Table)
            stdDev: lastIntervalStats.codex.stdDev,     // Max Delta (for Chart)
            p95: codexLatestStats.p95,
            p99: codexLatestStats.p99,
            eventCount: eventCounters.codexBars,  // Actual total events (not capped)
            intervalEventCount: intervalEvents.codex,    // Events in this 60s interval
            avgLatency: cxAvg
        },
        mobula: {
            ringBufferTTFD: 0, // Mobula has no ring buffer
            liveDataTTFD: connectionMetrics.mobula.liveDataTTFD,
            candlesPerSec: avgCandlesPerSecond.mobula,
            jitter: mbCurrentStats.jitter,
            stdDev: lastIntervalStats.mobula.stdDev,
            p95: mbCurrentStats.p95,
            p99: mbCurrentStats.p99,
            eventCount: eventCounters.mobulaOHLCV,  // Actual total events (not capped)
            intervalEventCount: intervalEvents.mobula,
            avgLatency: mbAvg
        }
    };

    // Reset Interval Buckets for next snapshot
    intervalLatencies.goldrush = [];
    intervalLatencies.codex = [];
    intervalLatencies.mobula = [];
    intervalEvents.goldrush = 0;
    intervalEvents.codex = 0;
    intervalEvents.mobula = 0;

    metricsHistory.push(metricsSnapshot);
    if (metricsHistory.length > 60) metricsHistory.shift(); // Keep last 60 min (60 * 60s = 3600s = 1hr)
}, 60000); // 1-minute snapshots (matching candle interval)

// Helper to increment throughput
function countUpdate(provider) {
    if (throughputCounters[provider] !== undefined) {
        throughputCounters[provider]++;
    }
}

// --- STATS ENDPOINT ---
const startedAt = Date.now();
let performanceHistory = [];

app.get('/stats', (req, res) => {
    const uptime = Date.now() - startedAt;

    res.json({
        uptime,
        history: performanceHistory,
        throughput: currentThroughput,
        candlesPerMinute: {
            goldrush: currentThroughput.goldrush * 60,
            codex: currentThroughput.codex * 60,
            mobula: currentThroughput.mobula * 60
        },
        latencyRace: {
            goldrush: { avgLatency: latestLatency.goldrush },
            codex: { avgLatency: latestLatency.codex },
            mobula: { avgLatency: latestLatency.mobula }
        },
        avgLatency300: {
            goldrush: getAvgLatency300('goldrush'),
            codex: getAvgLatency300('codex'),
            mobula: getAvgLatency300('mobula')
        },
        // Jitter & P99 calculated from rolling stats
        jitter: {
            goldrush: grStats.getStats().jitter,
            codex: codexLatestStats.jitter,
            mobula: mbStats.getStats().jitter
        },
        p99: {
            goldrush: grStats.getStats().p99,
            codex: codexLatestStats.p99,
            mobula: mbStats.getStats().p99
        }
    });
});

// --- METRICS HISTORY ENDPOINT (for comparison charts) ---
app.get('/metrics-history', (req, res) => {
    res.json({
        history: metricsHistory,
        current: {
            goldrush: {
                loadTime: connectionMetrics.goldrush.loadTime,
                candlesPerSec: avgCandlesPerSecond.goldrush,
                latencyVariance: getAvgDelta('goldrush'),
                latency300: getAvgLatency300('goldrush')
            },
            codex: {
                loadTime: connectionMetrics.codex.loadTime,
                candlesPerSec: avgCandlesPerSecond.codex,
                latencyVariance: getAvgDelta('codex'),
                latency300: getAvgLatency300('codex')
            },
            mobula: {
                loadTime: connectionMetrics.mobula.loadTime,
                candlesPerSec: avgCandlesPerSecond.mobula,
                latencyVariance: getAvgDelta('mobula'),
                latency300: getAvgLatency300('mobula')
            }
        }
    });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- BROADCAST HELPER ---
function broadcast(msg) {
    if (!isRunning) return;
    const data = JSON.stringify(msg);

    // Store LOG_EVENT in history for replay to new clients
    if (msg.type === 'LOG_EVENT' && msg.provider) {
        const maxLogs = 100; // Keep last 100 logs per provider
        if (logHistory[msg.provider]) {
            logHistory[msg.provider].push(msg);
            if (logHistory[msg.provider].length > maxLogs) {
                logHistory[msg.provider].shift();
            }
        }
    }

    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// --- GOLDRUSH: Process OHLCV Candles ---
async function processGoldrushCandles(candles) {
    const fastArrival = Date.now();

    if (!candles || candles.length === 0) return;

    const latestCandle = candles[candles.length - 1];
    const price = latestCandle.close || latestCandle.quote_rate_usd;

    // Auto-Detect Symbol from Metadata
    if (latestCandle.base_token && latestCandle.base_token.contract_ticker_symbol) {
        const detectedSymbol = latestCandle.base_token.contract_ticker_symbol;
        if (detectedSymbol && detectedSymbol !== SYMBOL) {
            // IGNORE 'Bonk' if we are on BASE (prevent cross-talk from zombie streams)
            if (CURRENT_CHAIN === 'BASE' && detectedSymbol === 'Bonk') return;

            console.log(`\n🔍 Auto-Detected Symbol: ${detectedSymbol} (was ${SYMBOL})`);
            const oldSymbol = SYMBOL;
            SYMBOL = detectedSymbol;

            // Migrate state
            if (pairs[oldSymbol]) {
                pairs[SYMBOL] = pairs[oldSymbol];
                delete pairs[oldSymbol];
            } else {
                pairs[SYMBOL] = {
                    price: pairs[oldSymbol]?.price || 0,
                    fastPrice: pairs[oldSymbol]?.fastPrice || 0,
                    slowPrice: pairs[oldSymbol]?.slowPrice || 0
                };
            }

            // Broadcast Update
            broadcast({ type: 'SYMBOL_UPDATE', data: { symbol: SYMBOL } });
        }
    }

    // Basic validation: Price must be positive
    if (!price || price <= 0) {
        console.warn(`⚠️ Ignored invalid price ($${price})`);
        return;
    }

    const candleTimeMs = new Date(latestCandle.timestamp).getTime();
    // For ONE_MINUTE interval, candle close time is candleStart + 60 seconds
    // We measure latency relative to when the candle *could* first arrive (at close)
    const CANDLE_DURATION_MS = 60 * 1000;
    let goldRushLatency = Date.now() - (candleTimeMs + CANDLE_DURATION_MS);

    // DEBUG:
    console.log(`[LATENCY DEBUG] GR: Now=${Date.now()} Candle=${candleTimeMs} Lat=${goldRushLatency}`);
    if (goldRushLatency < 0) goldRushLatency = 0;

    // Track Latency
    latencyStats.goldrush.sum += goldRushLatency;
    latencyStats.goldrush.count++;
    addLatencySample('goldrush', goldRushLatency);
    addLatencyDelta('goldrush', goldRushLatency);
    latestLatency.goldrush = goldRushLatency;

    logger.goldrush.stream(price, goldRushLatency, candles.length);
    // countUpdate('goldrush') removed - throughput now tracked only from updatePairs stream


    pairs[SYMBOL].price = price;
    pairs[SYMBOL].fastPrice = price;

    // Accumulate candles
    const newCandles = candles.map(c => ({
        time: Math.floor(new Date(c.timestamp).getTime() / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
    }));



    const candleMap = new Map();
    goldrushCandles.forEach(c => candleMap.set(c.time, c));
    newCandles.forEach(c => candleMap.set(c.time, c));

    goldrushCandles = Array.from(candleMap.values())
        .sort((a, b) => a.time - b.time)
        .slice(-15);

    broadcast({
        type: 'FAST_TICK',
        data: {
            pair: SYMBOL,
            price: price,
            timestamp: fastArrival,
            latency: goldRushLatency,
            candles: goldrushCandles,
            throughput: avgCandlesPerSecond.goldrush
        }
    });

    // Run INDEPENDENT GoldRush paper trading
    // checkGoldrushTrade(price);
}


// --- CODEX WEBSOCKET SUBSCRIPTION ---
let codexCleanup = null;


async function initCodexProvider() {
    // Start Live Subscription via SDK IMPACT: Run in parallel with history fetch
    startCodexSubscription();

    // Fetch History (Backfill) via HTTP - purely for chart data
    console.log("🐢 Fetching Codex History...");
    await fetchCodexPrice();
}

function startCodexSubscription() {
    if (codexCleanup) {
        try { codexCleanup(); } catch (e) { }
        codexCleanup = null;
    }

    console.log("🐢 Connecting to Codex GraphQL Stream (Events)...");
    // Timer will be set when WS connects (in 'connected' callback)
    connectionMetrics.codex.connects++;

    // Raw graphql-ws connection (NO SDK) with AUTO-RECONNECTION
    const codexWsClient = createClient({
        url: 'wss://graph.codex.io/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            Authorization: process.env.CODEX_API_KEY
        },
        retryAttempts: Infinity,  // Keep retrying forever
        shouldRetry: () => true,  // Always retry on close
        retry: async (retries) => {
            const delay = Math.min(1000 * Math.pow(2, retries), 30000); // Exponential backoff, max 30s
            console.log(`🔄 Codex Events reconnecting in ${delay / 1000}s (attempt ${retries + 1})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        },
        on: {
            connected: () => {
                connectionMetrics.codex.connectTime = Date.now(); // TTFD timer starts when Events WS connects
                console.log(`✅ Connected to Codex GraphQL Stream!`);
            },
            error: (err) => {
                console.error('❌ Codex WS Error:', err);
                connectionMetrics.codex.errors++;
                connectionMetrics.codex.lastError = Date.now();
            },
            closed: () => console.log('📴 Codex Events Stream Disconnected - will auto-reconnect')
        }
    });

    const address = PAIR_ADDRESS;
    const networkId = parseInt(CODEX_NETWORK_ID);

    console.log(`🐢 Subscribing to Codex Events for: ${address} on Network: ${networkId}`);

    const query = `
        subscription($address: String!, $networkId: Int!) {
            onEventsCreated(
                address: $address
                networkId: $networkId
            ) {
                events {
                    transactionHash
                    blockNumber
                    timestamp
                    data {
                        ... on SwapEventData {
                            priceUsd
                            amount0
                            amount1
                            type
                        }
                    }
                }
            }
        }
    `;

    // Subscribe to Events
    const eventsUnsub = codexWsClient.subscribe(
        {
            query,
            variables: { address, networkId }
        },
        {
            next: (result) => {
                const events = result?.data?.onEventsCreated?.events;
                if (events && events.length > 0) {
                    // TTFD on first onEventsCreated data
                    if (connectionMetrics.codex.liveDataTTFD === 0) {
                        connectionMetrics.codex.liveDataTTFD = Date.now() - connectionMetrics.codex.connectTime;
                        const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
                        console.log(`[${timeStr}] [CODEX] LIVE DATA    | First onEventsCreated | TTFD: ${connectionMetrics.codex.liveDataTTFD}ms`);
                    }
                    processCodexEvents(events);
                }
            },
            error: (err) => {
                console.error('❌ Codex Subscription Error:', err);
                connectionMetrics.codex.errors++;
                connectionMetrics.codex.lastError = Date.now();
            },
            complete: () => console.log('🐢 Codex Subscription Complete')
        }
    );

    // --- SECOND SUBSCRIPTION: onBarsUpdated for Bar Chart Throughput ---
    console.log("📊 Starting Codex onBarsUpdated Stream (Bar Chart)...");
    const codexBarsClient = createClient({
        url: 'wss://graph.codex.io/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            Authorization: process.env.CODEX_API_KEY
        },
        retryAttempts: Infinity,
        shouldRetry: () => true,
        retry: async (retries) => {
            const delay = Math.min(1000 * Math.pow(2, retries), 30000);
            console.log(`🔄 Codex Bars reconnecting in ${delay / 1000}s (attempt ${retries + 1})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        },
        on: {
            connected: () => {
                console.log('✅ Connected to Codex onBarsUpdated Stream!');
            },
            error: (err) => console.error('❌ Codex Bars WS Error:', err),
            closed: () => console.log('📴 Codex Bars Stream Disconnected - will auto-reconnect')
        }
    });

    const pairId = `${PAIR_ADDRESS}:${CODEX_NETWORK_ID}`;
    const barsQuery = `
        subscription($pairId: String!) {
            onBarsUpdated(
                pairId: $pairId
                quoteToken: token0
            ) {
                pairId
                timestamp
                aggregates {
                    r1 {
                        t
                        usd {
                            o
                            h
                            l
                            c
                            volume
                            t
                        }
                    }
                }
            }
        }
    `;

    const barsUnsub = codexBarsClient.subscribe(
        { query: barsQuery, variables: { pairId } },
        {
            next: (result) => {
                const now = Date.now();
                const bar = result?.data?.onBarsUpdated;
                if (bar && bar.aggregates?.r1?.usd) {
                    countUpdate('codex');

                    // TTFD calculated in onEventsCreated (faster)

                    // Latency: now - bar timestamp (Unix seconds)
                    const barTimeMs = bar.timestamp * 1000;
                    const latency = now - barTimeMs;
                    const price = bar.aggregates.r1.usd.c;

                    // Metrics (same stream type as GoldRush updatePairs)
                    latencyStats.codex.sum += latency;
                    latencyStats.codex.count++;
                    addLatencySample('codex', latency);
                    addLatencyDelta('codex', latency);
                    latestLatency.codex = latency;

                    // Rolling Stats
                    cxStats.add(latency);
                    const stats = cxStats.getStats();
                    codexLatestStats = stats;
                    intervalEvents.codex++;  // Track events per interval

                    // Interval Push (Raw Jitter)
                    if (latency >= 0 && latency < 60000) intervalLatencies.codex.push(latency);

                    const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
                    eventCounters.codexBars++;
                    const agg = bar.aggregates?.r1?.usd;
                    console.log(`\n[${timeStr}] [CODEX] onBarsUpdated Event #${eventCounters.codexBars}`);
                    console.log(`  O:${agg?.o?.toFixed(4)} H:${agg?.h?.toFixed(4)} L:${agg?.l?.toFixed(4)} C:${agg?.c?.toFixed(4)}`);
                    console.log(`  Timestamp: ${bar.timestamp} | Latency: ${latency}ms`);

                    // Broadcast log event to frontend
                    broadcast({
                        type: 'LOG_EVENT',
                        provider: 'codex',
                        data: {
                            id: `cx-bar-${eventCounters.codexBars}`,
                            eventNum: eventCounters.codexBars,
                            eventType: 'onBarsUpdated',
                            time: timeStr,
                            timestamp: bar.timestamp * 1000,
                            o: agg?.o?.toFixed(4),
                            h: agg?.h?.toFixed(4),
                            l: agg?.l?.toFixed(4),
                            c: agg?.c?.toFixed(4),
                            latency: latency
                        }
                    });

                    broadcast({
                        type: 'SLOW_TICK',
                        data: {
                            pair: SYMBOL,
                            price: price,
                            timestamp: now,
                            latency: latency,
                            candles: [],
                            throughput: avgCandlesPerSecond.codex,
                            stats: stats
                        }
                    });
                }
            },
            error: (err) => console.error('❌ Codex Bars Subscription Error:', err),
            complete: () => console.log('Codex Bars Stream Completed')
        }
    );

    // Assign Cleanup Function
    codexCleanup = () => {
        console.log('🛑 Disposing Codex Clients...');
        eventsUnsub();
        barsUnsub();
        codexWsClient.dispose();
        codexBarsClient.dispose();
    };
}


function processCodexEvents(events) {
    // NOTE: Latency stats are now calculated in onBarsUpdated for equal comparison with GoldRush
    // This function only updates the price state from swap events

    events.forEach(event => {
        if (event.data && event.data.priceUsd) {
            const price = parseFloat(event.data.priceUsd);

            // Update State only
            if (!pairs[SYMBOL]) pairs[SYMBOL] = { price: 0, fastPrice: 0, slowPrice: 0, geckoPrice: 0 };
            pairs[SYMBOL].slowPrice = price;

            // Update global stats capture
            updatePairs(SYMBOL, {
                slowPrice: price
            });
        }
    });
}

async function fetchCodexPrice() {
    const startTime = Date.now();
    try {
        const now = Math.floor(Date.now() / 1000);
        const lookback = now - 900;

        const query = `
            query {
                getBars(
                    symbol: "${PAIR_ADDRESS}:${CODEX_NETWORK_ID}"
                    from: ${lookback}
                    to: ${now}
                    resolution: "1"
                ) {
                    t
                    o
                    h
                    l
                    c
                }
            }
        `;

        const response = await axios.post(
            'https://graph.codex.io/graphql',
            { query },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': process.env.CODEX_API_KEY
                },
                timeout: 15000
            }
        );

        const endTime = Date.now();
        const networkLatency = endTime - startTime;
        const data = response.data?.data?.getBars;

        if (data && data.c && data.c.length > 0) {
            const codexPrice = data.c[data.c.length - 1];

            // TTFD now calculated in onBarsUpdated subscription (standardized)

            pairs[SYMBOL].slowPrice = codexPrice;

            // Format OHLCV candles
            codexCandles = data.t.map((timestamp, i) => ({
                time: timestamp,
                open: data.o[i],
                high: data.h[i],
                low: data.l[i],
                close: data.c[i]
            })).sort((a, b) => a.time - b.time);

            broadcast({
                type: 'SLOW_TICK',
                data: {
                    pair: SYMBOL,
                    price: codexPrice,
                    timestamp: endTime,
                    latency: networkLatency,
                    candles: codexCandles,
                    throughput: avgCandlesPerSecond.codex
                }
            });

            // Run INDEPENDENT Codex paper trading
            // checkCodexTrade(codexPrice);
        }

    } catch (err) {
        // Log Codex errors for debugging
        console.warn("⚠️ Codex fetch error:", err.message);
    }
}


// --- GOLDRUSH STREAM (raw graphql-ws) ---
let goldrushCleanup = null;

function startStream() {
    // 1. Cleanup previous stream if exists
    if (goldrushCleanup) {
        console.log('🧹 Cleaning up previous GoldRush streams...');
        goldrushCleanup();
        goldrushCleanup = null;
    }

    console.log(`🚀 Starting GoldRush OHLCV Pairs Stream on: ${CURRENT_CHAIN}`);
    // Timer will be set when WS connects (in 'connected' callback)

    // Use graphql-ws for raw GraphQL subscription (NO SDK) with AUTO-RECONNECTION
    const grWsClient = createClient({
        url: 'wss://gr-staging-v2.streaming.covalenthq.com/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            GOLDRUSH_API_KEY: process.env.COVALENT_API_KEY
        },
        retryAttempts: Infinity,  // Keep retrying forever
        shouldRetry: () => true,  // Always retry on close
        retry: async (retries) => {
            const delay = Math.min(1000 * Math.pow(2, retries), 30000);
            console.log(`🔄 GoldRush OHLCV reconnecting in ${delay / 1000}s (attempt ${retries + 1})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        },
        on: {
            connected: () => {
                console.log('✅ Connected to GoldRush OHLCV Stream!');
                connectionMetrics.goldrush.connects++;
                connectionMetrics.goldrush.connectTime = Date.now(); // TTFD timer starts here
            },
            error: (err) => {
                console.error('❌ GoldRush WS Error:', err);
                connectionMetrics.goldrush.errors++;
                connectionMetrics.goldrush.lastError = Date.now();
            },
            closed: () => console.log('📴 GoldRush OHLCV Stream Disconnected - will auto-reconnect')
        }
    });

    const query = `subscription {
        ohlcvCandlesForPair(
            chain_name: ${CURRENT_CHAIN}
            pair_addresses: ["${PAIR_ADDRESS}"]
            interval: ONE_MINUTE
            timeframe: ONE_HOUR
        ) {
            chain_name
            pair_address
            interval
            timeframe
            timestamp
            open
            high
            low
            close
            volume
            volume_usd
            quote_rate
            quote_rate_usd
            base_token {
                contract_ticker_symbol
            }
            quote_token {
                contract_ticker_symbol
            }
        }
    }`;

    // Subscribe and handle events
    const ohlcvUnsub = grWsClient.subscribe({ query }, {
        next: (result) => {
            const candles = result?.data?.ohlcvCandlesForPair;
            if (candles && candles.length > 0) {
                eventCounters.goldrushOHLCV++;
                const c = candles[candles.length - 1];
                const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
                console.log(`\n[GOLDRUSH] OHLCV Event #${eventCounters.goldrushOHLCV} (${candles.length} candles)`);
                console.log(`  O:${c.open?.toFixed(4)} H:${c.high?.toFixed(4)} L:${c.low?.toFixed(4)} C:${c.close?.toFixed(4)} V:${c.volume?.toFixed(2)}`);
                console.log(`  Timestamp: ${c.timestamp}`);

                // Detect Ring Buffer vs Live Data based on message size
                if (!connectionMetrics.goldrush.ringBufferReceived) {
                    // First message(s) with many candles = Ring Buffer (historical data)
                    if (candles.length > 1) {
                        // Still receiving ring buffer
                        connectionMetrics.goldrush.ringBufferTTFD = Date.now() - connectionMetrics.goldrush.connectTime;
                        console.log(`[${timeStr}] [GOLDRUSH] RING BUFFER  | Received ${candles.length} candles | TTFD: ${connectionMetrics.goldrush.ringBufferTTFD}ms`);
                    } else {
                        // Single candle = first LIVE data after buffer (or empty buffer)
                        connectionMetrics.goldrush.ringBufferReceived = true;

                        // If we never got a large buffer, the "buffer" time is just now
                        if (connectionMetrics.goldrush.ringBufferTTFD === 0) {
                            connectionMetrics.goldrush.ringBufferTTFD = Date.now() - connectionMetrics.goldrush.connectTime;
                        }

                        if (connectionMetrics.goldrush.liveDataTTFD === 0) {
                            connectionMetrics.goldrush.liveDataTTFD = Date.now() - connectionMetrics.goldrush.connectTime;
                        }
                        console.log(`[${timeStr}] [GOLDRUSH] RING BUFFER  | Skipped/Complete | TTFD: ${connectionMetrics.goldrush.ringBufferTTFD}ms`);
                        console.log(`[${timeStr}] [GOLDRUSH] LIVE DATA    | First candle | TTFD: ${connectionMetrics.goldrush.liveDataTTFD}ms`);
                    }
                } else {
                    // Subsequent Live Data Candles
                }

                processGoldrushOHLCV(candles);
            }
        },
        error: (err) => {
            console.error('❌ GoldRush Subscription Error:', err);
            connectionMetrics.goldrush.errors++;
            connectionMetrics.goldrush.lastError = Date.now();
        },
        complete: () => console.log('GoldRush OHLCV Stream Completed')
    });

    // --- SEPARATE CLIENT: updatePairs for LATENCY METRICS (not for TTFD) ---
    console.log('📊 Starting GoldRush updatePairs Stream...');
    const grUpdatePairsClient = createClient({
        url: 'wss://gr-staging-v2.streaming.covalenthq.com/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            GOLDRUSH_API_KEY: process.env.COVALENT_API_KEY
        },
        retryAttempts: Infinity,
        shouldRetry: () => true,
        retry: async (retries) => {
            const delay = Math.min(1000 * Math.pow(2, retries), 30000);
            console.log(`🔄 GoldRush updatePairs reconnecting in ${delay / 1000}s (attempt ${retries + 1})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        },
        on: {
            connected: () => {
                console.log('✅ Connected to GoldRush updatePairs Stream!');
            },
            error: (err) => console.error('❌ GoldRush UpdatePairs WS Error:', err),
            closed: () => console.log('📴 GoldRush updatePairs Stream Disconnected - will auto-reconnect')
        }
    });

    const updateQuery = `subscription {
        updatePairs(
            chain_name: ${CURRENT_CHAIN}
            pair_addresses: ["${PAIR_ADDRESS}"]
        ) {
            chain_name
            pair_address
            timestamp
            quote_rate
            quote_rate_usd
        }
    }`;

    const updateUnsub = grUpdatePairsClient.subscribe({ query: updateQuery }, {
        next: (result) => {
            const update = result?.data?.updatePairs;
            if (update) {
                eventCounters.goldrush++;
                const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
                console.log(`\n[GOLDRUSH] updatePairs Event #${eventCounters.goldrush}`);
                console.log(`  Timestamp: ${update.timestamp}`);

                // Calculate Latency
                const eventTime = new Date(update.timestamp).getTime();
                const latency = Date.now() - eventTime;

                // [FIX] Calculate Live Data TTFD on first tick (instead of waiting for next candle)
                if (connectionMetrics.goldrush.liveDataTTFD === 0) {
                    connectionMetrics.goldrush.liveDataTTFD = Date.now() - connectionMetrics.goldrush.connectTime;
                    console.log(`[${timeStr}] [GOLDRUSH] LIVE DATA    | First tick | TTFD: ${connectionMetrics.goldrush.liveDataTTFD}ms`);
                }

                // Log uniformed format
                console.log(`[${timeStr}] [GOLDRUSH] STREAM     | Tick received | Price: $${update.quote_rate_usd?.toFixed(2)} | Latency: ${latency}ms | Timestamp: ${update.timestamp}`);

                // Broadcast log event to frontend
                broadcast({
                    type: 'LOG_EVENT',
                    provider: 'goldrush',
                    data: {
                        id: `gr-update-${eventCounters.goldrush}`,
                        eventNum: eventCounters.goldrush,
                        eventType: 'updatePairs',
                        time: timeStr,
                        timestamp: update.timestamp,
                        price: update.quote_rate_usd?.toFixed(4)
                    }
                });

                // Map to internal format expected by processGoldrushUpdate
                update.price_usd = update.quote_rate_usd;
                processGoldrushUpdate(update);
            }
        },
        error: (err) => console.error('❌ GoldRush UpdatePairs Error:', err),
        complete: () => console.log('GoldRush UpdatePairs Stream Completed')
    });

    // Assign removal function to global variable
    goldrushCleanup = () => {
        console.log('🛑 Disposing GoldRush Clients...');
        ohlcvUnsub();
        updateUnsub();
        grWsClient.dispose();
        grUpdatePairsClient.dispose();
    };
}

// --- GOLDRUSH: Process updatePairs for LATENCY METRICS ---
function processGoldrushUpdate(update) {
    if (!update || !update.timestamp) return;

    const now = Date.now();

    // TTFD now calculated in ohlcvCandlesForPair handler (standardized to bar chart stream)

    // timestamp is the block timestamp (ISO string)
    const blockTime = new Date(update.timestamp).getTime();
    const latency = now - blockTime; // client_receive_time - block_time

    // Log latency like Codex
    const price = parseFloat(update.quote_rate_usd || 0).toFixed(2);
    const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    console.log(`[${timeStr}] [GOLDRUSH] STREAM     | Tick received | Price: $${price} | Latency: ${latency}ms | Timestamp: ${update.timestamp}`);

    // Add to rolling stats for p50/p95/p99
    // Note: updatePairs is a SEPARATE stream from OHLCV - no ring buffer concept here
    grStats.add(latency);
    latestLatency.goldrush = latency;
    intervalEvents.goldrush++;  // Track events per interval

    // Interval Push (Raw Jitter)
    intervalLatencies.goldrush.push(latency);

    addLatencySample('goldrush', latency);
    latencyStats.goldrush.sum += latency;
    latencyStats.goldrush.count++;
    addLatencyDelta('goldrush', latency);
    countUpdate('goldrush');
}

// --- GOLDRUSH: Process OHLCV Candles (charts only, latency comes from updatePairs) ---
function processGoldrushOHLCV(candles) {
    if (!candles || candles.length === 0) return;

    const latestCandle = candles[candles.length - 1];
    const price = latestCandle.close || latestCandle.quote_rate;

    if (price) {
        pairs[SYMBOL].price = price;
        pairs[SYMBOL].fastPrice = price;
    }

    // Update candles array for charts
    const newCandles = candles.map(c => ({
        time: Math.floor(new Date(c.timestamp).getTime() / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume_usd
    }));

    // Merge with existing candles
    const candleMap = new Map();
    goldrushCandles.forEach(c => candleMap.set(c.time, c));
    newCandles.forEach(c => candleMap.set(c.time, c));

    goldrushCandles = Array.from(candleMap.values())
        .sort((a, b) => a.time - b.time)
        .slice(-60); // Keep last 60 candles (1 hour of 1-min candles)

    // Broadcast candle update (latency stats come from updatePairs stream)
    broadcast({
        type: 'FAST_TICK',
        data: {
            pair: SYMBOL,
            price: price,
            timestamp: Date.now(),
            latency: latestLatency.goldrush,
            candles: goldrushCandles,
            throughput: avgCandlesPerSecond.goldrush
        }
    });
}

function startMobulaStream() {
    console.log("🔌 Connecting to Mobula WebSocket...");
    const ws = new WebSocket('wss://api.mobula.io');

    ws.on('open', () => {
        console.log("✅ Mobula WS Connected");
        connectionMetrics.mobula.connects++;
        connectionMetrics.mobula.connectTime = Date.now();
        connectionMetrics.mobula.ringBufferStart = Date.now();

        // Determine Chain ID (Mobula uses 'solana' or 'evm:ID')
        const chainId = CURRENT_CHAIN === 'SOLANA_MAINNET' ? 'solana' : 'evm:' + CODEX_NETWORK_ID;
        console.log(`Mobula Params: Address=${PAIR_ADDRESS} Chain=${chainId}`);

        // Subscribe OHLCV (Pair Mode)
        const ohlcvMsg = {
            type: "ohlcv",
            authorization: process.env.MOBULA_API_KEY,
            payload: {
                address: PAIR_ADDRESS,
                chainId: chainId,
                period: "1m",
                mode: "pair",
                subscriptionTracking: true
            }
        };
        ws.send(JSON.stringify(ohlcvMsg));
        console.log(`📤 Mobula OHLCV Sub: Pair ${PAIR_ADDRESS} on ${chainId} (mode: pair)`);

        // Subscribe Market Details (Trades)
        const marketMsg = {
            type: "market-details",
            authorization: process.env.MOBULA_API_KEY,
            payload: {
                pools: [
                    {
                        address: PAIR_ADDRESS,
                        blockchain: chainId
                    }
                ],
                subscriptionTracking: true
            }
        };
        ws.send(JSON.stringify(marketMsg));
        console.log(`📤 Mobula Market Details Sub`);
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            const now = Date.now();

            // Handle Market Details (Trades) for EVENT COUNTING + LATENCY
            // Trade structure: { date, token_price, type, hash, ... }
            if (msg.date && msg.token_price !== undefined) {
                // This is a trade event from market-details stream
                eventCounters.mobulaOHLCV++;  // Reuse counter for display consistency

                // Calculate latency from trade timestamp
                const tradeTime = msg.date; // Unix milliseconds
                const latency = now - tradeTime;

                countUpdate('mobula');

                // Update latency stats for getAvg() calculation
                latencyStats.mobula.sum += latency;
                latencyStats.mobula.count++;

                mbStats.add(latency);
                intervalLatencies.mobula.push(latency);
                intervalEvents.mobula++;

                // Trade handled - TTFD NOT calculated here (uses OHLCV instead)

                const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
                const tradeType = msg.type || 'unknown'; // 'buy' or 'sell'

                const logMsg = {
                    id: `mb-trade-${now}-${eventCounters.mobulaOHLCV}`,
                    eventNum: eventCounters.mobulaOHLCV,
                    timestamp: now,
                    time: timeStr,
                    latency: latency,
                    eventType: 'trade',
                    price: msg.token_price || 0,
                    details: tradeType
                };
                broadcast({ type: 'LOG_EVENT', provider: 'mobula', data: logMsg });
                console.log(`[${timeStr}] [MOBULA] Trade #${eventCounters.mobulaOHLCV} | ${tradeType.toUpperCase()} | Price: $${msg.token_price?.toFixed(4)} | Latency: ${latency}ms`);
                return; // Trade handled
            }

            // Snapshot does NOT trigger TTFD - only OHLCV does

            // Handle OHLCV Updates (Candle - BUFFER + TTFD calculation)
            if (msg.open && msg.close && msg.time) {
                // TTFD on first OHLCV candle
                if (connectionMetrics.mobula.liveDataTTFD === 0) {
                    connectionMetrics.mobula.liveDataTTFD = Date.now() - connectionMetrics.mobula.connectTime;
                    const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
                    console.log(`[${timeStr}] [MOBULA] LIVE DATA    | First OHLCV candle | TTFD: ${connectionMetrics.mobula.liveDataTTFD}ms`);
                }

                // Update candle buffer for charts
                const candleTime = msg.time;
                const lastCandle = mobulaCandles[mobulaCandles.length - 1];
                if (lastCandle && lastCandle.time === candleTime) {
                    mobulaCandles[mobulaCandles.length - 1] = msg;
                } else {
                    mobulaCandles.push(msg);
                    if (mobulaCandles.length > 500) mobulaCandles.shift();
                }
                return;
            }

            /*
             * DISABLED: User requested Aggregated Bars (Candles) only for metrics.
             * Raw trades are displayed in debug logs but not counted towards main stats
             * to align with GoldRush/Codex aggregated behavior.
             */
            // if (msg.data || (msg.pair && msg.date)) { ... }

        } catch (err) {
            console.error("Mobula Msg Parse Error:", err);
        }
    });

    ws.on('error', (err) => {
        console.error("❌ Mobula WS Error:", err.message);
        connectionMetrics.mobula.errors++;
        connectionMetrics.mobula.lastError = err.message;
    });

    ws.on('close', () => {
        console.warn("⚠️ Mobula WS Closed. Reconnecting in 5s...");
        setTimeout(startMobulaStream, 5000);
    });
}

server.listen(PORT, async () => {
    console.log(`🚀 Server Starting (${CURRENT_CHAIN} - ${SYMBOL})...`);

    // Resolve Network ID dynamically
    if (CHAIN_CONFIG[CURRENT_CHAIN]) {
        CODEX_NETWORK_ID = CHAIN_CONFIG[CURRENT_CHAIN].codexNetworkId;
        console.log(`✅ Using Codex Network ID: ${CODEX_NETWORK_ID}`);
    } else {
        console.warn(`⚠️ Unknown Chain: ${CURRENT_CHAIN}, defaulting to Solana ID`);
    }

    // Initialize Providers
    try {
        streamsStartTime = Date.now(); // Set global start time for all streams
        startStream(); // GoldRush
        startMobulaStream(); // Mobula
        await initCodexProvider(); // Codex
    } catch (err) {
        console.error("❌ Stats Server Init Error:", err);
    }

    console.log(`✅ Backend listening on http://localhost:${PORT}`);
});

// --- WS CONNECTION HANDLING ---
wss.on('connection', (ws) => {
    clients.add(ws);

    ws.send(JSON.stringify({
        type: 'INIT',
        data: { pairs, trades: [], ideas: [] }
    }));

    // Send existing candle data
    if (goldrushCandles.length > 0) {
        ws.send(JSON.stringify({
            type: 'FAST_TICK',
            data: {
                pair: SYMBOL,
                price: pairs[SYMBOL].fastPrice,
                timestamp: Date.now(),
                latency: 0,
                candles: goldrushCandles
            }
        }));
    }

    if (codexCandles.length > 0) {
        ws.send(JSON.stringify({
            type: 'SLOW_TICK',
            data: {
                pair: SYMBOL,
                price: pairs[SYMBOL].slowPrice,
                timestamp: Date.now(),
                latency: 0,
                candles: codexCandles
            }
        }));
    }

    // Send log history to new clients
    for (const logEvent of logHistory.goldrush) {
        ws.send(JSON.stringify(logEvent));
    }
    for (const logEvent of logHistory.codex) {
        ws.send(JSON.stringify(logEvent));
    }
    for (const logEvent of logHistory.mobula) {
        ws.send(JSON.stringify(logEvent));
    }

    ws.on('close', () => clients.delete(ws));
});


