import { z } from "zod";

export const Engine = z.enum(["godot", "web", "unknown"]);
export type Engine = z.infer<typeof Engine>;

export const ProjectSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "slug : minuscules, chiffres et tirets");

/**
 * Niveau d'autonomie du directeur pour un projet (ADR-20) :
 * - supervised : vous validez chaque proposition ;
 * - balanced : le directeur décide seul de ce qui ne fait pas débat, vous tranchez conflits et alternatives ;
 * - autonomous : il tranche aussi les conflits simples et lance les plans sans risque ; vous gardez la fusion.
 * - workshop (« atelier », ADR-24, par défaut) : aucune fiche ni décision à gérer ; le directeur rédige la consigne,
 *   le développeur réalise, le plan sans risque part tout seul ; vous relisez et fusionnez.
 */
export const Autonomy = z.enum(["workshop", "supervised", "balanced", "autonomous"]);
export type Autonomy = z.infer<typeof Autonomy>;

/** Contenu de <jeu>/studio/project.yaml. */
export const ProjectManifest = z.object({
  studio_version: z.literal(1),
  slug: ProjectSlug,
  name: z.string().min(1),
  engine: Engine,
  created_at: z.string(),
});
export type ProjectManifest = z.infer<typeof ProjectManifest>;
