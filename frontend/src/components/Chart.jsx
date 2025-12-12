import { useEffect, useRef } from 'react';
import { createChart, ColorType } from 'lightweight-charts';

export default function Chart({ candles = [], color = '#22c55e' }) {
    const chartContainerRef = useRef(null);
    const chartRef = useRef(null);
    const seriesRef = useRef(null);

    // Initialize chart
    useEffect(() => {
        if (!chartContainerRef.current) return;

        const chart = createChart(chartContainerRef.current, {
            layout: {
                background: { type: ColorType.Solid, color: 'transparent' },
                textColor: 'rgba(255, 255, 255, 0.7)',
                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
            },
            grid: {
                vertLines: { color: 'rgba(255, 255, 255, 0.03)' },
                horzLines: { color: 'rgba(255, 255, 255, 0.03)' },
            },
            crosshair: {
                mode: 0,
                vertLine: {
                    color: 'rgba(255, 255, 255, 0.2)',
                    width: 1,
                    style: 2,
                    labelBackgroundColor: color,
                },
                horzLine: {
                    color: 'rgba(255, 255, 255, 0.2)',
                    width: 1,
                    style: 2,
                    labelBackgroundColor: color,
                },
            },
            rightPriceScale: {
                borderColor: 'rgba(255, 255, 255, 0.1)',
                scaleMargins: {
                    top: 0.35,  // Leave room for header overlay
                    bottom: 0.1,
                },
            },
            timeScale: {
                borderColor: 'rgba(255, 255, 255, 0.1)',
                timeVisible: true,
                secondsVisible: false,
                rightOffset: 3,
                barSpacing: 10,
                minBarSpacing: 5,
            },
            handleScale: {
                axisPressedMouseMove: true,
            },
            handleScroll: {
                mouseWheel: true,
                pressedMouseMove: true,
            },
        });

        // Determine colors based on the color prop
        const isGreen = color === '#22c55e';
        const upColor = isGreen ? '#22c55e' : '#6366f1';
        const downColor = isGreen ? '#ef4444' : '#ec4899';

        const candlestickSeries = chart.addCandlestickSeries({
            upColor: upColor,
            downColor: downColor,
            borderVisible: false,
            wickUpColor: upColor,
            wickDownColor: downColor,
            priceFormat: {
                type: 'price',
                precision: 6,
                minMove: 0.000001,
            },
        });

        chartRef.current = chart;
        seriesRef.current = candlestickSeries;

        // Handle resize
        const handleResize = () => {
            if (chartContainerRef.current && chartRef.current) {
                chartRef.current.applyOptions({
                    width: chartContainerRef.current.clientWidth,
                    height: chartContainerRef.current.clientHeight,
                });
            }
        };

        handleResize();

        const resizeObserver = new ResizeObserver(handleResize);
        resizeObserver.observe(chartContainerRef.current);

        return () => {
            resizeObserver.disconnect();
            if (chartRef.current) {
                chartRef.current.remove();
                chartRef.current = null;
                seriesRef.current = null;
            }
        };
    }, [color]);

    // Update candle data
    useEffect(() => {
        console.log('📊 Chart useEffect - candles:', candles?.length, 'seriesRef:', !!seriesRef.current);

        if (!seriesRef.current) {
            console.log('❌ Chart: seriesRef is null');
            return;
        }
        if (!candles || candles.length === 0) {
            console.log('❌ Chart: No candles data');
            return;
        }

        console.log('📊 Raw candles sample:', candles[0]);

        // Format candles for lightweight-charts
        const formattedData = candles
            .map(candle => ({
                time: typeof candle.time === 'number'
                    ? candle.time
                    : Math.floor(new Date(candle.timestamp || candle.time).getTime() / 1000),
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
            }))
            .filter(c => c.open && c.high && c.low && c.close) // Filter out invalid candles
            .sort((a, b) => a.time - b.time);

        // Remove duplicates by time
        const uniqueData = formattedData.filter((v, i, a) =>
            a.findIndex(t => t.time === v.time) === i
        );

        console.log('📊 Formatted candles:', uniqueData.length, 'sample:', uniqueData[0]);

        if (uniqueData.length > 0) {
            seriesRef.current.setData(uniqueData);
            chartRef.current?.timeScale().fitContent();
            console.log('✅ Chart: Data set successfully');
        }
    }, [candles]);

    return (
        <div
            ref={chartContainerRef}
            className="w-full h-full"
            style={{
                minHeight: '200px',
                position: 'relative',
            }}
        />
    );
}
