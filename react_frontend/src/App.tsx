import { BrowserRouter, Routes, Route } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import DashboardLayout from './pages/DashboardLayout';
import InsightsDashboard from './pages/InsightsDashboard';
import AdminPanel from './pages/AdminPanel';
import LoginPage from './pages/LoginPage';
import ProtectedRoute from './components/ProtectedRoute';

import MapDashboard from './pages/Map';
import ForecastingDashboard from './pages/ForecastingDashboard';
import ForecastingDashboardLightGBM from './pages/ForecastingDashboardLightGBM';
import { Navigate } from 'react-router-dom';

const DashboardIndex = () => {
  const userRole = localStorage.getItem('user_role');
  const storeId = localStorage.getItem('store_id') || 'TX_1';

  if (userRole === 'STORE_OWNER') {
    return <Navigate to={`/dashboard/store/${storeId}`} replace />;
  }
  return <MapDashboard />;
};

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public Routes */}
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />

        {/* Protected Dashboard Routes */}
        <Route path="/dashboard" element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
          <Route index element={<DashboardIndex />} />
          <Route path="store/:storeId" element={<ForecastingDashboard />} />
          <Route path="storelgbm/:storeId" element={<ForecastingDashboardLightGBM />} />
          <Route path="insights" element={<InsightsDashboard />} />
          <Route path="admin" element={<AdminPanel />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
