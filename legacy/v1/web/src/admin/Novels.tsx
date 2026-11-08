import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { AdminNovel } from "../types";
import { Loading, StatusPill } from "../components";

export default function Novels() {
  const [novels, setNovels] = useState<AdminNovel[] | null>(null);
  const [filter, setFilter] = useState("");

  async function load() {
    const p = filter ? `?status=${filter}` : "";
    setNovels((await api.get<{ novels: AdminNovel[] }>(`/api/admin/novels${p}`)).novels);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function archive(slug: string) {
    await api.post(`/api/admin/novels/${slug}/archive`);
    load();
  }
  async function del(slug: string) {
    if (!confirm("确认删除这本书及其全部章节？")) return;
    await api.del(`/api/admin/novels/${slug}`);
    load();
  }

  if (!novels) return <Loading />;

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <select style={{ width: "auto" }} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">全部状态</option>
          <option value="writing">连载中</option>
          <option value="completed">已完结</option>
          <option value="planning">构思中</option>
          <option value="failed">失败</option>
          <option value="archived">已下架</option>
        </select>
        <button onClick={load}>刷新</button>
      </div>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>书名</th><th>状态</th><th>题材</th><th>进度</th><th>字数</th>
              <th>Token</th><th>成本</th><th>债务</th><th></th>
            </tr>
          </thead>
          <tbody>
            {novels.map((n) => (
              <tr key={n.id}>
                <td>
                  <Link to={`/book/${n.slug}`}>{n.title}</Link>
                  {n.nsfw && <span className="pill failed" style={{ marginLeft: 6 }}>R18</span>}
                </td>
                <td><StatusPill status={n.status} /></td>
                <td className="muted">{n.theme}</td>
                <td>{n.chapters_written}/{n.planned_chapters}</td>
                <td>{(n.word_count / 10000).toFixed(1)}万</td>
                <td className="muted">{(n.tokens_total / 1000).toFixed(0)}k</td>
                <td className="muted">${n.cost_total.toFixed(3)}</td>
                <td>{n.quality_debt > 0 ? <span className="pill failed">{n.quality_debt}</span> : "—"}</td>
                <td>
                  <div className="row" style={{ gap: 4 }}>
                    {n.status !== "archived" && <button onClick={() => archive(n.slug)}>下架</button>}
                    <button className="danger" onClick={() => del(n.slug)}>删除</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
