import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, getToken } from "../api";
import { BookDetail as TBookDetail } from "../types";
import { Loading, StatusPill, TopBar } from "../components";

export default function BookDetail() {
  const { slug } = useParams();
  const [book, setBook] = useState<TBookDetail | null>(null);
  const [resume, setResume] = useState(1);

  useEffect(() => {
    api.get<TBookDetail>(`/api/reader/books/${slug}`).then(setBook);
    api
      .get<{ chapter_index: number }>(`/api/reader/progress/${slug}`)
      .then((p) => setResume(p.chapter_index))
      .catch(() => {});
  }, [slug]);

  if (!book) return (<><TopBar /><Loading /></>);

  return (
    <>
      <TopBar />
      <div className="container">
        <div className="row" style={{ alignItems: "flex-start", gap: 24 }}>
          <div style={{ width: 160, flexShrink: 0 }}>
            <div className="cover">
              {book.has_cover ? (
                <img src={`/api/reader/books/${slug}/cover?token=${getToken()}`} alt={book.title} />
              ) : (
                <div className="cover-title">{book.title}</div>
              )}
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h1 style={{ margin: "0 0 8px" }}>{book.title}</h1>
            <div className="row" style={{ gap: 8, marginBottom: 12 }}>
              <StatusPill status={book.status} />
              <span className="pill">{book.theme}</span>
              {book.nsfw && <span className="pill failed">R18</span>}
              <span className="muted">
                {book.chapter_count}/{book.planned_chapters} 章 · {(book.word_count / 10000).toFixed(1)} 万字
              </span>
            </div>
            <p className="muted">{book.synopsis}</p>
            <div className="row" style={{ marginTop: 16 }}>
              <Link to={`/book/${slug}/read/${resume}`}>
                <button className="primary">{resume > 1 ? `续读 第${resume}章` : "开始阅读"}</button>
              </Link>
              <a href={`/api/reader/books/${slug}/epub?_t=${getToken()}`} onClick={downloadEpub(slug!)}>
                <button>下载 EPUB</button>
              </a>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 24 }}>
          <h3 style={{ marginTop: 0 }}>目录</h3>
          <div className="toc">
            {book.chapters.map((c) => (
              <Link key={c.index} to={`/book/${slug}/read/${c.index}`}>
                <span>{c.title}</span>
                <span className="muted">{c.word_count}字</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// EPUB 需带鉴权头，故用 fetch+blob 下载
function downloadEpub(slug: string) {
  return async (e: React.MouseEvent) => {
    e.preventDefault();
    const resp = await fetch(`/api/reader/books/${slug}/epub`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!resp.ok) return;
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug}.epub`;
    a.click();
    URL.revokeObjectURL(url);
  };
}
