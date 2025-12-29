import { useRef, useEffect } from 'react';

export default function TerminalLog({ logs = [], mode = 'fast' }) {
    const scrollRef = useRef(null);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [logs]);

    let modeColor, modeLabel, indicatorColor;

    if (mode === 'fast') {
        modeColor = 'text-green-400';
        modeLabel = 'GOLDRUSH';
        indicatorColor = 'bg-green-400';
    } else if (mode === 'gecko') {
        modeColor = 'text-emerald-400';
        modeLabel = 'GECKO';
        indicatorColor = 'bg-emerald-400';
    } else {
        modeColor = 'text-purple-400';
        modeLabel = 'CODEX';
        indicatorColor = 'bg-purple-400';
    }

    return (
        <div className="flex flex-col h-full min-h-0 bg-black/60 rounded-lg border border-white/10 overflow-hidden">
            <div className="px-3 py-2 border-b border-white/10 bg-black/40 flex items-center gap-2 shrink-0">
                <div className={`w-2 h-2 rounded-full ${indicatorColor} animate-pulse`} />
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
