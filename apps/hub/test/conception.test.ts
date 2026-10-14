import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, git, sandbox } from "./helpers.ts";

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
    // Le second tour voit le dossier du premier et les échanges.
    expect(fake.calls[1]!.prompt).toMatch(/<dossier_actuel>\n# Chats du Néant[\s\S]*Navigateur/);

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
