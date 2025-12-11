import React from 'react';
import { Bot, ArrowUpRight, ArrowDownRight, Target, ShieldAlert, Activity } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function IdeasPanel({ ideas }) {
    return (
        <div className="flex flex-col h-full bg-card/20 border-l border-white/5 backdrop-blur-sm">
            <div className="p-4 border-b border-white/5 flex items-center justify-between">
                <h3 className="font-bold flex items-center gap-2">
                    <Bot className="w-5 h-5 text-purple-400" />
                    CODEX INTELLIGENCE
                </h3>
                <span className="text-[10px] bg-purple-500/10 text-purple-400 px-2 py-0.5 rounded-full border border-purple-500/20">
                    AI ACTIVE
                </span>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                <AnimatePresence>
                    {ideas.map((idea) => (
                        <motion.div
                            key={idea.id}
                            initial={{ opacity: 0, x: 20, scale: 0.95 }}
                            animate={{ opacity: 1, x: 0, scale: 1 }}
                            exit={{ opacity: 0 }}
                            className={`p-4 rounded-xl border ${idea.side === 'long'
                                ? 'bg-green-500/5 border-green-500/20 shadow-[0_0_15px_rgba(34,197,94,0.1)]'
                                : 'bg-red-500/5 border-red-500/20 shadow-[0_0_15px_rgba(239,68,68,0.1)]'
                                }`}
                        >
                            <div className="flex justify-between items-center mb-3">
                                <div className="flex items-center gap-2">
                                    <span className={`font-bold text-sm tracking-wide ${idea.side === 'long' ? 'text-green-400' : 'text-red-400'}`}>
                                        {idea.side.toUpperCase()} {idea.pair}
                                    </span>
                                    {idea.side === 'long'
                                        ? <ArrowUpRight className="w-4 h-4 text-green-400" />
                                        : <ArrowDownRight className="w-4 h-4 text-red-400" />
                                    }
                                </div>
                                <span className="text-[10px] text-muted-foreground">
                                    {new Date(idea.timestamp).toLocaleTimeString()}
                                </span>
                            </div>

                            <p className="text-sm text-gray-300 leading-relaxed mb-4 font-light border-l-2 border-white/10 pl-3">
                                {idea.rationale}
                            </p>

                            <div className="grid grid-cols-2 gap-2 text-xs">
                                <div className="bg-black/20 rounded p-2 flex items-center gap-2">
                                    <Target className="w-3 h-3 text-blue-400" />
                                    <span className="text-muted-foreground">Target:</span>
                                    <span className="font-mono text-blue-400">+{idea.tpPct}%</span>
                                </div>
                                <div className="bg-black/20 rounded p-2 flex items-center gap-2">
                                    <ShieldAlert className="w-3 h-3 text-orange-400" />
                                    <span className="text-muted-foreground">Stop:</span>
                                    <span className="font-mono text-orange-400">-{idea.stopPct}%</span>
                                </div>
                            </div>
                        </motion.div>
                    ))}
                </AnimatePresence>

                {ideas.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-50">
                        <Activity className="w-8 h-8 mb-2 animate-pulse" />
                        <p className="text-sm">Waiting for market signals...</p>
                    </div>
                )}
            </div>
        </div>
    );
}
