import React from 'react';
import Chart from './Chart';
import TradeList from './TradeList';
import { TrendingUp, Activity, DollarSign, Zap, Database } from 'lucide-react';

export default function Dashboard({ state }) {
    // Determine active pair
    const activePair = Object.keys(state.goldrush.ticks)[0] || 'VIRTUAL-USD';
    const goldrushTick = state.goldrush.ticks[activePair];
    const codexTick = state.codex.ticks[activePair];

    // Calculate Totals
    const totalGoldRushPnL = state.goldrush.trades.reduce((acc, t) => acc + (Number(t.pnl) || 0), 0);
    const totalCodexPnL = state.codex.trades.reduce((acc, t) => acc + (Number(t.pnl) || 0), 0);

    return (
        <div className="grid grid-cols-2 gap-3 h-[calc(100vh-140px)]">
            {/* LEFT COLUMN: GOLDRUSH (FAST) */}
            <div className="flex flex-col gap-3">
                <div className="glass-card flex-1 rounded-xl p-4 relative overflow-hidden border-2 border-primary/20 shadow-[0_0_50px_rgba(74,222,128,0.1)]">
                    <div className="absolute top-4 left-4 z-10 flex flex-col gap-1">
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
                    {/* Chart Component */}
                    <Chart data={goldrushTick} />
                </div>

                <div className="h-2/5 glass-card rounded-xl p-0 overflow-hidden flex flex-col border border-primary/10">
                    <TradeList trades={state.goldrush.trades} mode="fast" />
                </div>
            </div>

            {/* RIGHT COLUMN: CODEX (SLOW) */}
            <div className="flex flex-col gap-3">
                <div className="glass-card flex-1 rounded-xl p-4 relative overflow-hidden border-2 border-white/5 opacity-80">
                    <div className="absolute top-4 left-4 z-10 flex flex-col gap-1">
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
                    {/* Chart Component */}
                    <Chart data={codexTick} />
                </div>

                <div className="h-2/5 glass-card rounded-xl p-0 overflow-hidden flex flex-col border border-white/5">
                    <TradeList trades={state.codex.trades} mode="slow" />
                </div>
            </div>
        </div>
    );
}
