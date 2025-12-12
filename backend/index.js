const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
const { GoldRushClient, StreamingChain, StreamingInterval, StreamingTimeframe } = require('@covalenthq/client-sdk');
require('dotenv').config();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3002;
const SYMBOL = 'VIRTUAL-USD';
const TOKEN_ADDRESS = '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b';

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

// Trading threshold: 0.01% price change to trigger (lowered for demo)
const THRESHOLD = 0.0001;

// --- SERVER SETUP ---
const app = express();
app.use(cors());

// Health check endpoint for Railway
app.get('/', (req, res) => {
    console.log('✅ Health check hit');
    res.status(200).json({ status: 'ok', service: 'GoldRush vs Codex Trading Bot', timestamp: new Date().toISOString() });
});
app.use(express.json());
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

        const shouldExit = (pos.side === 'LONG' && priceChange < -THRESHOLD) ||
            (pos.side === 'SHORT' && priceChange > THRESHOLD) ||
            holdTime > 10000;  // Close after 10 seconds max

        if (shouldExit) {
            const pnl = pos.side === 'LONG'
                ? (currentPrice - pos.entryPrice) * 10000
                : (pos.entryPrice - currentPrice) * 10000;

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
        if (priceChange > THRESHOLD) {
            goldrushTrading.position = { side: 'LONG', entryPrice: currentPrice, entryTime: Date.now() };
            console.log(`📈 GoldRush OPENED LONG @ $${currentPrice.toFixed(4)}`);
        } else if (priceChange < -THRESHOLD) {
            goldrushTrading.position = { side: 'SHORT', entryPrice: currentPrice, entryTime: Date.now() };
            console.log(`📉 GoldRush OPENED SHORT @ $${currentPrice.toFixed(4)}`);
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

        const shouldExit = (pos.side === 'LONG' && priceChange < -THRESHOLD) ||
            (pos.side === 'SHORT' && priceChange > THRESHOLD) ||
            holdTime > 10000;  // Close after 10 seconds max

        if (shouldExit) {
            const pnl = pos.side === 'LONG'
                ? (currentPrice - pos.entryPrice) * 10000
                : (pos.entryPrice - currentPrice) * 10000;

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
        if (priceChange > THRESHOLD) {
            codexTrading.position = { side: 'LONG', entryPrice: currentPrice, entryTime: Date.now() };
            console.log(`🐢 Codex OPENED LONG @ $${currentPrice.toFixed(4)}`);
        } else if (priceChange < -THRESHOLD) {
            codexTrading.position = { side: 'SHORT', entryPrice: currentPrice, entryTime: Date.now() };
            console.log(`🐢 Codex OPENED SHORT @ $${currentPrice.toFixed(4)}`);
        }
    }
}

// --- GOLDRUSH: Process OHLCV Candles ---
async function processGoldrushCandles(candles) {
    const fastArrival = Date.now();

    if (!candles || candles.length === 0) return;

    const latestCandle = candles[candles.length - 1];
    const price = latestCandle.close || latestCandle.quote_rate_usd;

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

    console.log(`📊 GoldRush accumulated candles: ${goldrushCandles.length}`);

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
                    symbol: "${TOKEN_ADDRESS}:8453"
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
    }
}

// --- GOLDRUSH SDK CLIENT ---
const goldrushClient = new GoldRushClient(
    process.env.COVALENT_API_KEY,
    {
        webSocketImpl: WebSocket  // Pass ws module for Node.js environment
    },
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
            chain_name: StreamingChain.BASE_MAINNET,
            token_addresses: [TOKEN_ADDRESS],
            interval: StreamingInterval.ONE_MINUTE,
            timeframe: StreamingTimeframe.ONE_HOUR,
        },
        {
            next: (data) => {
                const candles = Array.isArray(data) ? data : [data];
                if (candles && candles.length > 0) {
                    console.log(`📊 GoldRush SDK Candles Received: ${candles.length}`);
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
    console.log("🚀 Server Starting (REAL MODE)...");

    // Get Initial Price using Codex
    try {
        const now = Math.floor(Date.now() / 1000);
        const lookback = now - 900;
        const query = `
            query {
                getBars(
                    symbol: "${TOKEN_ADDRESS}:8453"
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

    // Start HTTP server FIRST (so healthcheck passes immediately)
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Backend listening on http://0.0.0.0:${PORT}`);

        // Then connect to streams after server is ready
        startStream();
        startCodexPolling();
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
