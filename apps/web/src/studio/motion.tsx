import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";

/**
 * Mouvement de l'interface (ADR-94) : des animations courtes et précises, et un interrupteur
 * « animations réduites » gardé sur ce poste. Par défaut, il suit le réglage de Windows.
 */
const KEY = "studio:motion";
type Motion = "full" | "reduced";

function initial(): Motion {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "full" || saved === "reduced") return saved;
  } catch {
    /* stockage indisponible : réglage du système */
  }
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduced" : "full";
}

const listeners = new Set<(m: Motion) => void>();
let current: Motion | null = null;

function apply(m: Motion) {
  current = m;
  document.documentElement.dataset.motion = m;
  for (const l of listeners) l(m);
}

/** À appeler une fois au démarrage : pose data-motion sur <html> avant le premier rendu animé. */
export function initMotion(): void {
  apply(initial());
}

export function useMotion(): [Motion, (m: Motion) => void] {
  const [m, setM] = useState<Motion>(current ?? initial());
  useEffect(() => {
    listeners.add(setM);
    return () => void listeners.delete(setM);
  }, []);
  const set = useCallback((next: Motion) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* le réglage ne survivra pas au rechargement, sans gravité */
    }
    apply(next);
  }, []);
  return [m, set];
}

/**
 * Le « glisseur » : un repère unique (fond ou soulignement) qui glisse jusqu'à l'élément actif d'un groupe,
 * au lieu d'apparaître d'un coup. `deps` : ce qui change l'élément actif (la route, l'onglet).
 */
export function useGlider(container: RefObject<HTMLElement | null>, selector: string, deps: unknown[]): void {
  useLayoutEffect(() => {
    const box = container.current;
    if (!box) return;
    let glider = box.querySelector<HTMLElement>(":scope > .glider");
    if (!glider) {
      glider = document.createElement("span");
      glider.className = "glider";
      glider.setAttribute("aria-hidden", "true");
      box.prepend(glider);
    }
    const place = () => {
      const target = box.querySelector<HTMLElement>(selector);
      if (!target || !glider) {
        glider?.classList.remove("on");
        return;
      }
      const b = box.getBoundingClientRect();
      const t = target.getBoundingClientRect();
      glider.style.setProperty("--gx", `${t.left - b.left + box.scrollLeft}px`);
      glider.style.setProperty("--gy", `${t.top - b.top + box.scrollTop}px`);
      glider.style.setProperty("--gw", `${t.width}px`);
      glider.style.setProperty("--gh", `${t.height}px`);
      // Première pose sans glisser depuis le coin.
      if (!glider.classList.contains("on")) {
        glider.classList.add("still");
        requestAnimationFrame(() => glider?.classList.remove("still"));
      }
      glider.classList.add("on");
    };
    place();
    // Le contenu peut bouger sans que le conteneur change de taille (police chargée, liste qui s'allonge) :
    // on suit aussi chacun de ses enfants.
    const ro = new ResizeObserver(place);
    const watch = () => {
      ro.disconnect();
      ro.observe(box);
      for (const child of box.children) if (child !== glider) ro.observe(child);
    };
    watch();
    void document.fonts?.ready.then(place);
    const mo = new MutationObserver((records) => {
      if (records.some((r) => r.target !== glider)) {
        watch();
        place();
      }
    });
    mo.observe(box, { subtree: true, attributes: true, attributeFilter: ["class"], childList: true });
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", place);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Les surfaces qui suivent la souris d'un halo très doux (survol « projecteur »). */
const SPOT = ".project-tile, .create-tile, .attention-card, .panel-card, .stat, .art-asset, .home-quick a";

/** Un seul écouteur pour toute l'application : il pose la position de la souris sur la surface survolée. */
export function installSpotlight(): () => void {
  let last: HTMLElement | null = null;
  const onMove = (e: PointerEvent) => {
    if (document.documentElement.dataset.motion === "reduced") return;
    const el = (e.target as Element | null)?.closest?.(SPOT) as HTMLElement | null;
    if (last && last !== el) last.classList.remove("spot-on");
    last = el;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
    if (!el.classList.contains("spot-on")) el.classList.add("spot-on");
  };
  const onLeave = () => {
    last?.classList.remove("spot-on");
    last = null;
  };
  document.addEventListener("pointermove", onMove, { passive: true });
  document.addEventListener("pointerleave", onLeave);
  return () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerleave", onLeave);
  };
}


/** Les groupes d'onglets segmentés (`.tabs`, `.segmented`) : un fond unique glisse sous l'onglet choisi. */
const SEGMENTS: [string, string][] = [
  [".tabs", ":scope > .tab.active"],
  [".segmented", ":scope > button.on"],
];

export function installAutoGliders(): () => void {
  const placed = new WeakMap<HTMLElement, HTMLElement>();
  const place = (box: HTMLElement, active: string) => {
    let g = placed.get(box);
    if (!g || g.parentElement !== box) {
      g = document.createElement("span");
      g.className = "glider seg-glider";
      g.setAttribute("aria-hidden", "true");
      box.prepend(g);
      placed.set(box, g);
    }
    const t = box.querySelector<HTMLElement>(active);
    if (!t) {
      g.classList.remove("on");
      box.classList.remove("has-glider");
      return;
    }
    const x = `${t.offsetLeft}px`;
    const y = `${t.offsetTop}px`;
    const w = `${t.offsetWidth}px`;
    const h = `${t.offsetHeight}px`;
    if (g.style.getPropertyValue("--gx") === x && g.style.getPropertyValue("--gy") === y && g.style.getPropertyValue("--gw") === w && g.classList.contains("on")) return;
    if (!g.classList.contains("on")) {
      g.classList.add("still");
      requestAnimationFrame(() => g!.classList.remove("still"));
    }
    g.style.setProperty("--gx", x);
    g.style.setProperty("--gy", y);
    g.style.setProperty("--gw", w);
    g.style.setProperty("--gh", h);
    g.classList.add("on");
    box.classList.add("has-glider");
  };
  let queued = false;
  const scan = () => {
    queued = false;
    for (const [sel, active] of SEGMENTS) for (const box of document.querySelectorAll<HTMLElement>(sel)) place(box, active);
  };
  const schedule = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(scan);
    }
  };
  const mo = new MutationObserver((records) => {
    if (records.some((r) => !(r.target instanceof HTMLElement && r.target.classList.contains("glider")))) schedule();
  });
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  window.addEventListener("resize", schedule);
  schedule();
  return () => {
    mo.disconnect();
    window.removeEventListener("resize", schedule);
  };
}
