export interface BookCard {
  slug: string;
  title: string;
  synopsis: string;
  status: string;
  nsfw: boolean;
  theme: string;
  tone: string;
  word_count: number;
  planned_chapters: number;
  chapter_count: number;
  has_cover: boolean;
  completed_at: string | null;
  updated_at: string | null;
}

export interface ChapterMeta {
  index: number;
  title: string;
  word_count: number;
}

export interface BookDetail extends BookCard {
  chapters: ChapterMeta[];
}

export interface ChapterContent {
  index: number;
  title: string;
  content: string;
  word_count: number;
}

export interface Theme {
  id: number;
  name: string;
  keywords: string[];
  style_prompt: string;
  length_hint: string;
  min_chapters: number | null;
  weight: number;
  nsfw: boolean;
  enabled: boolean;
}

export interface Profile {
  id: number;
  name: string;
  kind: string;
  base_url: string;
  api_key_set: boolean;
  model: string;
  temperature: number;
  max_tokens: number | null;
  price_prompt_per_mtok: number;
  price_completion_per_mtok: number;
  supports_tools: boolean;
  extra: Record<string, unknown>;
  enabled: boolean;
  is_default: boolean;
}

export interface Job {
  id: number;
  novel_id: number | null;
  novel_title: string;
  slug: string | null;
  type: string;
  stage: string;
  status: string;
  attempts: number;
  progress: { chapter?: number; total?: number; words?: number };
  error: string | null;
  updated_at: string | null;
}

export interface AdminNovel {
  id: number;
  slug: string;
  title: string;
  status: string;
  theme: string;
  nsfw: boolean;
  planned_chapters: number;
  chapters_written: number;
  word_count: number;
  tokens_total: number;
  cost_total: number;
  quality_debt: number;
  error: string | null;
  created_at: string | null;
}

export interface Stats {
  novels_by_status: Record<string, number>;
  books_today: number;
  cost_today: number;
  queue: Record<string, number>;
  rate_limit: {
    books_per_day: number;
    books_today: number;
    books_per_5h: number;
    books_last_5h: number;
    day_ok: boolean;
    h5_ok: boolean;
  };
  budget: {
    daily_tokens: number;
    tokens_today: number;
    per_book_tokens: number;
    daily_ok: boolean;
  };
  scheduler_paused: boolean;
  auto_generate: boolean;
}
