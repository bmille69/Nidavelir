import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Sources de données publiques (ADR-95). Certains jeux sont pilotés par leurs données : leurs règles chiffrées
 * (vagues, stats, sorts, améliorations) sont des fichiers que la communauté convertit en JSON lisible et archive
 * version par version. Pour ces jeux, on ne décompile rien et on ne touche ni au jeu installé, ni à son
 * anti-triche : on télécharge l'archive publique d'une version donnée.
 */
export type PublicSource = {
  id: string;
  /** Le jeu d'origine, tel que la détection le nomme (pour proposer cette source quand le jeu est protégé). */
  game: string;
  label: string;
  description: string;
  /** Version proposée par défaut (vérifiée), et l'indication pour en choisir une autre. */
  defaultPatch: string;
  patchHint: string;
};

export const PUBLIC_SOURCES: PublicSource[] = [
  {
    id: "lol-swarm",
    game: "League of Legends",
    label: "League of Legends — Swarm",
    description:
      "Le mode Swarm (Opération : Anima Squad, été 2024), retiré du jeu depuis. CommunityDragon en garde les données : vagues et leur déroulé, ennemis et boss, héros et armes, améliorations, courbe d'expérience, textes français.",
    defaultPatch: "14.15",
    patchHint: "Le mode est jouable de la version 14.14 à environ 14.17. La 14.15 est vérifiée.",
  },
];

const CDRAGON = "https://raw.communitydragon.org";

export function publicSource(id: string): PublicSource {
  const s = PUBLIC_SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(`Source inconnue : ${id}`);
  return s;
}

export function checkPatch(patch: string): string {
  const p = patch.trim();
  if (!/^\d{1,2}\.\d{1,2}$/.test(p)) throw new Error(`Version invalide : « ${patch} » (attendu : 14.15, par exemple)`);
  return p;
}

export function sourceUrl(id: string, patch: string): string {
  publicSource(id);
  return `${CDRAGON}/${patch}/game/data/maps/shipping/map33/`;
}

/** Lire une adresse publique : le texte, ou null si elle n'existe pas (404). */
export interface PublicDataPort {
  get(url: string, signal: AbortSignal): Promise<string | null>;
}

export class RealPublicData implements PublicDataPort {
  async get(url: string, signal: AbortSignal): Promise<string | null> {
    // Sans en-tête user-agent, CommunityDragon répond 403.
    const res = await fetch(url, { headers: { "user-agent": "nidavellir-hub" }, signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`CommunityDragon répond ${res.status} pour ${url}`);
    return res.text();
  }
}

export type ImportInput = { source: string; patch: string; out: string; port: PublicDataPort; log: (line: string) => void; signal: AbortSignal };

/** Télécharge les données d'une source dans `out`, en gardant les chemins de l'archive (pour pouvoir y revenir). */
export async function importPublic(input: ImportInput): Promise<{ files: number }> {
  publicSource(input.source);
  const patch = checkPatch(input.patch);
  const base = `${CDRAGON}/${patch}/game`;
  const save = (rel: string, text: string) => {
    const p = join(input.out, ...rel.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text, "utf8");
  };
  const check = () => {
    if (input.signal.aborted) throw new Error("Import arrêté");
  };

  input.log(`CommunityDragon, version ${patch} : la carte du mode (map33)…`);
  const map = await input.port.get(`${base}/data/maps/shipping/map33/map33.bin.json`, input.signal);
  if (map === null) throw new Error(`La version ${patch} n'a pas les données de Swarm sur CommunityDragon. Essayez la 14.15.`);
  save("data/maps/shipping/map33/map33.bin.json", map);
  let files = 1;

  check();
  const listing = (await input.port.get(`${base}/data/characters/`, input.signal)) ?? "";
  const names = [...new Set([...listing.matchAll(/href="(strawberry_[a-z0-9_]+)\/"/gi)].map((m) => m[1]!.toLowerCase()))].sort();
  input.log(`${names.length} personnages du mode (héros, ennemis, boss, objets de carte)…`);
  const queue = [...names];
  const missing: string[] = [];
  const worker = async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      check();
      const text = await input.port.get(`${base}/data/characters/${name}/${name}.bin.json`, input.signal);
      if (text === null) missing.push(name);
      else {
        save(`data/characters/${name}/${name}.bin.json`, text);
        files++;
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (missing.length) input.log(`Sans fiche : ${missing.join(", ")}`);

  check();
  input.log("Textes français (noms des ennemis, des améliorations, descriptions)…");
  try {
    const table = await input.port.get(`${base}/fr_fr/data/menu/en_us/lol.stringtable.json`, input.signal);
    if (table) {
      const entries = (JSON.parse(table) as { entries?: Record<string, string> }).entries ?? {};
      // Seuls les textes du mode : la table complète fait plus de 20 Mo.
      const kept = Object.fromEntries(Object.entries(entries).filter(([k]) => k.includes("strawberry")));
      save("textes-fr.json", JSON.stringify(kept, null, 1));
      files++;
      input.log(`${Object.keys(kept).length} textes gardés.`);
    }
  } catch (e) {
    input.log(`Textes français indisponibles (${(e as Error).message}) : les noms resteront ceux du code.`);
  }

  save(
    "SOURCE.md",
    [
      `# Source des données`,
      "",
      `- Archive : ${base}/ (CommunityDragon, données du jeu converties en JSON par la communauté)`,
      `- Version du jeu : ${patch}`,
      `- Importé le : ${new Date().toISOString().slice(0, 10)}`,
      "",
      "Usage personnel, non commercial. On réécrit les mécanismes et on reprend les nombres ; les images, sons et modèles de l'éditeur ne sont pas réutilisés.",
      "",
    ].join("\n"),
  );
  return { files: files + 1 };
}
