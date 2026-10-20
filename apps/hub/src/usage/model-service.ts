import type { Db } from "../db/database.ts";
import type { Journal } from "../journal/journal.ts";

/** Les agents qui appellent un modèle. Le gardien applique des règles fixes : aucun modèle. */
export const MODEL_ROLES = ["concepteur", "director", "archivist", "developer", "developer_big", "qa", "archeologue", "art_director", "art_workshop"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** Modèles proposés, du plus capable au plus économe (alias acceptés par Claude Code). */
export const MODEL_CHOICES = [
  { id: "fable", label: "Fable 5", note: "Le plus capable, consomme le plus" },
  { id: "opus", label: "Opus", note: "Très capable" },
  { id: "sonnet", label: "Sonnet", note: "Équilibré, rapide" },
  { id: "haiku", label: "Haiku", note: "Le plus rapide et le plus économe" },
] as const;
export type ModelId = (typeof MODEL_CHOICES)[number]["id"];

/** Ce que nous recommandons pour chaque rôle, et pourquoi (ADR-36, ADR-37, ADR-41). */
export const RECOMMENDED: Record<ModelRole, { model: ModelId; why: string }> = {
  concepteur: { model: "fable", why: "Appels rares et décisifs : le meilleur raisonnement vaut sa consommation." },
  director: { model: "sonnet", why: "Vous répond vite dans la discussion, avec des consignes claires." },
  archivist: { model: "sonnet", why: "Noter les idées et tenir le carnet ne demande pas plus." },
  developer: { model: "sonnet", why: "Chantiers ordinaires : environ 10 fois moins cher que Fable par action, et largement suffisant." },
  developer_big: { model: "fable", why: "Chantiers marqués « (gros) » : là, le meilleur raisonnement évite les chantiers repris." },
  qa: { model: "haiku", why: "Les vrais tests et le lancement du jeu font l'essentiel ; il relit." },
  archeologue: { model: "sonnet", why: "Il lit beaucoup de code : Sonnet comprend vite sans épuiser votre quota." },
  art_director: { model: "sonnet", why: "Regarde vos images, cherche des références et tient la bible : Sonnet suffit ; Opus pour un regard plus fin." },
  art_workshop: { model: "fable", why: "L'artisan 3D retouche le modèle dans Blender pas à pas, en regardant ses photos : le travail le plus difficile du circuit visuel (ADR-52)." },
};

export type ModelSetting = { role: ModelRole; model: string; recommended: ModelId; why: string };

/**
 * Le modèle de chaque agent, choisi depuis « Le studio en direct » (ADR-37).
 * Lu à chaque appel : un changement vaut pour le prochain appel, pas pour celui en cours.
 */
export class ModelService {
  readonly #db: Db;
  readonly #journal: Journal;
  readonly #defaults: Partial<Record<ModelRole, string>>;

  constructor(db: Db, journal: Journal, defaults: Partial<Record<ModelRole, string | undefined>> = {}) {
    this.#db = db;
    this.#journal = journal;
    this.#defaults = Object.fromEntries(Object.entries(defaults).filter(([, v]) => v)) as Partial<Record<ModelRole, string>>;
  }

  #stored(): Partial<Record<ModelRole, string>> {
    const row = this.#db.prepare("SELECT value FROM settings WHERE key = 'models'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Partial<Record<ModelRole, string>>) : {};
  }

  get(role: ModelRole): string {
    return this.#stored()[role] ?? this.#defaults[role] ?? RECOMMENDED[role].model;
  }

  list(): ModelSetting[] {
    return MODEL_ROLES.map((role) => ({ role, model: this.get(role), recommended: RECOMMENDED[role].model, why: RECOMMENDED[role].why }));
  }

  set(role: ModelRole, model: ModelId): ModelSetting[] {
    const from = this.get(role);
    const next = { ...this.#stored(), [role]: model };
    this.#db
      .prepare("INSERT INTO settings (key, value) VALUES ('models', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
    if (from !== model) this.#journal.append({ project: null, actor: { kind: "human" }, type: "model.changed", subject: role, payload: { from, to: model } });
    return this.list();
  }
}
