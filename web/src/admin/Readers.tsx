import { useEffect, useState } from "react";
import { api } from "../api";
import { Loading } from "../components";

interface Reader { id: number; label: string; enabled: boolean; }

export default function Readers() {
  const [readers, setReaders] = useState<Reader[] | null>(null);
  const [label, setLabel] = useState("");
  const [pw, setPw] = useState("");

  async function load() {
    setReaders((await api.get<{ readers: Reader[] }>("/api/admin/readers")).readers);
  }
  useEffect(() => { load(); }, []);

  async function add() {
    await api.post("/api/admin/readers", { label: label || "reader", password: pw });
    setLabel(""); setPw("");
    load();
  }
  async function del(id: number) {
    if (!confirm("删除该只读密码？")) return;
    await api.del(`/api/admin/readers/${id}`);
    load();
  }

  if (!readers) return <Loading />;

  return (
    <>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>新增只读密码</h3>
        <p className="muted" style={{ fontSize: 13 }}>可分发给不同的人；权限等同，仅用于区分各自的阅读进度。</p>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}><label>标签</label><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如：家人 / 朋友" /></div>
          <div style={{ flex: 1 }}><label>密码</label><input value={pw} onChange={(e) => setPw(e.target.value)} /></div>
          <button className="primary" onClick={add} disabled={!pw}>添加</button>
        </div>
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>#</th><th>标签</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {readers.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td><td>{r.label}</td><td>{r.enabled ? "启用" : "停用"}</td>
                <td><button className="danger" onClick={() => del(r.id)}>删除</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
