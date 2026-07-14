import { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { clearAuth, getRole } from "./api";

export function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("novelist_theme", next);
}

export function TopBar({ children }: { children?: ReactNode }) {
  const nav = useNavigate();
  const isAdmin = getRole() === "admin";
  return (
    <header className="topbar">
      <Link to="/" className="brand">书阁</Link>
      <div className="spacer" />
      {children}
      {isAdmin && <Link to="/admin"><button>管理</button></Link>}
      <button onClick={toggleTheme} title="切换明暗">◑</button>
      <button
        onClick={() => {
          clearAuth();
          nav("/login");
        }}
      >
        退出
      </button>
    </header>
  );
}

export function Loading({ text = "加载中…" }: { text?: string }) {
  return <div className="spin">{text}</div>;
}

export function StatusPill({ status }: { status: string }) {
  const label: Record<string, string> = {
    writing: "连载中",
    completed: "已完结",
    planning: "构思中",
    failed: "失败",
    archived: "已下架",
  };
  return <span className={`pill ${status}`}>{label[status] ?? status}</span>;
}
