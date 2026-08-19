import { useState } from 'react';
import { API_BASE_URL } from '../config';

import { Navigate } from 'react-router-dom';

export default function AdminPanel() {
    const userRole = localStorage.getItem('user_role');
    
    if (userRole !== 'ADMIN') {
        return <Navigate to="/dashboard" replace />;
    }
    const [formData, setFormData] = useState({
        email: '',
        password: '',
        role: 'STORE_OWNER',
        store_id: ''
    });
    
    const [status, setStatus] = useState<{type: 'error' | 'success', msg: string} | null>(null);
    const [loading, setLoading] = useState(false);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
    };

    const handleCreateUser = async (e: React.FormEvent) => {
        e.preventDefault();
        setStatus(null);
        setLoading(true);

        const token = localStorage.getItem('jwt');

        try {
            const response = await fetch(`${API_BASE_URL}/auth/create-user`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(formData)
            });

            const data = await response.json();

            if (response.ok) {
                setStatus({ type: 'success', msg: data.message || 'User created successfully!' });
                setFormData({ email: '', password: '', role: 'STORE_OWNER', store_id: '' });
            } else {
                setStatus({ type: 'error', msg: data.detail || 'Failed to create user.' });
            }
        } catch (err: any) {
            setStatus({ type: 'error', msg: err.message || 'An error occurred.' });
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="w-full pb-12 fade-up-enter fade-up-enter-active">
            {/* Page Header */}
            <div className="mb-8 border-b border-white/10 pb-6">
                <h1 className="font-display-lg text-3xl md:text-5xl text-on-surface mb-2 m-0 tracking-tight flex items-center gap-4">
                    <span className="material-symbols-outlined text-primary text-4xl">admin_panel_settings</span>
                    Admin Panel
                </h1>
                <p className="font-body-md text-secondary max-w-2xl m-0">Create new Store Owner or Admin accounts to grant system access.</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                {/* Form Column */}
                <div className="lg:col-span-5 space-y-6">
                    <div className="bg-[#121212] border border-[rgba(255,255,255,0.08)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] p-6 rounded-xl flex flex-col">
                        <div className="mb-6 pb-3 border-b border-white/10 flex items-center gap-3">
                            <span className="material-symbols-outlined text-primary text-[20px]">person_add</span>
                            <h2 className="font-label-caps text-[12px] text-on-surface tracking-widest uppercase m-0">Provision New User</h2>
                        </div>
                        
                        {status && (
                            <div className={`mb-6 p-3 border rounded font-body-sm text-sm ${status.type === 'error' ? 'bg-error/10 border-error/30 text-error' : 'bg-success/10 border-[#4ade80]/30 text-[#4ade80]'}`}>
                                {status.type === 'error' ? '❌ ' : '✅ '}{status.msg}
                            </div>
                        )}

                        <form onSubmit={handleCreateUser} className="space-y-6 flex-1">
                            <div className="space-y-2">
                                <label className="font-label-caps text-[12px] uppercase tracking-widest text-secondary block">Email Address</label>
                                <input 
                                    className="bg-transparent border-0 border-b border-white/20 rounded-none text-[#e3e2e2] px-0 py-2 w-full font-mono text-sm transition-all focus:outline-none focus:border-primary focus:shadow-[0_0_4px_rgba(212,175,55,0.5)] focus:pl-2 placeholder:text-white/20" 
                                    name="email" 
                                    type="email"
                                    placeholder="manager@m5.com" 
                                    value={formData.email} onChange={handleChange} required 
                                />
                            </div>
                            
                            <div className="space-y-2">
                                <label className="font-label-caps text-[12px] uppercase tracking-widest text-secondary block">Temporary Password</label>
                                <input 
                                    className="bg-transparent border-0 border-b border-white/20 rounded-none text-[#e3e2e2] px-0 py-2 w-full font-mono text-sm transition-all focus:outline-none focus:border-primary focus:shadow-[0_0_4px_rgba(212,175,55,0.5)] focus:pl-2 placeholder:text-white/20" 
                                    name="password" 
                                    type="password"
                                    placeholder="••••••••" 
                                    value={formData.password} onChange={handleChange} required 
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="font-label-caps text-[12px] uppercase tracking-widest text-secondary block">System Role</label>
                                <select 
                                    className="bg-transparent border-0 border-b border-white/20 rounded-none text-[#e3e2e2] px-0 py-2 w-full font-mono text-sm appearance-none transition-all focus:outline-none focus:border-primary focus:shadow-[0_0_4px_rgba(212,175,55,0.5)] focus:pl-2" 
                                    name="role" 
                                    value={formData.role} onChange={handleChange}
                                >
                                    <option value="STORE_OWNER" className="bg-[#1a1c1c]">Store Owner</option>
                                    <option value="ADMIN" className="bg-[#1a1c1c]">Administrator</option>
                                </select>
                            </div>

                            {formData.role === 'STORE_OWNER' && (
                                <div className="space-y-2">
                                    <label className="font-label-caps text-[12px] uppercase tracking-widest text-secondary block">Assigned Store ID</label>
                                    <input 
                                        className="bg-transparent border-0 border-b border-white/20 rounded-none text-[#e3e2e2] px-0 py-2 w-full font-mono text-sm transition-all focus:outline-none focus:border-primary focus:shadow-[0_0_4px_rgba(212,175,55,0.5)] focus:pl-2 placeholder:text-white/20" 
                                        name="store_id" 
                                        type="text"
                                        placeholder="e.g. TX_1" 
                                        value={formData.store_id} onChange={handleChange} required 
                                    />
                                    <p className="text-[10px] text-secondary mt-1 uppercase tracking-widest">Required for Store Owners</p>
                                </div>
                            )}

                            <div className="pt-6 mt-6 border-t border-white/10">
                                <button 
                                    type="submit" disabled={loading}
                                    className="w-full bg-primary-container text-[#050505] font-label-caps text-[12px] uppercase tracking-widest py-3 px-6 rounded hover:bg-primary transition-colors flex items-center justify-center gap-3 cursor-pointer disabled:opacity-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]"
                                >
                                    <span className="material-symbols-outlined text-[18px]">
                                        {loading ? 'sync' : 'how_to_reg'}
                                    </span>
                                    {loading ? 'Provisioning...' : 'Create Account'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
                
                {/* Information Column */}
                <div className="lg:col-span-7">
                    <div className="bg-[#121212]/50 border border-dashed border-white/20 p-8 rounded-xl h-full flex flex-col justify-center items-center text-center opacity-80">
                        <span className="material-symbols-outlined text-[48px] text-secondary mb-4 opacity-50">shield_person</span>
                        <h3 className="font-display-md text-xl text-on-surface mb-2 tracking-tight">Role Restrictions</h3>
                        <p className="font-body-sm text-secondary max-w-sm mx-auto leading-relaxed">
                            <strong>Administrators</strong> have unrestricted access to all tools, stores, and user provisioning. <br/><br/>
                            <strong>Store Owners</strong> are tightly scoped to their specific `store_id` (e.g., TX_1) and can only forecast data for their location.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
