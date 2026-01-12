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
const gkStats = new RollingStats(); // New Stats for Gecko

// Globa Interval Buckets for Raw Jitter (Reset every 5s)
let intervalLatencies = {
    goldrush: [],
    codex: [],
    gecko: []
};

// Carry-Forward Stats (Prevent 0-flicker)
let lastIntervalStats = {
    goldrush: { p50: 0, p95: 0, p99: 0, jitter: 0, stdDev: 0, eventCount: 0 },
    codex: { p50: 0, p95: 0, p99: 0, jitter: 0, stdDev: 0, eventCount: 0 },
    gecko: { p50: 0, p95: 0, p99: 0, jitter: 0, stdDev: 0, eventCount: 0 }
};

// Track last value of previous interval for Delta calculation
let lastIntervalEndVal = {
    goldrush: 0,
    codex: 0,
    gecko: 0
};

let codexLatestStats = { p50: 0, p95: 0, jitter: 0 };

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
let TOKEN_ADDRESS = PAIR_ADDRESS; // Codex events stream often uses Pair Address for swaps
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
        slowPrice: 0,
        geckoPrice: 0
    }
};

// Store OHLCV candle arrays for charts (independent)
let goldrushCandles = [];
let codexCandles = [];
let geckoCandles = [];

let clients = new Set();
let isRunning = true;
let streamsStartTime = 0; // Global start time for fair comparison

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

    // Only restart if chain changed OR token changed OR pair changed
    const needsFullRestart = newChain !== CURRENT_CHAIN || address !== TOKEN_ADDRESS || (pairAddress && pairAddress !== PAIR_ADDRESS);

    if (needsFullRestart) {
        console.log(`\n🔄 SWITCHING TO ${newChain} NETWORK...`);
        CURRENT_CHAIN = newChain;
        TOKEN_ADDRESS = address;
        if (pairAddress) PAIR_ADDRESS = pairAddress; // Update if provided
        SYMBOL = symbol || (isEVM ? 'TOKEN' : 'BONK');
        CODEX_NETWORK_ID = config.codexNetworkId;

        // Reset Global State
        pairs = { [SYMBOL]: { price: 0, fastPrice: 0, slowPrice: 0, geckoPrice: 0 } };
        goldrushCandles = [];
        codexCandles = [];
        geckoCandles = [];

        performanceHistory = []; // Reset history on token switch

        broadcast({ type: 'RESET', data: { symbol: SYMBOL, chain: newChain } });

        // Reset Metrics & Stats
        metricsHistory = [];
        throughputCounters = { goldrush: 0, codex: 0, gecko: 0 };
        currentThroughput = { goldrush: 0, codex: 0, gecko: 0 };
        throughputHistory = { goldrush: [], codex: [], gecko: [] };
        avgCandlesPerSecond = { goldrush: 0, codex: 0, gecko: 0 };

        latencyStats = {
            goldrush: { sum: 0, count: 0 },
            codex: { sum: 0, count: 0 },
            gecko: { sum: 0, count: 0 }
        };

        latency300 = {
            goldrush: { samples: [], sum: 0 },
            codex: { samples: [], sum: 0 },
            gecko: { samples: [], sum: 0 }
        };

        connectionMetrics = {
            goldrush: { loadStart: 0, loadTime: 0, connects: 0, errors: 0, lastError: null },
            codex: { loadStart: 0, loadTime: 0, connects: 0, errors: 0, lastError: null },
            gecko: { loadStart: 0, loadTime: 0, connects: 0, errors: 0, lastError: null }
        };

        latencyDelta = {
            goldrush: { prevLatency: null, deltas: [], sum: 0 },
            codex: { prevLatency: null, deltas: [], sum: 0 },
            gecko: { prevLatency: null, deltas: [], sum: 0 }
        };

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
        // 3. Gecko
        // Restart Gecko
        startGeckoStream();
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
let throughputCounters = { goldrush: 0, codex: 0, gecko: 0 };
let currentThroughput = { goldrush: 0, codex: 0, gecko: 0 };
let throughputHistory = { goldrush: [], codex: [], gecko: [] };
let avgCandlesPerSecond = { goldrush: 0, codex: 0, gecko: 0 };

let latencyStats = {
    goldrush: { sum: 0, count: 0 },
    codex: { sum: 0, count: 0 },
    gecko: { sum: 0, count: 0 }
};

// Rolling latency over last 300 candles per provider
let latency300 = {
    goldrush: { samples: [], sum: 0 },
    codex: { samples: [], sum: 0 },
    gecko: { samples: [], sum: 0 }
};

// --- METRICS HISTORY FOR COMPARISON CHARTS ---
// Track connection/load time for each provider
let connectionMetrics = {
    goldrush: { loadStart: 0, loadTime: 0, connects: 0, errors: 0, lastError: null },
    codex: { loadStart: 0, loadTime: 0, connects: 0, errors: 0, lastError: null },
    gecko: { loadStart: 0, loadTime: 0, connects: 0, errors: 0, lastError: null }
};

// --- LATENCY DELTA TRACKING (for stability score) ---
// Track previous latency and deltas for each provider
let latencyDelta = {
    goldrush: { prevLatency: null, deltas: [], sum: 0 },
    codex: { prevLatency: null, deltas: [], sum: 0 },
    gecko: { prevLatency: null, deltas: [], sum: 0 }
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
    ['goldrush', 'codex', 'gecko'].forEach(p => {
        throughputHistory[p].push(currentThroughput[p]);
        if (throughputHistory[p].length > 60) throughputHistory[p].shift();

        // Calculate average
        const sum = throughputHistory[p].reduce((a, b) => a + b, 0);
        avgCandlesPerSecond[p] = throughputHistory[p].length > 0
            ? parseFloat((sum / throughputHistory[p].length).toFixed(2))
            : 0;
    });

    throughputCounters = { goldrush: 0, codex: 0, gecko: 0 };

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
let latestLatency = { goldrush: 0, codex: 0, gecko: 0 };

// Snapshot History every 5 seconds (Fast for testing, normally 1m or 10m)
setInterval(() => {
    if (!isRunning) return;

    const getAvg = (provider) => {
        const s = latencyStats[provider];
        if (s.count === 0) return 0;
        const avg = Math.round(s.sum / s.count);
        // Reset
        s.sum = 0; s.count = 0;
        return avg;
    };

    // Calculate averages
    const grAvg = getAvg('goldrush');
    const cxAvg = getAvg('codex');
    const gkAvg = getAvg('gecko');

    // Update global state for /stats
    latestLatency = { goldrush: grAvg, codex: cxAvg, gecko: gkAvg };

    const snapshot = {
        time: Date.now(),
        goldrush: { avgLatency: grAvg },
        codex: { avgLatency: cxAvg },
        gecko: { avgLatency: gkAvg }
    };

    performanceHistory.push(snapshot);
    if (performanceHistory.length > 1000) performanceHistory.shift(); // Keep last 1000

    broadcast({ type: 'HISTORY_UPDATE', data: performanceHistory });

    // --- METRICS HISTORY SNAPSHOT (for comparison charts) ---
    const grCurrentStats = grStats.getStats();

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
    if (intervalLatencies.gecko.length > 0) {
        lastIntervalStats.gecko.stdDev = calculateMaxIntervalDelta(intervalLatencies.gecko, lastIntervalEndVal.gecko);
        lastIntervalEndVal.gecko = intervalLatencies.gecko[intervalLatencies.gecko.length - 1];
    }

    const metricsSnapshot = {
        time: Date.now(),
        goldrush: {
            loadTime: connectionMetrics.goldrush.loadTime,
            candlesPerSec: avgCandlesPerSecond.goldrush,
            jitter: grCurrentStats.jitter,              // Rolling Jitter (for Table)
            stdDev: lastIntervalStats.goldrush.stdDev,  // Max Delta (for Chart)
            p95: grCurrentStats.p95,
            p99: grCurrentStats.p99,
            eventCount: grStats.samples?.length || 0,
            avgLatency: grAvg
        },
        codex: {
            loadTime: connectionMetrics.codex.loadTime,
            candlesPerSec: avgCandlesPerSecond.codex,
            jitter: codexLatestStats.jitter,            // Rolling Jitter (for Table)
            stdDev: lastIntervalStats.codex.stdDev,     // Max Delta (for Chart)
            p95: codexLatestStats.p95,
            p99: codexLatestStats.p99,
            eventCount: cxStats.samples?.length || 0,
            avgLatency: cxAvg
        },
        gecko: {
            loadTime: connectionMetrics.gecko.loadTime,
            candlesPerSec: avgCandlesPerSecond.gecko,
            jitter: gkStats.getStats().jitter,          // Rolling Jitter (for Table)
            stdDev: lastIntervalStats.gecko.stdDev,     // Max Delta (for Chart)
            p95: gkStats.getStats().p95,
            p99: gkStats.getStats().p99,
            eventCount: gkStats.samples?.length || 0,
            avgLatency: gkAvg
        }
    };

    // Reset Interval Buckets for next snapshot
    intervalLatencies.goldrush = [];
    intervalLatencies.codex = [];
    intervalLatencies.gecko = [];

    metricsHistory.push(metricsSnapshot);
    if (metricsHistory.length > 60) metricsHistory.shift(); // Keep last 5 min
}, 5000);

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
            gecko: currentThroughput.gecko * 60
        },
        latencyRace: {
            goldrush: { avgLatency: latestLatency.goldrush },
            codex: { avgLatency: latestLatency.codex },
            gecko: { avgLatency: latestLatency.gecko }
        },
        avgLatency300: {
            goldrush: getAvgLatency300('goldrush'),
            codex: getAvgLatency300('codex'),
            gecko: getAvgLatency300('gecko')
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
            gecko: {
                loadTime: connectionMetrics.gecko.loadTime,
                candlesPerSec: avgCandlesPerSecond.gecko,
                latencyVariance: getAvgDelta('gecko'),
                latency300: getAvgLatency300('gecko')
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
                    slowPrice: pairs[oldSymbol]?.slowPrice || 0,
                    geckoPrice: pairs[oldSymbol]?.geckoPrice || 0
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
    countUpdate('goldrush'); // Track Hz


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
let geckoCleanup = null;
let geckoTradeCleanup = null;


async function initCodexProvider() {
    // Fetch History (Backfill) via HTTP - purely for chart data
    console.log("🐢 Fetching Codex History...");
    await fetchCodexPrice();

    // Start Live Subscription via SDK
    startCodexSubscription();
}

function startCodexSubscription() {
    if (codexCleanup) {
        try { codexCleanup(); } catch (e) { }
        codexCleanup = null;
    }

    console.log("🐢 Connecting to Codex GraphQL Stream (Events)...");
    connectionMetrics.codex.loadStart = Date.now(); // TTFD timer starts here
    connectionMetrics.codex.connects++;

    // Raw graphql-ws connection (NO SDK)
    const codexWsClient = createClient({
        url: 'wss://graph.codex.io/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            Authorization: process.env.CODEX_API_KEY
        },
        on: {
            connected: () => {
                console.log('✅ Connected to Codex GraphQL Stream!');
            },
            error: (err) => {
                console.error('❌ Codex WS Error:', err);
                connectionMetrics.codex.errors++;
                connectionMetrics.codex.lastError = Date.now();
            }
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

    codexWsClient.subscribe(
        {
            query,
            variables: { address, networkId }
        },
        {
            next: (result) => {
                const events = result?.data?.onEventsCreated?.events;
                if (events && events.length > 0) {
                    // Track first data load time (WS Connection -> First Packet)
                    if (connectionMetrics.codex.loadTime === 0) {
                        connectionMetrics.codex.loadTime = Date.now() - connectionMetrics.codex.loadStart;
                        console.log(`✅ Codex Time to First Data (WS): ${connectionMetrics.codex.loadTime}ms`);
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

    codexCleanup = () => codexWsClient.dispose();
    console.log("✅ Codex GraphQL Subscription Active (Events)!");

    // --- SECOND SUBSCRIPTION: onBarsUpdated for Bar Chart Throughput ---
    console.log("📊 Starting Codex onBarsUpdated Stream (Bar Chart)...");
    const codexBarsClient = createClient({
        url: 'wss://graph.codex.io/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            Authorization: process.env.CODEX_API_KEY
        },
        on: {
            connected: () => console.log('✅ Connected to Codex onBarsUpdated Stream!'),
            error: (err) => console.error('❌ Codex Bars WS Error:', err)
        }
    });

    const pairId = `${PAIR_ADDRESS}:${CODEX_NETWORK_ID}`;
    const barsQuery = `
        subscription($pairId: String!) {
            onBarsUpdated(pairId: $pairId) {
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
                        }
                    }
                }
            }
        }
    `;

    codexBarsClient.subscribe(
        { query: barsQuery, variables: { pairId } },
        {
            next: (result) => {
                const now = Date.now();
                const bar = result?.data?.onBarsUpdated;
                if (bar && bar.aggregates?.r1?.usd) {
                    // Track TTFD if not already rejected
                    if (connectionMetrics.codex.loadTime === 0) {
                        connectionMetrics.codex.loadTime = Date.now() - connectionMetrics.codex.loadStart;
                        console.log(`✅ Codex Time to First Data (WS-Bars): ${connectionMetrics.codex.loadTime}ms`);
                    }
                    countUpdate('codex');

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

                    // Interval Push (Raw Jitter)
                    if (latency >= 0 && latency < 60000) intervalLatencies.codex.push(latency);

                    const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
                    console.log(`[${timeStr}] [CODEX   ] STREAM     | Tick received | Price: $${parseFloat(price).toFixed(2)} | Latency: ${latency}ms`);

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
            complete: () => console.log('📊 Codex Bars Subscription Complete')
        }
    );

    // Update cleanup to dispose BOTH clients
    const originalCleanup = codexCleanup;
    codexCleanup = () => {
        try { originalCleanup(); } catch (e) { }
        try { codexBarsClient.dispose(); } catch (e) { }
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
                    symbol: "${TOKEN_ADDRESS}:${CODEX_NETWORK_ID}"
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

// --- COINGECKO INTEGRATION ---
async function fetchGeckoPool(tokenAddress) {
    // 1. Find the best pool for this token on the current chain
    try {
        const network = CURRENT_CHAIN === 'BASE_MAINNET' ? 'base' : 'solana';
        console.log(`🦎 Finding Pool for ${SYMBOL} (${tokenAddress}) on ${network}...`);
        const url = `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${tokenAddress}/pools?page=1`;
        const res = await axios.get(url, {
            headers: { 'Accept': 'application/json' }
        });

        const pools = res.data?.data;
        if (pools && pools.length > 0) {
            // Pick the first one (usually highest liquidity)
            const pool = pools[0];
            const poolAddress = pool.attributes.address;
            console.log(`🦎 Found Pool: ${poolAddress} (Liquidity: $${pool.attributes.reserve_in_usd})`);
            return poolAddress;
        } else {
            console.warn("⚠️ No pools found on GeckoTerminal for this token.");
            return null;
        }
    } catch (err) {
        console.error("❌ Gecko Pool Lookup Error:", err.message);
        return null;
    }
}

function startGeckoStream() {
    if (geckoCleanup) {
        // If it's a WS client, close it
        try { geckoCleanup.close(); } catch (e) { }
        geckoCleanup = null;
    }
    if (geckoTradeCleanup) {
        try { geckoTradeCleanup.close(); } catch (e) { }
        geckoTradeCleanup = null;
    }

    // 1. Resolve Pool Address First
    // Gecko needs a TOKEN address to find pools, but TOKEN_ADDRESS is currently our Pair Address
    const targetToken = CURRENT_CHAIN === 'BASE_MAINNET' ? VIRTUALS_ADDRESS : TOKEN_ADDRESS;

    fetchGeckoPool(targetToken).then(poolAddress => {
        if (!poolAddress) return;

        console.log(`🦎 Connecting to CoinGecko Stream...`);
        connectionMetrics.gecko.loadStart = Date.now();
        const ws = new WebSocket(`wss://stream.coingecko.com/v1?x_cg_pro_api_key=${process.env.COINGECKO_API_KEY}`);

        geckoCleanup = ws; // Save ref to close later

        ws.on('open', () => {
            console.log("✅ Connected to CoinGecko Stream!");
            connectionMetrics.gecko.connects++;
            // Subscribe to OnchainOHLCV
            const subMsg = {
                command: "subscribe",
                identifier: JSON.stringify({ channel: "OnchainOHLCV" })
            };
            ws.send(JSON.stringify(subMsg));
        });

        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());

            // Handle Subscription Confirmation
            if (msg.type === 'confirm_subscription') {
                console.log("🦎 Subscription Confirmed. Configuring Pool...");
                // Set the pool to stream: Solana network (solana), 1m interval, base token
                // DYNAMIC NETWORK:
                const geckoNetwork = CURRENT_CHAIN === 'BASE_MAINNET' ? 'base' : 'solana';

                const configMsg = {
                    command: "message",
                    identifier: JSON.stringify({ channel: "OnchainOHLCV" }),
                    data: JSON.stringify({
                        "network_id:pool_addresses": [`${geckoNetwork}:${poolAddress}`],
                        "interval": "1m",
                        "token": "base",
                        "action": "set_pools"
                    })
                };
                ws.send(JSON.stringify(configMsg));
            }

            // Handle Pool Configuration Success
            if (msg.message && typeof msg.message === 'string' && msg.message.includes("Subscription successful")) {
                console.log(`🦎 Streaming started for ${poolAddress}`);
            }

            // Handle OHLCV Data (for charts only, NOT latency)
            // CoinGecko may send data directly or wrapped in msg.message
            const ohlcvData = msg.message || msg;
            if (ohlcvData && ohlcvData.c && ohlcvData.t) {
                // TTFD now calculated in processGeckoTrade (OnchainTrade) for speed
                processGeckoOHLCV(ohlcvData);
            }
        });

        ws.on('error', (err) => {
            console.error("❌ Gecko Stream Error:", err.message);
            connectionMetrics.gecko.errors++;
            connectionMetrics.gecko.lastError = Date.now();
        });
        ws.on('close', () => console.log("📴 Gecko Stream Disconnected"));

        // --- SECOND CONNECTION: OnchainTrade for LATENCY METRICS ---
        console.log('📊 Starting CoinGecko OnchainTrade Stream...');
        const tradeWs = new WebSocket(`wss://stream.coingecko.com/v1?x_cg_pro_api_key=${process.env.COINGECKO_API_KEY}`);
        geckoTradeCleanup = tradeWs;

        tradeWs.on('open', () => {
            console.log("✅ Connected to CoinGecko OnchainTrade Stream!");
            // Subscribe to OnchainTrade channel
            const subMsg = {
                command: "subscribe",
                identifier: JSON.stringify({ channel: "OnchainTrade" })
            };
            tradeWs.send(JSON.stringify(subMsg));
        });

        tradeWs.on('message', (data) => {
            const msg = JSON.parse(data.toString());

            // Handle Subscription Confirmation
            if (msg.type === 'confirm_subscription') {
                console.log("🦎 OnchainTrade Subscription Confirmed. Configuring Pool...");
                const geckoNetwork = CURRENT_CHAIN === 'BASE_MAINNET' ? 'base' : 'solana';
                const configMsg = {
                    command: "message",
                    identifier: JSON.stringify({ channel: "OnchainTrade" }),
                    data: JSON.stringify({
                        "network_id:pool_addresses": [`${geckoNetwork}:${poolAddress}`],
                        "action": "set_pools"
                    })
                };
                tradeWs.send(JSON.stringify(configMsg));
            }

            // Handle Trade Data (for latency metrics)
            const tradeData = msg.message || msg;
            // OnchainTrade has: t (timestamp), ty (type), vo (volume), pu (price_usd), tx (tx_hash)
            if (tradeData && tradeData.t && tradeData.ty) {
                processGeckoTrade(tradeData);
            }
        });

        tradeWs.on('error', (err) => {
            console.error("❌ Gecko Trade Stream Error:", err.message);
        });
        tradeWs.on('close', () => console.log("📴 Gecko Trade Stream Disconnected"));
    });
}

// --- COINGECKO: Process OHLCV Data (charts only, latency comes from OnchainTrade) ---
function processGeckoOHLCV(ohlcv) {
    if (!ohlcv || !ohlcv.t || !ohlcv.c) return;

    const price = parseFloat(ohlcv.c);

    // Candle Logic
    const timeMs = ohlcv.t * 1000;
    const newCandle = {
        time: timeMs,
        open: parseFloat(ohlcv.o),
        high: parseFloat(ohlcv.h),
        low: parseFloat(ohlcv.l),
        close: parseFloat(ohlcv.c),
        volume: parseFloat(ohlcv.v)
    };

    // Update State
    pairs[SYMBOL].geckoPrice = price;

    const candleMap = new Map();
    geckoCandles.forEach(c => candleMap.set(c.time, c));
    candleMap.set(newCandle.time, newCandle);

    geckoCandles = Array.from(candleMap.values())
        .sort((a, b) => a.time - b.time)
        .slice(-15);

    // Broadcast candle update (latency stats come from OnchainTrade stream)
    // TTFD: First OHLCV candle = System Ready (per standardization)
    if (connectionMetrics.gecko.loadTime === 0) {
        connectionMetrics.gecko.loadTime = Date.now() - connectionMetrics.gecko.loadStart;
        console.log(`✅ Gecko Time to First Data (OnchainOHLCV): ${connectionMetrics.gecko.loadTime}ms`);
    }
    // Throughput counting for bar chart (per implementation plan)
    countUpdate('gecko');

    broadcast({
        type: 'CANDLE_UPDATE',
        provider: 'GECKO',
        data: {
            timestamp: Date.now(),
            price: price,
            candles: geckoCandles
        }
    });
}

// --- COINGECKO: Process OnchainTrade for LATENCY METRICS ---
function processGeckoTrade(trade) {
    if (!trade || !trade.t) return;

    // Track TTFD here (First Trade Event = System Alive)\n    // TTFD now calculated in processGeckoOHLCV (standardized to bar chart stream)

    const now = Date.now();
    // trade.t is Unix timestamp in ms (per CoinGecko docs: 1752072129000)
    const blockTime = trade.t;
    const latency = now - blockTime; // client_receive_time - block_time

    // Add to rolling stats for p50/p95/p99
    gkStats.add(latency);
    latestLatency.gecko = latency;
    addLatencySample('gecko', latency);
    latencyStats.gecko.sum += latency;
    latencyStats.gecko.count++;
    addLatencyDelta('gecko', latency);

    // Interval Push (Raw Jitter)
    if (intervalLatencies.gecko) intervalLatencies.gecko.push(latency);

    // Note: Throughput counting now done in processGeckoOHLCV (bar chart uses OHLCV)

    // Log Gecko latency
    const price = parseFloat(trade.pu || 0).toFixed(2);
    process.stdout.write(`[GECKO   ] STREAM     | Tick received | Price: $${price} | Latency: ${latency}ms\r`);
}

// --- GOLDRUSH STREAM (raw graphql-ws) ---
let goldrushCleanup = null;

function startStream() {
    console.log(`🚀 Starting GoldRush OHLCV Pairs Stream on: ${CURRENT_CHAIN}`);
    connectionMetrics.goldrush.loadStart = Date.now();

    // Use graphql-ws for raw GraphQL subscription (NO SDK)
    const grWsClient = createClient({
        url: 'wss://gr-staging-v2.streaming.covalenthq.com/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            GOLDRUSH_API_KEY: process.env.COVALENT_API_KEY
        },
        on: {
            connected: () => {
                console.log('✅ Connected to GoldRush OHLCV Stream!');
                connectionMetrics.goldrush.connects++;
            },
            error: (err) => {
                console.error('❌ GoldRush WS Error:', err);
                connectionMetrics.goldrush.errors++;
                connectionMetrics.goldrush.lastError = Date.now();
            },
            closed: () => console.log('📴 GoldRush OHLCV Stream Disconnected')
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
    grWsClient.subscribe({ query }, {
        next: (result) => {
            console.log('⚡ GoldRush OHLCV Received:', JSON.stringify(result).substring(0, 200));
            const candles = result?.data?.ohlcvCandlesForPair;
            if (candles && candles.length > 0) {
                // Track first data load time (time from connection start to first packet)
                if (connectionMetrics.goldrush.loadTime === 0) {
                    connectionMetrics.goldrush.loadTime = Date.now() - connectionMetrics.goldrush.loadStart;
                    console.log(`✅ GoldRush Time to First Data: ${connectionMetrics.goldrush.loadTime}ms`);
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

    // Cleanup logic for OHLCV client
    const disposeOHLCV = () => grWsClient.dispose();

    // --- SEPARATE CLIENT: updatePairs for LATENCY METRICS ---
    console.log('📊 Starting GoldRush updatePairs Stream...');
    const grUpdatePairsClient = createClient({
        url: 'wss://gr-staging-v2.streaming.covalenthq.com/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            GOLDRUSH_API_KEY: process.env.COVALENT_API_KEY
        },
        on: {
            connected: () => console.log('✅ Connected to GoldRush updatePairs Stream!'),
            error: (err) => console.error('❌ GoldRush updatePairs WS Error:', err)
        }
    });

    const updatePairsQuery = `subscription {
        updatePairs(
            chain_name: ${CURRENT_CHAIN}
            pair_addresses: ["${PAIR_ADDRESS.toLowerCase()}"]
        ) {
            chain_name
            pair_address
            timestamp
            quote_rate
            quote_rate_usd
            volume
            volume_usd
            market_cap
            liquidity
        }
    }`;

    grUpdatePairsClient.subscribe({ query: updatePairsQuery }, {
        next: (result) => {
            // Debug: log the full result structure
            console.log(`📊 GoldRush updatePairs raw:`, JSON.stringify(result).substring(0, 300));

            const update = result?.data?.updatePairs;
            if (update && update.timestamp) {
                processGoldrushUpdate(update);
            }
        },
        error: (err) => {
            console.error('❌ GoldRush updatePairs Error:', err);
        },
        complete: () => console.log('GoldRush updatePairs Stream Completed')
    });

    // Cleanup BOTH clients
    goldrushCleanup = () => {
        try { disposeOHLCV(); } catch (e) { }
        try { grUpdatePairsClient.dispose(); } catch (e) { }
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
    grStats.add(latency);
    latestLatency.goldrush = latency;

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

// --- INITIALIZATION ---
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
        await initCodexProvider(); // Codex
        startGeckoStream(); // Gecko
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


    if (geckoCandles.length > 0) {
        ws.send(JSON.stringify({
            type: 'GECKO_TICK',
            data: {
                pair: SYMBOL,
                price: pairs[SYMBOL].geckoPrice,
                timestamp: Date.now(),
                latency: 0,
                candles: geckoCandles
            }
        }));
    }



    ws.on('close', () => clients.delete(ws));
});


