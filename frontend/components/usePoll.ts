"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export type Poll<T> = { data: T | undefined; error: Error | undefined; refresh: () => void };

/** Periyodik veri çekme. Yükleniyor = `data` ve `error` ikisi de yok. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []): Poll<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const v = await fnRef.current();
        if (!alive) return;
        setData(v);
        setError(undefined);
      } catch (e) {
        if (alive) setError(e as Error);
      }
    };
    run();
    const id = setInterval(run, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, tick, ...deps]);

  return { data, error, refresh };
}

// ---------------------------------------------------------------- saat

const clockSubs = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | undefined;
function subscribeClock(cb: () => void) {
  clockSubs.add(cb);
  clockTimer ??= setInterval(() => clockSubs.forEach((f) => f()), 1000);
  return () => {
    clockSubs.delete(cb);
    if (!clockSubs.size && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}

/** Saniyede bir güncellenen unix saniye (render'da saf okunur). Sunucuda 0. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribeClock,
    () => Math.floor(Date.now() / 1000),
    () => 0,
  );
}

// ---------------------------------------------------------------- localStorage

function subscribeStorage(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener("darkscreener:storage", cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener("darkscreener:storage", cb);
  };
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // gizli pencere / engellenmiş depolama: oturumluk davran
  }
}

/** localStorage'daki ham değeri okur/yazar (tüm sekmelerde senkron). */
export function useStoredString(key: string): [string | null, (v: string) => void] {
  const value = useSyncExternalStore(
    subscribeStorage,
    () => readStorage(key),
    () => null,
  );
  const set = useCallback(
    (v: string) => {
      try {
        localStorage.setItem(key, v);
      } catch {}
      window.dispatchEvent(new Event("darkscreener:storage"));
    },
    [key],
  );
  return [value, set];
}
