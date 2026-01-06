/**
 * Codex Provider Module
 * Handles real-time price streaming from Codex API
 * Uses 1-minute OHLCV candles for cleaner trading signals
 */

const axios = require('axios');
const { Codex } = require('@codex-data/sdk');
const logger = require('../utils/logger');
const raceCoordinator = require('../utils/raceCoordinator');

// --- TRADING THRESHOLD ---
const CODEX_THRESHOLD = 0.000001;

// --- STATE ---
let candles = [];
let trading = {
    position: null,
    lastPrice: null,
    trades: [],
    totalPnL: 0
};

let cleanup = null;
let broadcast = null;
let getSymbol = null;
let updatePairs = null;
let networkId = '1399811149';
let currentTokenAddress = null;

// --- TIMEFRAME CONFIG ---
let currentResolution = '1'; // '1' = 1m, '5' = 5m, '15' = 15m
const RESOLUTION_MAP = {
    '1m': { resolution: '1', aggregate: 'r1' },
    '5m': { resolution: '5', aggregate: 'r5' },
    '15m': { resolution: '15', aggregate: 'r15' }
};

/**
 * Initialize the Codex provider
 */
function init(deps) {
    broadcast = deps.broadcast;
    getSymbol = deps.getSymbol;
    updatePairs = deps.updatePairs;
}

/**
 * Resolve Solana network ID from Codex API
 */
async function resolveNetworkId() {
    try {
        logger.codex.connect();
        const query = `query { getNetworks { id name } }`;
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

        const networks = res.data?.data?.getNetworks;
        const solanaNet = networks?.find(n => n.name.toLowerCase().includes('solana'));

        if (solanaNet) {
            networkId = solanaNet.id;
            logger.system.info(`Codex Network ID resolved: ${networkId}`);
        } else {
            logger.codex.warn(`Could not find Solana network. Using fallback: ${networkId}`);
        }

        return networkId;
    } catch (e) {
        logger.codex.error(`Network ID fetch failed: ${e.message}`);
        return networkId;
    }
}

/**
 * Fetch initial price and history
 */
async function fetchHistory(tokenAddress) {
    const startTime = Date.now();
    try {
        logger.codex.history();

        const now = Math.floor(Date.now() / 1000);
        const lookback = now - 900;

        const query = `
            query {
                getBars(
                    symbol: "${tokenAddress}:${networkId}"
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
            const price = data.c[data.c.length - 1];
            const SYMBOL = getSymbol();

            updatePairs(SYMBOL, { slowPrice: price });

            candles = data.t.map((timestamp, i) => ({
                time: timestamp,
                open: data.o[i],
                high: data.h[i],
                low: data.l[i],
                close: data.c[i]
            })).sort((a, b) => a.time - b.time)
                .slice(-15);

            broadcast({
                type: 'SLOW_TICK',
                data: {
                    pair: SYMBOL,
                    price: price,
                    timestamp: endTime,
                    latency: networkLatency,
                    candles: candles
                }
            });

            checkTrade(price);
            return price;
        }
    } catch (err) {
        logger.codex.error(`History fetch failed: ${err.message}`);
    }
    return null;
}

/**
 * Start the Codex WebSocket subscription
 */
function startSubscription(tokenAddress) {
    if (cleanup) cleanup();

    currentTokenAddress = tokenAddress;
    logger.codex.connect();
    const codex = new Codex(process.env.CODEX_API_KEY);

    const combinedTokenId = `${tokenAddress}:${networkId}`;
    const currentConfig = Object.values(RESOLUTION_MAP).find(r => r.resolution === currentResolution) || RESOLUTION_MAP['1m'];
    const aggregateKey = currentConfig.aggregate;

    const query = `
        subscription {
            onTokenBarsUpdated(
                tokenId: "${combinedTokenId}"
            ) {
                aggregates {
                    ${aggregateKey} {
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
        cleanup = codex.subscribe(
            query,
            {},
            {
                next: (data) => {
                    const aggregates = data?.data?.onTokenBarsUpdated?.aggregates;
                    const barData = aggregates?.[aggregateKey]?.usd;
                    if (barData) {
                        processUpdate(barData);
                    }
                },
                error: (err) => logger.codex.error(`Subscription error: ${err}`),
                complete: () => logger.codex.warn('Subscription completed'),
            }
        );
        logger.codex.connected();
    } catch (err) {
        logger.codex.error(`Failed to start subscription: ${err}`);
    }
}

/**
 * Process incoming bar data
 */
function processUpdate(barData) {
    const price = barData.c;
    const timestamp = barData.t;
    const timeMs = timestamp * 1000;
    const SYMBOL = getSymbol();

    if (!price || price <= 0) return;

    updatePairs(SYMBOL, { slowPrice: price });

    const newCandle = {
        time: timestamp,
        open: barData.o,
        high: barData.h,
        low: barData.l,
        close: barData.c
    };

    const candleMap = new Map();
    candles.forEach(c => candleMap.set(c.time, c));
    candleMap.set(newCandle.time, newCandle);

    candles = Array.from(candleMap.values())
        .sort((a, b) => a.time - b.time)
        .slice(-60);

    const latency = Date.now() - timeMs;

    logger.codex.stream(price, latency, candles.length);

    broadcast({
        type: 'SLOW_TICK',
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
function checkTrade(currentPrice) {
    if (!currentPrice || currentPrice <= 0) return;

    const prev = trading.lastPrice;
    trading.lastPrice = currentPrice;

    if (!prev) return;

    const priceChange = (currentPrice - prev) / prev;
    const SYMBOL = getSymbol();

    if (trading.position) {
        const pos = trading.position;
        const holdTime = Date.now() - pos.entryTime;

        const priceChangeFromEntry = (currentPrice - pos.entryPrice) / pos.entryPrice;
        const takeProfitTarget = CODEX_THRESHOLD * 3;
        const shouldExit = (pos.side === 'LONG' && priceChangeFromEntry > takeProfitTarget) ||
            (pos.side === 'SHORT' && priceChangeFromEntry < -takeProfitTarget) ||
            holdTime > 10000;

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

            trading.trades.unshift(trade);
            if (trading.trades.length > 50) trading.trades.pop();
            trading.totalPnL += trade.pnl;
            trading.position = null;

            broadcast({ type: 'SLOW_TRADE', data: trade });
            logger.codex.trade(pos.side, 'CLOSE', currentPrice, trade.pnl);
        }
    } else {
        if (priceChange > CODEX_THRESHOLD) {
            trading.position = { side: 'LONG', entryPrice: currentPrice, entryTime: Date.now(), latency: trading.lastLatency || 0 };
            logger.codex.trade('LONG', 'OPEN', currentPrice);
            raceCoordinator.reportSignal('codex', 'LONG', currentPrice, trading.lastLatency || 0);
        } else if (priceChange < -CODEX_THRESHOLD) {
            trading.position = { side: 'SHORT', entryPrice: currentPrice, entryTime: Date.now(), latency: trading.lastLatency || 0 };
            logger.codex.trade('SHORT', 'OPEN', currentPrice);
            raceCoordinator.reportSignal('codex', 'SHORT', currentPrice, trading.lastLatency || 0);
        }
    }
}

/**
 * Start the full Codex pipeline
 */
async function startStream(tokenAddress, networkIdOverride = null) {
    if (networkIdOverride) {
        networkId = networkIdOverride;
        logger.system.info(`Codex Network ID set to: ${networkId}`);
    } else {
        await resolveNetworkId();
    }
    await fetchHistory(tokenAddress);
    startSubscription(tokenAddress);
}

/**
 * Reset state
 */
function reset() {
    if (cleanup) {
        cleanup();
        cleanup = null;
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
        threshold: CODEX_THRESHOLD
    };
}

function getNetworkId() {
    return networkId;
}

/**
 * Set the timeframe (restarts stream with new resolution)
 * @param {string} tf - '1m', '5m', or '15m'
 */
function setTimeframe(tf) {
    if (!RESOLUTION_MAP[tf]) {
        logger.codex.error(`Invalid timeframe: ${tf}. Use 1m, 5m, or 15m.`);
        return false;
    }
    currentResolution = RESOLUTION_MAP[tf].resolution;
    logger.codex.info(`Timeframe changed to ${tf}`);

    // Reset state and restart stream with new resolution
    reset();
    if (currentTokenAddress) {
        startSubscription(currentTokenAddress);
    }
    return true;
}

/**
 * Get current timeframe
 */
function getCurrentTimeframe() {
    for (const [key, val] of Object.entries(RESOLUTION_MAP)) {
        if (val.resolution === currentResolution) return key;
    }
    return '1m';
}

module.exports = {
    init,
    resolveNetworkId,
    startStream,
    reset,
    getState,
    getNetworkId,
    setTimeframe,
    getCurrentTimeframe,
    THRESHOLD: CODEX_THRESHOLD
};
