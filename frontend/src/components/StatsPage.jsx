import React, { useEffect, useState, useRef } from 'react';
import { createChart } from 'lightweight-charts';
import { TrendingUp, TrendingDown, Trophy, Clock, Activity, BarChart3, Zap, Timer, Shield, Gauge } from 'lucide-react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002';

// Provider colors
const COLORS = {
    goldrush: '#ef4444',
    codex: '#3b82f6',
    gecko: '#eab308'
};

// Comparison Chart with 3 lines
const ComparisonChart = ({ title, metricKey, history, icon: Icon, unit = '' }) => {
    const containerRef = useRef(null);
    const chartRef = useRef(null);
    const seriesRefs = useRef({});

    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            height: 200,
            layout: { background: { type: 'solid', color: '#0a0a0a' }, textColor: '#666' },
            grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
            timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#222' },
            rightPriceScale: { borderColor: '#222' },
            crosshair: { mode: 1 },
        });

        // Add 3 line series
        seriesRefs.current.goldrush = chart.addLineSeries({
            color: COLORS.goldrush,
            lineWidth: 2,
            title: 'GoldRush'
        });
        seriesRefs.current.codex = chart.addLineSeries({
            color: COLORS.codex,
            lineWidth: 2,
            title: 'Codex'
        });
        seriesRefs.current.gecko = chart.addLineSeries({
            color: COLORS.gecko,
            lineWidth: 2,
            title: 'Gecko'
        });

        chartRef.current = chart;

        const handleResize = () => {
            if (containerRef.current && chartRef.current) {
                chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
            }
        };
        window.addEventListener('resize', handleResize);
        handleResize();

        return () => {
            window.removeEventListener('resize', handleResize);
            chart.remove();
        };
    }, []);

    useEffect(() => {
        if (!history || !chartRef.current) return;

        const providers = ['goldrush', 'codex', 'gecko'];
        providers.forEach(provider => {
            const data = history.map(h => ({
                time: Math.floor(h.time / 1000),
                value: h[provider]?.[metricKey] || 0
            }));
            seriesRefs.current[provider]?.setData(data);
        });

        if (history.length > 0) {
            chartRef.current.timeScale().fitContent();
        }
    }, [history, metricKey]);

    // Get current values for display
    const current = history && history.length > 0 ? history[history.length - 1] : null;

    return (
        <div className="comparison-chart">
            <div className="chart-header">
                {Icon && <Icon size={18} />}
                <span className="chart-title">{title}</span>
            </div>
            <div className="chart-container" ref={containerRef} />
            <div className="chart-legend">
                {['goldrush', 'codex', 'gecko'].map(p => (
                    <div key={p} className="legend-item" style={{ color: COLORS[p] }}>
                        <span className="legend-dot" style={{ background: COLORS[p] }} />
                        <span className="legend-name">{p.charAt(0).toUpperCase() + p.slice(1)}</span>
                        <span className="legend-value">
                            {current?.[p]?.[metricKey]?.toFixed(metricKey === 'candlesPerSec' ? 2 : 0)}{unit}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
};

function StatsPage({ onBack }) {
    const [stats, setStats] = useState(null);
    const [metricsHistory, setMetricsHistory] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    // Fetch stats and metrics history
    const fetchData = async () => {
        try {
            const [statsRes, metricsRes] = await Promise.all([
                fetch(`${BACKEND_URL}/stats`),
                fetch(`${BACKEND_URL}/metrics-history`)
            ]);
            const statsData = await statsRes.json();
            const metricsData = await metricsRes.json();
            setStats(statsData);
            setMetricsHistory(metricsData.history || []);
            setError(null);
        } catch (err) {
            setError('Failed to fetch stats');
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 5000); // Refresh every 5s
        return () => clearInterval(interval);
    }, []);

    const formatUptime = (ms) => {
        if (!ms || ms <= 0) return '0s';
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        return `${h}h ${m}m ${s}s`;
    };

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
                <button onClick={fetchData}>Retry</button>
            </div>
        );
    }

    const { uptime } = stats;

    return (
        <div className="stats-page">
            <header className="stats-header">
                <button className="back-btn" onClick={onBack}>← Back to Dashboard</button>
                <h1><BarChart3 size={24} /> Performance Comparison</h1>
                <div className="uptime">
                    <Clock size={16} />
                    Uptime: {formatUptime(uptime)}
                </div>
            </header>

            {/* 4 Comparison Charts in 2x2 Grid */}
            <div className="comparison-grid">
                <ComparisonChart
                    title="Data Loading Times"
                    metricKey="loadTime"
                    history={metricsHistory}
                    icon={Timer}
                    unit="ms"
                />
                <ComparisonChart
                    title="Candles per Second"
                    metricKey="candlesPerSec"
                    history={metricsHistory}
                    icon={Zap}
                    unit="/s"
                />
                <ComparisonChart
                    title="Stability"
                    metricKey="stability"
                    history={metricsHistory}
                    icon={Shield}
                    unit="%"
                />
                <ComparisonChart
                    title="Latency per 300 Candles"
                    metricKey="latency300"
                    history={metricsHistory}
                    icon={Gauge}
                    unit="ms"
                />
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
                
                /* 2x2 Comparison Grid */
                .comparison-grid {
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
                    gap: 20px;
                }
                
                .comparison-chart {
                    background: #111;
                    border: 1px solid #222;
                    border-radius: 12px;
                    padding: 16px;
                }
                
                .chart-header {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 12px;
                    color: #fff;
                    font-weight: 600;
                    font-size: 1rem;
                }
                
                .chart-container {
                    width: 100%;
                    border-radius: 8px;
                    overflow: hidden;
                }
                
                .chart-legend {
                    display: flex;
                    justify-content: space-around;
                    margin-top: 12px;
                    padding-top: 12px;
                    border-top: 1px solid #222;
                }
                
                .legend-item {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 0.85rem;
                }
                
                .legend-dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                }
                
                .legend-name {
                    font-weight: 500;
                }
                
                .legend-value {
                    font-family: 'SF Mono', monospace;
                    font-size: 0.8rem;
                    opacity: 0.7;
                }
                
                @media (max-width: 900px) {
                    .comparison-grid {
                        grid-template-columns: 1fr;
                    }
                }
            `}</style>
        </div>
    );
}

export default StatsPage;
