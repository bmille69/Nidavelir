import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, git, sandbox } from "./helpers.ts";
import { missingSections, PROJECT_SECTIONS } from "../src/conception/prompts.ts";

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => cleanupSandboxes());

const turn = (over: Record<string, unknown> = {}) => ({
  reply: "J'ai compris : un roguelike court avec des chats. Trois questions pour cadrer.",
  questions: [
    {
      question: "Sur quoi le jouer ?",
      why: "Ça décide du moteur.",
      options: [
        { label: "Navigateur", detail: "Web, TypeScript" },
        { label: "PC (Godot)", detail: "Exécutable" },
      ],
      recommended: "Navigateur",
    },
  ],
  title: "Chats du Néant",
  engine: "web",
  dossier: "# Chats du Néant\n## En une phrase\nUn roguelike de 15 minutes avec des chats.",
  chantiers: [{ title: "1. Base technique", goal: "Objectif : un écran qui se lance et un test qui passe." }],
  ready: false,
  claude_md: "",
  sources: [{ title: "Hades", url: "https://example.invalid/hades" }],
  ...over,
});

/** Un dossier de nouveau jeu sans trou : chaque section a quelques mots (ADR-73). */
const fullDossier = (title: string, extra = "") =>
  [`# ${title}`, ...PROJECT_SECTIONS.map((s) => `## ${s}\nCe qui est prévu pour « ${s} », en quelques mots utiles.`)].join("\n") + extra;

describe("Concepteur", () => {
  it("de l'idée en vrac au projet prêt à coder", async () => {
    const fake = new FakeOrchestrator();
    const sb = sandbox(fake);
    const calls: { tools?: string[]; tier?: string }[] = [];
    const structured = fake.structured.bind(fake);
    fake.structured = async (input) => {
      calls.push({ tools: (input as { tools?: string[] }).tools, tier: (input as { tier?: string }).tier });
      return structured(input);
    };
    fake.extractions.push(() => turn() as never, () => turn({ ready: true, questions: [], claude_md: "# Chats du Néant\nTextes en français." }) as never);

    const c = sb.hub.conceptions.start(sb.human(), { kind: "project", idea: "un roguelike avec des chats un peu comme hades" });
    expect(c.status).toBe("thinking");
    await sb.hub.conceptions.idle();
    let now = sb.hub.conceptions.get(c.id);
    expect(now).toMatchObject({ status: "open", title: "Chats du Néant" });
    expect(now.data.questions[0]!.recommended).toBe("Navigateur");
    expect(calls[0]).toEqual({ tools: ["WebSearch", "WebFetch"], tier: "concept" });

    // Pas prêt : on ne crée rien.
    await expect(sb.hub.conceptions.createProject(sb.human(), c.id, join(sb.dir, "games"))).rejects.toThrow(/pas encore prête/);

    sb.hub.conceptions.reply(sb.human(), c.id, "Sur quoi le jouer ? → Navigateur");
    await sb.hub.conceptions.idle();
    now = sb.hub.conceptions.get(c.id);
    expect(now.data.ready).toBe(true);
    expect(sb.hub.conceptions.messages(c.id).map((m) => m.role)).toEqual(["human", "concepteur", "human", "concepteur"]);
    // Pas de Godot sur ce PC de test : le Concepteur le sait.
    expect(fake.calls[1]!.systemPrompt).toMatch(/Godot n'est pas installé sur ce PC/);
    // La technologie se choisit d'après le jeu, candidates comparées, avec ce que le studio vérifie pour chacune (ADR-74).
    expect(fake.calls[1]!.systemPrompt).toMatch(/jamais par habitude[\s\S]*Compare 2 ou 3 candidates[\s\S]*· Godot : tout[\s\S]*· Web[\s\S]*· Autre \(Unity/);
    expect(fake.calls[1]!.systemPrompt).not.toMatch(/recommandé pour un jeu sur PC/);
    // Le second tour voit le dossier du premier et les échanges.
    expect(fake.calls[1]!.prompt).toMatch(/<dossier_actuel>\n# Chats du Néant[\s\S]*Navigateur/);

    // Prêt, mais le dossier d'un nouveau jeu a des trous (ADR-73) : le hub les montre et refuse de créer le projet.
    expect(now.data.missing).toContain("Contrôles et caméra");
    expect(now.data.missing).toContain("Son et musique");
    await expect(sb.hub.conceptions.createProject(sb.human(), c.id, join(sb.dir, "games"))).rejects.toThrow(/trous : Piliers, Boucle de jeu, Contrôles et caméra/);
    expect(fake.calls[1]!.systemPrompt).toMatch(/## Contrôles et caméra[\s\S]*## Tests et outils de débogage[\s\S]*Ne mets "ready" à true que si aucune section n'est vide/);
    fake.extractions.push(() => turn({ ready: true, questions: [], claude_md: "# Chats du Néant\nTextes en français.", dossier: fullDossier("Chats du Néant", "\nUn roguelike de 15 minutes avec des chats.") }) as never);
    sb.hub.conceptions.reply(sb.human(), c.id, "Complète le dossier");
    await sb.hub.conceptions.idle();
    expect(sb.hub.conceptions.get(c.id).data.missing).toEqual([]);

    const { project, tasks } = await sb.hub.conceptions.createProject(sb.human(), c.id, join(sb.dir, "games"));
    expect(project).toMatchObject({ slug: "chats-du-neant", autonomy: "workshop" });
    expect(readFileSync(join(project.root, "CLAUDE.md"), "utf8")).toMatch(/Textes en français/);
    expect(readFileSync(join(project.root, "studio", "conception.md"), "utf8")).toMatch(/roguelike de 15 minutes/);
    expect(git(project.root, "log", "-1", "--format=%s")).toMatch(/conception: dossier initial de Chats du Néant/);
    expect(tasks).toHaveLength(1);
    expect(sb.hub.tasks.get(project.slug, tasks[0]!)).toMatchObject({ title: "Base technique", status: "draft", origin: { thread: expect.any(String) } });
    expect(sb.hub.conceptions.get(c.id).status).toBe("done");
    expect(existsSync(join(sb.dir, "games", "chats-du-neant", ".git"))).toBe(true);
  });

  it("un jeu Godot (ADR-73) : le Concepteur connaît le Godot du PC, « Créer le projet » pose le socle et le CLAUDE.md", async () => {
    const fake = new FakeOrchestrator();
    const sb = sandbox(fake);
    sb.hub.conceptions.godot = () => ({ exe: join(sb.dir, "absent", "Godot_v4.6.2-stable_win64.exe"), version: "4.6.2", mono: false });
    const godot = { rendu: "gl_compatibility", dimension: "2d", largeur: 640, hauteur: 360, langage: "csharp" };
    fake.extractions.push(() => turn({ title: "Neuf Vies", engine: "godot", godot, ready: true, questions: [], claude_md: "# Neuf Vies\nTextes en français.", dossier: fullDossier("Neuf Vies") }) as never);
    const c = sb.hub.conceptions.start(sb.human(), { kind: "project", idea: "un roguelike avec des chats sur PC" });
    await sb.hub.conceptions.idle();
    expect(fake.calls[0]!.systemPrompt).toMatch(/le PC a Godot 4\.6\.2 \(sans \.NET : GDScript seulement\)[\s\S]*le HUB pose lui-même le socle/);

    // Le « Godot » du test n'existe pas : le socle est posé, rien n'est lancé, et la discussion le dit.
    const real = sb.hub.conceptions.godot;
    sb.hub.conceptions.godot = () => null;
    const { project } = await sb.hub.conceptions.createProject(sb.human(), c.id, join(sb.dir, "games"));
    sb.hub.conceptions.godot = real;
    const root = project.root;
    const projectGodot = readFileSync(join(root, "project.godot"), "utf8");
    expect(projectGodot).toMatch(/config\/name="Neuf Vies"/);
    expect(projectGodot).toMatch(/config\/features=PackedStringArray\("4\.6", "GL Compatibility"\)/);
    expect(projectGodot).toMatch(/window\/size\/viewport_width=640[\s\S]*viewport_height=360/);
    expect(projectGodot).toMatch(/StudioBridge="\*res:\/\/addons\/studio_bridge\/bridge\.gd"/);
    for (const f of ["scenes/main.tscn", "scripts/main.gd", "tests/test_demarrage.gd", "vitrines/README.md", ".gitignore", "addons/studio_bridge/bridge.gd", "addons/studio_tests/run.gd", "addons/studio_tests/studio_test.gd"]) expect(existsSync(join(root, f)), f).toBe(true);
    expect(readFileSync(join(root, "scenes", "main.tscn"), "utf8")).toMatch(/type="Node2D"/);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toMatch(/^\.godot\/$/m);
    // C# demandé sans Godot .NET sur le PC : GDScript.
    const claudeMd = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(claudeMd).toMatch(/Textes en français[\s\S]*## Godot dans le studio[\s\S]*Godot 4\.6[\s\S]*GDScript typé[\s\S]*godot --headless --path \. -s res:\/\/addons\/studio_tests\/run\.gd/);
    expect(git(root, "log", "--format=%s")).toMatch(/studio: socle Godot 4\.6/);
    expect(git(root, "status", "--porcelain")).toBe("");
    const thread = sb.hub.conversations.listThreads(project.slug)[0]!;
    expect(sb.hub.conversations.messages(project.slug, thread.id).at(-1)!.text).toMatch(/Socle Godot posé \(Godot 4\.6, rendu gl_compatibility, 2D, écran 640×360, GDScript\)[\s\S]*rien n'a pu être lancé/);
  });

  it("les trous du dossier : section absente, vide ou presque ; « Questions encore ouvertes » peut dire « aucune »", () => {
    const full = fullDossier("X");
    expect(missingSections(full, "project")).toEqual([]);
    expect(missingSections(full.replace("## Son et musique\n", "## Son et musique\nAucun.\n## Rien\n"), "project")).toEqual(["Son et musique"]);
    expect(missingSections(full.replace(/## Questions encore ouvertes\n.*$/, "## Questions encore ouvertes\nAucune."), "project")).toEqual([]);
    expect(missingSections("# X\n## en une phrase\nUn jeu de chats très court et nerveux.", "feature")).toContain("Piliers");
    // Accents et majuscules ne comptent pas.
    expect(missingSections(full.replace("## Écrans et parcours du joueur", "## ECRANS ET PARCOURS DU JOUEUR (titre, pause)"), "project")).toEqual([]);
  });

  it("une fonctionnalité d'un projet existant : le Concepteur connaît le code, les chantiers arrivent dans le projet", async () => {
    const fake = new FakeOrchestrator();
    const sb = sandbox(fake);
    const root = sb.makeGameRepo("games/destiny", { "README.md": "# D\n", "CLAUDE.md": "Le rendu ne touche pas la simulation.\n", "src/craft.ts": "export {};\n" });
    await sb.hub.projects.register(sb.human(), { path: root, slug: "destiny", name: "Destiny" });
    fake.extractions.push(() => turn({ title: "Système de craft", engine: "", ready: true, questions: [] }) as never);
    const c = sb.hub.conceptions.start(sb.human(), { kind: "feature", project: "destiny", idea: "un système de craft" });
    await sb.hub.conceptions.idle();
    expect(fake.calls[0]!.systemPrompt).toMatch(/GROSSE FONCTIONNALITÉ[\s\S]*Le rendu ne touche pas la simulation[\s\S]*src\/craft.ts/);
    const { tasks } = await sb.hub.conceptions.addToProject(sb.human(), c.id);
    expect(readFileSync(join(root, "studio", "conceptions", "systeme-de-craft.md"), "utf8")).toMatch(/Chats du Néant/);
    expect(sb.hub.tasks.get("destiny", tasks[0]!).status).toBe("draft");
    const thread = sb.hub.tasks.get("destiny", tasks[0]!).origin!.thread;
    expect(sb.hub.conversations.messages("destiny", thread)[0]!.text).toMatch(/1\. Base technique/);
  });

  it("« transmets » envoie les chantiers de toutes les étapes, pas seulement la première", async () => {
    const fake = new FakeOrchestrator();
    const sb = sandbox(fake);
    const root = sb.makeGameRepo("games/destiny", { "README.md": "# D\n" });
    await sb.hub.projects.register(sb.human(), { path: root, slug: "destiny", name: "Destiny" });
    const chantiers = [
      { etape: "1. Base jouable", title: "Recettes", goal: "Objectif : les recettes." },
      { etape: "1. Base jouable", title: "Établi", goal: "Objectif : l'établi." },
      { etape: "2. Profondeur", title: "Raretés", goal: "Objectif : les raretés." },
      { etape: "3. Finition", title: "Sons du craft", goal: "Objectif : les sons." },
    ];
    fake.extractions.push(() => turn({ title: "Système de craft", engine: "", ready: true, questions: [], chantiers, transmettre: true }) as never);
    const c = sb.hub.conceptions.start(sb.human(), { kind: "feature", project: "destiny", idea: "un système de craft" });
    await sb.hub.conceptions.idle();
    expect(fake.calls[0]!.systemPrompt).toMatch(/chantiers de TOUTES les étapes/);
    const tasks = sb.hub.tasks.list("destiny");
    expect(tasks.map((t) => t.title).sort()).toEqual(["Établi", "Raretés", "Recettes", "Sons du craft"].sort());
    expect(tasks.find((t) => t.title === "Raretés")!.goal).toMatch(/^Étape : 2\. Profondeur/);
    expect(sb.hub.conceptions.messages(c.id).at(-1)!.text).toMatch(/4 chantier\(s\), sur 3 étapes/);
    const thread = tasks[0]!.origin!.thread;
    expect(sb.hub.conversations.messages("destiny", thread)[0]!.text).toMatch(/1\. Base jouable\n1\. Recettes\n2\. Établi\n\n2\. Profondeur\n3\. Raretés/);
  });

  it("une refonte : les visuels partent chez le Directeur artistique, les chantiers savent lesquels arriveront", async () => {
    const fake = new FakeOrchestrator();
    const sb = sandbox(fake);
    const root = sb.makeGameRepo("games/destiny", { "README.md": "# D\n" });
    await sb.hub.projects.register(sb.human(), { path: root, slug: "destiny", name: "Destiny" });
    const chantiers = [
      { etape: "1. Relief", title: "Falaises en strates", goal: "Objectif : les falaises.", visuels: ["V1"] },
      { etape: "1. Relief", title: "Collisions des terrasses", goal: "Objectif : les collisions.", visuels: [] },
    ];
    const visuels = [
      { cle: "V1", nom: "Texture de roche stratifiée", type: "texture", usage: "faces des falaises", specs: "512x512, raccordable" },
      { cle: "V2", nom: "Arbre de la forêt", type: "modèle 3D", usage: "forêt de pins", specs: "3000 triangles" },
    ];
    fake.extractions.push(() => turn({ title: "Refonte de la carte", engine: "", ready: true, questions: [], chantiers, visuels, transmettre: true }) as never);
    const c = sb.hub.conceptions.start(sb.human(), { kind: "feature", project: "destiny", idea: "refaire la map" });
    await sb.hub.conceptions.idle();
    await sb.hub.art.idle();
    expect(fake.calls[0]!.systemPrompt).toMatch(/DIRECTEUR ARTISTIQUE/);

    // Chez le Directeur artistique : une fiche par visuel, et la demande avec le dossier ; il a pris la main.
    const art = sb.hub.art.state("destiny");
    expect(art.assets.map((a) => [a.id, a.name, a.status])).toEqual([
      ["A-0001", "Texture de roche stratifiée", "propose"],
      ["A-0002", "Arbre de la forêt", "propose"],
    ]);
    expect(art.messages[0]!.text).toMatch(/Demande transmise par le Concepteur, conception « Refonte de la carte »[\s\S]*copié dans ton dossier : conceptions\/refonte-de-la-carte\.md[\s\S]*A-0001 « Texture de roche stratifiée »/);
    expect(art.messages.at(-1)!.role).toBe("art");
    // Le DA ne lit que studio/art : le dossier y est copié.
    expect(readFileSync(join(root, "studio", "art", "conceptions", "refonte-de-la-carte.md"), "utf8")).toMatch(/Chats du Néant/);

    // Les chantiers : celui qui en dépend sait quel visuel arrivera et pose un provisoire ; l'autre n'en parle pas.
    const tasks = sb.hub.tasks.list("destiny");
    const cliffs = tasks.find((t) => t.title === "Falaises en strates")!;
    expect(cliffs.goal).toMatch(/Visuels confiés au Directeur artistique, pas encore faits :\n- A-0001 « Texture de roche stratifiée » \(texture\)[\s\S]*visuel provisoire[\s\S]*Dossier de conception complet/);
    expect(tasks.find((t) => t.title === "Collisions des terrasses")!.goal).not.toMatch(/Directeur artistique/);
    expect(sb.hub.conceptions.messages(c.id).at(-1)!.text).toMatch(/Les 2 visuel\(s\) prévus partent chez le Directeur artistique/);
    const thread = cliffs.origin!.thread;
    expect(sb.hub.conversations.messages("destiny", thread)[0]!.text).toMatch(/Visuels confiés au Directeur artistique[\s\S]*A-0001 Texture de roche stratifiée, A-0002 Arbre de la forêt/);
  });

  it("un redémarrage du hub pendant que le Concepteur travaille vous rend la main, avec un mot (ADR-61)", async () => {
    const fake = new FakeOrchestrator();
    const sb = sandbox(fake);
    fake.extractions.push(() => turn() as never);
    const c = sb.hub.conceptions.start(sb.human(), { kind: "project", idea: "un jeu de course" });
    await sb.hub.conceptions.idle();
    sb.hub.db.prepare("UPDATE conceptions SET status = 'thinking' WHERE id = ?").run(c.id);
    sb.hub.conceptions.recoverInterrupted();
    expect(sb.hub.conceptions.get(c.id).status).toBe("open");
    expect(sb.hub.conceptions.messages(c.id).at(-1)!.text).toMatch(/Le hub a redémarré pendant que je travaillais/);
  });

  it("une erreur du Concepteur est dite clairement et on peut réessayer", async () => {
    const fake = new FakeOrchestrator();
    const sb = sandbox(fake);
    fake.extractions.push(new Error("délai dépassé"));
    const c = sb.hub.conceptions.start(sb.human(), { kind: "project", idea: "un jeu de course" });
    await sb.hub.conceptions.idle();
    expect(sb.hub.conceptions.get(c.id).status).toBe("open");
    expect(sb.hub.conceptions.messages(c.id).at(-1)!.text).toMatch(/délai dépassé[\s\S]*réessayer/);
  });
});
