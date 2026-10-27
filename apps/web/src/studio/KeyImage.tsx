import { type ReactNode, useEffect, useState } from "react";
import { api, type TaskRow } from "../api.ts";

/**
 * L'image clé d'un jeu (ADR-86) : la dernière capture d'un chantier fusionné ou en relecture,
 * à défaut le style retenu par la Direction artistique. Sans l'une ni l'autre, l'initiale reste.
 */
export function latestShot(slug: string, tasks: TaskRow[]): string | null {
  const t = tasks.filter((x) => x.status === "merged" || x.status === "review").sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1))[0];
  return t ? api.screenshotUrl(slug, t.id, t.updated_at) : null;
}

/** Relu chaque minute, et à chaque changement de `refresh` (l'onglet du projet, par exemple). */
const EVERY = 60_000;

/** Le style retenu par la DA (duel de styles, ADR-58), ou null. */
export function useStyleImage(slug: string, refresh?: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => setUrl(null), [slug]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.art(slug).then(
        (s) => alive && setUrl(s.direction?.style?.file ? api.artFile(slug, s.direction.style.file) : null),
        () => {},
      );
    void load();
    const t = setInterval(() => void load(), EVERY);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [slug, refresh]);
  return url;
}

/** Capture du dernier chantier, puis style de la DA. */
export function useKeyImages(slug: string, refresh?: string): string[] {
  const [shot, setShot] = useState<string | null>(null);
  const style = useStyleImage(slug, refresh);
  useEffect(() => setShot(null), [slug]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.tasks(slug).then(
        (t) => alive && setShot(latestShot(slug, t)),
        () => {},
      );
    void load();
    const t = setInterval(() => void load(), EVERY);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [slug, refresh]);
  return [shot, style].filter((x): x is string => !!x);
}

/** La première image des candidates qui se charge ; si aucune, le repli. */
export function KeyImage({ urls, className, fallback = null }: { urls: (string | null)[]; className?: string; fallback?: ReactNode }) {
  const list = urls.filter((x): x is string => !!x);
  const sig = list.join("|");
  const [failed, setFailed] = useState<string[]>([]);
  useEffect(() => setFailed([]), [sig]);
  const src = list.find((u) => !failed.includes(u));
  if (!src) return <>{fallback}</>;
  return <img className={className} src={src} alt="" loading="lazy" onError={() => setFailed((f) => [...f, src])} />;
}
