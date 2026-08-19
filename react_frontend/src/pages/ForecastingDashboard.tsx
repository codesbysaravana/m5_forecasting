import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, BarChart, Bar, Cell } from 'recharts';
import { API_BASE_URL } from '../config';

export default function ForecastingDashboard() {
    const { storeId } = useParams<{ storeId: string }>();
    const userRole = localStorage.getItem('user_role');
    const assignedStoreId = localStorage.getItem('store_id');

    // If STORE_OWNER, force their assigned store. Otherwise, use URL param or default.
    const initialStoreId = userRole === 'STORE_OWNER' && assignedStoreId
        ? assignedStoreId
        : (storeId || 'TX_1');

    const [formData, setFormData] = useState({
        item_id: 'HOBBIES_1_001',
        store_id: initialStoreId,
        price: 8.26,
        is_weekend: 0,
        is_snap_day: 0
    });
    const [prediction, setPrediction] = useState<number | null>(null);
    const [hoveredData, setHoveredData] = useState<{ day: string, value: number, isPredicted: boolean } | null>(null);
    const [chartData, setChartData] = useState<any[]>([]);
    const [impactData, setImpactData] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Sync URL param changes to the form data (useful if navigating between stores)
    useEffect(() => {
        if (userRole !== 'STORE_OWNER') {
            setFormData(prev => ({ ...prev, store_id: storeId || 'TX_1' }));
        }
    }, [storeId, userRole]);

    // Initial dummy data to show a chart before prediction
    useEffect(() => {
        const initialData = [];
        let actualVol = 50;
        for (let i = 1; i <= 30; i++) {
            actualVol = actualVol + (Math.random() * 20 - 10);
            const dNum = 1913 - 30 + i;
            const baseDate = new Date('2011-01-29T00:00:00Z');
            baseDate.setUTCDate(baseDate.getUTCDate() + (dNum - 1));
            initialData.push({
                day: baseDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }),
                dayNum: dNum,
                actual: Math.max(0, Math.round(actualVol)),
                predicted: null
            });
        }
        setChartData(initialData);
    }, []);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value, type } = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: type === 'number' ? Number(value) : value
        }));
    };

    const handlePredict = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setPrediction(null);

        try {
            const response = await fetch(`${API_BASE_URL}/api/predict/prophet`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    item_id: formData.item_id,
                    store_id: formData.store_id,
                    price: Number(formData.price),
                    is_weekend: Number(formData.is_weekend),
                    is_snap_day: Number(formData.is_snap_day)
                })
            });

            if (!response.ok) {
                throw new Error('Failed to fetch prediction');
            }

            const data = await response.json();

            let newChartData: any[] = [];

            // Fetch Historical Data
            try {
                const histResponse = await fetch(`${API_BASE_URL}/api/data/historical`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ item_id: formData.item_id, store_id: formData.store_id })
                });

                if (histResponse.ok) {
                    const histData = await histResponse.json();
                    newChartData = histData.map((d: any) => {
                        const baseDate = new Date('2011-01-29T00:00:00Z');
                        baseDate.setUTCDate(baseDate.getUTCDate() + (parseInt(d.day) - 1));
                        return {
                            day: baseDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }),
                            dayNum: parseInt(d.day),
                            actual: d.sales,
                            predicted: null
                        };
                    });
                }
            } catch (e) {
                console.error("Failed to fetch historical data", e);
            }

            if (data.status === 'success') {
                const predVal = data.predicted_sales;
                setPrediction(predVal);

                // Generate Feature Impact (Simulated for visualization)
                const newImpact = [
                    { name: 'Base', value: Math.max(0, predVal * 0.55) },
                    { name: 'Price', value: predVal * (Number(formData.price) < 8 ? 0.15 : -0.05) },
                    { name: 'Weekend', value: Number(formData.is_weekend) === 1 ? predVal * 0.2 : predVal * -0.05 },
                    { name: 'SNAP', value: Number(formData.is_snap_day) === 1 ? predVal * 0.15 : 0 },
                ].map(d => ({ ...d, value: parseFloat(d.value.toFixed(1)) }));
                setImpactData(newImpact);

                if (newChartData.length === 0) {
                    // fallback if no history
                    let actualVol = 50;
                    for (let i = 1; i <= 30; i++) {
                        actualVol = actualVol + (Math.random() * 20 - 10);
                        const dNum = 1913 - 30 + i;
                        const baseDate = new Date('2011-01-29T00:00:00Z');
                        baseDate.setUTCDate(baseDate.getUTCDate() + (dNum - 1));
                        newChartData.push({
                            day: baseDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }),
                            dayNum: dNum,
                            actual: Math.max(0, Math.round(actualVol)),
                            predicted: null
                        });
                    }
                }

                // Plot the 28-day predictions
                const lastIdx = newChartData.length - 1;
                // Bridge the historical actual line to the prediction line seamlessly
                if (newChartData[lastIdx] && newChartData[lastIdx].actual != null) {
                    newChartData[lastIdx].predicted = newChartData[lastIdx].actual;
                }

                let lastDayNum = 1913;
                if (newChartData[lastIdx] && newChartData[lastIdx].dayNum) {
                    lastDayNum = newChartData[lastIdx].dayNum;
                }

                if (data.daily_predictions && data.daily_predictions.length > 0) {
                    data.daily_predictions.forEach((dailyVal: number, index: number) => {
                        const currentDayNum = lastDayNum + index + 1;
                        const baseDate = new Date('2011-01-29T00:00:00Z');
                        baseDate.setUTCDate(baseDate.getUTCDate() + (currentDayNum - 1));

                        // Map future true actuals if they exist (for model evaluation)
                        const trueActual = (data.future_actuals && data.future_actuals.length > index)
                            ? data.future_actuals[index]
                            : null;

                        newChartData.push({
                            day: baseDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }),
                            dayNum: currentDayNum,
                            actual: trueActual,
                            predicted: dailyVal
                        });
                    });
                } else {
                    // Fallback just in case
                    const currentDayNum = lastDayNum + 1;
                    const baseDate = new Date('2011-01-29T00:00:00Z');
                    baseDate.setUTCDate(baseDate.getUTCDate() + (currentDayNum - 1));
                    newChartData.push({
                        day: baseDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }),
                        dayNum: currentDayNum,
                        actual: null,
                        predicted: predVal
                    });
                }

                setChartData(newChartData);
            } else {
                throw new Error(data.model || 'Unknown error');
            }
        } catch (err: any) {
            setError(err.message || 'An error occurred during prediction.');
        } finally {
            setLoading(false);
        }
    };

    const CustomTooltip = ({ active, payload, label }: any) => {
        useEffect(() => {
            if (active && payload && payload.length > 0) {
                const data = payload[0].payload;
                const hasPredicted = data.predicted !== null && data.predicted !== undefined;
                const hasActual = data.actual !== null && data.actual !== undefined;

                if (hasPredicted || hasActual) {
                    setHoveredData(prev => {
                        if (prev && prev.day === data.day) return prev;
                        return {
                            day: data.day,
                            value: hasPredicted ? data.predicted : data.actual,
                            isPredicted: hasPredicted
                        };
                    });
                }
            } else {
                setHoveredData(prev => prev !== null ? null : prev);
            }
        }, [active, payload]);

        if (active && payload && payload.length) {
            return (
                <div className="bg-[#1a1c1c] border border-white/10 p-3 rounded shadow-lg backdrop-blur-md font-mono text-[12px]">
                    <p className="text-secondary mb-2 border-b border-white/10 pb-1">{label}</p>
                    {payload.map((entry: any, index: number) => (
                        <p key={`item-${index}`} style={{ color: entry.color }} className="flex justify-between gap-4 py-0.5 m-0">
                            <span>{entry.name}:</span>
                            <span>{Number(entry.value).toFixed(2)}</span>
                        </p>
                    ))}
                </div>
            );
        }
        return null;
    };

    const handleExport = async () => {
        try {
            const token = localStorage.getItem('jwt');
            const response = await fetch(`${API_BASE_URL}/api/data/export_insights`, {
                headers: token ? { 'Authorization': `Bearer ${token}` } : {}
            });

            if (!response.ok) throw new Error('Failed to generate export');

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `forecast_insights_${new Date().toISOString().split('T')[0]}.xlsx`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
        } catch (err) {
            console.error("Export failed:", err);
            alert("Failed to export Excel file. Please try again.");
        }
    };

    return (
        <div className="w-full pb-12 fade-up-enter fade-up-enter-active">
            {/* Page Header */}
            <div className="mb-8">
                <h1 className="font-display-lg text-3xl md:text-5xl text-on-surface mb-2 m-0 tracking-tight">Sales Forecast</h1>
                <p className="font-body-md text-secondary max-w-2xl m-0">Generate a 30-day sales forecast using item, store, pricing, and calendar signals.</p>
            </div>

            {/* Two Column Layout */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">

                {/* Left Column: Parameters */}
                <div className="lg:col-span-4 xl:col-span-3 space-y-6">
                    <div className="bg-[#121212] border border-[rgba(255,255,255,0.08)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] p-6 rounded-xl h-full flex flex-col">
                        <div className="mb-6 pb-3 border-b border-white/10 flex items-center gap-3">
                            <span className="material-symbols-outlined text-primary text-[20px]">tune</span>
                            <h2 className="font-label-caps text-[12px] text-on-surface tracking-widest uppercase m-0">Forecast Parameters</h2>
                        </div>

                        <form onSubmit={handlePredict} className="space-y-6 flex-1">
                            <div className="space-y-2">
                                <label className="font-label-caps text-[12px] uppercase tracking-widest text-secondary block" htmlFor="item_id">Item ID</label>
                                <input
                                    className="bg-transparent border-0 border-b border-white/20 rounded-none text-[#e3e2e2] px-0 py-2 w-full font-mono text-sm transition-all focus:outline-none focus:border-primary focus:shadow-[0_0_4px_rgba(212,175,55,0.5)] focus:pl-2"
                                    id="item_id" name="item_id"
                                    placeholder="e.g. HOBBIES_1_001" type="text"
                                    value={formData.item_id} onChange={handleChange} required
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="font-label-caps text-[12px] uppercase tracking-widest text-secondary block" htmlFor="store_id">Store ID</label>
                                <input
                                    className={`bg-transparent border-0 border-b border-white/20 rounded-none text-[#e3e2e2] px-0 py-2 w-full font-mono text-sm transition-all focus:outline-none focus:border-primary focus:shadow-[0_0_4px_rgba(212,175,55,0.5)] focus:pl-2 ${userRole === 'STORE_OWNER' ? 'opacity-50 cursor-not-allowed bg-black/20' : ''}`}
                                    id="store_id" name="store_id"
                                    placeholder="e.g. TX_1" type="text"
                                    value={formData.store_id} onChange={handleChange} required
                                    disabled={userRole === 'STORE_OWNER'}
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="font-label-caps text-[12px] uppercase tracking-widest text-secondary block" htmlFor="price">Price ($)</label>
                                <input
                                    className="bg-transparent border-0 border-b border-white/20 rounded-none text-[#e3e2e2] px-0 py-2 w-full font-mono text-sm transition-all focus:outline-none focus:border-primary focus:shadow-[0_0_4px_rgba(212,175,55,0.5)] focus:pl-2"
                                    id="price" name="price"
                                    placeholder="0.00" step="0.01" type="number"
                                    value={formData.price} onChange={handleChange} required
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="font-label-caps text-[12px] uppercase tracking-widest text-secondary block" htmlFor="is_weekend">Weekend</label>
                                    <select
                                        className="bg-transparent border-0 border-b border-white/20 rounded-none text-[#e3e2e2] px-0 py-2 w-full font-mono text-sm appearance-none transition-all focus:outline-none focus:border-primary focus:shadow-[0_0_4px_rgba(212,175,55,0.5)] focus:pl-2"
                                        id="is_weekend" name="is_weekend"
                                        value={formData.is_weekend} onChange={handleChange}
                                    >
                                        <option value={0} className="bg-[#1a1c1c]">0 (No)</option>
                                        <option value={1} className="bg-[#1a1c1c]">1 (Yes)</option>
                                    </select>
                                </div>
                                <div className="space-y-2">
                                    <label className="font-label-caps text-[12px] uppercase tracking-widest text-secondary block" htmlFor="is_snap_day">SNAP Day</label>
                                    <select
                                        className="bg-transparent border-0 border-b border-white/20 rounded-none text-[#e3e2e2] px-0 py-2 w-full font-mono text-sm appearance-none transition-all focus:outline-none focus:border-primary focus:shadow-[0_0_4px_rgba(212,175,55,0.5)] focus:pl-2"
                                        id="is_snap_day" name="is_snap_day"
                                        value={formData.is_snap_day} onChange={handleChange}
                                    >
                                        <option value={0} className="bg-[#1a1c1c]">0 (No)</option>
                                        <option value={1} className="bg-[#1a1c1c]">1 (Yes)</option>
                                    </select>
                                </div>
                            </div>

                            {error && (
                                <div className="p-3 bg-error/10 border border-error/30 rounded text-error font-body-sm text-sm">
                                    ❌ {error}
                                </div>
                            )}

                            <div className="pt-6 mt-6 border-t border-white/10">
                                <button
                                    type="submit" disabled={loading}
                                    className="w-full bg-primary-container text-[#050505] font-label-caps text-[12px] uppercase tracking-widest py-3 px-6 rounded hover:bg-primary transition-colors flex items-center justify-center gap-3 cursor-pointer disabled:opacity-50"
                                >
                                    <span className="material-symbols-outlined text-[18px]">
                                        {loading ? 'sync' : 'model_training'}
                                    </span>
                                    {loading ? 'Processing...' : 'Generate Forecast'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>

                {/* Right Column: Visualization */}
                <div className="lg:col-span-8 xl:col-span-9 space-y-6 flex flex-col min-w-0">

                    {/* KPI Boxes */}
                    <div className="flex gap-4 mb-2">
                        {/* Dynamic Hover Card */}
                        <div className="bg-[#121212] border border-[rgba(255,255,255,0.08)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] p-4 rounded-xl relative overflow-hidden group flex-1 max-w-[280px]">
                            {/* Subtle background accent */}
                            <div className="absolute -right-8 -top-8 w-24 h-24 bg-primary/5 rounded-full blur-xl group-hover:bg-primary/10 transition-all duration-700 pointer-events-none"></div>

                            <h3 className="font-label-caps text-[11px] uppercase tracking-widest text-secondary mb-1 m-0">
                                {hoveredData ? `Sales on ${hoveredData.day}` : 'Hover chart for daily details'}
                            </h3>
                            <div className="flex items-baseline gap-2">
                                <span className={`font-headline-xl text-3xl m-0 tracking-tight ${hoveredData ? 'text-primary' : 'text-secondary/30'}`}>
                                    {hoveredData ? hoveredData.value.toFixed(2) : '--'}
                                </span>
                                <span className={`font-body-sm text-[12px] ${hoveredData ? 'text-secondary' : 'text-secondary/30'}`}>units</span>
                            </div>
                            <div className={`mt-2 flex items-center gap-1.5 text-[11px] font-mono ${hoveredData ? 'text-secondary' : 'text-secondary/30'}`}>
                                {hoveredData ? (
                                    <>
                                        <div className={`w-2 h-2 rounded-full ${hoveredData.isPredicted ? 'bg-primary shadow-[0_0_8px_rgba(212,175,55,0.4)]' : 'bg-transparent border border-secondary'}`}></div>
                                        {hoveredData.isPredicted ? 'Predicted' : 'Actual'}
                                    </>
                                ) : (
                                    <>
                                        <span className="material-symbols-outlined text-[12px]">info</span>
                                        Interactive Day View
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Static Total Card */}
                        <div className="bg-[#121212] border border-[rgba(255,255,255,0.08)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] p-4 rounded-xl relative overflow-hidden group flex-1 max-w-[280px] flex flex-col justify-between">
                            <div>
                                <h3 className="font-label-caps text-[11px] uppercase tracking-widest text-secondary mb-1 m-0">
                                    Total 28-Day Target Sales
                                </h3>
                                <div className="flex items-baseline gap-2">
                                    <span className="font-headline-xl text-3xl text-primary m-0 tracking-tight">
                                        {prediction !== null ? prediction.toFixed(2) : '--'}
                                    </span>
                                    <span className="font-body-sm text-[12px] text-secondary">units</span>
                                </div>
                            </div>

                            <div className="mt-2 flex items-center justify-between">
                                <div className="flex items-center gap-1.5 text-[11px] text-secondary font-mono">
                                    <span className="material-symbols-outlined text-[12px]">model_training</span>
                                    Overall Sum
                                </div>

                                <button
                                    onClick={handleExport}
                                    type="button"
                                    className="flex items-center gap-1.5 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 px-2 py-1 rounded text-[10px] font-label-caps tracking-widest uppercase transition-colors"
                                >
                                    <span className="material-symbols-outlined text-[14px]">download</span>
                                    Excel
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Main Chart Area */}
                    <div className="bg-[#121212] border border-[rgba(255,255,255,0.08)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] p-6 rounded-xl flex-1 flex flex-col min-h-[600px]">
                        <div className="flex justify-between items-center mb-6 pb-3 border-b border-white/10">
                            <h3 className="font-label-caps text-[12px] text-on-surface uppercase tracking-widest flex items-center gap-2 m-0">
                                <span className="material-symbols-outlined text-[18px] text-secondary">monitoring</span>
                                Historical vs Predicted
                            </h3>
                            <div className="flex items-center gap-4 font-label-caps text-[10px] uppercase tracking-wider">
                                <div className="flex items-center gap-1.5">
                                    <div className="w-3 h-3 rounded-full border border-secondary bg-transparent"></div>
                                    <span className="text-secondary">Actual</span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <div className="w-3 h-3 rounded-full bg-primary shadow-[0_0_8px_rgba(212,175,55,0.4)]"></div>
                                    <span className="text-primary">Predicted</span>
                                </div>
                            </div>
                        </div>

                        <div className="flex-1 w-full h-full relative border border-white/5 rounded-xl overflow-hidden bg-[#0A0A0A]">

                            {/* Loading Overlay */}
                            {loading && (
                                <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#121414]/70 backdrop-blur-sm z-10">
                                    <span className="material-symbols-outlined text-primary text-[32px] animate-spin mb-3">sync</span>
                                    <p className="font-label-caps text-[12px] text-primary uppercase tracking-widest m-0">Processing Signals...</p>
                                </div>
                            )}

                            {/* Chart Data Render */}
                            <div className="absolute inset-0 pt-6 pr-6 pb-2 pl-0">
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart
                                        data={chartData}
                                        margin={{ top: 20, right: 20, left: -20, bottom: 0 }}
                                    >
                                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                                        <XAxis
                                            dataKey="day"
                                            stroke="#757575"
                                            tick={{ fill: '#757575', fontSize: 10, fontFamily: 'monospace' }}
                                            tickLine={false}
                                            axisLine={false}
                                            minTickGap={30}
                                        />
                                        <YAxis
                                            stroke="#757575"
                                            tick={{ fill: '#757575', fontSize: 10, fontFamily: 'monospace' }}
                                            tickLine={false}
                                            axisLine={false}
                                        />
                                        <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(212,175,55,0.2)', strokeWidth: 2 }} />

                                        {/* Show reference line if prediction exists */}
                                        {prediction !== null && <ReferenceLine x={chartData[chartData.length - 1]?.day} stroke="rgba(255,255,255,0.2)" strokeDasharray="3 3" />}

                                        <Line
                                            type="monotone"
                                            dataKey="actual"
                                            name="Actual"
                                            stroke="#e3e2e2"
                                            strokeWidth={1.5}
                                            dot={false}
                                            activeDot={{ r: 4, fill: '#121212', stroke: '#e3e2e2', strokeWidth: 2 }}
                                        />
                                        <Line
                                            type="monotone"
                                            dataKey="predicted"
                                            name="Predicted"
                                            stroke="#d4af37"
                                            strokeWidth={2}
                                            dot={false}
                                            activeDot={{ r: 4, fill: '#121212', stroke: '#d4af37', strokeWidth: 2 }}
                                            strokeDasharray="5 5"
                                        />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
