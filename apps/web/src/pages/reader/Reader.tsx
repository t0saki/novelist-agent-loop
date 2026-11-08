/**
 * 阅读器（沉浸模式，沿用 v1：点按正文切换上下栏 + 全屏）。Owner: lane H。
 * 进度：打开时恢复滚动位置，滚动节流保存，离开页面用 keepalive 兜底。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ReaderBookDetail, ReaderChapter } from '@novelist/shared';
import { enc, get } from '../../api/client';
import { useApi } from '../../api/hooks';
import { queryClient } from '../../api/queryClient';
import { Button, cx, ErrorBox, Loading } from '../../components/ui';
import { READER_FAMILIES, READER_THEMES, scrollRatio, splitParagraphs, stepPrefs, type ReaderFamily, type ReaderPrefs } from '../../lib/reader';
import { readLocal, writeLocal } from '../../lib/storage';

const PREFS_KEY = 'nv.reader';
const stop = (e: MouseEvent) => e.stopPropagation();
const SAVE_EVERY_MS = 2500;

function defaultPrefs(): ReaderPrefs {
  const dark = document.documentElement.classList.contains('dark');
  return { font: 19, lineHeight: 1.9, theme: dark ? 'dark' : 'paper', family: 'serif', width: 42 };
}

export function ReaderPage({ slug, no }: { slug: string; no: number }) {
  const navigate = useNavigate();
  const base = `/api/reader/books/${enc(slug)}`;
  const chapterQ = useApi<ReaderChapter>(`${base}/chapters/${no}`, { staleMs: 300_000 });
  const bookQ = useApi<ReaderBookDetail>(base, { staleMs: 60_000 });
  const ch = chapterQ.data?.no === no ? chapterQ.data : undefined;

  const [prefs, setPrefs] = useState<ReaderPrefs>(() => ({ ...defaultPrefs(), ...readLocal<Partial<ReaderPrefs>>(PREFS_KEY, {}) }));
  const [chrome, setChrome] = useState(true);
  const [panel, setPanel] = useState<'settings' | 'toc' | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [ratio, setRatio] = useState(0);

  const ready = useRef(false);
  const lastRatio = useRef(0);
  const lastSaved = useRef('');
  const lastSaveAt = useRef(0);

  useEffect(() => writeLocal(PREFS_KEY, prefs), [prefs]);
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute('content', READER_THEMES.find((t) => t.id === prefs.theme)?.swatch ?? '#111111');
  }, [prefs.theme]);

  const save = useCallback(
    (chapter: number, scroll: number, keepalive = false) => {
      const body = JSON.stringify({ ch: chapter, scroll: Math.round(scroll * 1000) / 1000 });
      if (body === lastSaved.current) return;
      lastSaved.current = body;
      lastSaveAt.current = Date.now();
      // 不走 api()：保存失败不该弹错或跳登录，下一次滚动会重试
      void fetch(`${base}/progress`, { method: 'PUT', credentials: 'same-origin', keepalive, headers: { 'content-type': 'application/json' }, body }).catch(() => {
        lastSaved.current = '';
      });
    },
    [base],
  );

  // 进入章节：取服务端进度，同章恢复滚动位置，别的章从头读
  const loadedNo = ch?.no;
  useEffect(() => {
    if (loadedNo === undefined) return;
    let cancelled = false;
    let frame = 0;
    void get<{ ch: number; scroll: number } | null>(`${base}/progress`)
      .catch(() => null)
      .then((p) => {
        if (cancelled) return;
        const target = p?.ch === loadedNo ? p.scroll : 0;
        frame = requestAnimationFrame(() => {
          const el = document.documentElement;
          window.scrollTo(0, target * (el.scrollHeight - window.innerHeight));
          lastRatio.current = target;
          setRatio(target);
          ready.current = true;
          if (p?.ch !== loadedNo) save(loadedNo, 0);
        });
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (ready.current) save(loadedNo, lastRatio.current, true);
      ready.current = false;
    };
  }, [base, loadedNo, save]);

  useEffect(() => {
    if (loadedNo === undefined) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!ready.current) return;
        const el = document.documentElement;
        const r = scrollRatio(window.scrollY, el.scrollHeight, window.innerHeight);
        lastRatio.current = r;
        setRatio(r);
        if (Date.now() - lastSaveAt.current > SAVE_EVERY_MS) save(loadedNo, r);
      });
    };
    const flush = () => {
      if (ready.current && document.visibilityState === 'hidden') save(loadedNo, lastRatio.current, true);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, [loadedNo, save]);

  // 书库的“读到第 N 章”离开时刷新；预取下一章让翻页无等待
  useEffect(
    () => () => {
      void queryClient.invalidateQueries({ queryKey: ['/api/reader/books'], exact: true });
      void queryClient.invalidateQueries({ queryKey: [base], exact: true });
    },
    [base],
  );
  const nextNo = ch?.next ?? null;
  const prevNo = ch?.prev ?? null;
  useEffect(() => {
    if (nextNo === null) return;
    const path = `${base}/chapters/${nextNo}`;
    void queryClient.prefetchQuery({ queryKey: [path], queryFn: () => get<ReaderChapter>(path), staleTime: 300_000 });
  }, [base, nextNo]);

  const go = useCallback((target: number | null) => {
    if (target === null) return;
    setPanel(null);
    void navigate({ to: '/read/$slug/$no', params: { slug, no: String(target) } });
  }, [navigate, slug]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else {
      setChrome(false);
      void document.documentElement.requestFullscreen?.();
    }
  }, []);

  useEffect(() => {
    const h = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === 'ArrowRight') go(nextNo);
      else if (e.key === 'ArrowLeft') go(prevNo);
      else if (e.key === 'f') toggleFullscreen();
      else if (e.key === 't') setChrome((v) => !v);
      else if (e.key === 'Escape') setPanel(null);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [go, nextNo, prevNo, toggleFullscreen]);

  const paragraphs = useMemo(() => (ch ? splitParagraphs(ch.text, ch.title) : []), [ch]);
  const toc = useMemo(() => bookQ.data?.volumes.flatMap((v) => v.chapters) ?? [], [bookQ.data]);
  const pos = toc.findIndex((c) => c.no === no);

  function onBodyTap() {
    if (window.getSelection()?.toString()) return;
    setPanel(null);
    setChrome((v) => !v);
  }

  const style = {
    '--reader-font-size': `${prefs.font}px`,
    '--reader-line-height': prefs.lineHeight,
    '--reader-width': `${prefs.width}rem`,
    '--reader-font-family': READER_FAMILIES[prefs.family].css,
  } as CSSProperties;
  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled;
  const barBtn = 'px-2.5 py-1.5 text-sm rounded hover:opacity-70 disabled:opacity-40';

  return (
    <div className="reader" data-reader-theme={prefs.theme} style={style}>
      {!chrome && <div className="reader-progress" style={{ width: `${ratio * 100}%` }} />}

      <div className={cx('reader-bar top', !chrome && 'off')} onClick={stop}>
        <div className="flex items-center gap-1 px-2 py-1 max-w-4xl mx-auto">
          <Link to="/books/$slug" params={{ slug }} className={barBtn}>
            ← 目录
          </Link>
          <div className="flex-1 min-w-0 text-center text-sm truncate" style={{ color: 'var(--r-sub)' }}>
            {bookQ.data?.title}
          </div>
          <button type="button" className={barBtn} onClick={() => setPanel((p) => (p === 'toc' ? null : 'toc'))}>
            章节
          </button>
          <button type="button" className={barBtn} aria-label="排版设置" onClick={() => setPanel((p) => (p === 'settings' ? null : 'settings'))}>
            Aa
          </button>
          {canFullscreen && (
            <button type="button" className={barBtn} onClick={toggleFullscreen}>
              {fullscreen ? '退出全屏' : '全屏'}
            </button>
          )}
        </div>
      </div>

      <div onClick={onBodyTap}>
        {chapterQ.error ? (
          <div className="reader-body">
            <ErrorBox error={chapterQ.error} retry={() => void chapterQ.refetch()} />
          </div>
        ) : !ch ? (
          <div className="min-h-dvh flex items-center justify-center">
            <Loading text="翻页中…" />
          </div>
        ) : (
          <article className="reader-body">
            <div className="text-sm mb-2" style={{ color: 'var(--r-sub)' }}>
              {ch.volumeTitle}
            </div>
            <h1>
              第 {ch.no} 章 {ch.title}
            </h1>
            {paragraphs.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 正文段落顺序固定，且可能有相同文本
              <p key={i}>{p}</p>
            ))}
            <div className="flex gap-3 mt-12 text-base" style={{ fontFamily: 'var(--font-sans)' }} onClick={stop}>
              <button type="button" disabled={prevNo === null} onClick={() => go(prevNo)} className="flex-1 py-3 rounded-md border disabled:opacity-40" style={{ borderColor: 'var(--r-line)' }}>
                上一章
              </button>
              <button type="button" disabled={nextNo === null} onClick={() => go(nextNo)} className="flex-1 py-3 rounded-md border disabled:opacity-40" style={{ borderColor: 'var(--r-line)' }}>
                {nextNo === null ? '已是最新' : '下一章'}
              </button>
            </div>
          </article>
        )}
      </div>

      {panel === 'settings' && (
        <div className="fixed z-40 right-3 top-14 w-72 max-w-[calc(100vw-1.5rem)] rounded-lg border p-4 space-y-3 text-sm shadow-xl" style={{ background: 'var(--r-bg)', borderColor: 'var(--r-line)', color: 'var(--r-ink)' }} onClick={stop}>
          <PrefRow label="字号" value={`${prefs.font}px`} onDec={() => setPrefs((p) => ({ ...p, font: stepPrefs.font(p.font, -1) }))} onInc={() => setPrefs((p) => ({ ...p, font: stepPrefs.font(p.font, 1) }))} />
          <PrefRow label="行距" value={prefs.lineHeight.toFixed(1)} onDec={() => setPrefs((p) => ({ ...p, lineHeight: stepPrefs.lineHeight(p.lineHeight, -0.1) }))} onInc={() => setPrefs((p) => ({ ...p, lineHeight: stepPrefs.lineHeight(p.lineHeight, 0.1) }))} />
          <PrefRow label="版心" value={`${prefs.width}em`} onDec={() => setPrefs((p) => ({ ...p, width: stepPrefs.width(p.width, -2) }))} onInc={() => setPrefs((p) => ({ ...p, width: stepPrefs.width(p.width, 2) }))} />
          <div className="flex items-center justify-between gap-2">
            <span style={{ color: 'var(--r-sub)' }}>字体</span>
            <div className="flex gap-1">
              {(Object.keys(READER_FAMILIES) as ReaderFamily[]).map((f) => (
                <button key={f} type="button" onClick={() => setPrefs((p) => ({ ...p, family: f }))} className="px-2 py-0.5 rounded border" style={{ borderColor: prefs.family === f ? 'var(--r-ink)' : 'var(--r-line)' }}>
                  {READER_FAMILIES[f].label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-between">
            {READER_THEMES.map((t) => (
              <button key={t.id} type="button" onClick={() => setPrefs((p) => ({ ...p, theme: t.id }))} className="flex flex-col items-center gap-1 text-xs" aria-pressed={prefs.theme === t.id}>
                <span className="size-8 rounded-full border-2 block" style={{ background: t.swatch, borderColor: prefs.theme === t.id ? 'var(--r-ink)' : 'var(--r-line)' }} />
                {t.label}
              </button>
            ))}
          </div>
          <p className="text-xs" style={{ color: 'var(--r-sub)' }}>
            快捷键：← → 翻章 · F 全屏 · T 显示/隐藏工具栏
          </p>
        </div>
      )}

      {panel === 'toc' && <TocDrawer toc={toc} current={no} onGo={go} onClose={() => setPanel(null)} />}

      <div className={cx('reader-bar bottom', !chrome && 'off')} onClick={stop}>
        <div className="flex items-center justify-between px-2 py-1 max-w-4xl mx-auto">
          <button type="button" className={barBtn} disabled={prevNo === null} onClick={() => go(prevNo)}>
            上一章
          </button>
          <span className="text-xs tabular-nums" style={{ color: 'var(--r-sub)' }}>
            {pos >= 0 ? `${pos + 1} / ${toc.length}` : `第 ${no} 章`} · {Math.round(ratio * 100)}%
          </span>
          <button type="button" className={barBtn} disabled={nextNo === null} onClick={() => go(nextNo)}>
            下一章
          </button>
        </div>
      </div>
    </div>
  );
}

function PrefRow({ label, value, onDec, onInc }: { label: string; value: string; onDec: () => void; onInc: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span style={{ color: 'var(--r-sub)' }}>{label}</span>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" className="!text-inherit" onClick={onDec} aria-label={`${label}减小`}>
          −
        </Button>
        <span className="tabular-nums w-12 text-center">{value}</span>
        <Button size="sm" variant="ghost" className="!text-inherit" onClick={onInc} aria-label={`${label}增大`}>
          ＋
        </Button>
      </div>
    </div>
  );
}

function TocDrawer({ toc, current, onGo, onClose }: { toc: ReaderBookDetail['volumes'][number]['chapters']; current: number; onGo: (n: number) => void; onClose: () => void }) {
  const currentRef = useRef<HTMLButtonElement>(null);
  useEffect(() => currentRef.current?.scrollIntoView({ block: 'center' }), []);
  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div className="absolute inset-y-0 right-0 w-80 max-w-[85vw] overflow-y-auto border-l" style={{ background: 'var(--r-bg)', borderColor: 'var(--r-line)', color: 'var(--r-ink)' }} onClick={stop}>
        {toc.map((c) => (
          <button key={c.no} ref={c.no === current ? currentRef : undefined} type="button" onClick={() => onGo(c.no)} className="block w-full text-left px-4 py-2 text-sm truncate" style={{ fontWeight: c.no === current ? 600 : 400, color: c.no === current ? 'var(--r-ink)' : 'var(--r-sub)' }}>
            第 {c.no} 章 {c.title}
          </button>
        ))}
      </div>
    </div>
  );
}
