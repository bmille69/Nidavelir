import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type Engine = "godot-dotnet" | "godot" | "unity-mono" | "unity-il2cpp" | "unreal" | "gamemaker" | "electron" | "renpy" | "rpgmaker" | "public-data" | "unknown";

/** Ce que le hub sait d'un jeu installé, sans rien y modifier (ADR-40). */
export type GameScan = {
  path: string;
  name: string;
  engine: Engine;
  engineLabel: string;
  /** Indices trouvés, en clair (« SlayTheSpire2.pck », « sts2.dll »…). */
  evidence: string[];
  /** Ce que l'outil lit (pack Godot, dossier de données Unity), assemblage C# principal, s'il y en a. */
  pck: string | null;
  assembly: string | null;
  /** Protection qui interdit le démontage (anti-triche, anti-copie), ou null. */
  protection: string | null;
  /** Ce qu'on peut honnêtement récupérer. */
  recoverable: string;
  /** Le jeu embarque un outil de mods (Harmony, BepInEx, chargeur de mods). */
  moddable: string | null;
  /** Outil nécessaire (catalogue), ou null si aucun n'est encore pris en charge. */
  tool: string | null;
  /** Le jeu semble mal installé (dossier de données vide…) : le démontage ne donnerait rien. */
  incomplete?: string | null;
  /** Quelle bibliothèque de données publiques (ADR-95) : rien n'est lu sur le PC. */
  public?: { source: string; patch: string } | null;
  /** Quels outils, dans quel ordre, et pourquoi celui-là plutôt qu'un autre. */
  plan: ToolStep[];
};

/**
 * Un outil du catalogue et son rôle pour ce moteur.
 * `obligatoire` : sans lui, rien ne sort. `conseillé` : il complète le premier. `dernier recours` : il ne lit que le
 * binaire, donc il ne rend pas le jeu — on le propose seulement quand rien d'autre ne marche.
 */
export type ToolStep = { id: string; role: "obligatoire" | "conseillé" | "dernier recours"; why: string };

const LABEL: Record<Engine, string> = {
  "godot-dotnet": "Godot (C#)",
  godot: "Godot (GDScript)",
  "unity-mono": "Unity (Mono)",
  "unity-il2cpp": "Unity (IL2CPP)",
  unreal: "Unreal Engine",
  gamemaker: "GameMaker",
  electron: "Electron (web)",
  renpy: "Ren'Py",
  rpgmaker: "RPG Maker",
  "public-data": "Données publiques (CommunityDragon)",
  unknown: "Moteur non reconnu",
};

const RECOVERABLE: Record<Engine, string> = {
  "godot-dotnet": "Tout le projet (scènes, ressources, scripts GDScript) et le code C# du jeu : le hub vérifie ensuite qu'il se recompile et démarre (ADR-120).",
  godot: "Tout le projet : scènes, ressources et scripts GDScript. Le hub vérifie ensuite qu'il se lance (ADR-120).",
  "unity-mono": "Le code C# très lisible, plus les images, sons et scènes. Le projet exporté ne se recompile pas tel quel : la route praticable est de modifier l'assemblage décompilé et de le remettre dans une copie du jeu.",
  "unity-il2cpp": "La structure du code (classes, fonctions, champs), les ressources, et le code de chaque fonction en pseudo-assembleur annoté (Cpp2IL) : moins lisible que du C#, mais les règles et les nombres y sont.",
  unreal: "Les ressources (modèles, textures, sons) ; le code seulement en pseudo-C, difficile à lire.",
  gamemaker: "Le code GML et les ressources.",
  electron: "Le code JavaScript, remis en forme.",
  renpy: "Les scripts du récit et les ressources.",
  rpgmaker: "Les données du jeu (cartes, événements) et les ressources.",
  "public-data": "Les données du mode, déjà converties en JSON (vagues, ennemis, sorts, améliorations, expérience). Pas le code : la logique fine tourne sur les serveurs de l'éditeur.",
  unknown: "Probablement un jeu compilé en C/C++ : peu de choses récupérables lisiblement.",
};

/** Godot (GDRE Tools) et Unity (AssetRipper) sont pris en charge ; les autres moteurs viendront à la demande. */
const TOOL: Partial<Record<Engine, string>> = { "godot-dotnet": "gdre", godot: "gdre", "unity-mono": "assetripper", "unity-il2cpp": "assetripper" };

/**
 * Le choix d'outil, moteur par moteur (ADR-126). Chaque outil du catalogue sait lire une famille de fichiers et rien
 * d'autre : Godot ne comprend pas Unity, ILSpy ne lit pas du code compilé, Ghidra ne rend pas un projet. La pipeline
 * suit donc cet ordre, et n'installe un outil que s'il sert à ce jeu-là.
 */
const PLAN: Record<Engine, ToolStep[]> = {
  "godot-dotnet": [
    { id: "gdre", role: "obligatoire", why: "Lit le pack .pck et rend tout le projet Godot : scènes, ressources, scripts et le C#." },
    { id: "ilspy", role: "conseillé", why: "Décompile les fichiers C# que GDRE laisse vides." },
    { id: "godot", role: "conseillé", why: "Rouvre le projet récupéré pour vérifier qu'il se recompile et démarre (ADR-120)." },
  ],
  godot: [
    { id: "gdre", role: "obligatoire", why: "Lit le pack .pck et rend tout le projet Godot : scènes, ressources, scripts." },
    { id: "godot", role: "conseillé", why: "Rouvre le projet récupéré pour vérifier qu'il se lance (ADR-120)." },
  ],
  "unity-mono": [
    { id: "assetripper", role: "obligatoire", why: "Lit les fichiers Unity et rend les ressources et le code C# décompilé." },
    { id: "ilspy", role: "conseillé", why: "Décompile et réécrit Assembly-CSharp.dll, qui ne se recompile pas tel quel." },
  ],
  "unity-il2cpp": [
    { id: "assetripper", role: "obligatoire", why: "Rend les ressources (images, sons, scènes)." },
    { id: "cpp2il", role: "conseillé", why: "Rend la structure des classes et le code de chaque fonction en pseudo-assembleur annoté." },
    { id: "ghidra", role: "dernier recours", why: "Pour les bibliothèques natives que Cpp2IL ne lit pas : il ne rend pas le projet, seulement le code machine." },
  ],
  unreal: [
    { id: "ghidra", role: "dernier recours", why: "Lit l'exécutable et les bibliothèques ; les Blueprints ne se décompilent pas, le projet ne se reconstruit pas." },
  ],
  gamemaker: [],
  electron: [],
  renpy: [],
  rpgmaker: [],
  "public-data": [],
  unknown: [
    { id: "ghidra", role: "dernier recours", why: "Jeu compilé en C/C++ : seul le binaire est lisible, en pseudo-C, et rien du projet ne revient." },
  ],
};

/** Anti-triche et anti-copie : on n'y touche jamais (bannissement possible, et interdit). */
const PROTECTIONS: [RegExp, string][] = [
  [/^easyanticheat/i, "Easy Anti-Cheat"],
  [/^battleye$/i, "BattlEye"],
  [/^(gameguard|nprotect)/i, "nProtect GameGuard"],
  [/^(ricochet|randgrid)/i, "Ricochet (anti-triche)"],
  [/^vanguard$/i, "Riot Vanguard"],
  [/^(xigncode|xhunter)/i, "XIGNCODE"],
  [/^(eac_launcher|start_protected_game)\.exe$/i, "Easy Anti-Cheat"],
  [/denuvo/i, "Denuvo (anti-copie)"],
  [/^(steam_api64\.cdx|.*\.vmp\d*)$/i, "VMProtect"],
  // Riot Vanguard s'installe à part (C:\Program Files\Riot Vanguard), jamais dans le dossier du jeu :
  // on reconnaît donc les jeux Riot eux-mêmes, qui l'exigent tous.
  [/^(league of legends|leagueclient|riotclientservices|valorant(-win64-shipping)?|vgc)\.exe$/i, "Riot Vanguard"],
];

/** Les jeux de ces éditeurs exigent un anti-triche installé hors de leur dossier. */
const PROTECTED_PATHS: [RegExp, string][] = [[/[\\/]Riot Games([\\/]|$)/i, "Riot Vanguard"]];

/** Ce qu'un dossier de données Unity contient toujours quand le jeu est bien installé. */
const UNITY_DATA = /^(globalgamemanagers|data\.unity3d|resources\.assets|level0|sharedassets\d+\.assets|Managed|il2cpp_data)$/i;

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Examine le dossier d'un jeu installé (lecture seule, deux niveaux de profondeur au plus). */
export function detectGame(path: string): GameScan {
  if (!isDir(path)) throw new Error(`Dossier introuvable : ${path}`);
  const top = list(path);
  const evidence: string[] = [];
  const has = (re: RegExp) => top.find((f) => re.test(f));
  let engine: Engine = "unknown";
  let pck: string | null = null;
  let assembly: string | null = null;

  // Protections : à la racine et un niveau plus bas, puis selon l'éditeur (anti-triche installé ailleurs).
  let protection: string | null = null;
  for (const name of [...top, ...top.filter((f) => isDir(join(path, f))).flatMap((d) => list(join(path, d)))]) {
    const hit = PROTECTIONS.find(([re]) => re.test(name));
    if (hit) {
      protection = hit[1];
      evidence.push(`protection : ${name}`);
      break;
    }
  }
  if (!protection) {
    const hit = PROTECTED_PATHS.find(([re]) => re.test(path));
    if (hit) {
      protection = hit[1];
      evidence.push(`protection : jeu de l'éditeur (${hit[1]})`);
    }
  }

  const godotPck = has(/\.pck$/i);
  const unityPlayer = has(/^UnityPlayer\.dll$/i);
  const unityData = top.find((f) => /_Data$/i.test(f) && isDir(join(path, f)));
  if (godotPck) {
    pck = join(path, godotPck);
    evidence.push(godotPck);
    // Godot .NET : un dossier data_<nom>_<plateforme> avec l'assemblage du jeu.
    const data = top.find((f) => /^data_.+_(windows|linuxbsd|macos)_/i.test(f) && isDir(join(path, f)));
    const dll = data ? list(join(path, data)).find((f) => f.toLowerCase() === `${data.replace(/^data_/i, "").replace(/_(windows|linuxbsd|macos)_.*$/i, "").toLowerCase()}.dll`) : undefined;
    if (data && dll) {
      engine = "godot-dotnet";
      assembly = join(path, data, dll);
      evidence.push(`${data}/${dll}`);
    } else if (data && list(join(path, data)).includes("GodotSharp.dll")) {
      engine = "godot-dotnet";
      evidence.push(`${data}/GodotSharp.dll`);
    } else engine = "godot";
  } else if (unityPlayer || unityData) {
    evidence.push(unityPlayer ?? unityData!);
    if (unityData) pck = join(path, unityData);
    if (has(/^GameAssembly\.dll$/i)) {
      engine = "unity-il2cpp";
      evidence.push("GameAssembly.dll");
    } else {
      engine = "unity-mono";
      const managed = unityData ? join(path, unityData, "Managed", "Assembly-CSharp.dll") : null;
      if (managed && existsSync(managed)) {
        assembly = managed;
        evidence.push(`${unityData}/Managed/Assembly-CSharp.dll`);
      }
    }
  } else if (has(/^Engine$/) || top.some((d) => isDir(join(path, d)) && existsSync(join(path, d, "Content", "Paks")))) {
    engine = "unreal";
    evidence.push("Content/Paks");
  } else if (has(/^data\.win$/i)) {
    engine = "gamemaker";
    evidence.push("data.win");
  } else if (existsSync(join(path, "resources", "app.asar"))) {
    engine = "electron";
    evidence.push("resources/app.asar");
  } else if (has(/^renpy$/i)) {
    engine = "renpy";
    evidence.push("renpy/");
  } else if (existsSync(join(path, "www", "js", "rpg_core.js")) || existsSync(join(path, "js", "rmmz_core.js"))) {
    engine = "rpgmaker";
    evidence.push("rpg_core.js / rmmz_core.js");
  }

  // Outils de mods embarqués par le jeu lui-même.
  const managedDirs = [path, ...top.filter((f) => /^data_|_Data$/i.test(f)).map((d) => join(path, d)), ...(unityData ? [join(path, unityData, "Managed")] : [])];
  const libs = managedDirs.flatMap(list);
  const moddable = libs.some((f) => /^0?Harmony\.dll$/i.test(f))
    ? "Harmony (outil de mods intégré)"
    : top.some((f) => /^BepInEx$/i.test(f))
      ? "BepInEx"
      : top.some((f) => /^mods?$/i.test(f) && isDir(join(path, f)))
        ? "dossier de mods"
        : null;
  if (moddable) evidence.push(moddable);

  // Jeu mal installé : un dossier de données Unity sans rien de ce qu'il contient toujours (cas réel : Mycopunk).
  let incomplete: string | null = null;
  if (unityData && !list(join(path, unityData)).some((f) => UNITY_DATA.test(f)))
    incomplete = `Le dossier ${unityData} ne contient pas les données du jeu (globalgamemanagers, Managed, il2cpp_data…) : le jeu semble mal installé. Vérifiez-le dans Steam (« Vérifier l'intégrité des fichiers »).`;

  return {
    path,
    name: basename(path),
    engine,
    engineLabel: LABEL[engine],
    evidence,
    pck,
    assembly,
    protection,
    recoverable: RECOVERABLE[engine],
    moddable,
    tool: protection ? null : (TOOL[engine] ?? null),
    incomplete,
    plan: protection ? [] : PLAN[engine],
  };
}

/** Le plan d'outils d'un moteur (ADR-126) : sert aussi aux fiches démontées avant cette décision. */
export function planFor(engine: Engine): ToolStep[] {
  return PLAN[engine] ?? [];
}

/** Une source de données publiques, décrite comme un jeu (ADR-95) : rien n'est lu sur le PC. */
export function publicScan(source: { id: string; game: string; label: string }, patch: string, url: string): GameScan {
  return {
    path: `communitydragon:${source.id}@${patch}`,
    name: `${source.label} (${patch})`,
    engine: "public-data",
    engineLabel: LABEL["public-data"],
    evidence: [url],
    pck: null,
    assembly: null,
    protection: null,
    recoverable: RECOVERABLE["public-data"],
    moddable: null,
    tool: "communitydragon",
    incomplete: null,
    public: { source: source.id, patch },
    plan: [],
  };
}
