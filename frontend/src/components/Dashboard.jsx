import React from 'react';
import Chart from './Chart';
import TradeList from './TradeList';
import TerminalLog from './TerminalLog';
import { Zap, Database, TrendingUp, TrendingDown } from 'lucide-react';

export default function Dashboard({ state }) {
    // Determine active pair
    const activePair = Object.keys(state.goldrush.ticks)[0] || 'VIRTUAL-USD';
    const goldrushTick = state.goldrush.ticks[activePair];
    const codexTick = state.codex.ticks[activePair];

    // Extract candles arrays for charts
    const goldrushCandles = goldrushTick?.candles || [];
    const codexCandles = codexTick?.candles || [];

    // Extract logs
    const goldrushLogs = state.goldrush.logs || [];
    const codexLogs = state.codex.logs || [];

    // Calculate Cumulative Totals
    const totalGoldRushPnL = state.goldrush.trades.reduce((acc, t) => acc + (Number(t.pnl) || 0), 0);
    const totalCodexPnL = state.codex.trades.reduce((acc, t) => acc + (Number(t.pnl) || 0), 0);

    // Trade counts
    const goldrushTradeCount = state.goldrush.trades.length;
    const codexTradeCount = state.codex.trades.length;

    // Helper for PnL display
    const formatPnL = (pnl) => {
        const isPositive = pnl >= 0;
        return {
            text: `${isPositive ? '+' : ''}$${pnl.toFixed(2)}`,
            color: isPositive ? 'text-green-400' : 'text-red-400',
            bgColor: isPositive ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30',
            icon: isPositive ? TrendingUp : TrendingDown
        };
    };

    const grPnL = formatPnL(totalGoldRushPnL);
    const cxPnL = formatPnL(totalCodexPnL);

    return (
        // MAIN GRID: 2 Columns, Fixed Height
        <div className="grid grid-cols-2 gap-4 h-[calc(100vh-120px)] p-1">

            {/* --- LEFT COLUMN (GOLDRUSH) --- */}
            <div className="grid grid-rows-[45%_30%_25%] gap-3 h-full">

                {/* 1. TOP: CHART */}
                <div className="glass-card rounded-xl border-2 border-primary/20 shadow-[0_0_50px_rgba(74,222,128,0.1)] relative overflow-hidden">
                    {/* Header Overlay with background */}
                    <div className="absolute top-0 left-0 right-0 z-20 p-4 pr-20 bg-gradient-to-b from-black/80 via-black/40 to-transparent pointer-events-none">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <Zap className="w-5 h-5 text-yellow-400" />
                                <h2 className="text-primary font-bold text-lg tracking-wide">GOLDRUSH API</h2>
                                <span className="bg-primary/20 text-primary text-[10px] font-bold px-2 py-0.5 rounded tracking-wider">LIVE (Verified)</span>
                            </div>
                            {/* Cumulative PnL Badge */}
                            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${grPnL.bgColor}`}>
                                <grPnL.icon className={`w-4 h-4 ${grPnL.color}`} />
                                <div className="text-right">
                                    <div className={`text-lg font-bold font-mono ${grPnL.color}`}>{grPnL.text}</div>
                                    <div className="text-[10px] text-gray-400">{goldrushTradeCount} trades</div>
                                </div>
                            </div>
                        </div>
                        <div className="flex items-baseline gap-3 mt-1">
                            <div className="text-3xl font-mono font-light text-white">
                                ${goldrushTick?.price?.toFixed(8) || '0.00000000'}
                            </div>
                        </div>
                    </div>

                    {/* Chart Canvas Container */}
                    <div className="absolute inset-0 top-0 w-full h-full z-10">
                        <Chart candles={goldrushCandles} color="#22c55e" />
                    </div>
                </div>

                {/* 2. MIDDLE: TRADES */}
                <div className="glass-card rounded-xl border border-primary/10 relative overflow-hidden">
                    <div className="absolute inset-0 w-full h-full">
                        <TradeList trades={state.goldrush.trades} mode="fast" totalPnL={totalGoldRushPnL} />
                    </div>
                </div>

                {/* 3. BOTTOM: TERMINAL LOG */}
                <div className="overflow-hidden">
                    <TerminalLog logs={goldrushLogs} mode="fast" />
                </div>
            </div>


            {/* --- RIGHT COLUMN (CODEX) --- */}
            <div className="grid grid-rows-[45%_30%_25%] gap-3 h-full">

                {/* 1. TOP: CHART */}
                <div className="glass-card rounded-xl border-2 border-white/5 opacity-80 relative overflow-hidden">
                    {/* Header Overlay with background */}
                    <div className="absolute top-0 left-0 right-0 z-20 p-4 pr-20 bg-gradient-to-b from-black/80 via-black/40 to-transparent pointer-events-none">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <Database className="w-5 h-5 text-gray-400" />
                                <h2 className="text-muted-foreground font-bold text-lg tracking-wide">CODEX API</h2>
                                <span className="bg-white/10 text-muted-foreground text-[10px] font-bold px-2 py-0.5 rounded tracking-wider">LATENCY: Live</span>
                            </div>
                            {/* Cumulative PnL Badge */}
                            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${cxPnL.bgColor}`}>
                                <cxPnL.icon className={`w-4 h-4 ${cxPnL.color}`} />
                                <div className="text-right">
                                    <div className={`text-lg font-bold font-mono ${cxPnL.color}`}>{cxPnL.text}</div>
                                    <div className="text-[10px] text-gray-400">{codexTradeCount} trades</div>
                                </div>
                            </div>
                        </div>
                        <div className="flex items-baseline gap-3 mt-1">
                            <div className="text-3xl font-mono font-light text-muted-foreground">
                                ${codexTick?.price?.toFixed(8) || '0.00000000'}
                            </div>
                        </div>
                    </div>

                    {/* Chart Canvas Container */}
                    <div className="absolute inset-0 top-0 w-full h-full z-10">
                        <Chart candles={codexCandles} color="#6366f1" />
                    </div>
                </div>

                {/* 2. MIDDLE: TRADES */}
                <div className="glass-card rounded-xl border border-white/5 relative overflow-hidden">
                    <div className="absolute inset-0 w-full h-full">
                        <TradeList trades={state.codex.trades} mode="slow" totalPnL={totalCodexPnL} />
                    </div>
                </div>

                {/* 3. BOTTOM: TERMINAL LOG */}
                <div className="overflow-hidden">
                    <TerminalLog logs={codexLogs} mode="slow" />
                </div>
            </div>

        </div>
    );
}
