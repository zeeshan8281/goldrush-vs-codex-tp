import React, { useEffect, useRef } from 'react';
import { createChart, ColorType } from 'lightweight-charts';

export default function Chart({ data }) {
    const chartContainerRef = useRef();
    const seriesRef = useRef(null);
    const chartRef = useRef(null);

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
            },
        });

        // Use addAreaSeries method
        const newSeries = chart.addAreaSeries({
            lineColor: '#22c55e',
            topColor: 'rgba(34, 197, 94, 0.4)',
            bottomColor: 'rgba(34, 197, 94, 0.0)',
            lineWidth: 2,
        });

        seriesRef.current = newSeries;
        chartRef.current = chart;

        // Handle Resize
        const handleResize = () => {
            if (chartContainerRef.current) {
                chart.applyOptions({ width: chartContainerRef.current.clientWidth });
            }
        };
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            chart.remove();
        };
    }, []);

    useEffect(() => {
        if (seriesRef.current && data) {
            try {
                seriesRef.current.update({
                    time: Math.floor(data.timestamp / 1000),
                    value: data.price
                });
            } catch (e) {
                // Ignore duplicate time errors
            }
        }
    }, [data]);

    return <div ref={chartContainerRef} className="w-full h-full" />;
}
