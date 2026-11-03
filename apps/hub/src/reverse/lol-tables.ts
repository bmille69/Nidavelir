import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Les tables du mode Swarm (ADR-95), calculées par le hub sans IA à partir des fichiers .bin.json de CommunityDragon.
 * Les fichiers bruts sont immenses (7 Mo pour la carte) et pleins de noms codés : ces tables rangent les nombres
 * utiles (vagues et déroulé, personnages, sorts, améliorations, expérience) en JSON court, avec les noms français.
 * L'Archéologue les lit d'abord, puis le studio s'en sert comme données de référence pour réécrire le mode.
 */

type Rec = Record<string, unknown> & { __type?: string };
type Entry = { key: string; v: Rec; file: string };

export type LolTables = { tables: Record<string, unknown>; map: string; index: string; records: number };

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".bin.json")) out.push(p);
  }
  return out;
}

const num = (x: unknown): number | undefined => (typeof x === "number" ? Math.round(x * 1000) / 1000 : undefined);
const nums = (x: unknown): number[] | undefined => (Array.isArray(x) && x.every((n) => typeof n === "number") ? x.map((n) => num(n)!) : undefined);
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
const rec = (x: unknown): Rec | undefined => (x && typeof x === "object" && !Array.isArray(x) ? (x as Rec) : undefined);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
/** Retire les champs vides, pour des tables courtes. */
const compact = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length))) as T;

/** « Characters/Strawberry_Enemy_Swarmer/CharacterRecords/Root » → « Strawberry_Enemy_Swarmer ». */
const characterOf = (path: unknown) => str(path)?.match(/^Characters\/([^/]+)\//i)?.[1] ?? str(path);

export function buildLolTables(root: string, name: string): LolTables {
  const entries: Entry[] = [];
  for (const file of walk(root)) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const rel = relative(root, file).replace(/\\/g, "/");
    for (const [key, v] of Object.entries(data)) if (rec(v)) entries.push({ key, v: v as Rec, file: rel });
  }
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const texts: Record<string, string> = existsSync(join(root, "textes-fr.json")) ? (JSON.parse(readFileSync(join(root, "textes-fr.json"), "utf8")) as Record<string, string>) : {};
  const t = (k: unknown) => (typeof k === "string" ? texts[k.toLowerCase()] : undefined);
  const of = (type: string) => entries.filter((e) => e.v.__type === type);

  // Personnages : héros, ennemis, mini-boss, boss, objets de carte. La carte du mode recopie certaines fiches :
  // on garde celle du personnage lui-même (data/characters/…).
  const records = new Map<string, Entry>();
  for (const e of of("CharacterRecord")) {
    const id = str(e.v.mCharacterName) ?? characterOf(e.file) ?? e.key;
    const seen = records.get(id);
    if (!seen || (!seen.file.startsWith("data/characters/") && e.file.startsWith("data/characters/"))) records.set(id, e);
  }
  const personnages = [...records.values()].map(({ v, file }) => {
    const id = str(v.mCharacterName) ?? characterOf(file) ?? "?";
    return compact({
      id,
      nom: t(v.name) ?? t(`game_character_displayname_${id}`),
      sorte: /_Boss_/i.test(id) ? "boss" : /_MiniBoss_/i.test(id) ? "mini-boss" : /_Enemy_|_EventEnemy_/i.test(id) ? "ennemi" : /_POI_|_Spire_|_Destructible_/i.test(id) ? "objet de carte" : "héros ou allié",
      pv: num(v.baseHP),
      pvParNiveau: num(v.hpPerLevel),
      regenPv: num(v.baseStaticHPRegen) || undefined,
      degats: num(v.baseDamage),
      degatsParNiveau: num(v.damagePerLevel),
      armure: num(v.baseArmor) || undefined,
      resistanceMagique: num(v.baseSpellBlock),
      vitesse: num(v.baseMoveSpeed),
      portee: num(v.attackRange),
      vitesseAttaque: num(v.attackSpeed),
      porteeDetection: num(v.acquisitionRange),
      rayonCollision: num(v.pathfindingCollisionRadius),
      xpALaMort: num(v.expGivenOnDeath) || undefined,
      orALaMort: num(v.goldGivenOnDeath) || undefined,
      etiquettes: str(v.unitTagsString),
      attaque: str(rec(v.basicAttack)?.mAttackName),
      sorts: arr(v.spellNames).filter((s) => s !== "BaseSpell").map(String),
      source: `jeu/${file}`,
    });
  });

  // Sorts : les valeurs par rang (dégâts, nombre de projectiles…), recharges, portées, formules.
  const sorts = of("SpellObject").map(({ key, v, file }) => {
    const s = rec(v.mSpell) ?? {};
    const valeurs = Object.fromEntries(arr(s.mDataValues).flatMap((d) => (rec(d) && str(rec(d)!.mName) ? [[str(rec(d)!.mName)!, nums(rec(d)!.mValues)]] : [])));
    return compact({
      id: str(v.mScriptName) ?? key,
      cle: key,
      nom: t(`${str(v.mScriptName) ?? ""}_name`) ?? t(`generatedtip_spell_${(str(v.mScriptName) ?? "").toLowerCase()}_displayname`),
      valeurs: Object.keys(valeurs).length ? valeurs : undefined,
      recharge: nums(s.cooldownTime),
      portee: nums(s.castRange),
      rayon: nums(s.castRadius),
      vitesseProjectile: num(rec(s.mMissileSpec)?.mMissileSpeed) ?? num(s.missileSpeed),
      formules: rec(s.mSpellCalculations),
      source: `jeu/${file}`,
    });
  });

  // Améliorations : l'arme ou le bonus, sa rareté, le sort qu'elle modifie.
  const augments = of("AugmentData").map(({ key, v }) =>
    compact({
      id: str(v.AugmentNameId) ?? key,
      nom: t(v.NameTra) ?? str(v.NameTra),
      description: t(v.DescriptionTra),
      infobulle: v.AugmentTooltipTra !== v.DescriptionTra ? t(v.AugmentTooltipTra) : undefined,
      rarete: num(v.rarity) ?? 0,
      sortRacine: str(v.RootSpell),
      cle: key,
    }),
  );

  // Vagues : qui apparaît, à quel rythme, à quelle distance du joueur.
  const waveEntries = entries.filter((e) => "SpawnIntervalSecs" in e.v || "WaveShape" in e.v);
  const waveName = (k: string) => str(byKey.get(k)?.v.name) ?? k;
  const vagues = waveEntries.map(({ key, v }) => {
    const shape = rec(v.WaveShape);
    return compact({
      nom: str(v.name) ?? key,
      carte: str(v.name)?.match(/^Map([A-Z])_/)?.[1],
      intervalleSecondes: num(v.SpawnIntervalSecs),
      parIntervalle: num(v.SpawnCountPerInterval),
      maximum: num(v.MaxSpawnCount),
      distanceMin: num(shape?.InnerRadius),
      distanceMax: num(shape?.OuterRadius),
      ennemis: arr(v.characters).map((c) => compact({ personnage: characterOf(rec(c)?.CharacterRecord), poids: num(rec(c)?.RandomWeight) })),
      comportements: arr(v.behaviors).map((b) => Object.fromEntries(Object.entries(rec(b) ?? {}).filter(([k]) => k !== "__type"))),
      cle: key,
    });
  });

  // Groupes de vagues (un champ « Waves ») et déroulé : les phases et leurs étapes, avec l'heure de début.
  const groups = new Map(entries.filter((e) => Array.isArray(e.v.Waves)).map((e) => [e.key, arr(e.v.Waves).map(String)]));
  const deroulement = of("LoLModesPhaseData").map(({ key, v }) => {
    let start = 0;
    const etapes = arr(v.SubPhases).map((sp) => {
      const s = rec(sp) ?? {};
      const refs = Object.values(s).flatMap((x) => (Array.isArray(x) ? x.map(String).filter((k) => groups.has(k)) : []));
      const step = compact({
        debutSecondes: num(start),
        dureeSecondes: num(s.duration),
        type: num(s.type),
        vagues: refs.flatMap((g) => groups.get(g)!.map(waveName)),
      });
      start += typeof s.duration === "number" ? s.duration : 0;
      return step;
    });
    return compact({ nom: t(v.DisplayNameTra) ?? str(v.DisplayNameTra) ?? key, type: num(v.type), dureeTotaleSecondes: num(start), etapes, cle: key });
  });

  const experience = of("ExperienceCurveData").map(({ key, v }) => ({ cle: key, xpParNiveau: nums(v.mExperienceRequiredPerLevel) ?? [] }));
  const progression = {
    paliers: of("MilestoneDefinition").map(({ v }) => compact({ nom: str(v.name), seuil: num(v.TriggerValue), recompenses: arr(v.properties).map(String) })),
    recompenses: of("RewardGroup").map(({ v }) => compact({ nom: str(v.internalName), titre: t(v.LocalizedName) ?? str(v.LocalizedName) })),
  };

  const tables: Record<string, unknown> = {
    "personnages.json": personnages,
    "sorts.json": sorts,
    "augments.json": augments,
    "vagues.json": vagues,
    "deroulement.json": deroulement,
    "experience.json": experience,
    "progression.json": progression,
  };

  // L'index des enregistrements (à chercher avec Grep) : un par ligne, sauf les effets visuels.
  const index = entries
    .filter((e) => e.v.__type !== "VfxSystemDefinitionData")
    .map((e) => `${str(e.v.name) ?? str(e.v.mScriptName) ?? str(e.v.mCharacterName) ?? str(e.v.AugmentNameId) ?? e.key} | ${e.v.__type ?? "?"} | jeu/${e.file}`)
    .sort()
    .join("\n");

  const types = new Map<string, number>();
  for (const e of entries) types.set(e.v.__type ?? "?", (types.get(e.v.__type ?? "?") ?? 0) + 1);
  const enemies = personnages.filter((p) => p.sorte !== "héros ou allié" && p.sorte !== "objet de carte");
  const main = [...deroulement].sort((a, b) => (b.etapes?.length ?? 0) - (a.etapes?.length ?? 0))[0];
  const lines = [
    `# Carte de « ${name} »`,
    "",
    "Calculée par le hub à partir des données publiques (CommunityDragon), sans IA. Il n'y a pas de code : ce sont les fichiers de données du jeu, convertis en JSON.",
    "Les nombres sont fiables. La logique fine (quand un effet se déclenche, l'IA des boss, les règles du serveur) n'y est pas : elle se déduit des noms, des valeurs et des textes, et se marque « (déduit) ».",
    "",
    "## Où lire",
    "- `tables/` : les tables rangées par le hub (commencez par là) :",
    `  - \`tables/vagues.json\` : ${vagues.length} vagues (rythme, nombre, distance, ennemis, comportements)`,
    `  - \`tables/deroulement.json\` : ${deroulement.length} phases ; la principale a ${main?.etapes?.length ?? 0} étapes (début et durée en secondes, vagues lancées)`,
    `  - \`tables/personnages.json\` : ${personnages.length} personnages, dont ${enemies.length} ennemis et boss`,
    `  - \`tables/sorts.json\` : ${sorts.length} sorts (valeurs par rang, recharges, portées, formules)`,
    `  - \`tables/augments.json\` : ${augments.length} améliorations (nom, description, rareté, sort modifié)`,
    `  - \`tables/experience.json\` : courbe d'expérience (${experience[0]?.xpParNiveau.length ?? 0} niveaux)`,
    `  - \`tables/progression.json\` : ${progression.paliers.length} paliers de progression entre les parties`,
    "- `jeu/` : les fichiers bruts (`data/maps/shipping/map33/map33.bin.json` pour le mode, `data/characters/strawberry_*/` pour chaque personnage), `textes-fr.json` (textes du mode), `SOURCE.md`.",
    "- `index-code.txt` : un enregistrement par ligne (nom | type | fichier), à chercher avec Grep.",
    "- Les noms entre accolades (`{e75aad84}`) sont des noms codés que la communauté n'a pas encore retrouvés : le sens se déduit du contenu.",
    "",
    "## Ennemis et boss (pv, dégâts, vitesse)",
    ...enemies.slice(0, 40).map((p) => `- ${p.nom ? `${p.nom} (\`${p.id}\`)` : `\`${p.id}\``} : ${p.sorte}, ${p.pv ?? "?"} pv, ${p.degats ?? "?"} dégâts, vitesse ${p.vitesse ?? "?"}`),
    "",
    "## Types d'enregistrements",
    ...[...types].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) => `- \`${k}\` : ${n}`),
    "",
  ];
  return { tables, map: lines.join("\n"), index: index ? `${index}\n` : "", records: entries.length };
}
