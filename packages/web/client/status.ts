import { useSyncExternalStore } from 'react';
import type { ArcWebStatus } from '../src/types.js';

interface StatusSnapshot {
  data?: ArcWebStatus;
  error?: string;
  refreshing: boolean;
}
let snapshot: StatusSnapshot = { refreshing: true };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let request: AbortController | undefined;

function publish(value: StatusSnapshot): void {
  snapshot = value;
  for (const listener of listeners) listener();
}

export async function refreshStatus(): Promise<void> {
  request?.abort();
  const current = new AbortController();
  request = current;
  publish({ ...snapshot, refreshing: true });
  try {
    const response = await fetch('/arc/api/status', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: current.signal,
    });
    if (!response.ok)
      throw new Error(response.status === 401 || response.status === 403 ? 'unauthorized' : 'unavailable');
    const data = (await response.json()) as ArcWebStatus;
    if (data.product !== 'ARC') throw new Error('unavailable');
    if (!current.signal.aborted) publish({ data, refreshing: false });
  } catch (error) {
    if (!current.signal.aborted)
      publish({
        ...snapshot,
        refreshing: false,
        error: error instanceof Error ? error.message : 'unavailable',
      });
  }
}

function onVisibility(): void {
  if (!document.hidden) void refreshStatus();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshStatus();
    timer = setInterval(() => {
      if (!document.hidden) void refreshStatus();
    }, 5000);
    document.addEventListener('visibilitychange', onVisibility);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
      request?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

export function useStatus(): StatusSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}

function language(): boolean {
  return (document.documentElement.lang || navigator.language).toLowerCase().startsWith('zh');
}
function observeLanguage(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  return () => observer.disconnect();
}
export function useChinese(): boolean {
  return useSyncExternalStore(observeLanguage, language);
}
