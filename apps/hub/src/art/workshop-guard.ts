/**
 * Les garde-fous mécaniques de l'atelier Blender (ADR-116), sans LLM : la santé de la scène mesurée par Blender avant et
 * après chaque code de l'artisan, et le rang d'une passe jugée par le validateur. La mesure et la restauration sont
 * dans workshop.py ; la décision est ici.
 */

/** Ce que `sante()` mesure dans workshop.py. */
export type Sante = {
  /** Images de texture branchées dans les matériaux du modèle et présentes. */
  textures: number;
  /** Images branchées mais absentes (ou nœud image vide) : le rendu est magenta. */
  textures_manquantes: number;
  /** Part de la surface (pondérée par l'aire) peinte par une texture présente, en points de pourcentage. */
  part_texturee: number;
  /** Part de la surface qui brille (matériaux à émission non nulle, masque de lueur compris), en points. */
  part_emissive: number;
  materiaux: number;
  triangles: number;
};

/** La consigne demande plus de lueur : yeux, visière, néon qui doivent briller. */
const GLOW = /lueur|lumineu|brill|émissi|emissi|néon|neon|glow|allum|éclat/i;

/**
 * Ce que le code de l'artisan a cassé, en clair et à son adresse, ou null. Casse : une texture devenue manquante ou
 * déliée, une lueur étalée sur le corps, un modèle vidé. `simple` : un objet modélisé de zéro, dont les pièces lumineuses
 * (une enseigne, une lanterne) sont voulues : la lueur n'y est pas gardée.
 */
export function stepBreak(avant: Sante, apres: Sante, consigne: string, simple = false): string | null {
  if (apres.textures_manquantes > avant.textures_manquantes) return "ton code a délié une texture (image manquante : le modèle serait rendu magenta)";
  // Une texture retirée d'une grande partie du corps (aplat, nœud supprimé) : ses détails sont perdus.
  if (avant.part_texturee >= 20 && apres.part_texturee < avant.part_texturee - 20) return `ton code a retiré la texture de ${Math.round(avant.part_texturee - apres.part_texturee)} % de la surface`;
  if (avant.triangles > 0 && (apres.triangles === 0 || apres.triangles < avant.triangles * 0.2)) return `ton code a vidé le modèle (${avant.triangles} triangles avant, ${apres.triangles} après)`;
  const seuil = Math.max(2 * avant.part_emissive, avant.part_emissive + 5);
  // Une lueur demandée peut grandir, jamais couvrir un quart du corps (le Brute, A-0003 : Neon_Eyes sur la moitié du corps).
  if (!simple && apres.part_emissive > seuil && (!GLOW.test(consigne) || apres.part_emissive > 25))
    return `ton code fait briller ${Math.round(apres.part_emissive)} % de la surface (${Math.round(avant.part_emissive)} % avant) : une lueur posée sur le corps au lieu des seuls détails`;
  return null;
}

/** Le rang d'une passe jugée : conforme > jouable (mineur) > forme bonne > reste. */
export function passRank(v: { ok: boolean; mineur: boolean; forme_ok: boolean }): number {
  return v.ok ? 3 : v.mineur ? 2 : v.forme_ok ? 1 : 0;
}

/** Une santé rendue par Blender, ou null si elle manque (ancienne scène, double de test). */
export function asSante(x: unknown): Sante | null {
  const s = x as Partial<Sante> | null;
  return s && typeof s.triangles === "number" && typeof s.part_emissive === "number" && typeof s.textures_manquantes === "number"
    ? { textures: Number(s.textures ?? 0), textures_manquantes: s.textures_manquantes, part_texturee: Number(s.part_texturee ?? 0), part_emissive: s.part_emissive, materiaux: Number(s.materiaux ?? 0), triangles: s.triangles }
    : null;
}
