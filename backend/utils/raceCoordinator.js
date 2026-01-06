/**
 * Race Coordinator
 * Tracks latency races between providers
 * The provider that detects a trading signal first (lowest latency) wins
 */

const logger = require('./logger');

// Race configuration
const RACE_WINDOW_MS = 5000; // 5 second window to group related signals

// Race history
let races = [];
let stats = {
    goldrush: { wins: 0, losses: 0, totalLatency: 0, signals: 0 },
    codex: { wins: 0, losses: 0, totalLatency: 0, signals: 0 },
    gecko: { wins: 0, losses: 0, totalLatency: 0, signals: 0 }
};

// Active race tracking (signals waiting to be resolved)
let pendingRace = null;
let raceTimeout = null;

/**
 * Report a trading signal from a provider
 * @param {string} provider - 'goldrush', 'codex', or 'gecko'
 * @param {string} signalType - 'LONG' or 'SHORT'
 * @param {number} price - The price at signal
 * @param {number} latency - The data latency in ms
 */
function reportSignal(provider, signalType, price, latency) {
    const now = Date.now();

    stats[provider].signals++;
    stats[provider].totalLatency += latency;

    // Check if this fits into an existing pending race
    if (pendingRace &&
        pendingRace.signalType === signalType &&
        (now - pendingRace.startTime) < RACE_WINDOW_MS) {
        // Add to existing race
        pendingRace.participants.push({
            provider,
            latency,
            price,
            timestamp: now
        });
    } else {
        // Resolve any previous race
        if (pendingRace) {
            resolveRace();
        }

        // Start a new race
        pendingRace = {
            id: `race-${now}`,
            signalType,
            startTime: now,
            participants: [{
                provider,
                latency,
                price,
                timestamp: now
            }]
        };

        // Set timeout to resolve the race
        if (raceTimeout) clearTimeout(raceTimeout);
        raceTimeout = setTimeout(resolveRace, RACE_WINDOW_MS);
    }
}

/**
 * Resolve a pending race - determine winner and losers
 */
function resolveRace() {
    if (!pendingRace || pendingRace.participants.length === 0) {
        pendingRace = null;
        return;
    }

    // Sort by TIMESTAMP (who detected first wins) - NOT by latency
    const sorted = pendingRace.participants.sort((a, b) => a.timestamp - b.timestamp);
    const winner = sorted[0];
    const losers = sorted.slice(1);

    // Update stats
    stats[winner.provider].wins++;
    losers.forEach(loser => {
        stats[loser.provider].losses++;
    });

    // Log the race result with time differences
    const loserNames = losers.map(l => {
        const delay = l.timestamp - winner.timestamp;
        return `${l.provider}(+${delay}ms)`;
    }).join(', ');
    logger.system.info(`Race ${pendingRace.signalType}: ${winner.provider} WON${loserNames ? ` beat ${loserNames}` : ''}`);

    // Store race for history
    races.push({
        id: pendingRace.id,
        signalType: pendingRace.signalType,
        timestamp: pendingRace.startTime,
        winner: winner.provider,
        winnerLatency: winner.latency,
        participants: pendingRace.participants.length
    });

    // Keep last 100 races
    if (races.length > 100) races.shift();

    pendingRace = null;
}

/**
 * Get race statistics
 */
function getStats() {
    const result = {};

    for (const [provider, data] of Object.entries(stats)) {
        const totalRaces = data.wins + data.losses;
        result[provider] = {
            wins: data.wins,
            losses: data.losses,
            winRate: totalRaces > 0 ? Number(((data.wins / totalRaces) * 100).toFixed(1)) : 0,
            avgLatency: data.signals > 0 ? Math.round(data.totalLatency / data.signals) : 0,
            totalSignals: data.signals
        };
    }

    return result;
}

/**
 * Get recent race history
 */
function getRaceHistory() {
    return races.slice(-20); // Last 20 races
}

/**
 * Reset all stats
 */
function reset() {
    races = [];
    stats = {
        goldrush: { wins: 0, losses: 0, totalLatency: 0, signals: 0 },
        codex: { wins: 0, losses: 0, totalLatency: 0, signals: 0 },
        gecko: { wins: 0, losses: 0, totalLatency: 0, signals: 0 }
    };
    pendingRace = null;
    if (raceTimeout) clearTimeout(raceTimeout);
}

module.exports = {
    reportSignal,
    getStats,
    getRaceHistory,
    reset
};
