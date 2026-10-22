import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Une recette de jeu (ADR-65) : tout ce que le studio de modding doit savoir pour un jeu précis. Ajouter un jeu, c'est
 * ajouter une recette ; le reste du studio ne change pas.
 */
export type GameRecipe = {
  id: string;
  name: string;
  /** Identifiant Steam du jeu. */
  appid: string;
  /** Fichiers qui prouvent qu'il s'agit bien de ce jeu (relatifs à son dossier). */
  marks: string[];
  /** Le chargeur de mods, installé dans le dossier du jeu sur votre clic. */
  loader: { name: string; version: string; url: string; size: string; installedMark: string; generatedMark: string; firstRun: string };
  /** Dossier du jeu où l'on pose les mods. */
  modsDir: string;
  /** Journal du chargeur, lu après vos parties. */
  log: string;
  /** Dossiers de sauvegarde, copiés à l'abri avant la première installation (motifs simples, %APPDATA% et %USERPROFILE%). */
  saves: string[];
  /** Commandes de construction que l'agent peut lancer telles quelles. */
  build: RegExp[];
  /** La commande que le hub lance pour vérifier la construction. */
  buildArgs: string[];
  /** Fichiers que l'agent ne peut pas écrire : la construction les exécuterait (MSBuild). Le hub les fournit. */
  locked: RegExp;
  /** Gabarit du projet de mod. */
  template: (input: { name: string; gameDir: string }) => Record<string, string>;
  /** Ce qui doit sortir de la construction (relatif au dossier du mod). */
  output: (name: string) => string;
  /** Les assemblies du jeu dont on tire la carte des types (relatif au dossier du jeu). */
  assemblies: string;
  /** Avertissements montrés avant de modder. */
  warnings: string[];
  /** La consigne de l'agent pour ce jeu. */
  agent: string;
};

const VS_NAME = /^[A-Za-z][A-Za-z0-9]{1,40}$/;

export const VAMPIRE_SURVIVORS: GameRecipe = {
  id: "vampire-survivors",
  name: "Vampire Survivors",
  appid: "1794680",
  marks: ["VampireSurvivors.exe", "GameAssembly.dll"],
  loader: {
    name: "MelonLoader",
    version: "v0.7.3",
    url: "https://github.com/LavaGang/MelonLoader/releases/download/v0.7.3/MelonLoader.x64.zip",
    size: "≈ 40 Mo",
    installedMark: join("MelonLoader", "net6", "MelonLoader.dll"),
    generatedMark: join("MelonLoader", "Il2CppAssemblies", "Assembly-CSharp.dll"),
    firstRun: "Lancez Vampire Survivors une fois depuis Steam, attendez le menu principal (MelonLoader prépare le jeu, la première fois prend une à deux minutes), puis quittez le jeu.",
  },
  modsDir: "Mods",
  log: join("MelonLoader", "Latest.log"),
  saves: ["%APPDATA%/Vampire_Survivors*", "%USERPROFILE%/AppData/LocalLow/poncle/Vampire Survivors"],
  build: [/^dotnet build( -c Release)?( -nologo)?( -v (q|quiet|m|minimal))?( -nologo)?$/],
  buildArgs: ["build", "-c", "Release", "-nologo", "-v", "q"],
  locked: /(\.(csproj|props|targets|sln|rsp)$)|(^|\/)(Directory\.Build\.[^/]+|nuget\.config|global\.json)$/i,
  template: ({ name, gameDir }) => ({
    [`${name}.csproj`]: [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "  <!-- Fourni par le hub (ADR-65) : le développeur ne le modifie pas. -->",
      "  <PropertyGroup>",
      "    <TargetFramework>net6.0</TargetFramework>",
      `    <AssemblyName>${name}</AssemblyName>`,
      `    <RootNamespace>${name}</RootNamespace>`,
      "    <LangVersion>latest</LangVersion>",
      "    <Nullable>disable</Nullable>",
      "    <ImplicitUsings>disable</ImplicitUsings>",
      "    <AppendTargetFrameworkToOutputPath>false</AppendTargetFrameworkToOutputPath>",
      "    <CopyLocalLockFileAssemblies>false</CopyLocalLockFileAssemblies>",
      "    <GenerateDocumentationFile>false</GenerateDocumentationFile>",
      "    <NoWarn>MSB3277;CS0618</NoWarn>",
      `    <GameDir>${gameDir}</GameDir>`,
      "  </PropertyGroup>",
      "  <ItemGroup>",
      '    <Reference Include="$(GameDir)\\MelonLoader\\net6\\MelonLoader.dll" Private="false" />',
      '    <Reference Include="$(GameDir)\\MelonLoader\\net6\\0Harmony.dll" Private="false" />',
      '    <Reference Include="$(GameDir)\\MelonLoader\\net6\\Il2CppInterop.Runtime.dll" Private="false" />',
      '    <Reference Include="$(GameDir)\\MelonLoader\\net6\\Il2CppInterop.Common.dll" Private="false" />',
      '    <Reference Include="$(GameDir)\\MelonLoader\\Il2CppAssemblies\\*.dll" Private="false" />',
      "  </ItemGroup>",
      "</Project>",
      "",
    ].join("\n"),
    "Mod.cs": [
      "using MelonLoader;",
      "",
      `[assembly: MelonInfo(typeof(${name}.Mod), "${name}", "1.0.0", "Nidavellir")]`,
      '[assembly: MelonGame("poncle", "Vampire Survivors")]',
      "",
      `namespace ${name}`,
      "{",
      "    public class Mod : MelonMod",
      "    {",
      "        public override void OnInitializeMelon()",
      "        {",
      `            LoggerInstance.Msg("${name} chargé.");`,
      "        }",
      "    }",
      "}",
      "",
    ].join("\n"),
  }),
  output: (name) => join("bin", "Release", `${name}.dll`),
  assemblies: join("MelonLoader", "Il2CppAssemblies"),
  warnings: [
    "Vampire Survivors a une coop en ligne : utilisez vos mods en solo (ou en coop locale), jamais en ligne avec d'autres joueurs.",
    "Le jeu n'a pas de support officiel des mods : une mise à jour du jeu peut casser un mod. Le studio vous prévient et le reconstruit.",
  ],
  agent: [
    "Le jeu : Vampire Survivors (Unity, IL2CPP), modé avec MelonLoader 0.7 (C#, .NET 6).",
    "- Le projet est déjà prêt : un .csproj (fourni par le hub, tu ne le modifies pas, ni aucun fichier .props/.targets/.sln) qui référence MelonLoader, Harmony, Il2CppInterop et les assemblies du jeu générées par MelonLoader (préfixe d'espace de noms « Il2Cpp », ex. Il2CppVampireSurvivors…).",
    "- Mod.cs contient la classe MelonMod et les attributs [MelonInfo] et [MelonGame(\"poncle\", \"Vampire Survivors\")] : garde-les.",
    "- Pour changer le comportement du jeu : des patchs Harmony ([HarmonyPatch(typeof(Type), nameof(Type.Methode))], Prefix/Postfix) sur les types du jeu ; MelonLoader applique tout seul les patchs de l'assembly du mod.",
    "- Les types et méthodes du jeu : cherche dans la CARTE DES TYPES (fichier carte-types.txt, donné en lecture seule) avec Grep. N'invente jamais un nom : vérifie-le dans la carte.",
    "- Rends les réglages ajustables par l'utilisateur avec MelonPreferences (une catégorie au nom du mod, des entrées avec valeur par défaut et description en français).",
    "- Écris dans le journal (LoggerInstance.Msg) une ligne claire au chargement, et une ligne quand un patch s'applique la première fois : c'est ainsi que le studio vérifie que le mod marche.",
    "- Mod pour le solo : ne touche à rien de réseau, de compte, de succès Steam ni de sauvegarde.",
    "- Construis avec exactement « dotnet build -c Release » (aucune autre commande de construction n'est permise) et corrige jusqu'à 0 erreur.",
  ].join("\n"),
};

export const RECIPES: GameRecipe[] = [VAMPIRE_SURVIVORS];

export function recipeFor(appid: string): GameRecipe | null {
  return RECIPES.find((r) => r.appid === appid) ?? null;
}

export function recipe(id: string): GameRecipe {
  const r = RECIPES.find((x) => x.id === id);
  if (!r) throw new Error(`Recette inconnue : ${id}`);
  return r;
}

/** Les marques du jeu sont là : c'est bien lui. */
export function matches(r: GameRecipe, dir: string): boolean {
  return r.marks.every((m) => existsSync(join(dir, m)));
}

/** Un nom de mod sûr pour C# et les fichiers : lettres et chiffres, sans espace, commençant par une lettre. */
export function modName(title: string): string {
  const words = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1));
  let name = words.join("").slice(0, 40);
  if (!/^[A-Za-z]/.test(name)) name = `Mod${name}`;
  return VS_NAME.test(name) ? name : "MonMod";
}
