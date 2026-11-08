import { useEffect, useState } from "react";
import { api } from "../api";
import { Theme } from "../types";
import { Loading } from "../components";

const EMPTY: Theme = {
  id: 0, name: "", keywords: [], style_prompt: "", length_hint: "中篇",
  min_chapters: null, weight: 1, nsfw: false, enabled: true,
};

export default function Themes() {
  const [themes, setThemes] = useState<Theme[] | null>(null);
  const [edit, setEdit] = useState<Theme | null>(null);
  const [kw, setKw] = useState("");

  async function load() {
    setThemes((await api.get<{ themes: Theme[] }>("/api/admin/themes")).themes);
  }
  useEffect(() => { load(); }, []);

  function open(t: Theme) {
    setEdit({ ...t });
    setKw(t.keywords.join("、"));
  }
  async function save() {
    if (!edit) return;
    const body = { ...edit, keywords: kw.split(/[、,，\s]+/).filter(Boolean) };
    if (edit.id) await api.put(`/api/admin/themes/${edit.id}`, body);
    else await api.post("/api/admin/themes", body);
    setEdit(null);
    load();
  }
  async function del(id: number) {
    if (!confirm("删除该题材？")) return;
    await api.del(`/api/admin/themes/${id}`);
    load();
  }

  if (!themes) return <Loading />;

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <span className="muted">题材决定自动选题方向，按权重加权轮转</span>
        <button className="primary" onClick={() => open(EMPTY)}>+ 新题材</button>
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>名称</th><th>关键词</th><th>篇幅</th><th>权重</th><th>NSFW</th><th>启用</th><th></th></tr></thead>
          <tbody>
            {themes.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td className="muted">{t.keywords.join("、")}</td>
                <td>{t.length_hint || "—"}{t.min_chapters ? ` (≥${t.min_chapters}章)` : ""}</td>
                <td>{t.weight}</td>
                <td>{t.nsfw ? "是" : "—"}</td>
                <td>{t.enabled ? "✓" : "✗"}</td>
                <td>
                  <div className="row" style={{ gap: 4 }}>
                    <button onClick={() => open(t)}>编辑</button>
                    <button className="danger" onClick={() => del(t.id)}>删</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {edit && (
        <div className="modal-backdrop" onClick={() => setEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{edit.id ? "编辑题材" : "新题材"}</h3>
            <label>名称</label>
            <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <label>关键词（顿号/逗号分隔）</label>
            <input value={kw} onChange={(e) => setKw(e.target.value)} />
            <label>风格提示词</label>
            <textarea rows={2} value={edit.style_prompt} onChange={(e) => setEdit({ ...edit, style_prompt: e.target.value })} />
            <div className="grid2">
              <div>
                <label>篇幅参考</label>
                <select value={edit.length_hint} onChange={(e) => setEdit({ ...edit, length_hint: e.target.value })}>
                  <option value="短篇">短篇</option>
                  <option value="中篇">中篇</option>
                  <option value="长篇">长篇</option>
                  <option value="超长篇">超长篇</option>
                </select>
              </div>
              <div>
                <label>最少章数（兜底，可空）</label>
                <input type="number" value={edit.min_chapters ?? ""} onChange={(e) => setEdit({ ...edit, min_chapters: e.target.value ? Number(e.target.value) : null })} />
              </div>
              <div>
                <label>权重</label>
                <input type="number" step="0.1" value={edit.weight} onChange={(e) => setEdit({ ...edit, weight: Number(e.target.value) })} />
              </div>
            </div>
            <div className="row" style={{ marginTop: 12, gap: 20 }}>
              <label style={{ margin: 0 }}><input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={edit.nsfw} onChange={(e) => setEdit({ ...edit, nsfw: e.target.checked })} />NSFW 题材</label>
              <label style={{ margin: 0 }}><input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} />启用</label>
            </div>
            <div className="row between" style={{ marginTop: 18 }}>
              <button onClick={() => setEdit(null)}>取消</button>
              <button className="primary" onClick={save} disabled={!edit.name}>保存</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
