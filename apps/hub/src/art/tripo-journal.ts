import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Une commande Tripo passée : son numéro, dès que Tripo l'a donné ; `counted` : ses crédits sont déjà comptés. */
export type TripoOrder = { task: string; label: string; at: string; counted: boolean };

/** Au-delà, Tripo a oublié la tâche : la commande serait de toute façon refaite. */
const KEEP_MS = 7 * 24 * 3600_000;

/**
 * Le carnet de commandes Tripo (ADR-70), d'après le journal des tâches payantes d'OhMyGame : chaque commande est notée
 * dès que Tripo rend son numéro, sous l'empreinte de ce qui a été demandé. Si le hub s'arrête ou qu'une étape suivante
 * échoue, la même demande reprend la commande au lieu d'en passer une nouvelle (et de la repayer). Les commandes d'une
 * fabrication réussie sont effacées : refaire la 3D plus tard en achète bien une nouvelle.
 * Rangé dans les données du hub (tools/tripo), jamais dans un dépôt ; la clé n'y figure pas.
 */
export class TripoJournal {
  readonly #file: string;
  readonly #now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.#file = file;
    this.#now = now;
  }

  get(fp: string): TripoOrder | null {
    return this.#read()[fp] ?? null;
  }

  add(fp: string, order: Omit<TripoOrder, "at" | "counted">): void {
    this.#update((all) => (all[fp] = { ...order, at: new Date(this.#now()).toISOString(), counted: false }));
  }

  counted(fp: string): void {
    this.#update((all) => {
      if (all[fp]) all[fp].counted = true;
    });
  }

  drop(...fps: string[]): void {
    if (fps.length) this.#update((all) => fps.forEach((fp) => delete all[fp]));
  }

  /** Les commandes en cours, pour le dire au besoin. */
  list(): TripoOrder[] {
    return Object.values(this.#read());
  }

  #read(): Record<string, TripoOrder> {
    try {
      const all = JSON.parse(readFileSync(this.#file, "utf8")) as Record<string, TripoOrder>;
      const limit = this.#now() - KEEP_MS;
      return Object.fromEntries(Object.entries(all).filter(([, o]) => Date.parse(o.at) > limit));
    } catch {
      return {};
    }
  }

  #update(change: (all: Record<string, TripoOrder>) => void): void {
    const all = this.#read();
    change(all);
    mkdirSync(dirname(this.#file), { recursive: true });
    // Écriture d'un bloc : un arrêt brutal ne laisse jamais un carnet à moitié écrit.
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
    renameSync(tmp, this.#file);
  }
}

/** L'empreinte d'une demande : l'adresse et le contenu, clés triées. */
export function orderFingerprint(path: string, same: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(`${path}\n${JSON.stringify(canon(same))}`).digest("hex");
}
