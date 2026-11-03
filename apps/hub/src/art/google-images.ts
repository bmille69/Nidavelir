import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GenRequest, GenState, ImageGenPort } from "./imagegen.ts";
import { VIEWS, type View, type ViewEdit, type ViewImage } from "./model3d.ts";

/**
 * Google Gemini (« Nano Banana ») comme générateur d'images du Directeur artistique (ADR-110) : par l'API REST
 * `generateContent`, avec des images de référence jointes. Nano Banana 2.1 dessine croquis et essais ; Nano Banana Pro
 * les retouches qui mènent à l'image finale et les vues de la planche, que Tripo copie. La clé vit dans les données du hub (jamais
 * dans un dépôt ni dans une réponse au navigateur) ; un plafond mensuel en dollars borne la dépense. Sans clé, plafond
 * atteint ou erreur : le générateur local (Flux) prend le relais, comme avant.
 */

export type GoogleState = { configured: boolean; month: string; usd: number; cap: number };
/** `draft` : Nano Banana 2.1 (croquis, variantes) ; `final` : Nano Banana Pro (retouche vers l'image finale, vues de la planche). */
export type GoogleTier = "draft" | "final";
export type GoogleSize = "1K" | "2K";
export type GoogleRequest = { prompt: string; images: Buffer[]; tier: GoogleTier; size: GoogleSize; aspect?: string | null };
export type GoogleImage = { image: Buffer; mime: string; model: string; label: string; usd: number };

/**
 * Les modèles et leurs prix estimés par image produite (page « pricing » de l'API Gemini, octobre 2026). Le prix réel
 * dépend aussi des images jointes (quelques dixièmes de centime) : c'est une estimation, comme son nom l'indique.
 */
export const GEMINI_DRAFT = { id: process.env.STUDIO_GEMINI_DRAFT_MODEL ?? "gemini-nano-banana-2.1", label: "Nano Banana 2.1", usd: { "1K": 0.0336, "2K": 0.0504 } } as const;
export const GEMINI_FINAL = { id: process.env.STUDIO_GEMINI_FINAL_MODEL ?? "gemini-3-pro-image", label: "Nano Banana Pro", usd: { "1K": 0.134, "2K": 0.134 } } as const;
/** Plafond mensuel par défaut, en dollars. */
export const GOOGLE_MONTHLY_USD = 10;
const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
/** Au plus 6 images jointes : la limite d'objets de Nano Banana Pro, la plus basse des deux. */
const MAX_IMAGES = 6;
/** Les essais d'une demande que le filtre de Google bloque sans raison stable. */
const BLOCKED_TRIES = 4;
/** Les formats d'image que Gemini sait rendre. */
const RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const UA = { "user-agent": "nidavellir-hub" };

export interface GoogleImagesPort {
  state(): GoogleState;
  /** Vérifie la clé auprès de Google (lister les modèles ne coûte rien), puis la garde dans les données du hub. */
  setKey(key: string): Promise<void>;
  setCap(usd: number): void;
  /** Pourquoi Google ne peut pas dessiner maintenant (`null` s'il peut) ; « pas de clé » se lit dans state().configured. */
  unavailable(tier: GoogleTier, size: GoogleSize): string | null;
  generate(req: GoogleRequest): Promise<GoogleImage>;
}

/** Une erreur de Google, sans jamais la clé dedans. */
class GoogleError extends Error {}

export class RealGoogleImages implements GoogleImagesPort {
  readonly #dir: string;
  readonly #defaultCap: number;

  constructor(dataDir: string, monthlyUsd = Number(process.env.STUDIO_GOOGLE_MONTHLY_USD ?? GOOGLE_MONTHLY_USD)) {
    this.#dir = join(dataDir, "tools", "google");
    this.#defaultCap = Number.isFinite(monthlyUsd) && monthlyUsd >= 0 ? monthlyUsd : GOOGLE_MONTHLY_USD;
  }

  #key(): string | null {
    const file = join(this.#dir, "key.json");
    if (!existsSync(file)) return null;
    try {
      return (JSON.parse(readFileSync(file, "utf8")) as { key: string }).key || null;
    } catch {
      return null;
    }
  }

  #usage(): { month: string; usd: number } {
    const month = new Date().toISOString().slice(0, 7);
    try {
      const u = JSON.parse(readFileSync(join(this.#dir, "usage.json"), "utf8")) as { month: string; usd: number };
      return u.month === month ? u : { month, usd: 0 };
    } catch {
      return { month, usd: 0 };
    }
  }

  #spend(usd: number): void {
    const u = this.#usage();
    mkdirSync(this.#dir, { recursive: true });
    writeFileSync(join(this.#dir, "usage.json"), JSON.stringify({ month: u.month, usd: Math.round((u.usd + usd) * 10_000) / 10_000 }), "utf8");
  }

  #cap(): number {
    try {
      const { cap } = JSON.parse(readFileSync(join(this.#dir, "settings.json"), "utf8")) as { cap: number };
      return Number.isFinite(cap) && cap >= 0 ? cap : this.#defaultCap;
    } catch {
      return this.#defaultCap;
    }
  }

  state(): GoogleState {
    const u = this.#usage();
    return { configured: this.#key() !== null, month: u.month, usd: u.usd, cap: this.#cap() };
  }

  async setKey(key: string): Promise<void> {
    const k = key.trim();
    if (!/^[\w.-]{30,}$/.test(k)) throw new Error("Une clé Google ressemble à « AIza… » (page « API keys » d'aistudio.google.com)");
    await this.#call(k, "GET", "/models?pageSize=1");
    mkdirSync(this.#dir, { recursive: true });
    writeFileSync(join(this.#dir, "key.json"), JSON.stringify({ key: k }), "utf8");
  }

  setCap(usd: number): void {
    if (!Number.isFinite(usd) || usd < 0 || usd > 1000) throw new Error("Le plafond mensuel va de 0 à 1000 $");
    mkdirSync(this.#dir, { recursive: true });
    writeFileSync(join(this.#dir, "settings.json"), JSON.stringify({ cap: Math.round(usd * 100) / 100 }), "utf8");
  }

  unavailable(tier: GoogleTier, size: GoogleSize): string | null {
    if (!this.#key()) return "pas de clé Google";
    const s = this.state();
    if (s.usd + modelOf(tier).usd[size] > s.cap) return `plafond mensuel Google atteint (${usd(s.usd)} sur ${usd(s.cap)}), il repart le mois prochain`;
    return null;
  }

  async generate(req: GoogleRequest): Promise<GoogleImage> {
    const key = this.#key();
    const why = this.unavailable(req.tier, req.size);
    if (!key || why) throw new GoogleError(why ?? "pas de clé Google");
    const model = modelOf(req.tier);
    const images = req.images.slice(0, MAX_IMAGES);
    const body = {
      contents: [{ role: "user", parts: [{ text: req.prompt }, ...images.map((b) => ({ inlineData: { mimeType: mimeOf(b), data: b.toString("base64") } }))] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { imageSize: req.size, ...(req.aspect ? { aspectRatio: req.aspect } : {}) } },
    };
    // Le filtre de Google bloque au hasard une même demande (un personnage armé : une fois sur deux en essai réel) ; une
    // réponse bloquée n'est pas facturée comme une image : on redemande jusqu'à BLOCKED_TRIES fois avant d'abandonner.
    let blob: GeminiBlob | undefined;
    let reason = "aucune image rendue";
    for (let attempt = 0; attempt < BLOCKED_TRIES && !blob?.data; attempt++) {
      const data = (await this.#call(key, "POST", `/models/${encodeURIComponent(model.id)}:generateContent`, body)) as GeminiResponse;
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      blob = parts.map((p) => p.inlineData ?? p.inline_data).find((b) => b?.data);
      reason = data.promptFeedback?.blockReason ?? data.candidates?.[0]?.finishReason ?? "aucune image rendue";
    }
    if (!blob?.data) throw new GoogleError(`${model.label} n'a pas rendu d'image (${reason})`);
    // Seule une image rendue est comptée : c'est elle que Google facture.
    const cost = model.usd[req.size];
    this.#spend(cost);
    return { image: Buffer.from(blob.data, "base64"), mime: blob.mimeType ?? blob.mime_type ?? "image/png", model: model.id, label: model.label, usd: cost };
  }

  async #call(key: string, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${GEMINI}${path}`, {
        method,
        headers: { "x-goog-api-key": key, ...UA, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(4 * 60_000),
      });
    } catch (err) {
      throw new GoogleError(`Google injoignable (${hide((err as Error).message, key).slice(0, 160)})`);
    }
    const text = await res.text();
    let payload: { error?: { message?: string; status?: string } } = {};
    try {
      payload = text ? (JSON.parse(text) as typeof payload) : {};
    } catch {
      /* réponse non JSON : traitée par le code HTTP */
    }
    if (res.status === 400 && /api key/i.test(payload.error?.message ?? "")) throw new GoogleError("Google refuse la clé");
    if (res.status === 401 || res.status === 403) throw new GoogleError("Google refuse la clé");
    if (res.status === 429) throw new GoogleError("Google limite les demandes pour l'instant (quota ou facturation du projet)");
    if (!res.ok) throw new GoogleError(`Google répond ${res.status}${payload.error?.message ? ` : ${hide(payload.error.message, key).slice(0, 200)}` : ""}`);
    return payload;
  }
}

type GeminiBlob = { mimeType?: string; mime_type?: string; data?: string };
type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string; inlineData?: GeminiBlob; inline_data?: GeminiBlob }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
};

export const modelOf = (tier: GoogleTier) => (tier === "final" ? GEMINI_FINAL : GEMINI_DRAFT);
const usd = (n: number) => `${n.toFixed(2).replace(".", ",")} $`;
const hide = (text: string, key: string) => (key ? text.split(key).join("…") : text);

function mimeOf(b: Buffer): string {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "RIFF") return "image/webp";
  return "image/png";
}

/** Le format Gemini le plus proche d'une largeur et d'une hauteur. */
export function aspectOf(width: number, height: number): string {
  const r = width / height;
  return RATIOS.reduce((best, a) => {
    const [w, h] = a.split(":").map(Number) as [number, number];
    const [bw, bh] = best.split(":").map(Number) as [number, number];
    return Math.abs(Math.log(w / h / r)) < Math.abs(Math.log(bw / bh / r)) ? a : best;
  });
}

// ── Ce que le fil raconte (ADR-110) ──

/** Une image dessinée par Google (son coût estimé), ou Google écarté au profit d'un autre outil. */
export type GenNote = { kind: "google"; label: string; usd: number } | { kind: "fallback"; reason: string; to: string };

/** Les lignes sobres du fil : ce que Google a dessiné et coûté, et pourquoi il a été écarté. Rien sans Google. */
export function noteLines(notes: GenNote[]): string[] {
  const drawn = notes.filter((n): n is Extract<GenNote, { kind: "google" }> => n.kind === "google");
  const counts = new Map<string, number>();
  for (const n of drawn) counts.set(n.label, (counts.get(n.label) ?? 0) + 1);
  const total = drawn.reduce((s, n) => s + n.usd, 0);
  const fallbacks = [...new Set(notes.filter((n): n is Extract<GenNote, { kind: "fallback" }> => n.kind === "fallback").map((n) => `Google indisponible : ${n.reason} → ${n.to}.`))];
  return [
    ...(drawn.length ? [`Images Google : ${[...counts].map(([label, k]) => `${k} × ${label}`).join(", ")} · ≈ ${usd(total)}.`] : []),
    ...fallbacks,
  ];
}

// ── Le générateur des visuels : Google d'abord s'il le peut, sinon Flux ──

const STYLE_REFS =
  "The additional attached images are style references from the same game (its art bible and assets already approved): match their art style, palette, line work and rendering, but do not copy their subjects.";

/**
 * Le générateur d'images du Directeur artistique : les demandes qui le permettent (`tier` donné, pas de réduction en pixel
 * art) partent chez Google ; sans clé, plafond atteint ou erreur, le générateur local les dessine, comme avant. Les
 * installations, l'état et la file restent ceux du générateur local.
 */
export class RoutedImageGen implements ImageGenPort {
  readonly #local: ImageGenPort;
  readonly #google: GoogleImagesPort;

  constructor(local: ImageGenPort, google: GoogleImagesPort) {
    this.#local = local;
    this.#google = google;
  }

  state(): GenState {
    return this.#local.state();
  }
  install(): void {
    this.#local.install();
  }
  installKontext(): void {
    this.#local.installKontext();
  }
  close(): void {
    this.#local.close();
  }

  async generate(req: GenRequest): Promise<Buffer> {
    if (!req.tier || req.scale || !this.#google.state().configured) return this.#local.generate(req);
    const size: GoogleSize = req.size ?? "1K";
    const why = this.#google.unavailable(req.tier, size);
    if (!why) {
      try {
        const g = await this.#google.generate({ ...googleRequest(req), tier: req.tier, size, aspect: aspectOf(req.width, req.height) });
        req.report?.({ kind: "google", label: g.label, usd: g.usd });
        return g.image;
      } catch (err) {
        req.report?.({ kind: "fallback", reason: (err as Error).message.slice(0, 200), to: "générateur local" });
      }
    } else req.report?.({ kind: "fallback", reason: why, to: "générateur local" });
    return this.#local.generate(req);
  }
}

/** La demande faite pour Flux, dite à Gemini : la consigne et ses images, puis les références de style du jeu. */
function googleRequest(req: GenRequest): { prompt: string; images: Buffer[] } {
  const refs = req.refs ?? [];
  const tail = refs.length ? ` ${STYLE_REFS}` : "";
  if (req.edit) {
    const [first, ...style] = req.edit.images;
    const lead = style.length ? "Edit the first attached image; the next ones show the style to follow." : "Edit the attached image.";
    return { prompt: `${lead} ${req.prompt} Keep everything else identical: subject, pose, framing, colors, lighting, plain background.${tail}`, images: [...(first ? [first] : []), ...style, ...refs] };
  }
  if (req.init) {
    const free = req.init.denoise > 0.6 ? " Details may change more freely." : "";
    return { prompt: `Draw a variation of the attached sketch: keep its composition, pose, silhouette and colors, with a cleaner, more finished rendering.${free} ${req.prompt}${tail}`, images: [req.init.image, ...refs] };
  }
  return { prompt: `${req.prompt}${tail}`, images: refs };
}

// ── La planche dessinée par Google (ADR-110) ──

/**
 * Les vues de la planche dessinées par Google : l'image de référence occupe la case qu'elle montre (la face d'ordinaire,
 * un côté ou le dos sinon, ADR-115), les autres viennent de Nano Banana.
 */
export interface SheetPort {
  /** Les quatre vues, dans l'ordre de Tripo. */
  draw(): Promise<ViewImage[]>;
  /** Une vue refaite à la demande du validateur, par Nano Banana Pro ; les autres vues ne bougent pas. */
  retouch(views: ViewImage[], edit: ViewEdit): Promise<Buffer>;
}

// Formulé en « plateau tournant » : en essai réel (le Héron, A-0005), la consigne longue « Draw the subject's LEFT side…
// Same character… » était bloquée par le filtre de Google à chaque essai, celle-ci passe le plus souvent (et `generate`
// redemande ce qui reste bloqué).
const SIDE: Record<Exclude<View, "front">, string> = {
  left: "90 degrees on a turntable and draw its LEFT side view, facing left",
  back: "180 degrees on a turntable and draw its BACK view",
  right: "90 degrees on a turntable and draw its RIGHT side view, facing right",
};
const STRICT =
  "Same character, same pose, same proportions, same colors and materials, same neutral even lighting, plain uniform light background, full body in frame, same scale and framing, no shadows, no text, orthographic-like view.";

/**
 * Une référence de profil ou de dos (ADR-115) : ce qu'elle montre, et chaque vue à dessiner, dite depuis elle. Côtés DU
 * SUJET, comme les cases de Tripo (voir `referenceView`).
 */
const SHOWN: Record<Exclude<View, "front">, string> = {
  left: "its LEFT side (it faces the left of the picture)",
  back: "its BACK (we see it from behind)",
  right: "its RIGHT side (it faces the right of the picture)",
};
const TURN: Record<View, string> = {
  front: "draw its FRONT view: the subject faces the camera, head and chest toward the viewer, symmetrical, as on a character turnaround sheet",
  left: "draw its LEFT side view: the subject faces the left of the picture, so we see its left flank",
  back: "draw its BACK view: the subject turns its back to the camera",
  right: "draw its RIGHT side view: the subject faces the right of the picture, so we see its right flank",
};

/**
 * La planche de Google pour l'image de référence validée `front` : gauche, dos et droite en 1K, chacune avec la face (et
 * les vues déjà dessinées) en références. `report` reçoit le coût de chaque image et, si Google se dérobe, la raison.
 * `reference` (ADR-115) : la case que l'image montre vraiment. Hors face, elle est placée dans cette case et Google
 * dessine les trois autres, la face d'abord (le Chien, A-0002 : de profil, la planche d'avant rendait trois fois le
 * même profil, refusée deux fois, 1,35 $ perdus).
 */
export function googleSheet(google: GoogleImagesPort, front: Buffer, report: (n: GenNote) => void, reference: View = "front"): SheetPort {
  if (reference !== "front") return turnedSheet(google, front, report, reference);
  // 1K, sans format imposé : en essai réel, la même vue de dos demandée en 2K ou avec un format était bloquée par le filtre de
  // Google, passait en 1K sans format ; Tripo n'a pas besoin de plus de 1024 px par vue.
  return {
    async draw() {
      const views: ViewImage[] = [{ view: "front", image: front }];
      try {
        // Nano Banana Pro pour les trois vues : en essai réel (le Héron, A-0005), Nano Banana 2.1 refusait deux demandes sur
        // trois (filtre PROHIBITED_CONTENT sur un personnage armé) et ses vues étaient moins fidèles ; Pro a rendu les trois
        // vues du premier coup, fidèles au concept (≈ 0,40 $ la planche, que Tripo ne facture plus).
        const why = google.unavailable("final", "1K");
        if (why) throw new Error(why);
        for (const view of VIEWS.slice(1) as Exclude<View, "front">[]) {
          const g = await google.generate({
            prompt: `Rotate this stylized video game asset (the first attached image, its front view) ${SIDE[view]}: same design, same colors, same pose, same proportions, plain light background, orthographic view.${views.length > 1 ? " The other attached images are views already drawn of it: stay consistent with them." : ""}`,
            images: views.map((v) => v.image),
            tier: "final",
            size: "1K",
          });
          report({ kind: "google", label: g.label, usd: g.usd });
          views.push({ view, image: g.image });
        }
      } catch (err) {
        report({ kind: "fallback", reason: (err as Error).message.slice(0, 200), to: "planche dessinée par Tripo" });
        throw err;
      }
      return views;
    },
    async retouch(views, edit) {
      const target = views.find((v) => v.view === edit.view);
      if (!target) throw new Error(`vue « ${edit.view} » absente`);
      const why = google.unavailable("final", "1K");
      if (why) throw new Error(why);
      const g = await google.generate({
        prompt: `Edit the first attached image (the ${edit.view.toUpperCase()} view of a game asset; the second image is its FRONT view): ${edit.prompt} ${STRICT} Change nothing else.`,
        images: [target.image, front],
        tier: "final",
        size: "1K",
      });
      report({ kind: "google", label: g.label, usd: g.usd });
      return g.image;
    },
  };
}

/** La planche autour d'une référence de profil ou de dos (ADR-115) : mêmes modèles et mêmes tailles que de face. */
function turnedSheet(google: GoogleImagesPort, image: Buffer, report: (n: GenNote) => void, reference: Exclude<View, "front">): SheetPort {
  const shown = SHOWN[reference];
  return {
    async draw() {
      const views: ViewImage[] = [{ view: reference, image }];
      try {
        const why = google.unavailable("final", "1K");
        if (why) throw new Error(why);
        // La face d'abord : les côtés et le dos s'appuient ensuite sur elle autant que sur la référence.
        for (const view of VIEWS.filter((v) => v !== reference)) {
          const g = await google.generate({
            prompt: `The first attached image shows this stylized video game asset from ${shown}. Rotate it on a turntable and ${TURN[view]}: same design, same colors, same pose, same proportions, plain light background, orthographic view.${views.length > 1 ? " The other attached images are views already drawn of it: stay consistent with them." : ""} Do not copy the first image's angle.`,
            images: views.map((v) => v.image),
            tier: "final",
            size: "1K",
          });
          report({ kind: "google", label: g.label, usd: g.usd });
          views.push({ view, image: g.image });
        }
      } catch (err) {
        report({ kind: "fallback", reason: (err as Error).message.slice(0, 200), to: "modèle tiré de l'image seule" });
        throw err;
      }
      // Dans l'ordre de Tripo : face, gauche, dos, droite.
      return VIEWS.map((v) => views.find((x) => x.view === v)!);
    },
    async retouch(views, edit) {
      const target = views.find((v) => v.view === edit.view);
      if (!target) throw new Error(`vue « ${edit.view} » absente`);
      if (edit.view === reference) throw new Error("la vue de référence ne se retouche pas");
      const why = google.unavailable("final", "1K");
      if (why) throw new Error(why);
      const g = await google.generate({
        prompt: `Edit the first attached image (the ${edit.view.toUpperCase()} view of a game asset; the second image is the reference, showing ${shown}): ${edit.prompt} ${STRICT} Change nothing else.`,
        images: [target.image, image],
        tier: "final",
        size: "1K",
      });
      report({ kind: "google", label: g.label, usd: g.usd });
      return g.image;
    },
  };
}
