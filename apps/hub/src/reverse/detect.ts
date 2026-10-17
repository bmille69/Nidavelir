import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type Engine = "godot-dotnet" | "godot" | "unity-mono" | "unity-il2cpp" | "unreal" | "gamemaker" | "electron" | "renpy" | "rpgmaker" | "unknown";

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
};

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
  unknown: "Moteur non reconnu",
};

const RECOVERABLE: Record<Engine, string> = {
  "godot-dotnet": "Le projet Godot presque complet : scènes, ressources, et le code C# décompilé, très lisible.",
  godot: "Le projet Godot presque complet : scènes, ressources et scripts GDScript.",
  "unity-mono": "Le code C# très lisible, plus les images, sons et scènes.",
  "unity-il2cpp": "La structure du code (classes, fonctions, champs) et les ressources ; pas le code lisible.",
  unreal: "Les ressources (modèles, textures, sons) ; le code seulement en pseudo-C, difficile à lire.",
  gamemaker: "Le code GML et les ressources.",
  electron: "Le code JavaScript, remis en forme.",
  renpy: "Les scripts du récit et les ressources.",
  rpgmaker: "Les données du jeu (cartes, événements) et les ressources.",
  unknown: "Probablement un jeu compilé en C/C++ : peu de choses récupérables lisiblement.",
};

/** Godot (GDRE Tools) et Unity (AssetRipper) sont pris en charge ; les autres moteurs viendront à la demande. */
const TOOL: Partial<Record<Engine, string>> = { "godot-dotnet": "gdre", godot: "gdre", "unity-mono": "assetripper", "unity-il2cpp": "assetripper" };

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
];

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

  // Protections : à la racine et un niveau plus bas.
  let protection: string | null = null;
  for (const name of [...top, ...top.filter((f) => isDir(join(path, f))).flatMap((d) => list(join(path, d)))]) {
    const hit = PROTECTIONS.find(([re]) => re.test(name));
    if (hit) {
      protection = hit[1];
      evidence.push(`protection : ${name}`);
      break;
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
  };
}
