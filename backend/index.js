const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
const { GoldRushClient, StreamingChain, StreamingInterval, StreamingTimeframe } = require('@covalenthq/client-sdk');
require('dotenv').config();

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 3002;
const SYMBOL = 'VIRTUAL-USD';
const TOKEN_ADDRESS = '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b';
const CHAIN_ID = '8453'; // Base Mainnet
const TRADING_THRESHOLD = 0.0001; // 0.01% price change
const HOLD_TIME_MS = 10000; // 10 seconds max hold
const MAX_CANDLES = 60;
const MAX_TRADES = 50;

// ============================================================================
// STATE
// ============================================================================

const state = {
    pairs: {
        [SYMBOL]: { price: 0, fastPrice: 0, slowPrice: 0 }
    },
    goldrush: {
        candles: [],
        position: null,
        lastPrice: null,
        trades: [],
        totalPnL: 0
    },
    codex: {
        candles: [],
        position: null,
        lastPrice: null,
        trades: [],
        totalPnL: 0
    },
    clients: new Set()
};

// ============================================================================
// SERVER SETUP
// ============================================================================

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'GoldRush vs Codex Trading Bot',
        timestamp: new Date().toISOString()
    });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ============================================================================
// WEBSOCKET BROADCAST
// ============================================================================

function broadcast(message) {
    const data = JSON.stringify(message);
    state.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// ============================================================================
// TRADING ENGINE
// ============================================================================

function executeTrade(source, currentPrice) {
    const trading = state[source];
    if (!currentPrice || currentPrice <= 0) return;

    const prev = trading.lastPrice;
    trading.lastPrice = currentPrice;
    if (!prev) return;

    const priceChange = (currentPrice - prev) / prev;

    if (trading.position) {
        handleExitConditions(source, trading, currentPrice, priceChange);
    } else {
        handleEntrySignals(source, trading, currentPrice, priceChange);
    }
}

function handleExitConditions(source, trading, currentPrice, priceChange) {
    const pos = trading.position;
    const holdTime = Date.now() - pos.entryTime;

    const shouldExit =
        (pos.side === 'LONG' && priceChange < -TRADING_THRESHOLD) ||
        (pos.side === 'SHORT' && priceChange > TRADING_THRESHOLD) ||
        holdTime > HOLD_TIME_MS;

    if (shouldExit) {
        const pnl = pos.side === 'LONG'
            ? (currentPrice - pos.entryPrice) * 10000
            : (pos.entryPrice - currentPrice) * 10000;

        const trade = {
            id: `${source === 'goldrush' ? 'gr' : 'cx'}-${Date.now()}`,
            timestamp: Date.now(),
            pair: SYMBOL,
            side: pos.side,
            entryPrice: pos.entryPrice,
            exitPrice: currentPrice,
            pnl: Number(pnl.toFixed(2)),
            latency: source === 'goldrush' ? 'Live' : `${Date.now() - pos.entryTime}ms`
        };

        trading.trades.unshift(trade);
        if (trading.trades.length > MAX_TRADES) trading.trades.pop();
        trading.totalPnL += trade.pnl;
        trading.position = null;

        const eventType = source === 'goldrush' ? 'FAST_TRADE' : 'SLOW_TRADE';
        broadcast({ type: eventType, data: trade });
    }
}

function handleEntrySignals(source, trading, currentPrice, priceChange) {
    if (priceChange > TRADING_THRESHOLD) {
        trading.position = { side: 'LONG', entryPrice: currentPrice, entryTime: Date.now() };
    } else if (priceChange < -TRADING_THRESHOLD) {
        trading.position = { side: 'SHORT', entryPrice: currentPrice, entryTime: Date.now() };
    }
}

// ============================================================================
// GOLDRUSH STREAM
// ============================================================================

const goldrushClient = new GoldRushClient(
    process.env.COVALENT_API_KEY,
    { webSocketImpl: WebSocket },
    {
        onOpened: () => console.log('✅ GoldRush Stream Connected'),
        onClosed: () => console.log('📴 GoldRush Stream Disconnected'),
        onError: (error) => console.error('❌ GoldRush Error:', error)
    }
);

function startGoldrushStream() {
    goldrushClient.StreamingService.subscribeToOHLCVTokens(
        {
            chain_name: StreamingChain.BASE_MAINNET,
            token_addresses: [TOKEN_ADDRESS],
            interval: StreamingInterval.ONE_MINUTE,
            timeframe: StreamingTimeframe.ONE_HOUR
        },
        {
            next: (data) => processGoldrushCandles(Array.isArray(data) ? data : [data]),
            error: (err) => console.error('❌ GoldRush SDK Error:', err),
            complete: () => console.log('GoldRush Stream Completed')
        }
    );
}

function processGoldrushCandles(candles) {
    if (!candles || candles.length === 0) return;

    const latestCandle = candles[candles.length - 1];
    const price = latestCandle.close || latestCandle.quote_rate_usd;

    state.pairs[SYMBOL].price = price;
    state.pairs[SYMBOL].fastPrice = price;

    // Update candle data
    const newCandles = candles.map(c => ({
        time: Math.floor(new Date(c.timestamp).getTime() / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
    }));

    const candleMap = new Map();
    state.goldrush.candles.forEach(c => candleMap.set(c.time, c));
    newCandles.forEach(c => candleMap.set(c.time, c));

    state.goldrush.candles = Array.from(candleMap.values())
        .sort((a, b) => a.time - b.time)
        .slice(-MAX_CANDLES);

    // Calculate latency
    const candleTimeMs = new Date(latestCandle.timestamp).getTime();
    const latency = Math.max(0, Date.now() - (candleTimeMs + 60000));

    broadcast({
        type: 'FAST_TICK',
        data: {
            pair: SYMBOL,
            price,
            timestamp: Date.now(),
            latency,
            candles: state.goldrush.candles
        }
    });

    executeTrade('goldrush', price);
}

// ============================================================================
// CODEX POLLING
// ============================================================================

async function startCodexPolling() {
    await fetchCodexData();
    setInterval(fetchCodexData, 60000);
}

async function fetchCodexData() {
    try {
        const now = Math.floor(Date.now() / 1000);
        const lookback = now - 900;

        const query = `
            query {
                getBars(
                    symbol: "${TOKEN_ADDRESS}:${CHAIN_ID}"
                    from: ${lookback}
                    to: ${now}
                    resolution: "1"
                ) {
                    t o h l c
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

        const startTime = Date.now();
        const data = response.data?.data?.getBars;

        if (data && data.c && data.c.length > 0) {
            const price = data.c[data.c.length - 1];
            state.pairs[SYMBOL].slowPrice = price;

            // Format candles
            state.codex.candles = data.t.map((timestamp, i) => ({
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
                    price,
                    timestamp: Date.now(),
                    latency: Date.now() - startTime,
                    candles: state.codex.candles
                }
            });

            executeTrade('codex', price);
        }
    } catch (err) {
        // Handle errors silently
    }
}

// ============================================================================
// WEBSOCKET CONNECTION HANDLER
// ============================================================================

wss.on('connection', (ws) => {
    state.clients.add(ws);

    // Send initial state
    ws.send(JSON.stringify({
        type: 'INIT',
        data: { pairs: state.pairs, trades: [], ideas: [] }
    }));

    // Send existing candle data
    if (state.goldrush.candles.length > 0) {
        ws.send(JSON.stringify({
            type: 'FAST_TICK',
            data: {
                pair: SYMBOL,
                price: state.pairs[SYMBOL].fastPrice,
                timestamp: Date.now(),
                latency: 0,
                candles: state.goldrush.candles
            }
        }));
    }

    if (state.codex.candles.length > 0) {
        ws.send(JSON.stringify({
            type: 'SLOW_TICK',
            data: {
                pair: SYMBOL,
                price: state.pairs[SYMBOL].slowPrice,
                timestamp: Date.now(),
                latency: 0,
                candles: state.codex.candles
            }
        }));
    }

    // Send existing trades
    state.goldrush.trades.forEach(trade => {
        ws.send(JSON.stringify({ type: 'FAST_TRADE', data: trade }));
    });
    state.codex.trades.forEach(trade => {
        ws.send(JSON.stringify({ type: 'SLOW_TRADE', data: trade }));
    });

    ws.on('close', () => state.clients.delete(ws));
});

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initialize() {
    console.log('🚀 Starting Trading Bot...');

    // Fetch initial price from Codex
    try {
        const now = Math.floor(Date.now() / 1000);
        const query = `
            query {
                getBars(
                    symbol: "${TOKEN_ADDRESS}:${CHAIN_ID}"
                    from: ${now - 900}
                    to: ${now}
                    resolution: "1"
                ) { c }
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

        state.pairs[SYMBOL].price = initialPrice;
        state.pairs[SYMBOL].fastPrice = initialPrice;
        state.pairs[SYMBOL].slowPrice = initialPrice;

        console.log(`✅ Initial Price: $${initialPrice}`);
    } catch (err) {
        console.log('⚠️ Could not fetch initial price');
    }

    // Start server first, then connect streams
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Server listening on http://0.0.0.0:${PORT}`);
        startGoldrushStream();
        startCodexPolling();
    });
}

initialize();
