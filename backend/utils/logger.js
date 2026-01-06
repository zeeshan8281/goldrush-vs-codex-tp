/**
 * Logger Utility - Uniform Colored Logging
 * GOLDRUSH: Red | CODEX: Blue | GECKO: Yellow
 */

const COLORS = {
    RESET: '\x1b[0m',
    RED: '\x1b[31m',
    BLUE: '\x1b[34m',
    YELLOW: '\x1b[33m',
    GREEN: '\x1b[32m',
    GRAY: '\x1b[90m',
    WHITE: '\x1b[37m',
};

const PROVIDERS = {
    GOLDRUSH: COLORS.RED,
    CODEX: COLORS.BLUE,
    GECKO: COLORS.YELLOW,
    SYSTEM: COLORS.WHITE,
};

function timestamp() {
    const now = new Date();
    return `${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
}

function formatPrice(price) {
    if (!price || price <= 0) return '$0.00';
    if (price < 0.0001) return `$${price.toFixed(10)}`;
    if (price < 1) return `$${price.toFixed(6)}`;
    return `$${price.toFixed(2)}`;
}

function formatPnL(pnl) {
    const prefix = pnl >= 0 ? '+' : '';
    const color = pnl >= 0 ? COLORS.GREEN : COLORS.RED;
    return `${color}${prefix}$${pnl.toFixed(2)}${COLORS.RESET}`;
}

function log(provider, type, message, data = {}) {
    const color = PROVIDERS[provider] || COLORS.WHITE;
    const ts = timestamp();
    const prefix = `[${ts}] [${provider.padEnd(8)}]`;

    let output = `${color}${prefix}${COLORS.RESET} ${type.padEnd(10)} | ${message}`;

    if (Object.keys(data).length > 0) {
        const dataStr = Object.entries(data)
            .map(([k, v]) => {
                if (k === 'price') return `Price: ${formatPrice(v)}`;
                if (k === 'pnl') return `PnL: ${formatPnL(v)}`;
                if (k === 'latency') return `Latency: ${v}ms`;
                if (k === 'candles') return `Candles: ${v}`;
                return `${k}: ${v}`;
            })
            .join(' | ');
        output += ` | ${COLORS.GRAY}${dataStr}${COLORS.RESET}`;
    }

    console.log(output);
}

const goldrush = {
    stream: (price, latency, candles) => log('GOLDRUSH', 'STREAM', 'Tick received', { price, latency, candles }),
    trade: (side, action, price, pnl = null) => {
        const msg = action === 'OPEN' ? `Opened ${side} position` : `Closed ${side} position`;
        log('GOLDRUSH', 'TRADE', msg, pnl !== null ? { price, pnl } : { price });
    },
    connect: () => log('GOLDRUSH', 'CONNECT', 'Connecting to stream...'),
    connected: () => log('GOLDRUSH', 'CONNECT', 'Connected successfully'),
    info: (msg) => log('GOLDRUSH', 'INFO', msg),
    error: (msg) => log('GOLDRUSH', 'ERROR', msg),
    warn: (msg) => log('GOLDRUSH', 'WARN', msg),
};

const codex = {
    stream: (price, latency, candles) => log('CODEX', 'STREAM', 'Tick received', { price, latency, candles }),
    trade: (side, action, price, pnl = null) => {
        const msg = action === 'OPEN' ? `Opened ${side} position` : `Closed ${side} position`;
        log('CODEX', 'TRADE', msg, pnl !== null ? { price, pnl } : { price });
    },
    connect: () => log('CODEX', 'CONNECT', 'Connecting to stream...'),
    connected: () => log('CODEX', 'CONNECT', 'Connected successfully'),
    history: () => log('CODEX', 'HISTORY', 'Fetching price history...'),
    info: (msg) => log('CODEX', 'INFO', msg),
    error: (msg) => log('CODEX', 'ERROR', msg),
    warn: (msg) => log('CODEX', 'WARN', msg),
};

const gecko = {
    stream: (price, latency, candles) => log('GECKO', 'STREAM', 'Tick received', { price, latency, candles }),
    trade: (side, action, price, pnl = null) => {
        const msg = action === 'OPEN' ? `Opened ${side} position` : `Closed ${side} position`;
        log('GECKO', 'TRADE', msg, pnl !== null ? { price, pnl } : { price });
    },
    connect: () => log('GECKO', 'CONNECT', 'Connecting to stream...'),
    connected: () => log('GECKO', 'CONNECT', 'Connected successfully'),
    pool: (address, liquidity) => log('GECKO', 'POOL', `Found pool: ${address}`, { liquidity }),
    info: (msg) => log('GECKO', 'INFO', msg),
    error: (msg) => log('GECKO', 'ERROR', msg),
    warn: (msg) => log('GECKO', 'WARN', msg),
};

const system = {
    info: (msg) => log('SYSTEM', 'INFO', msg),
    start: (msg) => log('SYSTEM', 'START', msg),
    ready: (port) => log('SYSTEM', 'READY', `Server listening on port ${port}`),
};

module.exports = {
    goldrush,
    codex,
    gecko,
    system,
    formatPrice,
    formatPnL,
    COLORS,
};
