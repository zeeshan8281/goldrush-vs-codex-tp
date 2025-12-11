import React, { useEffect, useRef, memo } from 'react';
import { createChart, ColorType } from 'lightweight-charts';

/**
 * Reusable Chart Component for real-time price visualization
 * @param {Object} data - { price: number, timestamp: number (ms) }
 * @param {string} color - Primary color for the chart line (default: green)
 */
function Chart({ data, color = '#22c55e' }) {
    const containerRef = useRef(null);
    const chartRef = useRef(null);
    const seriesRef = useRef(null);
    const lastTimeRef = useRef(0);

    // Initialize chart ONCE on mount
    useEffect(() => {
        if (!containerRef.current) return;

        // Create chart instance
        const chart = createChart(containerRef.current, {
            layout: {
                background: { type: ColorType.Solid, color: 'transparent' },
                textColor: '#9CA3AF',
            },
            grid: {
                vertLines: { color: 'rgba(255, 255, 255, 0.03)' },
                horzLines: { color: 'rgba(255, 255, 255, 0.03)' },
            },
            width: containerRef.current.clientWidth,
            height: containerRef.current.clientHeight,
            timeScale: {
                timeVisible: true,
                secondsVisible: true,
                borderColor: 'rgba(255, 255, 255, 0.1)',
            },
            rightPriceScale: {
                borderColor: 'rgba(255, 255, 255, 0.1)',
                scaleMargins: { top: 0.1, bottom: 0.1 },
            },
            crosshair: {
                mode: 1,
                vertLine: { labelBackgroundColor: color },
                horzLine: { labelBackgroundColor: color },
            },
        });

        // Create area series
        const series = chart.addAreaSeries({
            lineColor: color,
            topColor: `${color}66`,
            bottomColor: `${color}00`,
            lineWidth: 2,
            priceFormat: {
                type: 'price',
                precision: 8,
                minMove: 0.00000001,
            },
        });

        chartRef.current = chart;
        seriesRef.current = series;

        // Handle resize
        const resizeObserver = new ResizeObserver((entries) => {
            if (!entries[0]) return;
            const { width, height } = entries[0].contentRect;
            if (width > 0 && height > 0) {
                chart.applyOptions({ width, height });
            }
        });
        resizeObserver.observe(containerRef.current);

        // Cleanup
        return () => {
            resizeObserver.disconnect();
            chart.remove();
            chartRef.current = null;
            seriesRef.current = null;
        };
    }, [color]);

    // Update chart when data changes
    useEffect(() => {
        if (!seriesRef.current || !data) return;

        const { price, timestamp } = data;
        if (typeof price !== 'number' || typeof timestamp !== 'number') return;
        if (isNaN(price) || isNaN(timestamp)) return;

        const timeInSeconds = Math.floor(timestamp / 1000);

        // Skip if time hasn't advanced (avoid duplicate errors)
        if (timeInSeconds < lastTimeRef.current) return;

        try {
            seriesRef.current.update({
                time: timeInSeconds,
                value: price,
            });
            lastTimeRef.current = timeInSeconds;
        } catch (err) {
            // Silently ignore lightweight-charts errors (duplicates, etc.)
        }
    }, [data]);

    return (
        <div
            ref={containerRef}
            className="w-full h-full"
            style={{ minHeight: '200px' }}
        />
    );
}

export default memo(Chart);
