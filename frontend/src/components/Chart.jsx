import React, { useEffect, useRef } from 'react';
import { createChart, ColorType } from 'lightweight-charts';

export default function Chart({ data }) {
    const chartContainerRef = useRef();
    const chartRef = useRef(null);
    const seriesRef = useRef(null);

    // Track the last timestamp we successfully plotted to handle 'update' vs 'append'
    const lastTimeRef = useRef(0);

    // 1. Initialize Chart (Once)
    useEffect(() => {
        if (!chartContainerRef.current) return;

        const chart = createChart(chartContainerRef.current, {
            layout: {
                background: { type: ColorType.Solid, color: 'transparent' },
                textColor: '#A1A1AA',
            },
            grid: {
                vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
                horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
            },
            width: chartContainerRef.current.clientWidth,
            height: chartContainerRef.current.clientHeight,
            timeScale: {
                timeVisible: true,
                secondsVisible: true,
                borderColor: 'rgba(255, 255, 255, 0.1)',
                rightOffset: 5,
            },
            rightPriceScale: {
                borderColor: 'rgba(255, 255, 255, 0.1)',
                scaleMargins: {
                    top: 0.05,
                    bottom: 0.05,
                },
                autoScale: true,
            },
            crosshair: {
                vertLine: { labelBackgroundColor: '#22c55e' },
                horzLine: { labelBackgroundColor: '#22c55e' },
            }
        });

        const newSeries = chart.addAreaSeries({
            lineColor: '#22c55e',
            topColor: 'rgba(34, 197, 94, 0.4)',
            bottomColor: 'rgba(34, 197, 94, 0.0)',
            lineWidth: 2,
            priceFormat: {
                type: 'price',
                precision: 6,
                minMove: 0.000001,
            },
        });

        seriesRef.current = newSeries;
        chartRef.current = chart;

        // Resize Observer (Keep this as it solved layout issues)
        const resizeObserver = new ResizeObserver(entries => {
            if (entries.length === 0 || !entries[0].contentRect) return;
            const { width, height } = entries[0].contentRect;
            chart.applyOptions({ width, height });
        });
        resizeObserver.observe(chartContainerRef.current);

        return () => {
            resizeObserver.disconnect();
            chart.remove();
        };
    }, []);

    // 2. Handle Data Updates
    useEffect(() => {
        if (seriesRef.current && data && data.price) {
            try {
                // Convert ms to seconds
                const timeInSeconds = Math.floor(data.timestamp / 1000);

                // Logic: 
                // lightweight-charts 'update()' handles adding NEW bars OR updating the LAST bar
                // if the time is the same. It is smart.
                // We just feed it the point.

                seriesRef.current.update({
                    time: timeInSeconds,
                    value: data.price
                });

                lastTimeRef.current = timeInSeconds;

            } catch (e) {
                // If specific error occurs (e.g. older time), ignore it
                // console.warn("Chart Update Error:", e);
            }
        }
    }, [data]);

    return <div ref={chartContainerRef} className="w-full h-full" />;
}
