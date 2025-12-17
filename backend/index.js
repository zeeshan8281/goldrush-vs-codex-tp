const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
const { GoldRushClient, StreamingChain, StreamingInterval, StreamingTimeframe } = require('@covalenthq/client-sdk');
require('dotenv').config();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3002;
const SYMBOL = 'BONK';
const TOKEN_ADDRESS = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
let CODEX_NETWORK_ID = '1399811149'; // Default Fallback (will try to fetch dynamic)

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

// INDEPENDENT Paper Trading States - NO CONNECTION between them
let goldrushTrading = {
    position: null,       // { side: 'LONG'/'SHORT', entryPrice, entryTime }
    lastPrice: null,
    trades: [],
    totalPnL: 0
};

let codexTrading = {
    position: null,
    lastPrice: null,
    trades: [],
    totalPnL: 0
};

let clients = new Set();
let isRunning = true;

// Trading thresholds
// GoldRush: Higher threshold to filter out high-frequency noise (0.0005%)
const GOLDRUSH_THRESHOLD = 0.000005;
// Codex: Lower threshold as it has implicit time-filtering (0.0001%)
const CODEX_THRESHOLD = 0.000001;

// --- SERVER SETUP ---
const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint for Railway
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'GoldRush vs Codex Trading Bot (SOLANA)' });
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

    const prev = goldrushTrading.lastPrice;
    goldrushTrading.lastPrice = currentPrice;

    if (!prev) return;

    const priceChange = (currentPrice - prev) / prev;

    if (goldrushTrading.position) {
        const pos = goldrushTrading.position;
        const holdTime = Date.now() - pos.entryTime;

        const shouldExit = (pos.side === 'LONG' && priceChange < -GOLDRUSH_THRESHOLD) ||
            (pos.side === 'SHORT' && priceChange > GOLDRUSH_THRESHOLD) ||
            holdTime > 10000;  // Close after 10 seconds max

        if (shouldExit) {
            const pnl = pos.side === 'LONG'
                ? (currentPrice - pos.entryPrice) * 100000000
                : (pos.entryPrice - currentPrice) * 100000000;

            const trade = {
                id: `gr-${Date.now()}`,
                timestamp: Date.now(),
                pair: SYMBOL,
                side: pos.side,
                entryPrice: pos.entryPrice,
                exitPrice: currentPrice,
                pnl: Number(pnl.toFixed(2)),
                latency: 'Live'
            };

            goldrushTrading.trades.unshift(trade);
            if (goldrushTrading.trades.length > 50) goldrushTrading.trades.pop();
            goldrushTrading.totalPnL += trade.pnl;
            goldrushTrading.position = null;

            broadcast({ type: 'FAST_TRADE', data: trade });
            console.log(`📈 GoldRush CLOSED ${pos.side}: PnL $${trade.pnl.toFixed(2)}`);
        }
    } else {
        if (priceChange > GOLDRUSH_THRESHOLD) {
            goldrushTrading.position = { side: 'LONG', entryPrice: currentPrice, entryTime: Date.now() };
            console.log(`📈 GoldRush OPENED LONG @ $${currentPrice.toFixed(6)}`);
        } else if (priceChange < -GOLDRUSH_THRESHOLD) {
            goldrushTrading.position = { side: 'SHORT', entryPrice: currentPrice, entryTime: Date.now() };
            console.log(`📉 GoldRush OPENED SHORT @ $${currentPrice.toFixed(6)}`);
        }
    }
}

// --- CODEX PAPER TRADING (Independent - uses ONLY Codex data) ---
function checkCodexTrade(currentPrice) {
    if (!currentPrice || currentPrice <= 0) return;

    const prev = codexTrading.lastPrice;
    codexTrading.lastPrice = currentPrice;

    if (!prev) return;

    const priceChange = (currentPrice - prev) / prev;

    if (codexTrading.position) {
        const pos = codexTrading.position;
        const holdTime = Date.now() - pos.entryTime;

        const shouldExit = (pos.side === 'LONG' && priceChange < -CODEX_THRESHOLD) ||
            (pos.side === 'SHORT' && priceChange > CODEX_THRESHOLD) ||
            holdTime > 10000;  // Close after 10 seconds max

        if (shouldExit) {
            const pnl = pos.side === 'LONG'
                ? (currentPrice - pos.entryPrice) * 100000000
                : (pos.entryPrice - currentPrice) * 100000000;

            const trade = {
                id: `cx-${Date.now()}`,
                timestamp: Date.now(),
                pair: SYMBOL,
                side: pos.side,
                entryPrice: pos.entryPrice,
                exitPrice: currentPrice,
                pnl: Number(pnl.toFixed(2)),
                latency: `${Date.now() - pos.entryTime}ms`
            };

            codexTrading.trades.unshift(trade);
            if (codexTrading.trades.length > 50) codexTrading.trades.pop();
            codexTrading.totalPnL += trade.pnl;
            codexTrading.position = null;

            broadcast({ type: 'SLOW_TRADE', data: trade });
            console.log(`🐢 Codex CLOSED ${pos.side}: PnL $${trade.pnl.toFixed(2)}`);
        }
    } else {
        if (priceChange > CODEX_THRESHOLD) {
            codexTrading.position = { side: 'LONG', entryPrice: currentPrice, entryTime: Date.now() };
            console.log(`🐢 Codex OPENED LONG @ $${currentPrice.toFixed(6)}`);
        } else if (priceChange < -CODEX_THRESHOLD) {
            codexTrading.position = { side: 'SHORT', entryPrice: currentPrice, entryTime: Date.now() };
            console.log(`🐢 Codex OPENED SHORT @ $${currentPrice.toFixed(6)}`);
        }
    }
}

// --- GOLDRUSH: Process OHLCV Candles ---
async function processGoldrushCandles(candles) {
    const fastArrival = Date.now();

    if (!candles || candles.length === 0) return;

    const latestCandle = candles[candles.length - 1];
    const price = latestCandle.close || latestCandle.quote_rate_usd;

    // --- FLASH CRASH PROTECTION ---
    // 1. Sanity Check: Price must be positive
    if (!price || price <= 0) {
        console.warn(`⚠️ PROTECTED: Ignored invalid price ($${price})`);
        return;
    }

    // 2. Volatility Circuit Breaker: Ignore >20% instant moves (bad ticks)
    const currentPrice = pairs[SYMBOL].price;
    if (currentPrice > 0) {
        const pctChange = Math.abs((price - currentPrice) / currentPrice);
        if (pctChange > 0.20) { // 20% limit
            console.warn(`⚠️ PROTECTED: Flash Crash detected! Ignored ${(pctChange * 100).toFixed(2)}% deviation. Price: ${price}, Prev: ${currentPrice}`);
            return;
        }
    }
    // -----------------------------

    const candleTimeMs = new Date(latestCandle.timestamp).getTime();
    const candleCloseTime = candleTimeMs + 60000;
    let goldRushLatency = fastArrival - candleCloseTime;
    if (goldRushLatency < 0) goldRushLatency = 0;

    console.log(`\n⚡ GOLDRUSH [STREAM]: $${price} | Candles: ${candles.length} | Latency: ${goldRushLatency}ms`);

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
        .slice(-60);

    // console.log(`📊 GoldRush accumulated candles: ${goldrushCandles.length}`);

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

// --- CODEX POLLING LOOP ---
async function startCodexPolling() {
    console.log("🐢 Starting Codex Polling Loop (1 minute)...");

    // Fetch immediately on startup
    await fetchCodexPrice();

    // Then poll every minute
    setInterval(async () => {
        await fetchCodexPrice();
    }, 60000);
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
        // Silently handle errors
        // console.error("Codex Error:", err.message);
    }
}

// --- GOLDRUSH SDK CLIENT ---
const goldrushClient = new GoldRushClient(
    process.env.COVALENT_API_KEY,
    {},
    {
        onConnecting: () => console.log("🔗 Connecting to GoldRush Stream..."),
        onOpened: () => console.log("✅ Connected to GoldRush Stream!"),
        onClosed: () => console.log("📴 GoldRush Stream disconnected"),
        onError: (error) => console.error("❌ GoldRush Stream error:", error),
    }
);

function startStream() {
    goldrushClient.StreamingService.subscribeToOHLCVTokens(
        {
            chain_name: StreamingChain.SOLANA_MAINNET,
            token_addresses: [TOKEN_ADDRESS],
            interval: StreamingInterval.ONE_MINUTE,
            timeframe: StreamingTimeframe.ONE_HOUR,
        },
        {
            next: (data) => {
                const candles = Array.isArray(data) ? data : [data];
                if (candles && candles.length > 0) {
                    // console.log(`📊 GoldRush SDK Candles Received: ${candles.length}`);
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
        const lookback = now - 3600; // Get last hour
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
    startCodexPolling();

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

    // Send existing trades
    goldrushTrading.trades.forEach(trade => {
        ws.send(JSON.stringify({ type: 'FAST_TRADE', data: trade }));
    });
    codexTrading.trades.forEach(trade => {
        ws.send(JSON.stringify({ type: 'SLOW_TRADE', data: trade }));
    });

    ws.on('close', () => clients.delete(ws));
});

init();
