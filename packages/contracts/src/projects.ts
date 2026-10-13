import { z } from "zod";

export const Engine = z.enum(["godot", "web", "unknown"]);
export type Engine = z.infer<typeof Engine>;

export const ProjectSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "slug : minuscules, chiffres et tirets");

/** Contenu de <jeu>/studio/project.yaml. */
export const ProjectManifest = z.object({
  studio_version: z.literal(1),
  slug: ProjectSlug,
  name: z.string().min(1),
  engine: Engine,
  created_at: z.string(),
});
export type ProjectManifest = z.infer<typeof ProjectManifest>;
