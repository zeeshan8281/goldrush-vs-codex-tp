/**
 * Codex Provider Module
 * Handles real-time price streaming from Codex API
 * Uses 1-minute OHLCV candles for cleaner trading signals
 */

const axios = require('axios');
const { Codex } = require('@codex-data/sdk');
const logger = require('../utils/logger');
const RollingStats = require('../utils/stats');

const statsCalculator = new RollingStats();

// Removed Paper Trading Logic

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
/**
 * Start the Codex WebSocket subscription for Events
 */
function startSubscription(tokenAddress) {
    if (cleanup) cleanup();

    currentTokenAddress = tokenAddress;
    logger.codex.connect();
    const codex = new Codex(process.env.CODEX_API_KEY);

    // Filter for Swaps on the Token
    // We listen to events where the token is involved
    // Note: Ideally we listen to the Pool Address for specific swaps, 
    // but onEventsCreated can filter by contract address. 
    // Be careful: tokenAddress is the Token, not the Pool. 
    // For now, let's assume we are tracking the POOL address if possible, 
    // or we listen to Transfer events on the Token.
    // User Instructions: "for each swap event we store... corresponding block height and block time"
    // "onEventsCreated" is the right subscription.

    // We need the pair address for Swaps. 
    // Since we only have tokenAddress passed here, we might need to resolve the top pair first.
    // However, let's stick to the current flow. If tokenAddress is a Token, we get Transfers.
    // If it's a Pool, we get Swaps.
    // Let's assume the user wants us to track the Pool for Swaps.
    // But `backend/index.js` passes `TOKEN_ADDRESS`.

    const query = `
        subscription {
            onEventsCreated(
                networkId: ${networkId}
                candidate: {
                    address: "${tokenAddress}" 
                }
            ) {
                blockTimestamp
                transactionHash
                eventType
            }
        }
    `;

    try {
        cleanup = codex.subscribe(
            query,
            {},
            {
                next: (data) => {
                    const event = data?.data?.onEventsCreated;
                    if (event) {
                        processEvent(event);
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
 * Process incoming Event
 */
function processEvent(event) {
    // Latency = Client Receive Time - Block Time
    // event.blockTimestamp is usually in seconds (Unix)
    const blockTimeMs = new Date(event.blockTimestamp).getTime();
    // If blockTimestamp is a string ISO, standard Date parse works.
    // If it is unix seconds number, mul by 1000. 
    // Codex typically returns ISO string "2024-..." or unix timestamp? 
    // Let's assume ISO string based on standard GQL, but if number check type.

    let eventTime = blockTimeMs;
    if (!isNaN(event.blockTimestamp)) {
        // likely seconds
        eventTime = Number(event.blockTimestamp) * 1000;
        eventTimeMs = Number(event.blockTimestamp) * 1000;
    } else {
        eventTimeMs = new Date(event.blockTimestamp).getTime();
    }

    const now = Date.now();
    const latency = now - eventTimeMs;

    // Stats
    statsCalculator.add(latency);
    const stats = statsCalculator.getStats();

    broadcast({
        type: 'LATENCY_UPDATE',
        provider: 'CODEX',
        data: {
            timestamp: now,
            latency: latency,
            blockTime: eventTimeMs,
            stats: stats
        }
    });

    updatePairs(getSymbol(), { lastLatency: latency, stats: stats });
}

/**
 * Paper trading logic
 */


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
    candles = [];
}

/**
 * Get current state
 */
function getState() {
    return {
        candles,
        candles,
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
