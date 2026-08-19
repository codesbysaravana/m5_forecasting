
import { Link, Outlet, useNavigate } from 'react-router-dom';
import VoiceOverlay from '../components/VoiceOverlay';

export default function DashboardLayout() {
    const navigate = useNavigate();
    const userRole = localStorage.getItem('user_role');

    const handleLogout = () => {
        localStorage.removeItem('jwt');
        localStorage.removeItem('user_role');
        navigate('/');
    };

    return (
        <div className="min-h-screen flex flex-col bg-background text-on-surface font-body-md relative overflow-x-hidden selection:bg-primary-container selection:text-on-primary-container">

            {/* Top Navigation */}
            <header className="w-full border-b border-white/5 bg-surface-dim/80 backdrop-blur-xl sticky top-0 z-40">
                <div className="max-w-[1440px] mx-auto px-4 md:px-8 h-[72px] flex items-center justify-between">

                    <div className="flex items-center gap-6 md:gap-12">
                        <div className="font-headline-md text-[24px] font-bold text-primary flex items-center gap-2 select-none">
                            M5
                        </div>

                        <nav className="hidden sm:flex gap-6">
                            {userRole === 'ADMIN' && (
                                <Link to="/dashboard" className="text-primary font-label-caps text-label-caps tracking-widest uppercase transition-colors">
                                    HQ Map
                                </Link>
                            )}
                            
                            <Link to={`/dashboard/store/${localStorage.getItem('store_id') || 'TX_1'}`} className="text-primary font-label-caps text-label-caps tracking-widest uppercase transition-colors">
                                Prophet
                            </Link>
                            <Link to={`/dashboard/storelgbm/${localStorage.getItem('store_id') || 'TX_1'}`} className="text-primary font-label-caps text-label-caps tracking-widest uppercase transition-colors">
                                LightGBM
                            </Link>

                            <Link to="/dashboard/insights" className="text-on-surface-variant hover:text-primary font-label-caps text-label-caps tracking-widest uppercase transition-colors">
                                Insights
                            </Link>
                            {userRole === 'ADMIN' && (
                                <Link to="/dashboard/admin" className="text-on-surface-variant hover:text-primary font-label-caps text-label-caps tracking-widest uppercase transition-colors">
                                    Admin Panel
                                </Link>
                            )}
                        </nav>
                    </div>

                    <div className="flex items-center gap-4">
                        <button
                            onClick={handleLogout}
                            className="text-on-surface-variant hover:text-primary transition-all duration-300 font-label-caps text-[11px] tracking-widest uppercase border border-white/10 px-4 py-2 rounded-lg bg-black/20 hover:bg-black/40 cursor-pointer"
                        >
                            Logout
                        </button>
                    </div>
                </div>
                {/* Mobile Nav Link */}
                <div className="sm:hidden px-4 py-3 border-t border-white/5 bg-surface-dim/95 flex justify-center gap-6">
                    {userRole === 'ADMIN' && (
                        <Link to="/dashboard" className="text-primary font-label-caps text-label-caps tracking-widest uppercase">
                            HQ Map
                        </Link>
                    )}
                    
                    <Link to={`/dashboard/store/${localStorage.getItem('store_id') || 'TX_1'}`} className="text-primary font-label-caps text-label-caps tracking-widest uppercase">
                        Prophet
                    </Link>
                    <Link to={`/dashboard/storelgbm/${localStorage.getItem('store_id') || 'TX_1'}`} className="text-primary font-label-caps text-label-caps tracking-widest uppercase">
                        LightGBM
                    </Link>

                    <Link to="/dashboard/insights" className="text-on-surface-variant font-label-caps text-label-caps tracking-widest uppercase">
                        Insights
                    </Link>
                    {userRole === 'ADMIN' && (
                        <Link to="/dashboard/admin" className="text-on-surface-variant font-label-caps text-label-caps tracking-widest uppercase">
                            Admin Panel
                        </Link>
                    )}
                </div>
            </header>

            {/* Main Content Area */}
            <main className="flex-grow w-full max-w-[1440px] mx-auto px-4 sm:px-6 md:px-8 py-8 md:py-12 pb-32">
                <Outlet />
            </main>

            {/* Universal Floating Voice Assistant */}
            <VoiceOverlay />
        </div>
    );
}
