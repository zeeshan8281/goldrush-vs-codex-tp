import React, { useEffect, useState, useRef } from 'react';
import { createChart } from 'lightweight-charts';
import { TrendingUp, TrendingDown, Trophy, Clock, Activity, BarChart3 } from 'lucide-react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002';

function StatsPage({ onBack }) {
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const chartContainerRef = useRef(null);
    const chartRef = useRef(null);

    // Fetch stats from backend
    const fetchStats = async () => {
        try {
            const res = await fetch(`${BACKEND_URL}/stats`);
            const data = await res.json();
            setStats(data);
            setError(null);
        } catch (err) {
            setError('Failed to fetch stats');
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchStats();
        // Refresh every 30 seconds
        const interval = setInterval(fetchStats, 30000);
        return () => clearInterval(interval);
    }, []);

    // Create/update chart when history changes
    useEffect(() => {
        if (!chartContainerRef.current || !stats?.history?.length) return;

        // Clear existing chart
        if (chartRef.current) {
            chartRef.current.remove();
        }

        const chart = createChart(chartContainerRef.current, {
            width: chartContainerRef.current.clientWidth,
            height: 300,
            layout: {
                background: { type: 'solid', color: '#0a0a0a' },
                textColor: '#888',
            },
            grid: {
                vertLines: { color: '#1a1a1a' },
                horzLines: { color: '#1a1a1a' },
            },
            timeScale: {
                timeVisible: true,
                secondsVisible: false,
            },
        });

        chartRef.current = chart;

        // GoldRush line (red)
        const grSeries = chart.addLineSeries({
            color: '#ef4444',
            lineWidth: 2,
            title: 'GoldRush',
        });

        // Codex line (blue)
        const cxSeries = chart.addLineSeries({
            color: '#3b82f6',
            lineWidth: 2,
            title: 'Codex',
        });

        // Gecko line (yellow)
        const gkSeries = chart.addLineSeries({
            color: '#eab308',
            lineWidth: 2,
            title: 'Gecko',
        });

        // Convert history to chart format
        const grData = stats.history.map(h => ({
            time: Math.floor(h.timestamp / 1000),
            value: h.goldrush.totalPnL,
        }));
        const cxData = stats.history.map(h => ({
            time: Math.floor(h.timestamp / 1000),
            value: h.codex.totalPnL,
        }));
        const gkData = stats.history.map(h => ({
            time: Math.floor(h.timestamp / 1000),
            value: h.gecko.totalPnL,
        }));

        grSeries.setData(grData);
        cxSeries.setData(cxData);
        gkSeries.setData(gkData);

        chart.timeScale().fitContent();

        // Handle resize
        const handleResize = () => {
            chart.applyOptions({ width: chartContainerRef.current.clientWidth });
        };
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            chart.remove();
        };
    }, [stats?.history]);

    if (loading) {
        return (
            <div className="stats-page loading">
                <div className="spinner"></div>
                <p>Loading statistics...</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="stats-page error">
                <p>{error}</p>
                <button onClick={fetchStats}>Retry</button>
            </div>
        );
    }

    const { providers, comparison, uptime } = stats;

    const ProviderCard = ({ name, data, color }) => (
        <div className={`provider-card ${color}`}>
            <h3>{name}</h3>
            <div className="stat-grid">
                <div className="stat">
                    <span className="label">Total PnL</span>
                    <span className={`value ${data.totalPnL >= 0 ? 'positive' : 'negative'}`}>
                        {data.totalPnL >= 0 ? '+' : ''}${data.totalPnL.toFixed(2)}
                    </span>
                </div>
                <div className="stat">
                    <span className="label">Win Rate</span>
                    <span className="value">{data.winRate.toFixed(1)}%</span>
                </div>
                <div className="stat">
                    <span className="label">Trades</span>
                    <span className="value">{data.totalTrades}</span>
                </div>
                <div className="stat">
                    <span className="label">Avg/Trade</span>
                    <span className={`value ${data.avgPnLPerTrade >= 0 ? 'positive' : 'negative'}`}>
                        ${data.avgPnLPerTrade.toFixed(2)}
                    </span>
                </div>
                <div className="stat">
                    <span className="label">PnL/Min</span>
                    <span className={`value ${data.pnlPerMinute >= 0 ? 'positive' : 'negative'}`}>
                        ${data.pnlPerMinute.toFixed(4)}
                    </span>
                </div>
                <div className="stat">
                    <span className="label">W/L</span>
                    <span className="value">{data.wins}/{data.losses}</span>
                </div>
            </div>
        </div>
    );

    return (
        <div className="stats-page">
            <header className="stats-header">
                <button className="back-btn" onClick={onBack}>← Back to Dashboard</button>
                <h1><BarChart3 size={24} /> Performance Statistics</h1>
                <div className="uptime">
                    <Clock size={16} />
                    Uptime: {uptime.formatted}
                </div>
            </header>

            <div className="provider-cards">
                <ProviderCard name="GOLDRUSH" data={providers.goldrush} color="red" />
                <ProviderCard name="CODEX" data={providers.codex} color="blue" />
                <ProviderCard name="GECKO" data={providers.gecko} color="yellow" />
            </div>

            {/* Latency Comparison Section */}
            {stats.latencyRace && (
                <div className="race-section">
                    <h2>⚡ Data Latency Comparison</h2>
                    <p className="race-subtitle">Lower is better - shows how fast each provider delivers price data</p>
                    <div className="latency-comparison">
                        {['goldrush', 'codex', 'gecko']
                            .sort((a, b) => {
                                const latA = stats.latencyRace[a]?.avgLatency || 999999999;
                                const latB = stats.latencyRace[b]?.avgLatency || 999999999;
                                return latA - latB;
                            })
                            .map(provider => {
                                const race = stats.latencyRace[provider];
                                const color = provider === 'goldrush' ? 'red' : provider === 'codex' ? 'blue' : 'yellow';
                                const maxLatency = Math.max(
                                    stats.latencyRace.goldrush?.avgLatency || 1,
                                    stats.latencyRace.codex?.avgLatency || 1,
                                    stats.latencyRace.gecko?.avgLatency || 1
                                );
                                const barWidth = race.avgLatency > 0 ? (race.avgLatency / maxLatency) * 100 : 0;
                                const grLatency = stats.latencyRace.goldrush?.avgLatency || 1;
                                const speedMultiplier = race.avgLatency > 0 && grLatency > 0
                                    ? (race.avgLatency / grLatency).toFixed(1)
                                    : '1';

                                return (
                                    <div key={provider} className={`latency-row ${color}`}>
                                        <div className="latency-label">{provider.toUpperCase()}</div>
                                        <div className="latency-bar-container">
                                            <div
                                                className={`latency-bar ${color}`}
                                                style={{ width: `${barWidth}%` }}
                                            />
                                        </div>
                                        <div className="latency-value">
                                            {race.avgLatency > 0 ? `${(race.avgLatency / 1000).toFixed(1)}s` : 'N/A'}
                                        </div>
                                        {provider !== 'goldrush' && race.avgLatency > grLatency && (
                                            <div className="speed-badge">
                                                {speedMultiplier}x slower
                                            </div>
                                        )}
                                        {provider === 'goldrush' && (
                                            <div className="speed-badge fastest">FASTEST</div>
                                        )}
                                    </div>
                                );
                            })}
                    </div>
                </div>
            )}

            <div className="chart-section">
                <h2><Activity size={20} /> Cumulative PnL Over Time</h2>
                {stats.history && stats.history.length > 0 ? (
                    <div ref={chartContainerRef} className="chart-container" />
                ) : (
                    <div className="no-data">
                        <p>Chart data will appear after the first 10-minute snapshot.</p>
                        <p className="hint">Snapshots are captured every 10 minutes.</p>
                    </div>
                )}
                <div className="chart-legend">
                    <span className="legend-item red">● GoldRush</span>
                    <span className="legend-item blue">● Codex</span>
                    <span className="legend-item yellow">● Gecko</span>
                </div>
            </div>

            <style>{`
                .stats-page {
                    min-height: 100vh;
                    background: #0a0a0a;
                    color: #fff;
                    padding: 20px;
                }
                
                .stats-page.loading, .stats-page.error {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: 16px;
                }
                
                .spinner {
                    width: 40px;
                    height: 40px;
                    border: 3px solid #333;
                    border-top-color: #3b82f6;
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                }
                
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
                
                .stats-header {
                    display: flex;
                    align-items: center;
                    gap: 24px;
                    margin-bottom: 24px;
                    padding-bottom: 16px;
                    border-bottom: 1px solid #222;
                }
                
                .stats-header h1 {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-size: 1.5rem;
                    flex: 1;
                }
                
                .back-btn {
                    background: #1a1a1a;
                    border: 1px solid #333;
                    color: #888;
                    padding: 8px 16px;
                    border-radius: 6px;
                    cursor: pointer;
                    transition: all 0.2s;
                }
                
                .back-btn:hover {
                    background: #222;
                    color: #fff;
                }
                
                .uptime {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    color: #888;
                    font-size: 0.9rem;
                }
                
                .provider-cards {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 20px;
                    margin-bottom: 32px;
                }
                
                .provider-card {
                    background: #111;
                    border-radius: 12px;
                    padding: 20px;
                    border: 2px solid #222;
                    position: relative;
                    transition: all 0.3s;
                }
                
                .provider-card.red { border-color: #ef444433; }
                .provider-card.blue { border-color: #3b82f633; }
                .provider-card.yellow { border-color: #eab30833; }
                
                .provider-card.winner {
                    border-color: #22c55e !important;
                    box-shadow: 0 0 20px rgba(34, 197, 94, 0.2);
                }
                
                .winner-badge {
                    position: absolute;
                    top: -12px;
                    right: 16px;
                    background: #22c55e;
                    color: #000;
                    padding: 4px 12px;
                    border-radius: 12px;
                    font-size: 0.75rem;
                    font-weight: bold;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }
                
                .provider-card h3 {
                    font-size: 1.1rem;
                    margin-bottom: 16px;
                    color: #fff;
                }
                
                .provider-card.red h3 { color: #ef4444; }
                .provider-card.blue h3 { color: #3b82f6; }
                .provider-card.yellow h3 { color: #eab308; }
                
                .stat-grid {
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
                    gap: 12px;
                }
                
                .stat {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                
                .stat .label {
                    font-size: 0.75rem;
                    color: #666;
                    text-transform: uppercase;
                }
                
                .stat .value {
                    font-size: 1.1rem;
                    font-weight: 600;
                    font-family: 'SF Mono', monospace;
                }
                
                .stat .value.positive { color: #22c55e; }
                .stat .value.negative { color: #ef4444; }
                
                .chart-section {
                    background: #111;
                    border-radius: 12px;
                    padding: 20px;
                    border: 1px solid #222;
                }
                
                .chart-section h2 {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-size: 1.1rem;
                    margin-bottom: 16px;
                    color: #888;
                }
                
                .chart-container {
                    border-radius: 8px;
                    overflow: hidden;
                }
                
                .no-data {
                    padding: 60px 20px;
                    text-align: center;
                    color: #666;
                }
                
                .no-data .hint {
                    font-size: 0.85rem;
                    margin-top: 8px;
                }
                
                .chart-legend {
                    display: flex;
                    justify-content: center;
                    gap: 24px;
                    margin-top: 16px;
                }
                
                .legend-item {
                    font-size: 0.85rem;
                    color: #888;
                }
                
                .legend-item.red { color: #ef4444; }
                .legend-item.blue { color: #3b82f6; }
                .legend-item.yellow { color: #eab308; }
                
                .race-section {
                    background: #111;
                    border-radius: 12px;
                    padding: 20px;
                    border: 1px solid #222;
                    margin-bottom: 24px;
                }
                
                .race-section h2 {
                    font-size: 1.1rem;
                    margin-bottom: 4px;
                    color: #fff;
                }
                
                .race-subtitle {
                    color: #666;
                    font-size: 0.85rem;
                    margin-bottom: 24px;
                }
                
                .latency-comparison {
                    display: flex;
                    flex-direction: column;
                    gap: 16px;
                }
                
                .latency-row {
                    display: grid;
                    grid-template-columns: 100px 1fr 80px 120px;
                    align-items: center;
                    gap: 16px;
                    padding: 8px 0;
                }
                
                .latency-label {
                    font-weight: 600;
                    font-size: 0.9rem;
                }
                
                .latency-row.red .latency-label { color: #ef4444; }
                .latency-row.blue .latency-label { color: #3b82f6; }
                .latency-row.yellow .latency-label { color: #eab308; }
                
                .latency-bar-container {
                    height: 24px;
                    background: #1a1a1a;
                    border-radius: 4px;
                    overflow: hidden;
                    position: relative;
                }
                
                .latency-bar {
                    height: 100%;
                    border-radius: 4px;
                    transition: width 0.5s ease-out;
                    min-width: 4px;
                }
                
                .latency-bar.red { background: #ef4444; }
                .latency-bar.blue { background: #3b82f6; }
                .latency-bar.yellow { background: #eab308; }
                
                .latency-value {
                    text-align: right;
                    font-family: 'SF Mono', monospace;
                    color: #888;
                }
                
                .speed-badge {
                    background: #222;
                    color: #888;
                    padding: 4px 8px;
                    border-radius: 4px;
                    font-size: 0.75rem;
                    text-align: center;
                    border: 1px solid #333;
                }
                
                .speed-badge.fastest {
                    background: rgba(34, 197, 94, 0.1);
                    color: #22c55e;
                    border-color: rgba(34, 197, 94, 0.2);
                    font-weight: 600;
                }
                
                @media (max-width: 900px) {
                    .provider-cards {
                        grid-template-columns: 1fr;
                    }
                    
                    .latency-row {
                        grid-template-columns: 80px 1fr;
                        grid-template-rows: auto auto;
                        gap: 8px;
                    }
                    
                    .latency-value, .speed-badge {
                        grid-column: 2;
                        justify-self: start;
                        text-align: left;
                    }
                }
            `}</style>
        </div>
    );
}

export default StatsPage;
