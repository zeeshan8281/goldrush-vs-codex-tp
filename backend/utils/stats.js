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

    reset() {
        this.samples = [];
    }

    /**
     * Calculates percentile using Linear Interpolation method
     * Formula: v = x[k] + f * (x[k+1] - x[k])
     */
    static calculatePercentile(sorted, p) {
        if (sorted.length === 0) return 0;
        if (sorted.length === 1) return sorted[0];
        if (p <= 0) return sorted[0];
        if (p >= 1) return sorted[sorted.length - 1];

        // Rank index (0-based) based on formula: i = p * (N - 1)
        const index = p * (sorted.length - 1);
        const base = Math.floor(index);
        const rest = index - base;

        if (base >= sorted.length - 1) {
            return sorted[sorted.length - 1];
        }

        const v0 = sorted[base];
        const v1 = sorted[base + 1];

        return v0 + rest * (v1 - v0);
    }

    getStats() {
        if (this.samples.length === 0) {
            return { p50: 0, p95: 0, p99: 0, jitter: 0, stdDev: 0 };
        }

        const sorted = [...this.samples].sort((a, b) => a - b);
        const len = sorted.length;

        const p50 = RollingStats.calculatePercentile(sorted, 0.50);
        const p95 = RollingStats.calculatePercentile(sorted, 0.95);
        const p99 = RollingStats.calculatePercentile(sorted, 0.99);

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

        const p50 = RollingStats.calculatePercentile(sorted, 0.50);
        const p95 = RollingStats.calculatePercentile(sorted, 0.95);
        const p99 = RollingStats.calculatePercentile(sorted, 0.99);
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
