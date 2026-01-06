/**
 * GoldRush Provider Module
 * Handles real-time price streaming from GoldRush/Covalent SDK
 * Uses 1-second OHLCV candles for high-frequency data
 */

const { GoldRushClient, StreamingChain, StreamingInterval, StreamingTimeframe } = require('@covalenthq/client-sdk');
const logger = require('../utils/logger');
const raceCoordinator = require('../utils/raceCoordinator');

// --- TRADING THRESHOLD ---
const GOLDRUSH_THRESHOLD = 0;

// --- PRICE VALIDATION ---
// Track reference price to filter garbage data
let referencePrice = null;
const MAX_PRICE_DEVIATION = 0.5; // Max 50% deviation from reference

// --- STATE ---
let candles = [];
let trading = {
    position: null,
    lastPrice: null,
    trades: [],
    totalPnL: 0
};

let client = null;
let broadcast = null;
let getSymbol = null;
let updatePairs = null;
let currentTokenAddress = null;

// --- TIMEFRAME CONFIG ---
let currentInterval = StreamingInterval.ONE_MINUTE; // Default: 1m
const INTERVAL_MAP = {
    '1m': StreamingInterval.ONE_MINUTE,
    '5m': StreamingInterval.FIVE_MINUTES,
    '15m': StreamingInterval.FIFTEEN_MINUTES
};

/**
 * Initialize the GoldRush provider
 */
function init(deps) {
    broadcast = deps.broadcast;
    getSymbol = deps.getSymbol;
    updatePairs = deps.updatePairs;

    client = new GoldRushClient(
        process.env.COVALENT_API_KEY,
        {},
        {
            onConnecting: () => logger.goldrush.connect(),
            onOpened: () => logger.goldrush.connected(),
            onClosed: () => logger.goldrush.warn('Stream disconnected'),
            onError: (error) => logger.goldrush.error(`Stream error: ${error}`),
        }
    );
}

/**
 * Set reference price (called from main with initial price)
 */
function setReferencePrice(price) {
    if (price && price > 0) {
        referencePrice = price;
    }
}

/**
 * Validate price against reference to filter garbage data
 */
function isValidPrice(price) {
    if (!price || price <= 0) return false;

    // If no reference, accept any positive price
    if (!referencePrice) {
        referencePrice = price;
        return true;
    }

    // Check deviation from reference
    const deviation = Math.abs(price - referencePrice) / referencePrice;
    if (deviation > MAX_PRICE_DEVIATION) {
        logger.goldrush.warn(`Rejected garbage price: $${price} (${(deviation * 100).toFixed(1)}% deviation from $${referencePrice})`);
        return false;
    }

    // Update reference with valid price (rolling average)
    referencePrice = referencePrice * 0.9 + price * 0.1;
    return true;
}

/**
 * Start the GoldRush price stream
 */
function startStream(tokenAddress, chainName = 'solana-mainnet') {
    if (!client) {
        logger.goldrush.error('Client not initialized. Call init() first.');
        return;
    }

    // Resolve chain name to SDK constant
    let chain = StreamingChain.SOLANA_MAINNET;
    if (chainName === 'base-mainnet') chain = StreamingChain.BASE_MAINNET;

    logger.goldrush.info(`Starting stream on ${chainName} for ${tokenAddress}`);

    currentTokenAddress = tokenAddress;
    logger.goldrush.connect();

    client.StreamingService.subscribeToOHLCVTokens(
        {
            chain_name: chain,
            token_addresses: [tokenAddress],
            interval: currentInterval,
            timeframe: StreamingTimeframe.FIFTEEN_MINUTES,
        },
        {
            next: (data) => {
                const candleData = Array.isArray(data) ? data : [data];
                if (candleData && candleData.length > 0) {
                    processCandles(candleData);
                }
            },
            error: (err) => logger.goldrush.error(`SDK Error: ${err}`),
            complete: () => logger.goldrush.warn('Stream completed'),
        }
    );
}

/**
 * Process incoming OHLCV candles
 */
function processCandles(incomingCandles) {
    const fastArrival = Date.now();

    if (!incomingCandles || incomingCandles.length === 0) return;

    const latestCandle = incomingCandles[incomingCandles.length - 1];
    const price = latestCandle.close || latestCandle.quote_rate_usd;

    // CRITICAL: Validate price to filter garbage data
    if (!isValidPrice(price)) {
        return;
    }

    const candleTimeMs = new Date(latestCandle.timestamp).getTime();
    const candleCloseTime = candleTimeMs + 1000;
    let latency = fastArrival - candleCloseTime;
    if (latency < 0) latency = 0;

    const SYMBOL = getSymbol();
    // logger.goldrush.stream moved to end of function

    // Update pairs state
    updatePairs(SYMBOL, { price, fastPrice: price });

    // Accumulate candles - FILTER OUT garbage OHLC data
    const newCandles = incomingCandles
        .filter(c => {
            // All OHLC values must be valid
            const values = [c.open, c.high, c.low, c.close];
            if (values.some(v => !v || v <= 0)) return false;
            // All values must be within 50% of reference price
            if (referencePrice) {
                for (const v of values) {
                    const deviation = Math.abs(v - referencePrice) / referencePrice;
                    if (deviation > MAX_PRICE_DEVIATION) return false;
                }
            }
            return true;
        })
        .map(c => ({
            time: Math.floor(new Date(c.timestamp).getTime() / 1000),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close
        }));

    const candleMap = new Map();
    candles.forEach(c => candleMap.set(c.time, c));
    newCandles.forEach(c => candleMap.set(c.time, c));

    candles = Array.from(candleMap.values())
        .sort((a, b) => a.time - b.time)
        .slice(-15); // Keep last 15 candles (matches Codex ~15m history)

    console.log(`DEBUG: GoldRush Candles Sliced. Size: ${candles.length}`);

    broadcast({
        type: 'FAST_TICK',
        data: {
            pair: SYMBOL,
            price: price,
            timestamp: fastArrival,
            latency: latency,
            candles: candles
        }
    });

    // Store latency for race reporting
    trading.lastLatency = latency;

    // Log AFTER processing to show correct candle count
    logger.goldrush.stream(price, latency, candles.length);

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
        const takeProfitTarget = GOLDRUSH_THRESHOLD * 3;
        const shouldExit = (pos.side === 'LONG' && priceChangeFromEntry > takeProfitTarget) ||
            (pos.side === 'SHORT' && priceChangeFromEntry < -takeProfitTarget) ||
            holdTime > 10000;

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

            trading.trades.unshift(trade);
            if (trading.trades.length > 50) trading.trades.pop();
            trading.totalPnL += trade.pnl;
            trading.position = null;

            broadcast({ type: 'FAST_TRADE', data: trade });
            logger.goldrush.trade(pos.side, 'CLOSE', currentPrice, trade.pnl);
        }
    } else {
        if (priceChange > GOLDRUSH_THRESHOLD) {
            trading.position = { side: 'LONG', entryPrice: currentPrice, entryTime: Date.now(), latency: trading.lastLatency || 0 };
            logger.goldrush.trade('LONG', 'OPEN', currentPrice);
            raceCoordinator.reportSignal('goldrush', 'LONG', currentPrice, trading.lastLatency || 0);
        } else if (priceChange < -GOLDRUSH_THRESHOLD) {
            trading.position = { side: 'SHORT', entryPrice: currentPrice, entryTime: Date.now(), latency: trading.lastLatency || 0 };
            logger.goldrush.trade('SHORT', 'OPEN', currentPrice);
            raceCoordinator.reportSignal('goldrush', 'SHORT', currentPrice, trading.lastLatency || 0);
        }
    }
}

/**
 * Reset state
 */
function reset() {
    candles = [];
    trading = {
        position: null,
        lastPrice: null,
        trades: [],
        totalPnL: 0
    };
    referencePrice = null;
}

/**
 * Get current state
 */
function getState() {
    return {
        candles,
        trading,
        threshold: GOLDRUSH_THRESHOLD
    };
}

/**
 * Set the timeframe (restarts stream with new interval)
 * @param {string} tf - '1m', '5m', or '15m'
 */
function setTimeframe(tf) {
    if (!INTERVAL_MAP[tf]) {
        logger.goldrush.error(`Invalid timeframe: ${tf}. Use 1m, 5m, or 15m.`);
        return false;
    }
    currentInterval = INTERVAL_MAP[tf];
    logger.goldrush.info(`Timeframe changed to ${tf}`);

    // Reset state and restart stream with new interval
    reset();
    if (currentTokenAddress) {
        startStream(currentTokenAddress);
    }
    return true;
}

/**
 * Get current timeframe
 */
function getCurrentTimeframe() {
    for (const [key, val] of Object.entries(INTERVAL_MAP)) {
        if (val === currentInterval) return key;
    }
    return '1m';
}

module.exports = {
    init,
    startStream,
    reset,
    getState,
    setReferencePrice,
    setTimeframe,
    getCurrentTimeframe,
    THRESHOLD: GOLDRUSH_THRESHOLD
};
