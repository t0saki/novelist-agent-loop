import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { BookDetail, ChapterContent } from "../types";
import { Loading, toggleTheme } from "../components";

export default function Reader() {
  const { slug, index } = useParams();
  const idx = Number(index);
  const nav = useNavigate();
  const [ch, setCh] = useState<ChapterContent | null>(null);
  const [book, setBook] = useState<BookDetail | null>(null);
  const [font, setFont] = useState(() => Number(localStorage.getItem("reader_font") ?? 19));

  useEffect(() => {
    setCh(null);
    api.get<ChapterContent>(`/api/reader/books/${slug}/chapters/${idx}`).then(setCh);
    window.scrollTo(0, 0);
  }, [slug, idx]);

  useEffect(() => {
    api.get<BookDetail>(`/api/reader/books/${slug}`).then(setBook);
  }, [slug]);

  // 保存进度
  useEffect(() => {
    if (!ch) return;
    api.put(`/api/reader/progress/${slug}`, { chapter_index: idx, scroll: 0 }).catch(() => {});
  }, [ch, slug, idx]);

  useEffect(() => {
    localStorage.setItem("reader_font", String(font));
  }, [font]);

  const chapters = book?.chapters ?? [];
  const pos = chapters.findIndex((c) => c.index === idx);
  const prev = pos > 0 ? chapters[pos - 1] : null;
  const next = pos >= 0 && pos < chapters.length - 1 ? chapters[pos + 1] : null;

  function go(target: number) {
    nav(`/book/${slug}/read/${target}`);
  }

  if (!ch) return <Loading text="翻页中…" />;

  return (
    <>
      <div className="reader-container">
        <div className="row between" style={{ marginBottom: 20 }}>
          <button onClick={() => nav(`/book/${slug}`)}>← 目录</button>
          <span className="muted">
            {book?.title} · {pos + 1}/{chapters.length}
          </span>
        </div>
        <article className="reader-body" style={{ ["--reader-font" as string]: `${font}px` }}>
          <h2>{ch.title}</h2>
          {ch.content.split("\n").filter((p) => p.trim()).map((p, i) => (
            <p key={i}>{p.trim()}</p>
          ))}
        </article>
        <div className="row between" style={{ marginTop: 40 }}>
          <button disabled={!prev} onClick={() => prev && go(prev.index)}>← 上一章</button>
          <button disabled={!next} onClick={() => next && go(next.index)}>
            {next ? "下一章 →" : "已是最新"}
          </button>
        </div>
      </div>

      <div className="reader-toolbar">
        <button onClick={() => setFont((f) => Math.max(14, f - 1))}>A-</button>
        <span className="muted" style={{ minWidth: 40, textAlign: "center" }}>{font}px</span>
        <button onClick={() => setFont((f) => Math.min(30, f + 1))}>A+</button>
        <button onClick={toggleTheme}>◑</button>
        <button disabled={!prev} onClick={() => prev && go(prev.index)}>上一章</button>
        <button disabled={!next} onClick={() => next && go(next.index)}>下一章</button>
      </div>
    </>
  );
}
