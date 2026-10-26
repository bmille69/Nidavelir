import { useEffect, useRef, useState } from "react";

type Point = { x: number; y: number };
const INK = "#ff3b30";
/** Largeur d'export : assez pour lire le jeu, assez léger pour le directeur. */
const MAX_WIDTH = 1600;

/**
 * Montrer au lieu de décrire (ADR-72), d'après le « Draw » d'OhMyGame : vous entourez ou pointez au doigt ou à la souris ce
 * qui ne va pas sur une photo du jeu, vous dites un mot, et l'image annotée part au directeur. Les traits sont gardés dans
 * les pixels de l'image, puis redessinés sur une copie à l'export.
 */
export function Annotator({ source, title, onClose, onSend }: { source: string | Blob; title: string; onClose: () => void; onSend: (text: string, image: Blob) => Promise<void> }) {
  const [url] = useState(() => (typeof source === "string" ? source : URL.createObjectURL(source)));
  const img = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const drawing = useRef<Point[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => () => {
    if (typeof source !== "string") URL.revokeObjectURL(url);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);

  /** Épaisseur du trait, en pixels de l'image : lisible quelle que soit sa taille. */
  const width = (w: number) => Math.max(4, Math.round(w / 160));
  const paint = (ctx: CanvasRenderingContext2D, all: Point[][], scale: number, w: number, min = 0) => {
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // À l'écran, jamais plus fin que 3 px, même sur un téléphone.
    ctx.lineWidth = Math.max(width(w) * scale, min);
    for (const s of all) {
      if (s.length === 1) {
        // Un toucher seul : un point bien visible.
        ctx.beginPath();
        ctx.arc(s[0]!.x * scale, s[0]!.y * scale, width(w) * 2 * scale, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      s.forEach((p, k) => (k ? ctx.lineTo(p.x * scale, p.y * scale) : ctx.moveTo(p.x * scale, p.y * scale)));
      ctx.stroke();
    }
  };

  /** Le calque suit la taille affichée de l'image ; on y redessine tout à chaque trait. */
  const redraw = (all = strokes) => {
    const c = canvas.current;
    const i = img.current;
    if (!c || !i || !i.naturalWidth) return;
    const r = i.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
    c.style.width = `${r.width}px`;
    c.style.height = `${r.height}px`;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    paint(ctx, all, (r.width / i.naturalWidth) * dpr, i.naturalWidth, 3 * dpr);
  };
  useEffect(() => {
    redraw();
    const onResize = () => redraw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [strokes, ready]);

  const at = (e: React.PointerEvent): Point => {
    const i = img.current!;
    const r = i.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * i.naturalWidth, y: ((e.clientY - r.top) / r.height) * i.naturalHeight };
  };
  const down = (e: React.PointerEvent) => {
    if (!ready) return;
    try {
      // Le trait continue même si le doigt sort de l'image.
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      /* pointeur inconnu du navigateur : on dessine sans capture */
    }
    drawing.current = [at(e)];
    redraw([...strokes, drawing.current]);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    drawing.current.push(at(e));
    redraw([...strokes, drawing.current]);
  };
  const up = () => {
    if (!drawing.current) return;
    const s = drawing.current;
    drawing.current = null;
    setStrokes((all) => [...all, s]);
  };

  async function send() {
    const i = img.current;
    if (!i || busy) return;
    setBusy(true);
    setError(null);
    try {
      const scale = Math.min(1, MAX_WIDTH / i.naturalWidth);
      const out = document.createElement("canvas");
      out.width = Math.round(i.naturalWidth * scale);
      out.height = Math.round(i.naturalHeight * scale);
      const ctx = out.getContext("2d")!;
      ctx.drawImage(i, 0, 0, out.width, out.height);
      paint(ctx, strokes, scale, i.naturalWidth);
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/jpeg", 0.9));
      if (!blob) throw new Error("Impossible de préparer l'image");
      await onSend(text.trim(), blob);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="annotator" role="dialog" aria-label={title}>
      <div className="annotator-panel">
        <header className="annotator-head">
          <strong>{title}</strong>
          <span className="muted small">Entourez ou touchez ce qui ne va pas.</span>
          <button className="secondary small" onClick={onClose} disabled={busy}>
            Fermer
          </button>
        </header>
        <div className="annotator-stage">
          <div className="annotator-frame">
            <img ref={img} src={url} alt="" draggable={false} onLoad={() => setReady(true)} />
            <canvas ref={canvas} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
          </div>
        </div>
        <div className="annotator-tools">
          <button className="secondary small" disabled={!strokes.length || busy} onClick={() => setStrokes((s) => s.slice(0, -1))}>
            Annuler le trait
          </button>
          <button className="secondary small" disabled={!strokes.length || busy} onClick={() => setStrokes([])}>
            Tout effacer
          </button>
        </div>
        <div className="annotator-send">
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Qu'est-ce qui ne va pas ? (facultatif)" rows={2} disabled={busy} />
          <button onClick={send} disabled={busy || !ready}>
            {busy ? "Envoi…" : "Envoyer au directeur"}
          </button>
        </div>
        {error && <p className="error small">{error}</p>}
      </div>
    </div>
  );
}

/** Le message qui accompagne une image : votre mot (ou un mot par défaut), puis la ligne de l'image. */
export function withImage(text: string, line: string): string {
  return `${text || "Regarde ce que j'ai entouré sur cette capture du jeu."}\n\n${line}`;
}
