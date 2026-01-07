const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
const { GoldRushClient, StreamingChain, StreamingInterval, StreamingTimeframe } = require('@covalenthq/client-sdk');
const { Codex } = require('@codex-data/sdk');
require('dotenv').config();
const logger = require('./utils/logger');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3002;
// Default to BONK (Solana), but allow dynamic updates
let SYMBOL = 'BONK';
let TOKEN_ADDRESS = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
let CURRENT_CHAIN = 'SOLANA'; // 'SOLANA' or 'BASE'

const CHAIN_CONFIG = {
    SOLANA: {
        name: 'SOLANA',
        codexNetworkId: '1399811149',
        goldrushChain: StreamingChain.SOLANA_MAINNET
    },
    BASE: {
        name: 'BASE',
        codexNetworkId: '8453',
        goldrushChain: StreamingChain.BASE_MAINNET
    }
};

let CODEX_NETWORK_ID = CHAIN_CONFIG.SOLANA.codexNetworkId;

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

// INDEPENDENT Paper Trading States - NO CONNECTION between them
let goldrushTrading = {
    position: null,       // { side: 'LONG'/'SHORT', entryPrice, entryTime }
    lastPrice: null,
    trades: [],
    stats: { wins: 0, losses: 0, total: 0 },
    totalPnL: 0
};

let codexTrading = {
    position: null,
    lastPrice: null,
    trades: [],
    stats: { wins: 0, losses: 0, total: 0 },
    totalPnL: 0
};

let geckoTrading = {
    position: null,
    lastPrice: null,
    trades: [],
    stats: { wins: 0, losses: 0, total: 0 },
    totalPnL: 0
};

let clients = new Set();
let isRunning = true;

// --- TRADING CONFIGURATION ---
const CONFIG = {
    // Trade simulation value in USD
    TRADE_VALUE: 1000,
    // Maximum position hold time in ms
    MAX_HOLD_TIME: 10000,
    // Maximum trades to keep in history
    MAX_TRADE_HISTORY: 50,
    // Maximum candles to keep for charts
    MAX_CANDLES: 15,
    // Maximum price deviation for outlier rejection (50%)
    MAX_PRICE_DEVIATION: 0.5,
    // Trading thresholds for each provider
    THRESHOLDS: {
        GOLDRUSH: 0.000001,
        CODEX: 0.000001,
        GECKO: 0.000001
    }
};

// Legacy constants for backward compatibility
const GOLDRUSH_THRESHOLD = CONFIG.THRESHOLDS.GOLDRUSH;
const CODEX_THRESHOLD = CONFIG.THRESHOLDS.CODEX;
const GECKO_THRESHOLD = CONFIG.THRESHOLDS.GECKO;

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
    const { address, symbol } = req.body;
    if (!address) return res.status(400).json({ error: 'Address is required' });

    // CHAIN DETECTION
    // Solana addresses are Base58 (no '0x'), Base (EVM) addresses start with '0x'
    const isEVM = address.startsWith('0x');
    const newChain = isEVM ? 'BASE' : 'SOLANA';
    const config = CHAIN_CONFIG[newChain];

    // Only restart if chain changed OR token changed
    const needsFullRestart = newChain !== CURRENT_CHAIN || address !== TOKEN_ADDRESS;

    if (needsFullRestart) {
        console.log(`\n🔄 SWITCHING TO ${newChain} NETWORK...`);
        CURRENT_CHAIN = newChain;
        TOKEN_ADDRESS = address;
        SYMBOL = symbol || (isEVM ? 'TOKEN' : 'BONK');
        CODEX_NETWORK_ID = config.codexNetworkId;

        // Reset Global State
        pairs = { [SYMBOL]: { price: 0, fastPrice: 0, slowPrice: 0, geckoPrice: 0 } };
        goldrushCandles = [];
        codexCandles = [];
        geckoCandles = [];

        goldrushTrading = { position: null, lastPrice: null, trades: [], stats: { wins: 0, losses: 0, total: 0 }, totalPnL: 0 };
        codexTrading = { position: null, lastPrice: null, trades: [], stats: { wins: 0, losses: 0, total: 0 }, totalPnL: 0 };
        geckoTrading = { position: null, lastPrice: null, trades: [], stats: { wins: 0, losses: 0, total: 0 }, totalPnL: 0 };

        performanceHistory = []; // Reset history on token switch

        broadcast({ type: 'RESET', data: { symbol: SYMBOL, chain: newChain } });

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
    goldrushTrading = { position: null, lastPrice: null, trades: [], stats: { wins: 0, losses: 0, total: 0 }, totalPnL: 0 };
    codexTrading = { position: null, lastPrice: null, trades: [], stats: { wins: 0, losses: 0, total: 0 }, totalPnL: 0 };
    geckoTrading = { position: null, lastPrice: null, trades: [], stats: { wins: 0, losses: 0, total: 0 }, totalPnL: 0 };

    // Broadcast reset
    broadcast({ type: 'TIMEFRAME_CHANGE', data: { timeframe } });

    res.json({ success: true, timeframe });
});

// --- THROUGHPUT TRACKING (Hz) ---
// Count updates per second
let throughputCounters = { goldrush: 0, codex: 0, gecko: 0 };
let currentThroughput = { goldrush: 0, codex: 0, gecko: 0 };
let latencyStats = {
    goldrush: { sum: 0, count: 0 },
    codex: { sum: 0, count: 0 },
    gecko: { sum: 0, count: 0 }
};

// Reset counters every second
setInterval(() => {
    currentThroughput = { ...throughputCounters };
    throughputCounters = { goldrush: 0, codex: 0, gecko: 0 };

    if (isRunning) {
        broadcast({ type: 'METRICS_UPDATE', data: currentThroughput });
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
        goldrush: { pnl: goldrushTrading.totalPnL, avgLatency: grAvg },
        codex: { pnl: codexTrading.totalPnL, avgLatency: cxAvg },
        gecko: { pnl: geckoTrading.totalPnL, avgLatency: gkAvg }
    };

    performanceHistory.push(snapshot);
    if (performanceHistory.length > 1000) performanceHistory.shift(); // Keep last 1000

    broadcast({ type: 'HISTORY_UPDATE', data: performanceHistory });
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

    const calcStats = (trading) => {
        // Use persistent stats if available, fallback to array calculation (legacy safety)
        const total = trading.stats ? trading.stats.total : trading.trades.length;
        const wins = trading.stats ? trading.stats.wins : trading.trades.filter(t => t.pnl > 0).length;
        const losses = trading.stats ? trading.stats.losses : trading.trades.filter(t => t.pnl < 0).length;

        return {
            totalPnL: Number(trading.totalPnL.toFixed(2)),
            totalTrades: total,
            wins,
            losses,
            winRate: total > 0 ? Number(((wins / total) * 100).toFixed(1)) : 0,
            avgPnLPerTrade: total > 0
                ? Number((trading.totalPnL / total).toFixed(4))
                : 0,
            pnlPerMinute: uptime > 0
                ? Number((trading.totalPnL / (uptime / 60000)).toFixed(4))
                : 0
        };
    };

    res.json({
        uptime,
        goldrush: calcStats(goldrushTrading),
        codex: calcStats(codexTrading),
        gecko: calcStats(geckoTrading),
        history: performanceHistory,
        throughput: currentThroughput, // Add live throughput data
        latencyRace: {
            goldrush: { avgLatency: latestLatency.goldrush },
            codex: { avgLatency: latestLatency.codex },
            gecko: { avgLatency: latestLatency.gecko }
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

// --- GOLDRUSH PAPER TRADING (Independent - uses ONLY GoldRush data) ---
function checkGoldrushTrade(currentPrice) {
    if (!currentPrice || currentPrice <= 0) return;

    // SANITY CHECK: Reject prices that are more than 50% different from last known price
    // This catches garbage data like 6.97e-9 when price should be ~0.0000116
    const prev = goldrushTrading.lastPrice;
    if (prev && prev > 0) {
        const priceChangePercent = Math.abs((currentPrice - prev) / prev);
        if (priceChangePercent > CONFIG.MAX_PRICE_DEVIATION) {
            console.log(`⚠️ GoldRush REJECTED outlier price: $${currentPrice.toFixed(12)} (${(priceChangePercent * 100).toFixed(1)}% change)`);
            return; // Skip this garbage data
        }
    }

    goldrushTrading.lastPrice = currentPrice;

    if (!prev) return;

    const priceChange = (currentPrice - prev) / prev;

    if (goldrushTrading.position) {
        const pos = goldrushTrading.position;
        const holdTime = Date.now() - pos.entryTime;

        // Calculate profit/loss from ENTRY price (not previous tick)
        const priceChangeFromEntry = (currentPrice - pos.entryPrice) / pos.entryPrice;

        // TAKE PROFIT: Exit when position is profitable by 3x threshold
        const takeProfitTarget = GOLDRUSH_THRESHOLD * 3;
        const shouldExit = (pos.side === 'LONG' && priceChangeFromEntry > takeProfitTarget) ||
            (pos.side === 'SHORT' && priceChangeFromEntry < -takeProfitTarget) ||
            holdTime > CONFIG.MAX_HOLD_TIME;  // Close after max hold time

        if (shouldExit) {
            // PnL Calculation: Simulating a $1,000 trade size
            const tradeValue = CONFIG.TRADE_VALUE;
            const pnl = pos.side === 'LONG'
                ? (tradeValue * (currentPrice - pos.entryPrice) / pos.entryPrice)
                : (tradeValue * (pos.entryPrice - currentPrice) / pos.entryPrice);

            const trade = {
                id: `gr-${Date.now()}`,
                timestamp: Date.now(),
                pair: SYMBOL,
                side: pos.side,
                entryPrice: pos.entryPrice,
                exitPrice: currentPrice,
                pnl: Number(pnl.toFixed(2)),
                latency: 0  // GoldRush latency tracked separately
            };

            goldrushTrading.trades.unshift(trade);
            if (goldrushTrading.trades.length > CONFIG.MAX_TRADE_HISTORY) goldrushTrading.trades.pop();
            goldrushTrading.totalPnL += trade.pnl;

            // Update Persistent Stats
            if (goldrushTrading.stats) {
                goldrushTrading.stats.total++;
                if (trade.pnl > 0) goldrushTrading.stats.wins++;
                else if (trade.pnl < 0) goldrushTrading.stats.losses++;
            }

            goldrushTrading.position = null;

            broadcast({ type: 'FAST_TRADE', data: trade });
            logger.goldrush.trade(pos.side, 'CLOSE', currentPrice, trade.pnl);
        }
    } else {
        if (priceChange > GOLDRUSH_THRESHOLD) {
            goldrushTrading.position = { side: 'LONG', entryPrice: currentPrice, entryTime: Date.now() };
            logger.goldrush.trade('LONG', 'OPEN', currentPrice);
        } else if (priceChange < -GOLDRUSH_THRESHOLD) {
            goldrushTrading.position = { side: 'SHORT', entryPrice: currentPrice, entryTime: Date.now() };
            logger.goldrush.trade('SHORT', 'OPEN', currentPrice);
        }
    }
}

// --- CODEX PAPER TRADING (Independent - uses ONLY Codex data) ---
function checkCodexTrade(currentPrice) {
    if (!currentPrice || currentPrice <= 0) return;

    // SANITY CHECK: Reject prices that are more than 50% different from last known price
    const prev = codexTrading.lastPrice;
    if (prev && prev > 0) {
        const priceChangePercent = Math.abs((currentPrice - prev) / prev);
        if (priceChangePercent > CONFIG.MAX_PRICE_DEVIATION) {
            console.log(`⚠️ Codex REJECTED outlier price: $${currentPrice.toFixed(12)} (${(priceChangePercent * 100).toFixed(1)}% change)`);
            return;
        }
    }

    codexTrading.lastPrice = currentPrice;

    if (!prev) return;

    const priceChange = (currentPrice - prev) / prev;

    if (codexTrading.position) {
        const pos = codexTrading.position;
        const holdTime = Date.now() - pos.entryTime;

        // Calculate profit/loss from ENTRY price (not previous tick)
        const priceChangeFromEntry = (currentPrice - pos.entryPrice) / pos.entryPrice;

        // TAKE PROFIT: Exit when position is profitable by 3x threshold
        const takeProfitTarget = CODEX_THRESHOLD * 3;
        const shouldExit = (pos.side === 'LONG' && priceChangeFromEntry > takeProfitTarget) ||
            (pos.side === 'SHORT' && priceChangeFromEntry < -takeProfitTarget) ||
            holdTime > CONFIG.MAX_HOLD_TIME;  // Close after max hold time

        if (shouldExit) {
            // PnL Calculation: Simulating trade
            const tradeValue = CONFIG.TRADE_VALUE;
            const pnl = pos.side === 'LONG'
                ? (tradeValue * (currentPrice - pos.entryPrice) / pos.entryPrice)
                : (tradeValue * (pos.entryPrice - currentPrice) / pos.entryPrice);

            const trade = {
                id: `cx-${Date.now()}`,
                timestamp: Date.now(),
                pair: SYMBOL,
                side: pos.side,
                entryPrice: pos.entryPrice,
                exitPrice: currentPrice,
                pnl: Number(pnl.toFixed(2)),
                latency: holdTime  // Time position was held (ms)
            };

            codexTrading.trades.unshift(trade);
            if (codexTrading.trades.length > CONFIG.MAX_TRADE_HISTORY) codexTrading.trades.pop();
            codexTrading.totalPnL += trade.pnl;

            // Update Persistent Stats
            if (codexTrading.stats) {
                codexTrading.stats.total++;
                if (trade.pnl > 0) codexTrading.stats.wins++;
                else if (trade.pnl < 0) codexTrading.stats.losses++;
            }

            codexTrading.position = null;

            broadcast({ type: 'SLOW_TRADE', data: trade });
            logger.codex.trade(pos.side, 'CLOSE', currentPrice, trade.pnl);
        }
    } else {
        // --- INSTANT EXECUTION (Raw Speed) ---
        if (priceChange > CODEX_THRESHOLD) {
            codexTrading.position = { side: 'LONG', entryPrice: currentPrice, entryTime: Date.now() };
            logger.codex.trade('LONG', 'OPEN', currentPrice);
        } else if (priceChange < -CODEX_THRESHOLD) {
            codexTrading.position = { side: 'SHORT', entryPrice: currentPrice, entryTime: Date.now() };
            logger.codex.trade('SHORT', 'OPEN', currentPrice);
        }
    }
}

// --- COINGECKO PAPER TRADING ---
function checkGeckoTrade(currentPrice) {
    if (!currentPrice || currentPrice <= 0) return;

    const prev = geckoTrading.lastPrice;
    geckoTrading.lastPrice = currentPrice;

    if (!prev) return;

    const priceChange = (currentPrice - prev) / prev;

    if (geckoTrading.position) {
        const pos = geckoTrading.position;
        const holdTime = Date.now() - pos.entryTime;

        // Calculate profit/loss from ENTRY price
        const priceChangeFromEntry = (currentPrice - pos.entryPrice) / pos.entryPrice;

        // TAKE PROFIT: Exit when position is profitable by 3x threshold
        const takeProfitTarget = GECKO_THRESHOLD * 3;
        const shouldExit = (pos.side === 'LONG' && priceChangeFromEntry > takeProfitTarget) ||
            (pos.side === 'SHORT' && priceChangeFromEntry < -takeProfitTarget) ||
            holdTime > CONFIG.MAX_HOLD_TIME;  // Close after max hold time

        if (shouldExit) {
            // PnL Calculation: Simulating trade
            const tradeValue = CONFIG.TRADE_VALUE;
            const pnl = pos.side === 'LONG'
                ? (tradeValue * (currentPrice - pos.entryPrice) / pos.entryPrice)
                : (tradeValue * (pos.entryPrice - currentPrice) / pos.entryPrice);

            const trade = {
                id: `gk-${Date.now()}`,
                timestamp: Date.now(),
                pair: SYMBOL,
                side: pos.side,
                entryPrice: pos.entryPrice,
                exitPrice: currentPrice,
                pnl: Number(pnl.toFixed(2)),
                latency: holdTime  // Time position was held (ms)
            };

            geckoTrading.trades.unshift(trade);
            if (geckoTrading.trades.length > CONFIG.MAX_TRADE_HISTORY) geckoTrading.trades.pop();
            geckoTrading.totalPnL += trade.pnl;

            // Update Persistent Stats
            if (geckoTrading.stats) {
                geckoTrading.stats.total++;
                if (trade.pnl > 0) geckoTrading.stats.wins++;
                else if (trade.pnl < 0) geckoTrading.stats.losses++;
            }

            geckoTrading.position = null;

            broadcast({ type: 'GECKO_TRADE', data: trade });
            logger.gecko.trade(pos.side, 'CLOSE', currentPrice, trade.pnl);
        }
    } else {
        if (priceChange > GECKO_THRESHOLD) {
            geckoTrading.position = { side: 'LONG', entryPrice: currentPrice, entryTime: Date.now() };
            logger.gecko.trade('LONG', 'OPEN', currentPrice);
        } else if (priceChange < -GECKO_THRESHOLD) {
            geckoTrading.position = { side: 'SHORT', entryPrice: currentPrice, entryTime: Date.now() };
            logger.gecko.trade('SHORT', 'OPEN', currentPrice);
        }
    }
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
            if (CURRENT_CHAIN === 'BASE' && detectedSymbol === 'Bonk') {
                // console.log("Ignored zombie Bonk packet on Base");
                return;
            }

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
    const candleCloseTime = candleTimeMs + 60000;
    let goldRushLatency = fastArrival - candleCloseTime;
    if (goldRushLatency < 0) goldRushLatency = 0;

    // Track Latency
    latencyStats.goldrush.sum += goldRushLatency;
    latencyStats.goldrush.count++;

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
            candles: goldrushCandles
        }
    });

    // Run INDEPENDENT GoldRush paper trading
    checkGoldrushTrade(price);
}


// --- CODEX WEBSOCKET SUBSCRIPTION ---
let codexCleanup = null;
let geckoCleanup = null;


async function initCodexProvider() {
    // 1. Fetch History (Backfill) via HTTP
    console.log("🐢 Fetching Codex History...");
    await fetchCodexPrice();

    // 2. Start Live Subscription via SDK (Low-Level)
    startCodexSubscription();
}

function startCodexSubscription() {
    if (codexCleanup) codexCleanup();

    console.log("🐢 Connecting to Codex SDK Stream...");
    const codex = new Codex(process.env.CODEX_API_KEY);

    const combinedTokenId = `${TOKEN_ADDRESS}:${CODEX_NETWORK_ID}`;
    console.log(`🐢 Subscribing to Codex (SDK/Raw) with: ${combinedTokenId}`);

    // Raw Query that we KNOW works
    const query = `
        subscription {
            onTokenBarsUpdated(
                tokenId: "${combinedTokenId}"
            ) {
                aggregates {
                    r1 {
                        usd {
                            c
                            o
                            h
                            l
                            t
                        }
                    }
                }
            }
        }
    `;

    try {
        codexCleanup = codex.subscribe(
            query,
            {},
            {
                next: (data) => {
                    const r1 = data?.data?.onTokenBarsUpdated?.aggregates?.r1?.usd;
                    if (r1) {
                        processCodexUpdate(r1);
                    }
                },
                error: (err) => console.error('❌ Codex SDK Subscription Error:', err),
                complete: () => console.log('🐢 Codex SDK Subscription Complete'),
            }
        );
        console.log("✅ Codex SDK Subscription Active!");

    } catch (err) {
        console.error("❌ Failed to start Codex SDK Subscription:", err);
    }
}


function processCodexUpdate(barData) {
    const codexPrice = barData.c;
    const timestamp = barData.t; // Unix timestamp in seconds
    const timeMs = timestamp * 1000;

    // Null check for pairs[SYMBOL]
    if (!pairs[SYMBOL]) {
        pairs[SYMBOL] = { price: 0, fastPrice: 0, slowPrice: 0, geckoPrice: 0 };
    }

    // Update State
    pairs[SYMBOL].slowPrice = codexPrice;

    // Update Candles (Append new data)
    const newCandle = {
        time: timestamp,
        open: barData.o,
        high: barData.h,
        low: barData.l,
        close: barData.c
    };

    // Merge logic
    const candleMap = new Map();
    codexCandles.forEach(c => candleMap.set(c.time, c));
    candleMap.set(newCandle.time, newCandle); // Overwrite/Add

    codexCandles = Array.from(candleMap.values())
        .sort((a, b) => a.time - b.time)
        .slice(-15); // Keep last 15 candles

    // Calculate Latency (Time since candle start vs arrival)
    // Note: Codex timestamp is candle START time. So real latency = (Now - CandleStart)
    const latency = Date.now() - timeMs;

    // Track Latency
    latencyStats.codex.sum += latency;
    latencyStats.codex.count++;

    logger.codex.stream(codexPrice, latency, codexCandles.length);
    countUpdate('codex'); // Track Hz

    broadcast({
        type: 'SLOW_TICK',
        data: {
            pair: SYMBOL,
            price: codexPrice,
            timestamp: Date.now(),
            latency: latency, // Numeric Latency (calculated above)
            candles: codexCandles
        }
    });

    // Run INDEPENDENT Codex paper trading
    checkCodexTrade(codexPrice);
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
                timeout: 5000
            }
        );

        const endTime = Date.now();
        const networkLatency = endTime - startTime;
        const data = response.data?.data?.getBars;

        if (data && data.c && data.c.length > 0) {
            const codexPrice = data.c[data.c.length - 1];

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
                    candles: codexCandles
                }
            });

            // Run INDEPENDENT Codex paper trading
            checkCodexTrade(codexPrice);
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
        const network = CURRENT_CHAIN === 'BASE' ? 'base' : 'solana';
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

    // 1. Resolve Pool Address First
    fetchGeckoPool(TOKEN_ADDRESS).then(poolAddress => {
        if (!poolAddress) return;

        console.log(`🦎 Connecting to CoinGecko Stream...`);
        const ws = new WebSocket(`wss://stream.coingecko.com/v1?x_cg_pro_api_key=${process.env.COINGECKO_API_KEY}`);

        geckoCleanup = ws; // Save ref to close later

        ws.on('open', () => {
            console.log("✅ Connected to CoinGecko Stream!");
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
                const configMsg = {
                    command: "message",
                    identifier: JSON.stringify({ channel: "OnchainOHLCV" }),
                    data: JSON.stringify({
                        "network_id:pool_addresses": [`solana:${poolAddress}`],
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

            // Handle OHLCV Data
            // CoinGecko may send data directly or wrapped in msg.message
            const ohlcvData = msg.message || msg;
            if (ohlcvData && ohlcvData.c && ohlcvData.t) {
                processGeckoUpdate(ohlcvData);
            }
        });

        ws.on('error', (err) => console.error("❌ Gecko Stream Error:", err.message));
        ws.on('close', () => console.log("📴 Gecko Stream Disconnected"));
    });
}

function processGeckoUpdate(data) {
    const price = data.c;
    const timestamp = data.t; // Unix timestamp (seconds)
    const timeMs = timestamp * 1000;

    if (!price) return;

    // Update State
    pairs[SYMBOL].geckoPrice = price;

    // Update Candles
    const newCandle = {
        time: timestamp,
        open: data.o,
        high: data.h,
        low: data.l,
        close: data.c
    };

    const candleMap = new Map();
    geckoCandles.forEach(c => candleMap.set(c.time, c));
    candleMap.set(newCandle.time, newCandle);

    geckoCandles = Array.from(candleMap.values())
        .sort((a, b) => a.time - b.time)
        .slice(-15);

    // Calculate Latency (Time since candle start)
    const latency = Date.now() - timeMs;

    // Track Latency
    latencyStats.gecko.sum += latency;
    latencyStats.gecko.count++;

    logger.gecko.stream(price, latency, geckoCandles.length);
    countUpdate('gecko'); // Track Hz

    broadcast({
        type: 'GECKO_TICK',
        data: {
            pair: SYMBOL,
            price: price,
            timestamp: Date.now(),
            latency: latency,
            candles: geckoCandles
        }
    });

    checkGeckoTrade(price);
}

// --- GOLDRUSH SDK CLIENT ---
let goldrushClient = null;
let goldrushCleanup = null;

function createGoldrushClient() {
    // Cleanup previous instance if exists
    if (goldrushCleanup) {
        try {
            goldrushCleanup();
        } catch (e) {
            console.log("Note: GoldRush cleanup had no effect (SDK may not support unsubscribe)");
        }
        goldrushCleanup = null;
    }

    // Create fresh client instance
    goldrushClient = new GoldRushClient(
        process.env.COVALENT_API_KEY,
        {},
        {
            onConnecting: () => console.log("🔗 Connecting to GoldRush Stream..."),
            onOpened: () => console.log("✅ Connected to GoldRush Stream!"),
            onClosed: () => console.log("📴 GoldRush Stream disconnected"),
            onError: (error) => console.error("❌ GoldRush Stream error:", error),
        }
    );

    return goldrushClient;
}

function startStream() {
    // Create fresh client to avoid zombie streams
    const client = createGoldrushClient();

    const chain = CHAIN_CONFIG[CURRENT_CHAIN].goldrushChain;
    console.log(`Starting GoldRush Stream on: ${chain}`);

    // Store cleanup reference
    goldrushCleanup = client.StreamingService.subscribeToOHLCVTokens(
        {
            chain_name: chain,
            token_addresses: [TOKEN_ADDRESS],
            interval: StreamingInterval.ONE_MINUTE,
            timeframe: StreamingTimeframe.FIFTEEN_MINUTES,
        },
        {
            next: (data) => {
                const candles = Array.isArray(data) ? data : [data];
                if (candles && candles.length > 0) {
                    // Validate this data is for current token/chain
                    const latestCandle = candles[candles.length - 1];
                    if (latestCandle.base_token?.contract_ticker_symbol) {
                        const sym = latestCandle.base_token.contract_ticker_symbol;
                        // Skip if chain doesn't match (zombie prevention)
                        if (CURRENT_CHAIN === 'BASE' && sym === 'Bonk') return;
                        if (CURRENT_CHAIN === 'SOLANA' && sym === 'VIRTUAL') return;
                    }
                    processGoldrushCandles(candles);
                }
            },
            error: (err) => console.error('❌ GoldRush SDK Error:', err),
            complete: () => console.log('GoldRush Stream Completed'),
        }
    );
}

// --- INITIALIZATION ---
async function init() {
    console.log("🚀 Server Starting (SOLANA MODE - BONK)...");

    // 1. Fetch Solana Network ID from Codex
    try {
        console.log("🔍 Resolving Codex Network ID for Solana...");
        const netQuery = `query { getNetworks { id name } }`;
        const netRes = await axios.post(
            'https://graph.codex.io/graphql',
            { query: netQuery },
            { headers: { 'Content-Type': 'application/json', 'Authorization': process.env.CODEX_API_KEY }, timeout: 5000 }
        );
        const networks = netRes.data?.data?.getNetworks;
        const solanaNet = networks?.find(n => n.name.toLowerCase().includes('solana'));
        if (solanaNet) {
            CODEX_NETWORK_ID = solanaNet.id;
            console.log(`✅ Using Codex Network ID: ${CODEX_NETWORK_ID}`);
        } else {
            console.warn(`⚠️ Could not find Solana in Codex networks. Using fallback: ${CODEX_NETWORK_ID}`);
        }
    } catch (e) {
        console.warn(`⚠️ Network ID fetch failed: ${e.message}. Using fallback: ${CODEX_NETWORK_ID}`);
    }


    // 2. Get Initial Price using Codex
    try {
        const now = Math.floor(Date.now() / 1000);
        const lookback = now - 900; // Get last 15 minutes
        const query = `
            query {
                getBars(
                    symbol: "${TOKEN_ADDRESS}:${CODEX_NETWORK_ID}"
                    from: ${lookback}
                    to: ${now}
                    resolution: "1"
                ) {
                    c
                }
            }
        `;

        const res = await axios.post(
            'https://graph.codex.io/graphql',
            { query },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': process.env.CODEX_API_KEY
                },
                timeout: 5000
            }
        );

        const data = res.data?.data?.getBars;
        const initialPrice = (data && data.c && data.c.length > 0) ? data.c[data.c.length - 1] : 0;

        pairs[SYMBOL].price = initialPrice;
        pairs[SYMBOL].fastPrice = initialPrice;
        pairs[SYMBOL].slowPrice = initialPrice;
        console.log(`✅ Initial Price Snapshot: $${initialPrice}`);
    } catch (err) {
        console.log("⚠️ Could not fetch initial price:", err.message);
    }

    startStream();
    initCodexProvider();
    startGeckoStream();

    server.listen(PORT, () => {
        console.log(`✅ Backend listening on http://localhost:${PORT}`);
    });
}

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

    // Send existing trades
    goldrushTrading.trades.forEach(trade => {
        ws.send(JSON.stringify({ type: 'FAST_TRADE', data: trade }));
    });
    codexTrading.trades.forEach(trade => {
        ws.send(JSON.stringify({ type: 'SLOW_TRADE', data: trade }));
    });
    geckoTrading.trades.forEach(trade => {
        ws.send(JSON.stringify({ type: 'GECKO_TRADE', data: trade }));
    });

    ws.on('close', () => clients.delete(ws));
});

init();
