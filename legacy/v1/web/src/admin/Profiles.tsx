import { useEffect, useState } from "react";
import { api } from "../api";
import { Profile } from "../types";
import { Loading } from "../components";

const EMPTY: Profile = {
  id: 0, name: "", kind: "chat", base_url: "https://api.openai.com/v1", api_key_set: false,
  model: "", temperature: 0.9, max_tokens: null, price_prompt_per_mtok: 0,
  price_completion_per_mtok: 0, supports_tools: true, extra: {}, enabled: true, is_default: false,
};

const STAGES = [
  ["ideation", "选题"], ["concept", "构思"], ["bible", "设定集"],
  ["outline", "大纲"], ["writing", "写作"], ["finalize", "成书"],
];

export default function Profiles() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [edit, setEdit] = useState<(Profile & { api_key?: string }) | null>(null);
  const [stageMap, setStageMap] = useState<Record<string, number[]>>({});

  async function load() {
    setProfiles((await api.get<{ profiles: Profile[] }>("/api/admin/profiles")).profiles);
    const s = await api.get<{ stage_profiles: Record<string, number[]> }>("/api/admin/settings");
    setStageMap(s.stage_profiles ?? {});
  }
  useEffect(() => { load(); }, []);

  async function save() {
    if (!edit) return;
    const body = { ...edit };
    if (edit.id) await api.put(`/api/admin/profiles/${edit.id}`, body);
    else await api.post("/api/admin/profiles", body);
    setEdit(null);
    load();
  }
  async function del(id: number) {
    if (!confirm("删除该模型配置？")) return;
    await api.del(`/api/admin/profiles/${id}`);
    load();
  }
  async function setStage(stage: string, profileId: number) {
    const next = { ...stageMap, [stage]: profileId ? [profileId] : [] };
    setStageMap(next);
    await api.put("/api/admin/settings", { stage_profiles: next });
  }

  if (!profiles) return <Loading />;
  const chat = profiles.filter((p) => p.kind === "chat");

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <span className="muted">配置 OpenAI 兼容端点（chat / image / embedding）</span>
        <button className="primary" onClick={() => setEdit({ ...EMPTY, api_key: "" })}>+ 新模型</button>
      </div>

      <div className="card table-wrap">
        <table>
          <thead><tr><th>名称</th><th>类型</th><th>模型</th><th>端点</th><th>密钥</th><th>默认</th><th>启用</th><th></th></tr></thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td><span className="pill">{p.kind}</span></td>
                <td className="muted">{p.model}</td>
                <td className="muted" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.base_url}</td>
                <td>{p.api_key_set ? "✓" : "—"}</td>
                <td>{p.is_default ? "★" : ""}</td>
                <td>{p.enabled ? "✓" : "✗"}</td>
                <td>
                  <div className="row" style={{ gap: 4 }}>
                    <button onClick={() => setEdit({ ...p, api_key: "" })}>编辑</button>
                    <button className="danger" onClick={() => del(p.id)}>删</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>阶段模型分配</h3>
        <p className="muted" style={{ fontSize: 13 }}>为各阶段指定 chat 模型（未指定则用默认）。大纲可用强模型、正文可用便宜模型。</p>
        <div className="grid2">
          {STAGES.map(([stage, label]) => (
            <div key={stage}>
              <label>{label}</label>
              <select value={stageMap[stage]?.[0] ?? 0} onChange={(e) => setStage(stage, Number(e.target.value))}>
                <option value={0}>（默认）</option>
                {chat.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>

      {edit && (
        <div className="modal-backdrop" onClick={() => setEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{edit.id ? "编辑模型" : "新模型"}</h3>
            <div className="grid2">
              <div><label>名称</label><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
              <div><label>类型</label>
                <select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>
                  <option value="chat">chat</option><option value="image">image</option><option value="embedding">embedding</option>
                </select>
              </div>
            </div>
            <label>Base URL</label>
            <input value={edit.base_url} onChange={(e) => setEdit({ ...edit, base_url: e.target.value })} />
            <label>模型名</label>
            <input value={edit.model} onChange={(e) => setEdit({ ...edit, model: e.target.value })} />
            <label>API Key {edit.api_key_set && <span className="muted">（留空不修改）</span>}</label>
            <input type="password" value={edit.api_key ?? ""} onChange={(e) => setEdit({ ...edit, api_key: e.target.value })} />
            <div className="grid2">
              <div><label>温度</label><input type="number" step="0.1" value={edit.temperature} onChange={(e) => setEdit({ ...edit, temperature: Number(e.target.value) })} /></div>
              <div><label>max_tokens（可空）</label><input type="number" value={edit.max_tokens ?? ""} onChange={(e) => setEdit({ ...edit, max_tokens: e.target.value ? Number(e.target.value) : null })} /></div>
              <div><label>输入价/百万token</label><input type="number" step="0.01" value={edit.price_prompt_per_mtok} onChange={(e) => setEdit({ ...edit, price_prompt_per_mtok: Number(e.target.value) })} /></div>
              <div><label>输出价/百万token</label><input type="number" step="0.01" value={edit.price_completion_per_mtok} onChange={(e) => setEdit({ ...edit, price_completion_per_mtok: Number(e.target.value) })} /></div>
            </div>
            <div className="row" style={{ marginTop: 12, gap: 20 }}>
              <label style={{ margin: 0 }}><input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={edit.supports_tools} onChange={(e) => setEdit({ ...edit, supports_tools: e.target.checked })} />支持工具调用</label>
              <label style={{ margin: 0 }}><input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={edit.is_default} onChange={(e) => setEdit({ ...edit, is_default: e.target.checked })} />设为默认</label>
              <label style={{ margin: 0 }}><input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} />启用</label>
            </div>
            <div className="row between" style={{ marginTop: 18 }}>
              <button onClick={() => setEdit(null)}>取消</button>
              <button className="primary" onClick={save} disabled={!edit.name || !edit.model}>保存</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
