import { useEffect, useState } from "react";
import { api } from "../api";
import { Loading } from "../components";

interface AllSettings {
  rate_limit: { books_per_day: number; books_per_5h: number };
  token_budget: { daily_tokens: number; per_book_tokens: number };
  concurrency: number;
  dedup_threshold: number;
  scene_floor_ratio: number;
  max_job_attempts: number;
  illustration_density: string;
  illustration_every_n: number;
  auto_generate: boolean;
  scheduler_paused: boolean;
}

export default function SettingsPage() {
  const [s, setS] = useState<AllSettings | null>(null);
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api.get<AllSettings>("/api/admin/settings").then(setS);
  }, []);

  async function save() {
    if (!s) return;
    await api.put("/api/admin/settings", s);
    setMsg("已保存");
    setTimeout(() => setMsg(""), 2000);
  }
  async function changePw() {
    await api.put("/api/admin/password", { new_password: pw });
    setPw("");
    setMsg("管理员密码已更新");
    setTimeout(() => setMsg(""), 2000);
  }

  if (!s) return <Loading />;

  return (
    <>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>限流</h3>
        <div className="grid2">
          <div><label>每 24 小时最多新书（0=不限）</label><input type="number" value={s.rate_limit.books_per_day} onChange={(e) => setS({ ...s, rate_limit: { ...s.rate_limit, books_per_day: Number(e.target.value) } })} /></div>
          <div><label>每 5 小时最多新书（0=不限）</label><input type="number" value={s.rate_limit.books_per_5h} onChange={(e) => setS({ ...s, rate_limit: { ...s.rate_limit, books_per_5h: Number(e.target.value) } })} /></div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Token 预算</h3>
        <div className="grid2">
          <div><label>每日 token 上限（0=不限）</label><input type="number" value={s.token_budget.daily_tokens} onChange={(e) => setS({ ...s, token_budget: { ...s.token_budget, daily_tokens: Number(e.target.value) } })} /></div>
          <div><label>单本 token 上限（0=不限）</label><input type="number" value={s.token_budget.per_book_tokens} onChange={(e) => setS({ ...s, token_budget: { ...s.token_budget, per_book_tokens: Number(e.target.value) } })} /></div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>生成参数</h3>
        <div className="grid2">
          <div><label>并发写作本数</label><input type="number" value={s.concurrency} onChange={(e) => setS({ ...s, concurrency: Number(e.target.value) })} /></div>
          <div><label>阶段级重试上限</label><input type="number" value={s.max_job_attempts} onChange={(e) => setS({ ...s, max_job_attempts: Number(e.target.value) })} /></div>
          <div><label>场景字数达标下限（0-1）</label><input type="number" step="0.05" value={s.scene_floor_ratio} onChange={(e) => setS({ ...s, scene_floor_ratio: Number(e.target.value) })} /></div>
          <div><label>查重相似度阈值（0-1）</label><input type="number" step="0.01" value={s.dedup_threshold} onChange={(e) => setS({ ...s, dedup_threshold: Number(e.target.value) })} /></div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>插图</h3>
        <div className="grid2">
          <div><label>插图密度</label>
            <select value={s.illustration_density} onChange={(e) => setS({ ...s, illustration_density: e.target.value })}>
              <option value="none">不生成</option>
              <option value="cover">仅封面</option>
              <option value="every_n">封面 + 每 N 章插图</option>
            </select>
          </div>
          <div><label>每 N 章一张插图</label><input type="number" value={s.illustration_every_n} onChange={(e) => setS({ ...s, illustration_every_n: Number(e.target.value) })} /></div>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>需在「模型」中配置 image 类型端点方可生效。</p>
      </div>

      <div className="row" style={{ marginTop: 4 }}>
        <button className="primary" onClick={save}>保存全部配置</button>
        {msg && <span className="ok-text">{msg}</span>}
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 style={{ marginTop: 0 }}>修改管理员密码</h3>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="新密码" /></div>
          <button onClick={changePw} disabled={pw.length < 4}>更新密码</button>
        </div>
      </div>
    </>
  );
}
