/**
 * CoinGecko Provider Module
 * Handles real-time price streaming from CoinGecko/GeckoTerminal API
 * Uses 1-minute OHLCV candles
 */

const axios = require('axios');
const WebSocket = require('ws');
const logger = require('../utils/logger');
const raceCoordinator = require('../utils/raceCoordinator');

// --- TRADING THRESHOLD ---
const GECKO_THRESHOLD = 0.000001;

// --- STATE ---
let candles = [];
let trading = {
    position: null,
    lastPrice: null,
    trades: [],
    totalPnL: 0
};

let wsClient = null;
let broadcast = null;
let getSymbol = null;
let updatePairs = null;

/**
 * Initialize the CoinGecko provider
 */
function init(deps) {
    broadcast = deps.broadcast;
    getSymbol = deps.getSymbol;
    updatePairs = deps.updatePairs;
}

/**
 * Fetch the best pool address for a token on Solana
 */
async function fetchPoolAddress(tokenAddress) {
    try {
        const SYMBOL = getSymbol();

        const url = `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${tokenAddress}/pools?page=1`;
        const res = await axios.get(url, {
            headers: { 'Accept': 'application/json' }
        });

        const pools = res.data?.data;
        if (pools && pools.length > 0) {
            const pool = pools[0];
            const poolAddress = pool.attributes.address;
            const liquidity = pool.attributes.reserve_in_usd;
            logger.gecko.pool(poolAddress, `$${Number(liquidity).toLocaleString()}`);
            return poolAddress;
        } else {
            logger.gecko.warn('No pools found for this token');
            return null;
        }
    } catch (err) {
        logger.gecko.error(`Pool lookup failed: ${err.message}`);
        return null;
    }
}

/**
 * Start the CoinGecko WebSocket stream
 */
async function startStream(tokenAddress) {
    if (wsClient) {
        try { wsClient.close(); } catch (e) { }
        wsClient = null;
    }

    const poolAddress = await fetchPoolAddress(tokenAddress);
    if (!poolAddress) return;

    logger.gecko.connect();
    const ws = new WebSocket(`wss://stream.coingecko.com/v1?x_cg_pro_api_key=${process.env.COINGECKO_API_KEY}`);

    wsClient = ws;

    ws.on('open', () => {
        logger.gecko.connected();
        const subMsg = {
            command: "subscribe",
            identifier: JSON.stringify({ channel: "OnchainOHLCV" })
        };
        ws.send(JSON.stringify(subMsg));
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'confirm_subscription') {
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

        const ohlcvData = msg.message || msg;
        if (ohlcvData && ohlcvData.c && ohlcvData.t) {
            processUpdate(ohlcvData);
        }
    });

    ws.on('error', (err) => logger.gecko.error(`Stream error: ${err.message}`));
    ws.on('close', () => logger.gecko.warn('Stream disconnected'));
}

/**
 * Process incoming OHLCV data
 */
function processUpdate(data) {
    const price = data.c;
    const timestamp = data.t;
    const timeMs = timestamp * 1000;
    const SYMBOL = getSymbol();

    if (!price) return;

    updatePairs(SYMBOL, { geckoPrice: price });

    const newCandle = {
        time: timestamp,
        open: data.o,
        high: data.h,
        low: data.l,
        close: data.c
    };

    const candleMap = new Map();
    candles.forEach(c => candleMap.set(c.time, c));
    candleMap.set(newCandle.time, newCandle);

    candles = Array.from(candleMap.values())
        .sort((a, b) => a.time - b.time)
        .slice(-15);

    const latency = Date.now() - timeMs;

    logger.gecko.stream(price, latency, candles.length);

    broadcast({
        type: 'GECKO_TICK',
        data: {
            pair: SYMBOL,
            price: price,
            timestamp: Date.now(),
            latency: latency,
            candles: candles
        }
    });

    // Store latency for race reporting
    trading.lastLatency = latency;
    checkTrade(price);
}

/**
 * Paper trading logic
 */
// Removed Paper Trading Logic
function checkTrade(currentPrice) {
    // No-op
}

/**
 * Reset state
 */
function reset() {
    if (wsClient) {
        try { wsClient.close(); } catch (e) { }
        wsClient = null;
    }
    candles = [];
    trading = {
        position: null,
        lastPrice: null,
        trades: [],
        totalPnL: 0
    };
}

/**
 * Get current state
 */
function getState() {
    return {
        candles,
        trading,
        threshold: GECKO_THRESHOLD
    };
}

module.exports = {
    init,
    startStream,
    reset,
    getState,
    THRESHOLD: GECKO_THRESHOLD
};
