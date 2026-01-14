import React, { useEffect, useState, useRef } from 'react';
import { createChart } from 'lightweight-charts';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, Cell } from 'recharts';
import { TrendingUp, TrendingDown, Trophy, Clock, Activity, BarChart3, Zap, Timer, Shield, Gauge, Info } from 'lucide-react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002';

// Provider colors
// Provider colors (with transparency for overlapping bars)
const COLORS = {
    goldrush: '#ef4444cc',
    codex: '#3b82f6cc',
    mobula: '#22c55ecc'
};

// Stat Card with 3 provider values stacked vertically
const StatCard = ({ title, metricKey, data, icon: Icon, unit = '', formula = '' }) => {
    const allProviders = [
        { key: 'goldrush', label: 'GoldRush', color: COLORS.goldrush },
        { key: 'codex', label: 'Codex', color: COLORS.codex },
        { key: 'mobula', label: 'Mobula', color: COLORS.mobula }
    ];

    const [visibleProviders, setVisibleProviders] = useState(['goldrush', 'codex', 'mobula']);

    const toggleProvider = (key) => {
        setVisibleProviders(prev =>
            prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key]
        );
    };

    return (
        <div className="stat-card">
            <div className="stat-card-header">
                {Icon && <Icon size={18} />}
                <span className="chart-title">{title}</span>
                {formula && (
                    <div className="info-tooltip-wrapper">
                        <Info size={14} className="info-icon" />
                        <div className="info-tooltip">{formula}</div>
                    </div>
                )}
            </div>
            <div className="provider-toggles">
                {allProviders.map(p => (
                    <label key={p.key} className="provider-toggle" style={{ color: p.color }}>
                        <input
                            type="checkbox"
                            checked={visibleProviders.includes(p.key)}
                            onChange={() => toggleProvider(p.key)}
                        />
                        <span className="toggle-dot" style={{ background: visibleProviders.includes(p.key) ? p.color : '#555' }} />
                        {p.label}
                    </label>
                ))}
            </div>
            <div className="stat-card-body">
                {allProviders.filter(p => visibleProviders.includes(p.key)).map(p => (
                    <div key={p.key} className="stat-row" style={{ borderLeftColor: p.color }}>
                        <span className="stat-label">{p.label}</span>
                        <span className="stat-value" style={{ color: p.color }}>
                            {data?.[p.key]?.[metricKey] ? Math.round(data[p.key][metricKey]).toLocaleString() : '—'} {unit}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
};

// TTFD Card with separate metrics per provider (matching mockup)
const TTFDCard = ({ data, icon: Icon }) => {
    const formatMs = (ms) => {
        if (!ms || ms <= 0) return '—';
        return `${Math.round(ms).toLocaleString()} ms`;
    };

    return (
        <div className="stat-card ttfd-card">
            <div className="stat-card-header">
                {Icon && <Icon size={18} />}
                <span className="chart-title">Time to First Data</span>
                <div className="info-tooltip-wrapper">
                    <Info size={14} className="info-icon" />
                    <div className="info-tooltip">
                        Ring Buffer: WSS established → first OHLCV data<br />
                        Live Data: Wall clock → first tick timestamp
                    </div>
                </div>
            </div>
            <div className="ttfd-columns">
                {/* GoldRush Column */}
                <div className="ttfd-column goldrush">
                    <div className="ttfd-provider-header" style={{ color: COLORS.goldrush }}>GoldRush</div>
                    <div className="ttfd-metrics">
                        <div className="ttfd-metric">
                            <span className="ttfd-label">Ring Buffer:</span>
                            <span className="ttfd-value" style={{ color: COLORS.goldrush }}>
                                {formatMs(data?.goldrush?.ringBufferTTFD)}
                            </span>
                        </div>
                        <div className="ttfd-metric">
                            <span className="ttfd-label">Live Data:</span>
                            <span className="ttfd-value" style={{ color: COLORS.goldrush }}>
                                {formatMs(data?.goldrush?.liveDataTTFD)}
                            </span>
                        </div>
                    </div>
                </div>
                {/* Codex Column */}
                <div className="ttfd-column codex">
                    <div className="ttfd-provider-header" style={{ color: COLORS.codex }}>Codex</div>
                    <div className="ttfd-metrics">
                        <div className="ttfd-metric">
                            <span className="ttfd-label">Live Data:</span>
                            <span className="ttfd-value" style={{ color: COLORS.codex }}>
                                {formatMs(data?.codex?.liveDataTTFD)}
                            </span>
                        </div>
                    </div>
                </div>
                {/* Mobula Column */}
                <div className="ttfd-column mobula">
                    <div className="ttfd-provider-header" style={{ color: COLORS.mobula }}>Mobula</div>
                    <div className="ttfd-metrics">
                        {/* Ring Buffer removed as requested */}
                        <div className="ttfd-metric">
                            <span className="ttfd-label">Live Data:</span>
                            <span className="ttfd-value" style={{ color: COLORS.mobula }}>
                                {formatMs(data?.mobula?.liveDataTTFD)}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const ComparisonChart = ({ title, metricKey, history, icon: Icon, unit = '', formula = '' }) => {
    const containerRef = useRef(null);
    const chartRef = useRef(null);
    const seriesRefs = useRef({});

    const allProviders = [
        { key: 'goldrush', label: 'GoldRush', color: COLORS.goldrush },
        { key: 'codex', label: 'Codex', color: COLORS.codex },
        { key: 'mobula', label: 'Mobula', color: COLORS.mobula }
    ];

    const [visibleProviders, setVisibleProviders] = useState(['goldrush', 'codex', 'mobula']);

    const toggleProvider = (key) => {
        setVisibleProviders(prev =>
            prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key]
        );
    };

    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            height: 200,
            layout: { background: { type: 'solid', color: '#0a0a0a' }, textColor: '#666' },
            grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
            timeScale: { timeVisible: true, secondsVisible: true, borderColor: '#222' },
            rightPriceScale: { borderColor: '#222' },
            crosshair: { mode: 1 },
        });

        // Add 3 line series



        seriesRefs.current.goldrush = chart.addLineSeries({
            color: COLORS.goldrush,
            lineWidth: 3,
            title: 'GoldRush'
        });
        seriesRefs.current.codex = chart.addLineSeries({
            color: COLORS.codex,
            lineWidth: 4,
            title: 'Codex'
        });
        seriesRefs.current.mobula = chart.addLineSeries({
            color: COLORS.mobula,
            lineWidth: 3,
            title: 'Mobula'
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

        // Update all series - show data or empty based on visibility
        ['goldrush', 'codex', 'mobula'].forEach(provider => {
            const isVisible = visibleProviders.includes(provider);
            const data = history.map(h => ({
                time: Math.floor(h.time / 1000),
                value: isVisible ? (h[provider]?.[metricKey] || 0) : 0
            }));
            seriesRefs.current[provider]?.setData(isVisible ? data : []);
        });

        if (history.length > 0) {
            chartRef.current.timeScale().fitContent();
        }
    }, [history, metricKey, visibleProviders]);

    // Get current values for display
    const current = history && history.length > 0 ? history[history.length - 1] : null;

    return (
        <div className="comparison-chart">
            <div className="chart-header">
                {Icon && <Icon size={18} />}
                <span className="chart-title">{title}</span>
                {formula && (
                    <div className="info-tooltip-wrapper">
                        <Info size={14} className="info-icon" />
                        <div className="info-tooltip">{formula}</div>
                    </div>
                )}
            </div>
            <div className="provider-toggles">
                {allProviders.map(p => (
                    <label key={p.key} className="provider-toggle" style={{ color: p.color }}>
                        <input
                            type="checkbox"
                            checked={visibleProviders.includes(p.key)}
                            onChange={() => toggleProvider(p.key)}
                        />
                        <span className="toggle-dot" style={{ background: visibleProviders.includes(p.key) ? p.color : '#555' }} />
                        {p.label}
                    </label>
                ))}
            </div>
            <div className="chart-container" ref={containerRef} />
            <div className="chart-legend">
                {allProviders.filter(p => visibleProviders.includes(p.key)).map(p => (
                    <div key={p.key} className="legend-item" style={{ color: p.color }}>
                        <span className="legend-dot" style={{ background: p.color }} />
                        <span className="legend-name">{p.label}</span>
                        <span className="legend-value">
                            {current?.[p.key]?.[metricKey]?.toFixed(metricKey === 'candlesPerSec' ? 2 : 0)}{unit}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
};

// Latency Comparison Table - p95, Jitter, p99, Event Count
const LatencyComparisonTable = ({ data, icon: Icon }) => {
    const allProviders = [
        { key: 'goldrush', label: 'GoldRush', color: COLORS.goldrush },
        { key: 'codex', label: 'Codex', color: COLORS.codex },
        { key: 'mobula', label: 'Mobula', color: COLORS.mobula }
    ];

    const [visibleProviders, setVisibleProviders] = useState(['goldrush', 'codex', 'mobula']);

    const toggleProvider = (key) => {
        setVisibleProviders(prev =>
            prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key]
        );
    };

    const formatValue = (value, unit = 'ms') => {
        if (value === undefined || value === null) return '—';
        if (value >= 1000) return `${(value / 1000).toFixed(1)} s`;
        return `${Math.round(value).toLocaleString()} ${unit}`;
    };

    const visibleList = allProviders.filter(p => visibleProviders.includes(p.key));

    return (
        <div className="latency-comparison-table">
            <div className="chart-header">
                {Icon && <Icon size={18} />}
                <span className="chart-title">Latency Comparison</span>
                <div className="info-tooltip-wrapper">
                    <Info size={14} className="info-icon" />
                    <div className="info-tooltip">Latency percentiles from Update Pairs stream. Lower is better.</div>
                </div>
            </div>
            <div className="provider-toggles">
                {allProviders.map(p => (
                    <label key={p.key} className="provider-toggle" style={{ color: p.color }}>
                        <input
                            type="checkbox"
                            checked={visibleProviders.includes(p.key)}
                            onChange={() => toggleProvider(p.key)}
                        />
                        <span className="toggle-dot" style={{ background: visibleProviders.includes(p.key) ? p.color : '#555' }} />
                        {p.label}
                    </label>
                ))}
            </div>
            <div className="latency-table">
                {visibleList.map(p => (
                    <div key={p.key} className="latency-column" style={{ borderTopColor: p.color }}>
                        <div className="provider-name" style={{ color: p.color }}>{p.label}</div>
                        <div className="metric-row">
                            <span className="metric-label">p95 Latency</span>
                            <span className="metric-value">{formatValue(data?.[p.key]?.p95)}</span>
                        </div>
                        <div className="metric-row">
                            <span className="metric-label">Jitter (p95 - p50)</span>
                            <span className="metric-value">{formatValue(data?.[p.key]?.jitter)}</span>
                        </div>
                        <div className="metric-row">
                            <span className="metric-label">p99 Latency</span>
                            <span className="metric-value">{formatValue(data?.[p.key]?.p99)}</span>
                        </div>
                        <div className="metric-row">
                            <span className="metric-label">Events</span>
                            <span className="metric-value">{data?.[p.key]?.eventCount?.toLocaleString() || '—'}</span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

// Events Per Interval - Grouped Bar Chart using Recharts
const CandlesPerIntervalChart = ({ history, icon: Icon }) => {
    const allProviders = [
        { key: 'goldrush', label: 'GoldRush', color: '#ef4444' },
        { key: 'codex', label: 'Codex', color: '#3b82f6' },
        { key: 'mobula', label: 'Mobula', color: '#22c55e' }
    ];

    const [visibleProviders, setVisibleProviders] = useState(['goldrush', 'codex', 'mobula']);

    const toggleProvider = (key) => {
        setVisibleProviders(prev =>
            prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key]
        );
    };

    // Each snapshot is now 1 minute - map directly to chart data
    // Filter to last 15 minutes only
    const fifteenMinAgo = Date.now() - (15 * 60 * 1000);
    const recentHistory = history?.filter(h => h.time > fifteenMinAgo) || [];

    // Map snapshots directly to chart data (no grouping needed - each snapshot = 1 minute)
    const chartData = recentHistory.map(h => {
        const time = new Date(h.time);
        const label = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

        return {
            time: label,
            GoldRush: h.goldrush?.intervalEventCount || 0,
            Codex: h.codex?.intervalEventCount || 0,
            Mobula: h.mobula?.intervalEventCount || 0
        };
    });

    return (
        <div className="comparison-chart">
            <div className="chart-header">
                {Icon && <Icon size={18} />}
                <span className="chart-title">Events per Interval</span>
                <div className="info-tooltip-wrapper">
                    <Info size={14} className="info-icon" />
                    <div className="info-tooltip">Event count per 1-minute interval for GoldRush (red) and Codex (blue).</div>
                </div>
            </div>
            <div className="provider-toggles">
                {allProviders.map(p => (
                    <label key={p.key} className="provider-toggle" style={{ color: p.color }}>
                        <input
                            type="checkbox"
                            checked={visibleProviders.includes(p.key)}
                            onChange={() => toggleProvider(p.key)}
                        />
                        <span className="toggle-dot" style={{ background: visibleProviders.includes(p.key) ? p.color : '#555' }} />
                        {p.label}
                    </label>
                ))}
            </div>
            <div style={{ width: '100%', height: 200 }}>
                <ResponsiveContainer>
                    <BarChart data={chartData} barGap={2} barCategoryGap="20%">
                        <XAxis
                            dataKey="time"
                            tick={{ fill: '#666', fontSize: 10 }}
                            axisLine={{ stroke: '#333' }}
                            tickLine={{ stroke: '#333' }}
                        />
                        <YAxis
                            tick={{ fill: '#666', fontSize: 10 }}
                            axisLine={{ stroke: '#333' }}
                            tickLine={{ stroke: '#333' }}
                        />
                        <Tooltip
                            contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 4 }}
                            labelStyle={{ color: '#888' }}
                        />
                        {visibleProviders.includes('goldrush') && (
                            <Bar dataKey="GoldRush" fill="#ef4444" radius={[2, 2, 0, 0]} />
                        )}
                        {visibleProviders.includes('codex') && (
                            <Bar dataKey="Codex" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                        )}
                        {visibleProviders.includes('mobula') && (
                            <Bar dataKey="Mobula" fill="#22c55e" radius={[2, 2, 0, 0]} />
                        )}
                    </BarChart>
                </ResponsiveContainer>
            </div>
            <div className="chart-legend">
                {allProviders.filter(p => visibleProviders.includes(p.key)).map(p => (
                    <div key={p.key} className="legend-item" style={{ color: p.color }}>
                        <span className="legend-dot" style={{ background: p.color }} />
                        <span className="legend-name">{p.label}</span>
                    </div>
                ))}
            </div>
        </div>
    );
};

// Average Latency Bar Chart - Grouped Bar Chart using Recharts
const AvgLatencyBarChart = ({ history, icon: Icon }) => {
    const allProviders = [
        { key: 'goldrush', label: 'GoldRush', color: '#ef4444' },
        { key: 'codex', label: 'Codex', color: '#3b82f6' },
        { key: 'mobula', label: 'Mobula', color: '#22c55e' }
    ];

    const [visibleProviders, setVisibleProviders] = useState(['goldrush', 'codex', 'mobula']);

    const toggleProvider = (key) => {
        setVisibleProviders(prev =>
            prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key]
        );
    };

    // Aggregate latency data into 1-minute bins (matching candle interval)
    // Filter to last 15 minutes only
    const fifteenMinAgo = Date.now() - (15 * 60 * 1000);
    const recentHistory = history?.filter(h => h.time > fifteenMinAgo) || [];

    const groupedData = recentHistory.reduce((acc, h) => {
        const time = new Date(h.time);
        // Round to nearest 1 minute
        time.setSeconds(0);
        time.setMilliseconds(0);

        const label = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

        if (!acc[label]) {
            acc[label] = { grLatency: 0, cxLatency: 0, mbLatency: 0, grCount: 0, cxCount: 0, mbCount: 0 };
        }

        // Only add if there's actual latency data (not 0)
        if (h.goldrush?.avgLatency > 0) {
            acc[label].grLatency += h.goldrush.avgLatency;
            acc[label].grCount += 1;
        }
        if (h.codex?.avgLatency > 0) {
            acc[label].cxLatency += h.codex.avgLatency;
            acc[label].cxCount += 1;
        }
        if (h.mobula?.avgLatency > 0) {
            acc[label].mbLatency += h.mobula.avgLatency;
            acc[label].mbCount += 1;
        }

        return acc;
    }, {}) || {};

    const chartData = Object.keys(groupedData).map(label => {
        const group = groupedData[label];
        // Calculate average latency for the 1-minute bin
        const grVal = group.grCount > 0 ? Math.round(group.grLatency / group.grCount) : 0;
        const cxVal = group.cxCount > 0 ? Math.round(group.cxLatency / group.cxCount) : 0;
        const mbVal = group.mbCount > 0 ? Math.round(group.mbLatency / group.mbCount) : 0;

        return {
            time: label,
            GoldRush: grVal,
            Codex: cxVal,
            Mobula: mbVal
        };
    });

    return (
        <div className="comparison-chart">
            <div className="chart-header">
                {Icon && <Icon size={18} />}
                <span className="chart-title">Average Latency (ms)</span>
                <div className="info-tooltip-wrapper">
                    <Info size={14} className="info-icon" />
                    <div className="info-tooltip">Average latency (Receive Time - Block Time) per 5-minute interval.</div>
                </div>
            </div>
            <div className="provider-toggles">
                {allProviders.map(p => (
                    <label key={p.key} className="provider-toggle" style={{ color: p.color }}>
                        <input
                            type="checkbox"
                            checked={visibleProviders.includes(p.key)}
                            onChange={() => toggleProvider(p.key)}
                        />
                        <span className="toggle-dot" style={{ background: visibleProviders.includes(p.key) ? p.color : '#555' }} />
                        {p.label}
                    </label>
                ))}
            </div>
            <div style={{ width: '100%', height: 200 }}>
                <ResponsiveContainer>
                    <BarChart data={chartData} barGap={2} barCategoryGap="20%">
                        <XAxis
                            dataKey="time"
                            tick={{ fill: '#666', fontSize: 10 }}
                            axisLine={{ stroke: '#333' }}
                            tickLine={{ stroke: '#333' }}
                        />
                        <YAxis
                            tick={{ fill: '#666', fontSize: 10 }}
                            axisLine={{ stroke: '#333' }}
                            tickLine={{ stroke: '#333' }}
                            tickFormatter={(value) => value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`}
                        />
                        <Tooltip
                            contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 4 }}
                            labelStyle={{ color: '#888' }}
                            formatter={(value) => [`${value}ms`, '']}
                        />
                        {visibleProviders.includes('goldrush') && (
                            <Bar dataKey="GoldRush" fill="#ef4444" radius={[2, 2, 0, 0]} />
                        )}
                        {visibleProviders.includes('codex') && (
                            <Bar dataKey="Codex" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                        )}
                        {visibleProviders.includes('mobula') && (
                            <Bar dataKey="Mobula" fill="#22c55e" radius={[2, 2, 0, 0]} />
                        )}
                    </BarChart>
                </ResponsiveContainer>
            </div>
            <div className="chart-legend">
                {allProviders.filter(p => visibleProviders.includes(p.key)).map(p => (
                    <div key={p.key} className="legend-item" style={{ color: p.color }}>
                        <span className="legend-dot" style={{ background: p.color }} />
                        <span className="legend-name">{p.label}</span>
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

    // Live Log Terminal State
    const [logs, setLogs] = useState({ goldrush: [], codex: [], mobula: [] });
    const [isPaused, setIsPaused] = useState(false);
    const grLogRef = useRef(null);
    const cxLogRef = useRef(null);
    const mbLogRef = useRef(null);

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

    // WebSocket for live logs
    const isPausedRef = useRef(isPaused);
    isPausedRef.current = isPaused; // Keep ref in sync with state

    useEffect(() => {
        const WS_URL = import.meta.env.VITE_WS_URL || `ws://${window.location.hostname}:3002`;
        const ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            // console.log("✅ StatsPage WS Connected");
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'LOG_EVENT') {
                    if (!isPausedRef.current) {
                        setLogs(prev => ({
                            ...prev,
                            [data.provider]: [...prev[data.provider], data.data].slice(-100) // Keep last 100
                        }));
                    }
                } else if (data.type === 'RESET') {
                    setLogs({ goldrush: [], codex: [], mobula: [] });
                }
            } catch (e) {
                // Ignore parse errors
            }
        };

        ws.onerror = () => { };
        ws.onclose = () => { };

        return () => ws.close();
    }, []); // Empty dependency array - only connect once

    // Auto-scroll to bottom when new logs arrive
    useEffect(() => {
        if (!isPaused) {
            if (grLogRef.current) grLogRef.current.scrollTop = grLogRef.current.scrollHeight;
            if (cxLogRef.current) cxLogRef.current.scrollTop = cxLogRef.current.scrollHeight;
            if (mbLogRef.current) mbLogRef.current.scrollTop = mbLogRef.current.scrollHeight;
        }
    }, [logs, isPaused]);

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


            {/* 4 Comparison Charts in 2x2 Grid */}
            <div className="comparison-grid">
                <TTFDCard
                    data={metricsHistory.length > 0 ? metricsHistory[metricsHistory.length - 1] : null}
                    icon={Timer}
                />
                <CandlesPerIntervalChart
                    history={metricsHistory}
                    icon={BarChart3}
                />
                <LatencyComparisonTable
                    data={metricsHistory.length > 0 ? metricsHistory[metricsHistory.length - 1] : null}
                    icon={Gauge}
                />
                <AvgLatencyBarChart
                    history={metricsHistory}
                    icon={Activity}
                />
            </div>

            {/* Live Log Terminal */}
            <div className="log-terminal">
                <div className="log-header">
                    <h3>📋 Live Logs</h3>
                    <div className="log-controls">
                        <button
                            className={`log-btn ${isPaused ? 'paused' : ''}`}
                            onClick={() => setIsPaused(!isPaused)}
                        >
                            {isPaused ? '▶ Resume' : '⏸ Pause'}
                        </button>
                        <button
                            className="log-btn clear"
                            onClick={() => setLogs({ goldrush: [], codex: [], mobula: [] })}
                        >
                            🗑 Clear
                        </button>
                    </div>
                </div>
                <div className="log-columns">
                    <div className="log-column">
                        <div className="log-column-header goldrush">GoldRush ({logs.goldrush.length})</div>
                        <div className="log-content" ref={grLogRef}>
                            {logs.goldrush.map((log, i) => (
                                <div key={log.id || `gr-${i}`} className={`log-entry goldrush ${log.eventType === 'RESTART' ? 'system-log' : ''}`}>
                                    <span className="log-event">
                                        #{log.eventNum} {log.eventType}
                                        {log.eventType === 'RESTART' && <span className="log-details"> {log.details}</span>}
                                    </span>
                                    <span className="log-time">{new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                                </div>
                            ))}
                            {logs.goldrush.length === 0 && <div className="log-empty">Waiting for events...</div>}
                        </div>
                    </div>
                    <div className="log-column">
                        <div className="log-column-header codex">Codex ({logs.codex.length})</div>
                        <div className="log-content" ref={cxLogRef}>
                            {logs.codex.map((log, i) => (
                                <div key={log.id || `cx-${i}`} className={`log-entry codex ${log.eventType === 'RESTART' ? 'system-log' : ''}`}>
                                    <span className="log-event">
                                        #{log.eventNum} {log.eventType}
                                        {log.eventType === 'RESTART' && <span className="log-details"> {log.details}</span>}
                                    </span>
                                    <span className="log-time">{new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                                </div>
                            ))}
                            {logs.codex.length === 0 && <div className="log-empty">Waiting for events...</div>}
                        </div>
                    </div>
                    <div className="log-column">
                        <div className="log-column-header mobula">Mobula ({logs.mobula.length})</div>
                        <div className="log-content" ref={mbLogRef}>
                            {logs.mobula.map((log, i) => (
                                <div key={log.id || `mb-${i}`} className={`log-entry mobula ${log.eventType === 'RESTART' ? 'system-log' : ''}`}>
                                    <span className="log-event">
                                        #{log.eventNum} {log.eventType}
                                        {log.eventType === 'RESTART' && <span className="log-details"> {log.details}</span>}
                                    </span>
                                    <span className="log-time">{new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                                </div>
                            ))}
                            {logs.mobula.length === 0 && <div className="log-empty">Waiting for events...</div>}
                        </div>
                    </div>

                </div>
            </div>

            <style>{`
                .stats-page {
                    min-height: 100vh;
                    background: #0a0a0a;
                    color: #fff;
                    padding: 8px;
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
                
                .stat-card {
                    background: #111;
                    border: 1px solid #222;
                    border-radius: 12px;
                    padding: 16px;
                }
                
                /* TTFD Card - Two Column Layout */
                .ttfd-card .ttfd-columns {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 16px;
                }
                
                .ttfd-column {
                    background: #0a0a0a;
                    border-radius: 12px;
                    padding: 16px;
                    border: 1px solid #222;
                }
                
                .ttfd-column.goldrush {
                    border-left: 3px solid #ef4444;
                }
                
                .ttfd-column.codex {
                    border-left: 3px solid #3b82f6;
                }
                
                .ttfd-provider-header {
                    font-size: 1.1rem;
                    font-weight: 700;
                    margin-bottom: 16px;
                    padding-bottom: 8px;
                    border-bottom: 1px solid #222;
                }
                
                .ttfd-metrics {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }
                
                .ttfd-metric {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                
                .ttfd-label {
                    color: #888;
                    font-size: 0.85rem;
                    font-weight: 500;
                }
                
                .ttfd-value {
                    font-size: 1.4rem;
                    font-weight: 700;
                    font-family: 'Monaco', monospace;
                }
                
                .stat-card-header {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 16px;
                    color: #fff;
                    font-weight: 600;
                    font-size: 1rem;
                }
                
                .stat-card-body {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }
                
                .stat-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 16px 20px;
                    background: #0a0a0a;
                    border-radius: 10px;
                    border-left: 4px solid;
                }
                
                .stat-label {
                    color: #888;
                    font-size: 0.95rem;
                    font-weight: 500;
                }
                
                .stat-value {
                    font-size: 1.3rem;
                    font-weight: 700;
                    font-family: 'Monaco', monospace;
                }
                
                .comparison-chart {
                    background: #111;
                    border: 1px solid #222;
                    border-radius: 12px;
                    padding: 12px 16px 8px 16px;
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
                
                .info-tooltip-wrapper {
                    position: relative;
                    display: inline-flex;
                    margin-left: auto;
                }
                
                .info-icon {
                    color: #666;
                    cursor: help;
                    transition: color 0.2s;
                }
                
                .info-icon:hover {
                    color: #3b82f6;
                }
                
                .info-tooltip {
                    position: absolute;
                    top: 100%;
                    right: 0;
                    margin-top: 8px;
                    background: #1a1a1a;
                    border: 1px solid #333;
                    border-radius: 8px;
                    padding: 10px 14px;
                    font-size: 0.75rem;
                    font-weight: 400;
                    color: #aaa;
                    white-space: nowrap;
                    opacity: 0;
                    visibility: hidden;
                    transition: all 0.2s;
                    z-index: 100;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                }
                
                .info-tooltip-wrapper:hover .info-tooltip {
                    opacity: 1;
                    visibility: visible;
                }
                
                .chart-container {
                    width: 100%;
                    border-radius: 8px;
                    overflow: hidden;
                }
                
                .chart-legend {
                    display: flex;
                    justify-content: space-around;
                    margin-top: 8px;
                    padding: 8px 0 0 0;
                    border-top: 1px solid #222;
                }
                
                .provider-toggles {
                    display: flex;
                    gap: 16px;
                    justify-content: center;
                    margin-bottom: 8px;
                    padding: 8px;
                    background: rgba(255,255,255,0.03);
                    border-radius: 6px;
                }
                
                .provider-toggle {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    cursor: pointer;
                    font-size: 0.85rem;
                    user-select: none;
                }
                
                .provider-toggle input[type="checkbox"] {
                    display: none;
                }
                
                .toggle-dot {
                    width: 10px;
                    height: 10px;
                    border-radius: 50%;
                    transition: background 0.2s;
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
                
                .latency-comparison-table {
                    background: #111;
                    border: 1px solid #222;
                    border-radius: 12px;
                    padding: 16px;
                }
                
                .latency-table {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 12px;
                    margin-top: 12px;
                }
                
                .latency-column {
                    background: #0a0a0a;
                    border-radius: 8px;
                    padding: 16px;
                    border-top: 3px solid;
                }
                
                .provider-name {
                    font-weight: 700;
                    font-size: 0.9rem;
                    margin-bottom: 14px;
                    padding-bottom: 10px;
                    border-bottom: 1px solid #222;
                }
                
                .metric-row {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    margin-bottom: 12px;
                }
                
                .metric-label {
                    color: #666;
                    font-size: 0.75rem;
                    font-weight: 500;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                
                .metric-value {
                    color: #eab308;
                    font-size: 1.1rem;
                    font-weight: 700;
                    font-family: 'Monaco', monospace;
                }
                
                @media (max-width: 900px) {
                    .comparison-grid {
                        grid-template-columns: 1fr;
                    }
                    .latency-table {
                        grid-template-columns: 1fr;
                    }
                }

                /* Log Terminal Styles */
                .log-terminal {
                    background: #111;
                    border: 1px solid #333;
                    border-radius: 8px;
                    margin-top: 16px;
                    overflow: hidden;
                }
                
                .log-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 12px 16px;
                    background: #1a1a1a;
                    border-bottom: 1px solid #333;
                }
                
                .log-header h3 {
                    margin: 0;
                    font-size: 14px;
                    color: #fff;
                }
                
                .log-controls {
                    display: flex;
                    gap: 8px;
                }
                
                .log-btn {
                    padding: 6px 12px;
                    font-size: 12px;
                    border: 1px solid #444;
                    border-radius: 4px;
                    background: #222;
                    color: #fff;
                    cursor: pointer;
                    transition: all 0.2s;
                }
                
                .log-btn:hover {
                    background: #333;
                }
                
                .log-btn.paused {
                    background: #2563eb;
                    border-color: #3b82f6;
                }
                
                .log-btn.clear {
                    background: #7f1d1d;
                    border-color: #ef4444;
                }
                
                .log-columns {
                    display: grid;
                    grid-template-columns: 1fr 1fr 1fr;
                    gap: 0;
                }
                
                .log-column {
                    border-right: 1px solid #333;
                }
                
                .log-column:last-child {
                    border-right: none;
                }
                
                .log-column-header {
                    padding: 8px 12px;
                    font-size: 12px;
                    font-weight: 600;
                    background: #1a1a1a;
                    border-bottom: 1px solid #333;
                }
                
                .log-column-header.goldrush {
                    color: #ef4444;
                }
                
                .log-column-header.codex {
                    color: #3b82f6;
                }
                
                .log-column-header.mobula {
                    color: #22c55e;
                }
                
                .log-content {
                    height: 200px;
                    overflow-y: auto;
                    font-family: 'Monaco', 'Menlo', monospace;
                    font-size: 11px;
                    padding: 8px;
                }
                
                .log-entry {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                    padding: 4px 0;
                    border-bottom: 1px solid #222;
                }

                .log-entry.system-log {
                    background: rgba(234, 179, 8, 0.1);
                    border-left: 3px solid #eab308;
                    padding-left: 8px;
                    margin: 4px 0;
                    width: 100%;
                }

                .log-details {
                    color: #eab308;
                    font-weight: 600;
                    margin-left: 4px;
                }
                
                .log-entry.goldrush .log-event {
                    color: #ef4444;
                }
                
                .log-entry.codex .log-event {
                    color: #3b82f6;
                }
                
                .log-entry.mobula .log-event {
                    color: #22c55e;
                }
                
                .log-event {
                    font-weight: 600;
                }
                
                .log-details {
                    color: #888;
                }
                
                .log-time {
                    color: #666;
                    font-size: 10px;
                }
                
                .log-latency {
                    color: #f59e0b;
                    font-size: 10px;
                }
                
                .log-empty {
                    color: #555;
                    text-align: center;
                    padding: 40px;
                    font-style: italic;
                }
                
                @media (max-width: 600px) {
                    .log-columns {
                        grid-template-columns: 1fr;
                    }
                }
            `}</style>
        </div >
    );
}

export default StatsPage;
