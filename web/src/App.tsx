import { Navigate, Route, Routes } from "react-router-dom";
import { getRole, getToken } from "./api";
import Login from "./pages/Login";
import Library from "./pages/Library";
import BookDetail from "./pages/BookDetail";
import Reader from "./pages/Reader";
import AdminLayout from "./admin/AdminLayout";
import Dashboard from "./admin/Dashboard";
import Themes from "./admin/Themes";
import Profiles from "./admin/Profiles";
import SettingsPage from "./admin/SettingsPage";
import Jobs from "./admin/Jobs";
import Novels from "./admin/Novels";
import Readers from "./admin/Readers";

function RequireAuth({ children, admin }: { children: JSX.Element; admin?: boolean }) {
  const token = getToken();
  if (!token) return <Navigate to="/login" replace />;
  if (admin && getRole() !== "admin") return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><Library /></RequireAuth>} />
      <Route path="/book/:slug" element={<RequireAuth><BookDetail /></RequireAuth>} />
      <Route path="/book/:slug/read/:index" element={<RequireAuth><Reader /></RequireAuth>} />
      <Route path="/admin" element={<RequireAuth admin><AdminLayout /></RequireAuth>}>
        <Route index element={<Dashboard />} />
        <Route path="novels" element={<Novels />} />
        <Route path="jobs" element={<Jobs />} />
        <Route path="themes" element={<Themes />} />
        <Route path="profiles" element={<Profiles />} />
        <Route path="readers" element={<Readers />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
