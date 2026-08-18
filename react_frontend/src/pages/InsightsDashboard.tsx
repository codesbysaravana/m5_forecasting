import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { API_BASE_URL } from '../config';

export default function InsightsDashboard() {
    const [data, setData] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchInsights = async () => {
            try {
                const response = await fetch(`${API_BASE_URL}/api/data/insights`);
                if (!response.ok) {
                    throw new Error('Failed to fetch insights data');
                }
                const jsonData = await response.json();
                setData(jsonData);
            } catch (err: any) {
                setError(err.message || 'An error occurred while loading insights.');
            } finally {
                setLoading(false);
            }
        };

        fetchInsights();
    }, []);

    const handleExport = () => {
        if (!data) return;

        const lines = [];
        // Top level metrics
        lines.push("Metric,Value,Trend/Status,Growth");
        lines.push(`"Projected Revenue","${data.projected_revenue.value}","${data.projected_revenue.trend}","${data.projected_revenue.growth}"`);
        lines.push(`"Confidence Interval","${data.confidence_interval.value}","${data.confidence_interval.status}",""`);
        
        lines.push("");
        // Drivers
        lines.push("Key Driver,Change,Trend");
        data.key_drivers.forEach((driver: any) => {
            lines.push(`"${driver.name}","${driver.change}","${driver.trend}"`);
        });
        
        lines.push("");
        // Insight
        lines.push("Jade AI Insight");
        const safeInsight = data.jade_insight.replace(/"/g, '""');
        lines.push(`"${safeInsight}"`);

        const csvContent = lines.join("\n");
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", "m5_global_insights_export.csv");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    if (loading) {
        return (
            <div className="flex flex-col gap-8 h-full items-center justify-center">
                <span className="material-symbols-outlined text-primary text-[32px] animate-spin">sync</span>
                <p className="font-label-caps text-[12px] text-primary uppercase tracking-widest">Loading Insights...</p>
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="flex flex-col gap-8 h-full items-center justify-center text-error">
                <span className="material-symbols-outlined text-[32px]">error</span>
                <p className="font-body-sm">{error || 'Failed to load data.'}</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-8 md:gap-12 fade-up-enter fade-up-enter-active">
            {/* Dashboard Header */}
            <header className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-white/5 pb-8">
                <div>
                    <p className="font-label-caps text-[11px] text-primary uppercase tracking-[0.15em] mb-2">
                        Q3 Projections
                    </p>
                    <h1 className="font-display-lg text-3xl md:text-5xl text-on-surface m-0 tracking-tight">
                        Global Sales Forecast
                    </h1>
                </div>
                <div className="flex gap-4">
                    <button onClick={handleExport} className="bg-transparent border border-white/20 text-on-surface px-4 py-2 rounded-lg flex items-center gap-2 hover:bg-white/5 transition-colors font-label-caps text-[11px] uppercase tracking-widest cursor-pointer">
                        <span className="material-symbols-outlined text-[18px]">download</span>
                        Export
                    </button>
                    <Link to="/dashboard" className="bg-primary-container text-[#050505] px-4 py-2 rounded-lg flex items-center gap-2 hover:bg-[#ffe088] transition-colors font-label-caps text-[11px] uppercase tracking-widest cursor-pointer no-underline shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]">
                        <span className="material-symbols-outlined text-[18px]">add</span>
                        New Model
                    </Link>
                </div>
            </header>

            {/* Bento Grid Layout for Dashboard Content */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-8">
                {/* Key Metric 1 */}
                <div className="col-span-1 md:col-span-6 bg-surface-dim/70 backdrop-blur-xl border border-[rgba(212,175,55,0.15)] p-6 md:p-8 rounded-2xl flex flex-col justify-between min-h-[160px] shadow-[0_8px_32px_rgba(0,0,0,0.4)] relative overflow-hidden group">
                    <div className="flex justify-between items-start z-10 relative">
                        <h3 className="font-body-sm text-on-surface-variant m-0">Projected Revenue (Q3)</h3>
                        <span className="material-symbols-outlined text-primary">{data.projected_revenue.trend === 'up' ? 'trending_up' : 'trending_down'}</span>
                    </div>
                    <div className="z-10 relative mt-8">
                        <p className="font-headline-xl text-4xl text-on-surface m-0 tracking-tight">{data.projected_revenue.value}</p>
                        <p className={`font-label-caps text-[11px] mt-2 m-0 uppercase tracking-widest ${data.projected_revenue.trend === 'up' ? 'text-[#4ade80]' : 'text-error'}`}>{data.projected_revenue.growth} vs Q2</p>
                    </div>
                    {/* Glow effect */}
                    <div className="absolute -right-12 -top-12 w-32 h-32 bg-primary-container/10 rounded-full blur-2xl group-hover:bg-primary-container/20 transition-all duration-700 pointer-events-none"></div>
                </div>

                {/* Key Metric 2 */}
                <div className="col-span-1 md:col-span-6 bg-surface-dim/70 backdrop-blur-xl border border-[rgba(212,175,55,0.15)] p-6 md:p-8 rounded-2xl flex flex-col justify-between min-h-[160px] shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
                    <div className="flex justify-between items-start">
                        <h3 className="font-body-sm text-on-surface-variant m-0">Confidence Interval</h3>
                        <span className="material-symbols-outlined text-on-surface-variant">analytics</span>
                    </div>
                    <div className="mt-8">
                        <p className="font-headline-xl text-4xl text-on-surface m-0 tracking-tight">{data.confidence_interval.value}</p>
                        <p className="font-label-caps text-[11px] text-on-surface-variant mt-2 m-0 uppercase tracking-widest">{data.confidence_interval.status}</p>
                    </div>
                </div>

                {/* Main Chart Area */}
                <div className="col-span-1 md:col-span-8 bg-surface-dim/70 backdrop-blur-xl border border-[rgba(212,175,55,0.15)] p-6 md:p-8 rounded-2xl min-h-[400px] flex flex-col shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="font-headline-md text-xl text-on-surface m-0">Revenue Trajectory</h2>
                        <div className="flex gap-4">
                            <button className="font-label-caps text-[11px] text-primary border-b border-primary pb-1 uppercase tracking-widest bg-transparent cursor-pointer">1M</button>
                            <button className="font-label-caps text-[11px] text-on-surface-variant border-b border-transparent hover:text-on-surface hover:border-white/20 pb-1 uppercase tracking-widest bg-transparent transition-all cursor-pointer">3M</button>
                            <button className="font-label-caps text-[11px] text-on-surface-variant border-b border-transparent hover:text-on-surface hover:border-white/20 pb-1 uppercase tracking-widest bg-transparent transition-all cursor-pointer">YTD</button>
                        </div>
                    </div>
                    <div className="flex-grow flex items-center justify-center relative border border-white/5 rounded-xl overflow-hidden bg-black/50">
                        {/* Placeholder for Chart */}
                        <div className="absolute inset-0 opacity-20 pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle at center, rgba(212, 175, 55, 0.1) 0%, transparent 70%)' }}></div>
                        
                        {/* SVG Chart Abstract Representation */}
                        <svg className="w-full h-full min-h-[300px]" preserveAspectRatio="none" viewBox="0 0 800 300">
                            {/* Grid Lines */}
                            <line stroke="rgba(255,255,255,0.05)" strokeWidth="1" x1="0" x2="800" y1="250" y2="250"></line>
                            <line stroke="rgba(255,255,255,0.05)" strokeWidth="1" x1="0" x2="800" y1="150" y2="150"></line>
                            <line stroke="rgba(255,255,255,0.05)" strokeWidth="1" x1="0" x2="800" y1="50" y2="50"></line>
                            
                            {/* Data Line */}
                            <path d="M0,280 C100,260 200,200 300,180 C400,160 500,210 600,100 C700,-10 800,40 800,40" fill="none" stroke="#D4AF37" strokeWidth="2"></path>
                            
                            {/* Forecast Area (Dashed) */}
                            <path d="M600,100 C700,-10 800,40 800,40" fill="none" stroke="#D4AF37" strokeDasharray="5,5" strokeWidth="2"></path>
                            
                            {/* Gradient Fill */}
                            <path d="M0,280 C100,260 200,200 300,180 C400,160 500,210 600,100 C700,-10 800,40 800,40 L800,300 L0,300 Z" fill="url(#chartGradient)" opacity="0.1"></path>
                            
                            <defs>
                                <linearGradient id="chartGradient" x1="0" x2="0" y1="0" y2="1">
                                    <stop offset="0%" stopColor="#D4AF37"></stop>
                                    <stop offset="100%" stopColor="#050505"></stop>
                                </linearGradient>
                            </defs>
                        </svg>
                    </div>
                </div>

                {/* Right Sidebar / Insights */}
                <div className="col-span-1 md:col-span-4 flex flex-col gap-6 md:gap-8">
                    <div className="bg-surface-dim/70 backdrop-blur-xl border border-[rgba(212,175,55,0.15)] p-6 md:p-8 rounded-2xl flex-grow shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
                        <h2 className="font-headline-md text-xl text-on-surface mb-6 m-0">Key Drivers</h2>
                        <ul className="flex flex-col gap-4 p-0 m-0 list-none">
                            {data.key_drivers.map((driver: any, idx: number) => (
                                <li key={idx} className="flex items-center justify-between border-b border-white/5 pb-4 last:border-0 last:pb-0">
                                    <span className="font-body-sm text-on-surface">{driver.name}</span>
                                    <span className={`font-body-sm ${driver.trend === 'up' ? 'text-[#4ade80]' : 'text-error'}`}>
                                        {driver.change}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>

                    <div className="bg-gradient-to-br from-primary-container/20 to-black/80 backdrop-blur-xl border border-primary-container/30 p-6 md:p-8 rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
                        <h2 className="font-headline-md text-xl text-primary mb-4 m-0 flex items-center gap-2">
                            <span className="material-symbols-outlined text-[20px]">smart_toy</span>
                            Jade Insight
                        </h2>
                        <p className="font-body-sm text-on-surface-variant italic border-l-2 border-primary pl-4 py-1 m-0 leading-relaxed">
                            "{data.jade_insight}"
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
