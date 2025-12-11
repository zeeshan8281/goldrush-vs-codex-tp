export default function TradeList({ trades, mode = 'fast' }) {
    return (
        <div className="flex flex-col h-full min-h-0">
            <div className="p-3 border-b border-white/5 bg-black/40 backdrop-blur flex justify-between items-center shrink-0">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                    {mode === 'fast' ? (
                        <><span>⚡</span> GoldRush Executions</>
                    ) : (
                        <><span>🐢</span> Codex Executions</>
                    )}
                </h3>
                <span className="text-xs text-muted-foreground bg-white/5 px-2 py-0.5 rounded-full">{trades.length} Trades</span>
            </div>

            <div className="flex-1 overflow-y-auto min-h-0 custom-scrollbar">
                <table className="w-full text-left text-sm relative">
                    <thead className="bg-black/20 text-muted-foreground sticky top-0 z-10 backdrop-blur-sm shadow-sm">
                        <tr>
                            <th className="p-3 font-medium text-xs uppercase tracking-wider">Time</th>
                            <th className="p-3 font-medium text-xs uppercase tracking-wider">Type</th>
                            <th className="p-3 font-medium text-xs uppercase tracking-wider">Entry</th>
                            <th className="p-3 font-medium text-xs uppercase tracking-wider">Exit</th>
                            <th className="p-3 font-medium text-xs uppercase tracking-wider">Latency</th>
                            <th className="p-3 font-medium text-xs uppercase tracking-wider">P&L</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 text-xs">
                        {trades.map((trade) => {
                            const isWin = Number(trade.pnl) > 0;
                            return (
                                <tr key={trade.id} className="hover:bg-white/5 transition-colors group">
                                    <td className="p-3 font-mono text-muted-foreground opacity-70 group-hover:opacity-100">
                                        {new Date(trade.timestamp).toLocaleTimeString()}
                                    </td>
                                    <td className={`p-3 font-bold ${trade.side === 'LONG' ? 'text-green-400' : 'text-red-400'}`}>
                                        {trade.side}
                                    </td>
                                    <td className="p-3 font-mono opacity-80">
                                        ${Number(trade.entryPrice).toFixed(4)}
                                    </td>
                                    <td className="p-3 font-mono opacity-80">
                                        ${Number(trade.exitPrice).toFixed(4)}
                                    </td>
                                    <td className={`p-3 font-mono ${mode === 'fast' ? 'text-yellow-400' : 'text-red-400'}`}>
                                        {trade.latency || 'N/A'}
                                    </td>
                                    <td className={`p-3 font-mono font-bold ${isWin ? 'text-green-400' : 'text-red-400'}`}>
                                        {isWin ? '+' : ''}${Number(trade.pnl || 0).toFixed(2)}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>

                {trades.length === 0 && (
                    <div className="text-center p-8 text-muted-foreground text-sm opacity-50 flex flex-col items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-white/20 animate-pulse" />
                        Waiting for signals...
                    </div>
                )}
            </div>
        </div>
    );
}
