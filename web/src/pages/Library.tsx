import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { BookCard } from "../types";
import { Loading, TopBar } from "../components";

export default function Library() {
  const [books, setBooks] = useState<BookCard[] | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("");

  async function load() {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (filter) params.set("status", filter);
    const r = await api.get<{ books: BookCard[] }>(`/api/reader/books?${params}`);
    setBooks(r.books);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  return (
    <>
      <TopBar>
        <input
          style={{ maxWidth: 200 }}
          placeholder="搜索书名…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
        />
        <select style={{ width: "auto" }} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">全部</option>
          <option value="writing">连载中</option>
          <option value="completed">已完结</option>
        </select>
      </TopBar>
      <div className="container">
        {!books ? (
          <Loading />
        ) : books.length === 0 ? (
          <div className="spin">书架空空如也，等待第一本书诞生…</div>
        ) : (
          <div className="grid">
            {books.map((b) => (
              <Link key={b.slug} to={`/book/${b.slug}`} className="book-card">
                <div className="cover">
                  {b.has_cover ? (
                    <img src={`/api/reader/books/${b.slug}/cover`} alt={b.title} />
                  ) : (
                    <div className="cover-title">{b.title}</div>
                  )}
                  <span className="badge">{b.status === "writing" ? "连载中" : "完结"}</span>
                  {b.nsfw && <span className="badge nsfw">R18</span>}
                </div>
                <div className="title">{b.title}</div>
                <div className="meta">
                  {b.theme} · {b.chapter_count}章 · {(b.word_count / 10000).toFixed(1)}万字
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
