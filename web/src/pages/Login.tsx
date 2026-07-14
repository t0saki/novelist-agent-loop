import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { login } from "../api";
import { toggleTheme } from "../components";

export default function Login() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const r = await login(pw);
      nav(r.role === "admin" ? "/admin" : "/");
    } catch {
      setErr("密码错误");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-box" onSubmit={submit}>
        <h1>书阁</h1>
        <p className="muted">AI 自动写作 · 在线阅读</p>
        <div style={{ marginTop: 24 }}>
          <input
            type="password"
            placeholder="输入访问密码"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoFocus
          />
        </div>
        <div style={{ marginTop: 12 }}>
          <button className="primary" style={{ width: "100%" }} disabled={busy || !pw}>
            {busy ? "登录中…" : "进入"}
          </button>
        </div>
        {err && <div className="error">{err}</div>}
        <div style={{ marginTop: 20 }}>
          <button type="button" onClick={toggleTheme}>◑ 明暗</button>
        </div>
      </form>
    </div>
  );
}
