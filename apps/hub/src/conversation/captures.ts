import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../art/manifest.ts";
import type { Clock } from "../clock.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import type { VcsPort } from "../vcs/git.ts";

/**
 * Les captures annotées (ADR-72), d'après le « Draw » d'OhMyGame : vous entourez ce qui ne va pas sur une photo du jeu, le
 * directeur la regarde. Elles vivent dans `studio/captures/` du dépôt du jeu, commitées par le hub : le directeur les lit,
 * et le développeur et le testeur d'un chantier les retrouvent dans leur copie.
 */
export const CAPTURES_DIR = "studio/captures";
/** Une image jointe à un message : une ligne à elle seule. */
export const IMAGE_MARK = "§IMAGE§ ";
const NAME = /^[\w-]{1,80}\.(png|jpg|webp)$/;
const LINE = /^§IMAGE§ studio\/captures\/([\w-]{1,80}\.(?:png|jpg|webp))$/gm;
const MAX_BYTES = 8 * 1024 * 1024;
const TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  "image/png": { ext: ".png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/jpeg": { ext: ".jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/webp": { ext: ".webp", magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
};
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

/** Les noms des images jointes à un message, dans l'ordre (seulement celles qui existent). */
export function imagesOf(gameRoot: string, text: string): string[] {
  return [...text.matchAll(LINE)].map((m) => m[1]!).filter((n) => existsSync(join(gameRoot, CAPTURES_DIR, n)));
}

/** Pour le directeur : chaque image jointe devient une consigne de la regarder, et d'en transmettre le chemin. */
export function withImages(text: string): string {
  return text.replace(
    LINE,
    (_, name: string) =>
      `[Capture jointe par le directeur créatif : ${CAPTURES_DIR}/${name}. Les traits rouges entourent ou montrent ce dont il parle. Regarde-la avec l'outil Read (fichier « ${name} » de ton dossier) avant de répondre, et dis ce que tu y vois. Si tu confies un chantier à ce sujet, recopie ce chemin dans la consigne : le développeur et le testeur la regarderont.]`,
  );
}

export class CaptureStore {
  readonly #projects: ProjectRegistry;
  readonly #vcs: VcsPort;
  readonly #clock: Clock;

  constructor(deps: { projects: ProjectRegistry; vcs: VcsPort; clock: Clock }) {
    this.#projects = deps.projects;
    this.#vcs = deps.vcs;
    this.#clock = deps.clock;
  }

  /** Enregistre et commite une image ; rend la ligne à mettre dans le message. */
  async save(project: string, body: Buffer, mime: string): Promise<{ file: string; line: string }> {
    const type = TYPES[mime];
    if (!type || !type.magic(body)) throw new CaptureError("Envoyez une image (PNG, JPEG ou WebP)");
    if (body.length > MAX_BYTES) throw new CaptureError("Image trop lourde (8 Mo au plus)");
    const root = this.#projects.get(project).root;
    const stamp = this.#clock.now().replace(/\D/g, "").slice(0, 14);
    const name = `${stamp}-${randomBytes(3).toString("hex")}${type.ext}`;
    writeAtomic(join(root, CAPTURES_DIR, name), body);
    await this.#vcs.commitPaths(root, [CAPTURES_DIR], `captures: image annotée ${name}`).catch(() => null);
    const file = `${CAPTURES_DIR}/${name}`;
    return { file, line: `${IMAGE_MARK}${file}` };
  }

  file(project: string, name: string): { path: string; mime: string } {
    if (!NAME.test(name)) throw new CaptureError("Image introuvable");
    const path = join(this.#projects.get(project).root, CAPTURES_DIR, name);
    if (!existsSync(path)) throw new CaptureError("Image introuvable");
    return { path, mime: MIME[name.split(".").pop()!]! };
  }
}
