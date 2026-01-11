/**
 * Rolling Statistics Calculator
 * Maintains a sliding window of values to compute percentiles/jitter.
 */
class RollingStats {
    constructor(windowSize = 1000) {
        this.windowSize = windowSize;
        this.samples = [];
    }

    add(value) {
        if (typeof value !== 'number') return;
        this.samples.push(value);
        if (this.samples.length > this.windowSize) {
            this.samples.shift();
        }
    }

    getStats() {
        if (this.samples.length === 0) {
            return { p50: 0, p95: 0, p99: 0, jitter: 0 };
        }

        // Sort copy of samples
        const sorted = [...this.samples].sort((a, b) => a - b);
        const len = sorted.length;

        const p50 = sorted[Math.floor(len * 0.50)];
        const p95 = sorted[Math.floor(len * 0.95)];
        const p99 = sorted[Math.floor(len * 0.99)];

        // Jitter = p95 - p50
        const jitter = Math.max(0, p95 - p50);

        // Standard Deviation
        const sum = this.samples.reduce((a, b) => a + b, 0);
        const mean = sum / len;
        const squareDiffs = this.samples.map(val => Math.pow(val - mean, 2));
        const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / len;
        const stdDev = Math.sqrt(avgSquareDiff);

        return { p50, p95, p99, jitter, stdDev };
    }
    static calculateSnapshotStats(samples) {
        if (!samples || samples.length === 0) {
            return { p50: 0, p95: 0, p99: 0, jitter: 0, stdDev: 0 };
        }

        const sorted = [...samples].sort((a, b) => a - b);
        const len = sorted.length;

        const p50 = sorted[Math.floor(len * 0.50)];
        const p95 = sorted[Math.floor(len * 0.95)];
        const p99 = sorted[Math.floor(len * 0.99)];
        const jitter = Math.max(0, p95 - p50);

        const sum = samples.reduce((a, b) => a + b, 0);
        const mean = sum / len;
        const squareDiffs = samples.map(val => Math.pow(val - mean, 2));
        const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / len;
        const stdDev = Math.sqrt(avgSquareDiff);

        return { p50, p95, p99, jitter, stdDev };
    }
}

module.exports = RollingStats;
