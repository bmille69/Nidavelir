import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type StudioSnapshot } from "../api.ts";

const StudioContext = createContext<StudioSnapshot | null>(null);
const RefreshContext = createContext<() => void>(() => {});

/** Interroge le hub toutes les 2,5 s (en pause quand l'onglet est caché) et partage l'état de l'équipe. */
export function StudioProvider({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<StudioSnapshot | null>(null);
  const [tick, setTick] = useState<() => void>(() => () => {});
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      api.studio().then((s) => alive && setSnap(s), () => {});
    };
    setTick(() => tick);
    tick();
    const t = setInterval(tick, 2500);
    document.addEventListener("visibilitychange", tick);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  return (
    <RefreshContext.Provider value={tick}>
      <StudioContext.Provider value={snap}>{children}</StudioContext.Provider>
    </RefreshContext.Provider>
  );
}

export function useStudio(): StudioSnapshot | null {
  return useContext(StudioContext);
}

/** Rafraîchit tout de suite l'état du studio (après une action). */
export function useStudioRefresh(): () => void {
  return useContext(RefreshContext);
}

/** Horloge locale pour les durées (« depuis 2 min »). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
