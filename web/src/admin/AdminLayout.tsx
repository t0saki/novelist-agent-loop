import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { getToken } from "../api";
import { TopBar } from "../components";

const TABS = [
  ["", "仪表盘"],
  ["novels", "书籍"],
  ["jobs", "任务"],
  ["themes", "题材"],
  ["profiles", "模型"],
  ["readers", "只读密码"],
  ["settings", "配置"],
];

export default function AdminLayout() {
  const [events, setEvents] = useState<string[]>([]);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/admin/events?token=${getToken()}`);
    esRef.current = es;
    const push = (label: string) => setEvents((e) => [label, ...e].slice(0, 6));
    es.addEventListener("chapter_done", (ev) => {
      const d = JSON.parse((ev as MessageEvent).data);
      push(`《${d.title}》第${d.chapter}/${d.total}章完成`);
    });
    es.addEventListener("job_done", (ev) => {
      const d = JSON.parse((ev as MessageEvent).data);
      push(`✅《${d.title}》成书（${(d.words / 10000).toFixed(1)}万字）`);
    });
    es.addEventListener("book_created", () => push("📖 自动立项新书"));
    es.addEventListener("stage", (ev) => {
      const d = JSON.parse((ev as MessageEvent).data);
      push(`阶段：${d.label}（novel #${d.novel_id}）`);
    });
    es.addEventListener("job_error", (ev) => {
      const d = JSON.parse((ev as MessageEvent).data);
      push(`⚠️ 任务出错：${d.error?.slice(0, 40) ?? ""}`);
    });
    return () => es.close();
  }, []);

  return (
    <>
      <TopBar />
      <div className="container">
        <nav className="row" style={{ gap: 6, marginBottom: 20 }}>
          {TABS.map(([path, label]) => (
            <NavLink
              key={path}
              to={`/admin/${path}`}
              end={path === ""}
              className={({ isActive }) => (isActive ? "active" : "")}
              style={{ padding: "6px 12px", borderRadius: 8 }}
            >
              {label}
            </NavLink>
          ))}
        </nav>

        {events.length > 0 && (
          <div className="card" style={{ marginBottom: 16, padding: "10px 16px" }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>实时动态</div>
            {events.map((e, i) => (
              <div key={i} style={{ fontSize: 13, opacity: 1 - i * 0.12 }}>{e}</div>
            ))}
          </div>
        )}

        <Outlet />
      </div>
    </>
  );
}
