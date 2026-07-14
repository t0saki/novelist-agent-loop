import { useEffect, useState } from "react";
import { api } from "../api";
import { Job } from "../types";
import { Loading } from "../components";

const STAGE_LABEL: Record<string, string> = {
  ideation: "选题", concept: "构思", bible: "设定集",
  outline: "大纲", writing: "写作", finalize: "成书",
};

export default function Jobs() {
  const [jobs, setJobs] = useState<Job[] | null>(null);

  async function load() {
    setJobs((await api.get<{ jobs: Job[] }>("/api/admin/jobs")).jobs);
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  async function retry(id: number) {
    await api.post(`/api/admin/jobs/${id}/retry`);
    load();
  }

  if (!jobs) return <Loading />;

  return (
    <div className="card table-wrap">
      <table>
        <thead>
          <tr><th>#</th><th>书</th><th>阶段</th><th>状态</th><th>进度</th><th>重试</th><th>错误</th><th></th></tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>{j.id}</td>
              <td>{j.novel_title || "—"}</td>
              <td>{STAGE_LABEL[j.stage] ?? j.stage}</td>
              <td><span className={`pill ${j.status === "failed" ? "failed" : j.status === "done" ? "completed" : j.status === "running" ? "writing" : ""}`}>{j.status}</span></td>
              <td>{j.progress?.chapter ? `${j.progress.chapter}/${j.progress.total}` : "—"}</td>
              <td>{j.attempts}</td>
              <td className="muted" style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.error ?? ""}</td>
              <td>{(j.status === "failed" || j.status === "paused") && <button onClick={() => retry(j.id)}>重跑</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
