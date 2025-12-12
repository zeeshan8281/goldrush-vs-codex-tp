import { useRef, useEffect } from 'react';

export default function TerminalLog({ logs = [], mode = 'fast' }) {
    const scrollRef = useRef(null);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [logs]);

    const modeColor = mode === 'fast' ? 'text-green-400' : 'text-purple-400';
    const modeLabel = mode === 'fast' ? 'GOLDRUSH' : 'CODEX';

    return (
        <div className="flex flex-col h-full min-h-0 bg-black/60 rounded-lg border border-white/10 overflow-hidden">
            <div className="px-3 py-2 border-b border-white/10 bg-black/40 flex items-center gap-2 shrink-0">
                <div className={`w-2 h-2 rounded-full ${mode === 'fast' ? 'bg-green-400' : 'bg-purple-400'} animate-pulse`} />
                <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                    {modeLabel} Stream
                </span>
            </div>

            <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto min-h-0 p-2 font-mono text-[11px] leading-relaxed custom-scrollbar"
            >
                {logs.length === 0 ? (
                    <div className="text-muted-foreground opacity-50 text-center py-4">
                        Waiting for data...
                    </div>
                ) : (
                    logs.map((log, i) => (
                        <div key={i} className="flex gap-2 hover:bg-white/5 px-1 rounded">
                            <span className="text-muted-foreground opacity-50 shrink-0">
                                {log.time}
                            </span>
                            <span className={modeColor}>{log.type}</span>
                            <span className="text-white/80">{log.message}</span>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
