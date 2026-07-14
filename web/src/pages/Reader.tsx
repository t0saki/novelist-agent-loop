import { MouseEvent, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { BookDetail, ChapterContent } from "../types";
import { Loading, toggleTheme } from "../components";

const stop = (e: MouseEvent) => e.stopPropagation();

export default function Reader() {
  const { slug, index } = useParams();
  const idx = Number(index);
  const nav = useNavigate();
  const [ch, setCh] = useState<ChapterContent | null>(null);
  const [book, setBook] = useState<BookDetail | null>(null);
  const [font, setFont] = useState(() => Number(localStorage.getItem("reader_font") ?? 19));
  const [lineH, setLineH] = useState(() => Number(localStorage.getItem("reader_lineh") ?? 1.9));
  const [chrome, setChrome] = useState(true); // 上下栏是否可见（默认可见，便于发现）
  const [settings, setSettings] = useState(false);
  const [fs, setFs] = useState(false);

  useEffect(() => {
    setCh(null);
    api.get<ChapterContent>(`/api/reader/books/${slug}/chapters/${idx}`).then(setCh);
    window.scrollTo(0, 0);
  }, [slug, idx]);

  useEffect(() => {
    api.get<BookDetail>(`/api/reader/books/${slug}`).then(setBook);
  }, [slug]);

  useEffect(() => {
    if (!ch) return;
    api.put(`/api/reader/progress/${slug}`, { chapter_index: idx, scroll: 0 }).catch(() => {});
  }, [ch, slug, idx]);

  useEffect(() => localStorage.setItem("reader_font", String(font)), [font]);
  useEffect(() => localStorage.setItem("reader_lineh", String(lineH)), [lineH]);

  // 全屏状态跟踪
  useEffect(() => {
    const h = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);

  const chapters = book?.chapters ?? [];
  const pos = chapters.findIndex((c) => c.index === idx);
  const prev = pos > 0 ? chapters[pos - 1] : null;
  const next = pos >= 0 && pos < chapters.length - 1 ? chapters[pos + 1] : null;

  function go(target: number) {
    nav(`/book/${slug}/read/${target}`);
  }

  // 方向键翻章
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && /INPUT|TEXTAREA/.test(t.tagName)) return;
      if (e.key === "ArrowRight" && next) go(next.index);
      else if (e.key === "ArrowLeft" && prev) go(prev.index);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prev, next, slug]);

  function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  if (!ch) return <Loading text="翻页中…" />;

  return (
    <div className="reader-root">
      {/* 顶栏 */}
      <div className={`reader-bar top ${chrome ? "" : "hidden"}`} onClick={stop}>
        <button onClick={() => nav(`/book/${slug}`)}>← 目录</button>
        <div className="bar-title">{book?.title} · 第{idx}章 · {pos + 1}/{chapters.length}</div>
        <div className="bar-actions">
          <button onClick={() => setSettings((v) => !v)} title="字号/行距">Aa</button>
          <button onClick={toggleTheme} title="明暗">◑</button>
          <button onClick={toggleFullscreen} title={fs ? "退出全屏" : "全屏"}>{fs ? "⤢" : "⛶"}</button>
        </div>
      </div>

      {/* 正文：点击切换上下栏 */}
      <div className="reader-scroll" onClick={() => { setChrome((v) => !v); setSettings(false); }}>
        <article className="reader-body" style={{ ["--reader-font" as string]: `${font}px`, ["--reader-lineh" as string]: lineH }}>
          <h2>{ch.title}</h2>
          {ch.content.split("\n").filter((p) => p.trim()).map((p, i) => (
            <p key={i}>{p.trim()}</p>
          ))}
          <div className="chapter-end-nav" onClick={stop}>
            <button disabled={!prev} onClick={() => prev && go(prev.index)}>← 上一章</button>
            <button disabled={!next} onClick={() => next && go(next.index)}>{next ? "下一章 →" : "已是最新"}</button>
          </div>
        </article>
      </div>

      {/* 设置气泡 */}
      {settings && (
        <div className="reader-settings" onClick={stop}>
          <div className="seg">
            <span className="seg-label">字号</span>
            <button onClick={() => setFont((f) => Math.max(14, f - 1))}>A-</button>
            <span className="val">{font}px</span>
            <button onClick={() => setFont((f) => Math.min(32, f + 1))}>A+</button>
          </div>
          <div className="seg">
            <span className="seg-label">行距</span>
            <button onClick={() => setLineH((l) => Math.max(1.4, +(l - 0.1).toFixed(1)))}>紧</button>
            <span className="val">{lineH.toFixed(1)}</span>
            <button onClick={() => setLineH((l) => Math.min(2.6, +(l + 0.1).toFixed(1)))}>松</button>
          </div>
        </div>
      )}

      {/* 底栏 */}
      <div className={`reader-bar bottom ${chrome ? "" : "hidden"}`} onClick={stop}>
        <button disabled={!prev} onClick={() => prev && go(prev.index)}>‹ 上一章</button>
        <span className="bar-progress">{pos + 1} / {chapters.length}</span>
        <button disabled={!next} onClick={() => next && go(next.index)}>下一章 ›</button>
      </div>
    </div>
  );
}
