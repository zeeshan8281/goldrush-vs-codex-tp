export default function TradeList({ trades, mode = 'fast' }) {
    return (
        <div className="flex flex-col h-full">
            <div className="p-3 border-b border-white/5 bg-black/10 flex justify-between items-center">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                    {mode === 'fast' ? '⚡ GoldRush Executions' : '🐢 Codex Executions'}
                </h3>
                <span className="text-xs text-muted-foreground">{trades.length} Trades</span>
            </div>
            <div className="flex-1 overflow-auto">
                <table className="w-full text-left text-sm">
                    <thead className="bg-white/5 text-muted-foreground sticky top-0 backdrop-blur-md">
                        <tr>
                            <th className="p-3 font-medium">Time</th>
                            <th className="p-3 font-medium">Type</th>
                            <th className="p-3 font-medium">Entry</th>
                            <th className="p-3 font-medium">Exit</th>
                            <th className="p-3 font-medium">Latency</th>
                            <th className="p-3 font-medium">P&L</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                        {trades.map((trade) => {
                            const isWin = trade.pnl > 0;
                            return (
                                <tr key={trade.id} className="hover:bg-white/5 transition-colors">
                                    <td className="p-3 font-mono text-xs text-muted-foreground">
                                        {new Date(trade.timestamp).toLocaleTimeString()}
                                    </td>
                                    <td className={`p-3 uppercase text-xs font-bold ${trade.side === 'LONG' ? 'text-green-400' : 'text-red-400'}`}>
                                        {trade.side}
                                    </td>
                                    <td className="p-3 font-mono text-xs text-muted-foreground">
                                        ${trade.entryPrice?.toFixed(4)}
                                    </td>
                                    <td className="p-3 font-mono text-xs text-secondary-foreground">
                                        ${trade.exitPrice?.toFixed(4)}
                                    </td>
                                    <td className={`p-3 font-mono text-xs ${mode === 'fast' ? 'text-yellow-400' : 'text-red-400'}`}>
                                        {trade.latency || (trade.latencyAdvantageMs ? `+${trade.latencyAdvantageMs}ms` : 'N/A')}
                                    </td>
                                    <td className={`p-3 font-mono font-bold ${isWin ? 'text-green-400' : 'text-gray-500'}`}>
                                        {isWin ? '+' : ''}${Number(trade.pnl || 0).toFixed(2)}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>

                {trades.length === 0 && (
                    <div className="text-center p-8 text-muted-foreground text-sm">
                        Waiting for signals...
                    </div>
                )}
            </div>
        </div>
    );
}
