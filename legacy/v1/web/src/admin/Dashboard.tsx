import { useEffect, useState } from "react";
import { api } from "../api";
import { Stats } from "../types";
import { Loading } from "../components";

export default function Dashboard() {
  const [s, setS] = useState<Stats | null>(null);
  const [msg, setMsg] = useState("");

  async function load() {
    setS(await api.get<Stats>("/api/admin/stats"));
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  async function toggle(key: "scheduler_paused" | "auto_generate", value: boolean) {
    await api.put("/api/admin/settings", { [key]: value });
    load();
  }

  async function createNow() {
    await api.post("/api/admin/novels", {});
    setMsg("已手动立项一本，稍后在书籍/任务中查看");
    setTimeout(() => setMsg(""), 3000);
    load();
  }

  if (!s) return <Loading />;
  const rl = s.rate_limit;
  const bg = s.budget;

  return (
    <>
      <div className="stat-grid">
        <div className="stat"><div className="num">{s.books_today}</div><div className="lbl">今日新书</div></div>
        <div className="stat"><div className="num">{s.novels_by_status.completed ?? 0}</div><div className="lbl">已完结</div></div>
        <div className="stat"><div className="num">{s.novels_by_status.writing ?? 0}</div><div className="lbl">连载中</div></div>
        <div className="stat"><div className="num">${s.cost_today.toFixed(2)}</div><div className="lbl">今日成本</div></div>
        <div className="stat"><div className="num">{(bg.tokens_today / 1000).toFixed(0)}k</div><div className="lbl">今日 token</div></div>
        <div className="stat"><div className="num">{s.queue.running ?? 0}</div><div className="lbl">运行中任务</div></div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <div className="row between">
          <h3 style={{ margin: 0 }}>调度</h3>
          <div className="row">
            <button className="primary" onClick={createNow}>+ 立即立项一本</button>
          </div>
        </div>
        {msg && <div className="ok-text" style={{ marginTop: 8 }}>{msg}</div>}
        <div className="row" style={{ marginTop: 14, gap: 24 }}>
          <label style={{ margin: 0 }}>
            <input
              type="checkbox"
              style={{ width: "auto", marginRight: 6 }}
              checked={!s.scheduler_paused}
              onChange={(e) => toggle("scheduler_paused", !e.target.checked)}
            />
            调度器运行中
          </label>
          <label style={{ margin: 0 }}>
            <input
              type="checkbox"
              style={{ width: "auto", marginRight: 6 }}
              checked={s.auto_generate}
              onChange={(e) => toggle("auto_generate", e.target.checked)}
            />
            自动立项新书
          </label>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>限流与预算</h3>
        <div className="grid2">
          <div>
            <div className="muted" style={{ fontSize: 13 }}>本数限流</div>
            <div>近 5 小时：{rl.books_last_5h} / {rl.books_per_5h || "∞"} {rl.h5_ok ? "" : "（已满）"}</div>
            <div>近 24 小时：{rl.books_today} / {rl.books_per_day || "∞"} {rl.day_ok ? "" : "（已满）"}</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 13 }}>Token 预算</div>
            <div>今日：{(bg.tokens_today / 1000).toFixed(0)}k / {bg.daily_tokens ? (bg.daily_tokens / 1000).toFixed(0) + "k" : "∞"} {bg.daily_ok ? "" : "（耗尽）"}</div>
            <div>单本上限：{bg.per_book_tokens ? (bg.per_book_tokens / 1000).toFixed(0) + "k" : "∞"}</div>
          </div>
        </div>
      </div>
    </>
  );
}
