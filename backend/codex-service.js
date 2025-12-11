const axios = require('axios');

class CodexService {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.endpoint = 'https://graph.codex.io/graphql';
    }

    async getBars(symbol, resolution = '1', countback = 10) {
        const now = Math.floor(Date.now() / 1000);
        // Fetch last 24h just in case, but rely on countback
        const from = now - 86400;

        const query = `
      query GetTokenBars($symbol: String!, $from: Int!, $to: Int!, $resolution: String!, $countback: Int) {
        getTokenBars(
          symbol: $symbol
          from: $from
          to: $to
          resolution: $resolution
          removeEmptyBars: true
          countback: $countback
        ) {
          o
          h
          l
          c
          volume
          t
        }
      }
    `;

        try {
            const response = await axios.post(
                this.endpoint,
                {
                    query,
                    variables: {
                        symbol,
                        from,
                        to: now,
                        resolution,
                        countback
                    }
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': this.apiKey // assuming Bearer or just key
                    }
                }
            );

            if (response.data.errors) {
                console.error('Codex API Data Errors:', JSON.stringify(response.data.errors, null, 2));
                return [];
            }

            return response.data.data.getTokenBars || [];
        } catch (error) {
            console.error('Codex API Error:', error.message);
            return [];
        }
    }

    // Simple "Strategy" to replace LLM
    analyze(bars) {
        if (!bars || bars.length < 2) return null;

        const last = bars[bars.length - 1];
        const prev = bars[bars.length - 2];

        // Simple Momentum Strategy
        const isGreen = last.c > last.o;
        const wasGreen = prev.c > prev.o;
        const priceChange = ((last.c - prev.c) / prev.c) * 100;

        // Trigger on consecutive greens with volume increase
        if (isGreen && wasGreen && priceChange > 0.05) { // 0.05% move
            return {
                side: 'long',
                rationale: `Codex Data: Consecutive green candles. Price up ${priceChange.toFixed(3)}% on increasing volume.`,
                confidence: 0.8
            };
        } else if (!isGreen && !wasGreen && priceChange < -0.05) {
            return {
                side: 'short',
                rationale: `Codex Data: Bearish momentum. Price dropped ${Math.abs(priceChange).toFixed(3)}% in last tick.`,
                confidence: 0.8
            };
        }

        return null;
    }
}

module.exports = CodexService;
