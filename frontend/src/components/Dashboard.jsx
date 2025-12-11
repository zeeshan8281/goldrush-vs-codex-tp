import React from 'react';
import Chart from './Chart';
import TradeList from './TradeList';
import { Zap, Database } from 'lucide-react';

export default function Dashboard({ state }) {
    // Determine active pair
    const activePair = Object.keys(state.goldrush.ticks)[0] || 'VIRTUAL-USD';
    const goldrushTick = state.goldrush.ticks[activePair];
    const codexTick = state.codex.ticks[activePair];

    // Calculate Totals
    const totalGoldRushPnL = state.goldrush.trades.reduce((acc, t) => acc + (Number(t.pnl) || 0), 0);
    const totalCodexPnL = state.codex.trades.reduce((acc, t) => acc + (Number(t.pnl) || 0), 0);

    return (
        // MAIN GRID: 2 Columns, Fixed Height
        <div className="grid grid-cols-2 gap-4 h-[calc(100vh-120px)] p-1">

            {/* --- LEFT COLUMN (GOLDRUSH) --- */}
            <div className="grid grid-rows-[60%_40%] gap-4 h-full">

                {/* 1. TOP: CHART (Strict 60% Height) */}
                <div className="glass-card rounded-xl border-2 border-primary/20 shadow-[0_0_50px_rgba(74,222,128,0.1)] relative overflow-hidden">
                    {/* Header Overlay */}
                    <div className="absolute top-4 left-4 z-20 flex flex-col gap-1 pointer-events-none">
                        <div className="flex items-center gap-2">
                            <Zap className="w-5 h-5 text-yellow-400" />
                            <h2 className="text-primary font-bold text-lg tracking-wide">GOLDRUSH API</h2>
                            <span className="bg-primary/20 text-primary text-[10px] font-bold px-2 py-0.5 rounded tracking-wider">LIVE STREAM</span>
                        </div>
                        <div className="flex items-baseline gap-3">
                            <div className="text-3xl font-mono font-light text-white">
                                ${goldrushTick?.price?.toFixed(4) || '0.0000'}
                            </div>
                            <div className="text-sm font-bold text-green-400 bg-green-500/10 px-2 py-1 rounded border border-green-500/20">
                                NET PnL: +${totalGoldRushPnL.toFixed(2)}
                            </div>
                        </div>
                    </div>

                    {/* Chart Canvas Container - Absolute to fill parent exactly */}
                    <div className="absolute inset-0 top-0 w-full h-full z-10">
                        <Chart data={goldrushTick} />
                    </div>
                </div>

                {/* 2. BOTTOM: TRADES (Strict 40% Height) */}
                <div className="glass-card rounded-xl border border-primary/10 relative overflow-hidden">
                    <div className="absolute inset-0 w-full h-full">
                        <TradeList trades={state.goldrush.trades} mode="fast" />
                    </div>
                </div>
            </div>


            {/* --- RIGHT COLUMN (CODEX) --- */}
            <div className="grid grid-rows-[60%_40%] gap-4 h-full">

                {/* 1. TOP: CHART (Strict 60% Height) */}
                <div className="glass-card rounded-xl border-2 border-white/5 opacity-80 relative overflow-hidden">
                    {/* Header Overlay */}
                    <div className="absolute top-4 left-4 z-20 flex flex-col gap-1 pointer-events-none">
                        <div className="flex items-center gap-2">
                            <Database className="w-5 h-5 text-gray-400" />
                            <h2 className="text-muted-foreground font-bold text-lg tracking-wide">CODEX API</h2>
                            <span className="bg-white/10 text-muted-foreground text-[10px] font-bold px-2 py-0.5 rounded tracking-wider">LATENCY: {codexTick?.latency || '...'}ms</span>
                        </div>
                        <div className="flex items-baseline gap-3">
                            <div className="text-3xl font-mono font-light text-muted-foreground">
                                ${codexTick?.price?.toFixed(4) || '0.0000'}
                            </div>
                            <div className="text-sm font-bold text-gray-500 bg-gray-500/10 px-2 py-1 rounded border border-gray-500/20">
                                NET PnL: ${totalCodexPnL.toFixed(2)}
                            </div>
                        </div>
                    </div>

                    {/* Chart Canvas Container */}
                    <div className="absolute inset-0 top-0 w-full h-full z-10">
                        <Chart data={codexTick} />
                    </div>
                </div>

                {/* 2. BOTTOM: TRADES (Strict 40% Height) */}
                <div className="glass-card rounded-xl border border-white/5 relative overflow-hidden">
                    <div className="absolute inset-0 w-full h-full">
                        <TradeList trades={state.codex.trades} mode="slow" />
                    </div>
                </div>
            </div>

        </div>
    );
}
