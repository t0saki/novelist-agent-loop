import { useSyncExternalStore } from 'react';

export type ToastTone = 'ok' | 'danger' | 'info';
export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
}

let items: ToastItem[] = [];
let nextId = 1;
const subs = new Set<() => void>();
const emit = () => {
  for (const s of subs) s();
};

export function toast(text: string, tone: ToastTone = 'info'): void {
  const id = nextId++;
  items = [...items.slice(-3), { id, text, tone }];
  emit();
  setTimeout(() => dismissToast(id), tone === 'danger' ? 7000 : 3500);
}

export function dismissToast(id: number): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const useToasts = () =>
  useSyncExternalStore(
    (s) => {
      subs.add(s);
      return () => subs.delete(s);
    },
    () => items,
  );
