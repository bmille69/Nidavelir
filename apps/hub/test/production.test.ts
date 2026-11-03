import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDirectives } from "../src/conversation/conversation-service.ts";
import { createHub, type Hub } from "../src/hub.ts";
import { PRODUCER, PRODUCTION_MARK, type PlanData } from "../src/production/production-service.ts";
import { SOUND_DIRECTOR } from "../src/sound/sound-service.ts";
import type { EffectRequest, MusicRequest, SoundGenPort } from "../src/sound/elevenlabs.ts";
import { FakeExecutor, REPORT, VERIFIED } from "./fake-executor.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, git, sandbox, type Sandbox } from "./helpers.ts";

/** Le plan de production (ADR-107) : un objectif, tous les métiers enchaînés par les circuits existants. */
vi.setConfig({ testTimeout: 60_000 });
afterEach(() => cleanupSandboxes());

const P = "jeu";
const MP3 = (n: number) => Buffer.concat([Buffer.from("ID3"), Buffer.alloc(2000, n)]);

const PLAN: PlanData = {
  titre: "Le boss Gardien",
  objectif: "Un boss apparaît à la vague 10 : il a 500 PV, une attaque de zone, une silhouette à lui et un rugissement.",
  criteres: ["À la vague 10, un boss de 500 PV apparaît", "Son attaque de zone touche les tours à moins de 3 cases", "Son rugissement est joué à son apparition"],
  visuels: [{ cle: "v1", nom: "Gardien", type: "sprite", usage: "le boss, vu de dessus", specs: "64x64, 4 directions" }],
  sons: [{ nom: "Rugissement", usage: "à l'apparition du boss" }],
  chantiers: [
    { cle: "c1", titre: "Le boss et ses PV", consigne: "Objectif : un boss à la vague 10.\nÀ faire : 500 PV.\nOù : src/boss.ts\nContraintes : rien.\nVérification : test.\nHors périmètre : l'attaque.", visuels: ["v1", "inconnu"], sons: ["Rugissement"] },
    { cle: "c2", titre: "L'attaque de zone", consigne: "Objectif : une attaque de zone.\nÀ faire : 3 cases.\nOù : src/attaque.ts\nContraintes : rien.\nVérification : test.\nHors périmètre : le visuel.", visuels: [], sons: [] },
  ],
  note: "Le code avance pendant que le Directeur artistique fait le Gardien ; vous choisirez le rugissement.",
};

/** Le directeur prépare le plan, le directeur sonore propose, le carnet « État du jeu » se réécrit : chacun reconnu à sa consigne. */
class Orchestrator extends FakeOrchestrator {
  plan: PlanData | Error = PLAN;
  readonly plans: { prompt: string; system: string }[] = [];
  override async structured(input: { systemPrompt: string; prompt: string; jsonSchema: object; skillsDir?: string }) {
    if (input.systemPrompt.startsWith(PRODUCER.slice(0, 60))) {
      this.plans.push({ prompt: input.prompt, system: input.systemPrompt });
      if (this.plan instanceof Error) throw this.plan;
      return { data: structuredClone(this.plan), costUsd: 0.05 };
    }
    if (input.systemPrompt.startsWith(SOUND_DIRECTOR.slice(0, 40)))
      return { data: { note: "Grave et rauque.", sounds: [{ name: "Rugissement", kind: "effet", usage: "à l'apparition du boss", prompt: "deep monster roar, short", seconds: 2, loop: false }] }, costUsd: 0.01 };
    if (/<etat|État du jeu/.test(input.systemPrompt)) return { data: { etat: "Le jeu a un boss Gardien et son attaque de zone, testés." }, costUsd: 0.001 };
    return super.structured(input);
  }
}

class FakeSoundGen implements SoundGenPort {
  readonly name = "fake";
  key: string | null = "sk_test";
  configured() {
    return this.key !== null;
  }
  async setKey(k: string) {
    this.key = k;
  }
  async credits() {
    return { used: 0, limit: 30_000, tier: "creator", resetsAt: null };
  }
  async effect(_req: EffectRequest) {
    return MP3(1);
  }
  async music(_req: MusicRequest) {
    return MP3(2);
  }
}

async function settle(hub: Hub) {
  for (let k = 0; k < 10; k++) {
    await hub.conversations.idle();
    await hub.tasks.idle();
    await hub.autopilot?.idle();
    await hub.gameState.idle();
    await hub.sound.idle();
    await hub.art.idle();
    await hub.productions?.idle();
  }
}

async function setup(opts: { production?: false } = {}) {
  const orch = new Orchestrator();
  const exec = new FakeExecutor();
  const sb: Sandbox = sandbox();
  sb.hub.close();
  const hub = createHub({
    databasePath: join(sb.dir, "hub/.data/production.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    clock: fakeClock(),
    orchestrator: orch,
    executor: exec,
    soundGen: new FakeSoundGen(),
    dataDir: join(sb.dir, "hub/.data"),
    autopilot: { synthesisDelayMs: 0 },
    ...(opts.production === false ? { production: false as const } : {}),
  });
  sb.hub = hub;
  const root = sb.makeGameRepo("games/jeu", { "README.md": "# Jeu\n", "src/main.ts": "export {};\n", "studio/BRIEF.md": "# Jeu\nTower defense.\n" });
  await hub.projects.register(sb.human(), { path: root, slug: P, name: "Jeu" });
  hub.projects.setAutonomy(sb.human(), P, "workshop");
  const thread = hub.conversations.createThread(P, "Le boss").id;
  const notes = () => hub.conversations.messages(P, thread).map((m) => m.text).join("\n---\n");
  /** Le directeur répond par un bloc [[PRODUCTION]] : le plan se prépare. */
  const ask = async () => {
    orch.replies.push("Un boss touche le code, un visuel et un son : je prépare un plan de production.\n[[PRODUCTION]]\nUn boss Gardien à la vague 10, avec son visuel et son rugissement. Il veut 500 PV.\n[[/PRODUCTION]]");
    await hub.conversations.send(P, thread, "Je veux un boss à la vague 10, avec son look et un rugissement.");
    await settle(hub);
    return hub.productions!.list(P)[0]!;
  };
  return { sb, hub, orch, exec, root, thread, notes, ask };
}

/** Un chantier qui écrit un fichier, puis un testeur qui valide. */
function works(exec: FakeExecutor, file: string, content: string, check?: (prompt: string) => void) {
  exec.scripts.execute.push(async (t, req) => {
    check?.(req.prompt);
    await t.write(file, content);
    return REPORT;
  });
  exec.scripts.verify.push(() => VERIFIED);
}

describe("le bloc [[PRODUCTION]]", () => {
  it("est lu à part, et sans lui les consignes du directeur restent exactement les mêmes", () => {
    const plain = parseDirectives("Je lance.\n[[CHANTIER: Grille]]\nObjectif : une grille.\n[[/CHANTIER]]");
    expect(plain.directives).not.toHaveProperty("production");
    const withPlan = parseDirectives("Voici le plan.\n[[PRODUCTION]]\nUn boss avec son visuel.\n[[/PRODUCTION]]");
    expect(withPlan.directives.production).toBe("Un boss avec son visuel.");
    expect(withPlan.text).toBe("Voici le plan.");
  });
});

describe("le plan de production", () => {
  it("préparé, validé d'un clic, puis code, visuel et son enchaînés jusqu'à la vérification d'ensemble", async () => {
    const { sb, hub, orch, exec, root, thread, notes, ask } = await setup();
    // Le directeur, en atelier, connaît la règle.
    expect(orch.calls.find((c) => c.kind === "reply")?.systemPrompt ?? "").toBe("");
    const prod = await ask();
    expect(orch.calls.find((c) => c.kind === "reply")!.systemPrompt).toMatch(/<plans_de_production>[\s\S]*\[\[PRODUCTION\]\]/);

    // Préparé avec la demande, la discussion et le jeu ; montré dans la discussion ; rien n'est lancé sans vous.
    expect(prod).toMatchObject({ status: "proposed", title: "Le boss Gardien", thread });
    expect(orch.plans[0]!.prompt).toMatch(/<demande>\nUn boss Gardien à la vague 10[\s\S]*<discussion>[\s\S]*Je veux un boss[\s\S]*<fichiers_du_jeu[\s\S]*src\/main\.ts/);
    expect(notes()).toMatch(/Je prépare le plan de production P-0001/);
    expect(notes()).toContain(`${PRODUCTION_MARK}{"id":"P-0001"}`);
    expect(hub.tasks.list(P)).toEqual([]);
    expect(hub.productions!.waiting(P)).toEqual([{ text: "Plan « Le boss Gardien » : à valider", href: `#/p/${P}/t/${thread}` }]);
    // Le renvoi vers un visuel inconnu du plan est retiré.
    expect(prod.plan!.chantiers[0]!.visuels).toEqual(["v1"]);

    // Valider : il faut votre session.
    await expect(hub.productions!.start({ id: "x" } as never, P, prod.id)).rejects.toThrow();
    works(exec, "src/boss.ts", "export const pv = 500;\n", (prompt) => {
      expect(prompt).toMatch(/Plan de production P-0001 « Le boss Gardien », chantier 1 sur 2\. Dossier du plan[^\n]*studio\/production\/p-0001-le-boss-gardien\.md/);
      expect(prompt).toMatch(/Visuels confiés au Directeur artistique, pas encore faits :\n- A-0001 « Gardien » \(sprite\)/);
      expect(prompt).toMatch(/Sons prévus par le plan pour ce chantier \(Rugissement\) : n'en ajoute aucun[\s\S]*point d'accroche/);
    });
    works(exec, "src/attaque.ts", "export const portee = 3;\n");
    const view = await hub.productions!.start(sb.human(), P, prod.id);
    await expect(hub.productions!.start(sb.human(), P, prod.id)).rejects.toThrow(/déjà lancé/);
    expect(view.status).toBe("running");
    // Le dossier du plan est dans le jeu, commité ; le DA a sa fiche ; le directeur sonore a proposé.
    expect(readFileSync(join(root, "studio/production/p-0001-le-boss-gardien.md"), "utf8")).toMatch(/# Plan de production P-0001 : Le boss Gardien[\s\S]*## Critères d'acceptation de l'ensemble\n1\. À la vague 10/);
    expect(git(root, "log", "--format=%s")).toMatch(/studio: plan de production P-0001 « Le boss Gardien »/);
    await settle(hub);
    expect(hub.art.state(P).assets.map((a) => [a.id, a.name, a.status])).toEqual([["A-0001", "Gardien", "propose"]]);
    expect(hub.sound.sounds(P).map((s) => [s.id, s.status])).toEqual([["S-0001", "propose"]]);

    // Les deux chantiers sont fusionnés par la file habituelle ; le plan attend vos choix de son et le visuel.
    const [c1, c2] = Object.values(hub.productions!.get(P, prod.id).refs.tasks);
    expect([hub.tasks.get(P, c1!).status, hub.tasks.get(P, c2!).status]).toEqual(["merged", "merged"]);
    let v = hub.productions!.view(P, prod.id);
    expect(v.steps.map((s) => [s.kind, s.label, s.state])).toEqual([
      ["chantier", "Le boss et ses PV", "done"],
      ["chantier", "L'attaque de zone", "done"],
      ["visuel", "Gardien", "active"],
      ["son", "Rugissement", "you"],
      ["verification", "Vérification d'ensemble", "todo"],
    ]);
    expect(hub.productions!.waiting(P)).toEqual([{ text: "Plan « Le boss Gardien » : S-0001 « Rugissement » — générez des essais et écoutez", href: `#/p/${P}/plans` }]);

    // Vous écoutez et choisissez : le branchement part tout seul, dans la discussion du plan.
    works(exec, "src/sound.ts", 'export const roar = "/audio/effet/rugissement.mp3";\n', (prompt) => expect(prompt).toMatch(/S-0001 « Rugissement »/));
    hub.sound.generate(sb.human(), P, "S-0001", 1);
    await hub.sound.idle();
    hub.sound.choose(sb.human(), P, "S-0001", "S-0001-1.mp3");
    await settle(hub);
    const soundTask = hub.productions!.get(P, prod.id).refs.soundTask!;
    expect(hub.tasks.get(P, soundTask)).toMatchObject({ title: "S-0001 : brancher le son « Rugissement »", status: "merged", origin: { thread } });
    expect(hub.sound.sounds(P)[0]!.status).toBe("integre");
    expect(hub.productions!.get(P, prod.id).refs.final).toBeNull();

    // Le visuel arrive dans le jeu (circuit du DA, simulé ici) : la vérification d'ensemble part, avec tout ce qui a été produit.
    const manifest = join(root, "studio/art/assets.json");
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    m.assets[0] = { ...m.assets[0], status: "integre", renders: ["production/a-0001.png"], verdict: { ok: true, summary: "ok", points: [], prompt: null, file: "production/a-0001.png", by: "human", at: "x" } };
    writeFileSync(manifest, JSON.stringify(m, null, 2));
    git(root, "commit", "-am", "art: A-0001 intégré (test)");
    works(exec, "test/boss.test.ts", "// critères du plan\n", (prompt) => {
      expect(prompt).toMatch(/Vérification d'ensemble du plan de production P-0001 « Le boss Gardien »[\s\S]*1\. À la vague 10, un boss de 500 PV apparaît[\s\S]*- A-0001 « Gardien » : studio\/art\/production\/a-0001\.png[\s\S]*- S-0001 « Rugissement » : public\/audio\/effet\/rugissement\.mp3[\s\S]*Écris ou complète des tests automatisés/);
    });
    hub.productions!.advance(P);
    await settle(hub);
    const done = hub.productions!.view(P, prod.id);
    expect(hub.tasks.get(P, done.refs.final!)).toMatchObject({ title: "Vérification d'ensemble : Le boss Gardien", status: "merged" });
    expect(done.status).toBe("done");
    expect(done.steps.every((s) => s.state === "done")).toBe(true);
    expect(notes()).toMatch(/✓ Plan P-0001 « Le boss Gardien » terminé/);
    expect(hub.productions!.waiting(P)).toEqual([]);
    expect(existsSync(join(root, "test/boss.test.ts"))).toBe(true);
  });

  it("un chantier en échec met le plan en pause, le dit une fois ; relancé, le plan reprend ; « Continuer sans » existe", async () => {
    const { sb, hub, orch, exec, notes, ask } = await setup();
    orch.plan = { ...PLAN, visuels: [], sons: [], chantiers: [PLAN.chantiers[1]!] };
    const prod = await ask();
    exec.scripts.execute.push(async () => {
      throw new Error("le développeur a planté");
    });
    await hub.productions!.start(sb.human(), P, prod.id);
    await settle(hub);
    const tid = Object.values(hub.productions!.get(P, prod.id).refs.tasks)[0]!;
    expect(hub.tasks.get(P, tid).status).toBe("failed");
    expect(hub.productions!.get(P, prod.id).status).toBe("paused");
    expect(notes().match(/⏸ Plan P-0001 en pause/g)).toHaveLength(1);
    hub.productions!.advance(P);
    await settle(hub);
    expect(notes().match(/⏸ Plan P-0001 en pause/g)).toHaveLength(1);
    expect(hub.productions!.waiting(P)[0]!.text).toMatch(/en pause, T-0001 .* à relancer/);
    // Pas de sons dans ce plan : « Continuer sans les sons » n'a pas de sens.
    expect(() => hub.productions!.skip(sb.human(), P, prod.id, "sons")).toThrow(/Étape introuvable/);
    // Relancé : le plan reprend, puis sa vérification d'ensemble part.
    works(exec, "src/attaque.ts", "export const portee = 3;\n");
    works(exec, "test/attaque.test.ts", "// ok\n");
    await hub.tasks.launch(P, tid);
    await settle(hub);
    expect(notes()).toMatch(/▶ Plan P-0001 : l'étape bloquée est repartie/);
    expect(hub.productions!.get(P, prod.id).status).toBe("done");
    // Sur un plan fini, plus rien ne se saute.
    expect(() => hub.productions!.skip(sb.human(), P, prod.id, tid)).toThrow(/pas en cours/);
  });

  it("refaire une proposition remplace celle qui n'était pas validée ; un plan abandonné ne lance plus rien", async () => {
    const { sb, hub, ask } = await setup();
    const first = await ask();
    const second = await ask();
    expect(second.id).not.toBe(first.id);
    expect(hub.productions!.get(P, first.id)).toMatchObject({ status: "cancelled", refs: { replacedBy: second.id } });
    await expect(hub.productions!.start(sb.human(), P, first.id)).rejects.toThrow(/ne peut plus être lancé/);
    hub.productions!.cancel(sb.human(), P, second.id);
    expect(hub.productions!.get(P, second.id).status).toBe("cancelled");
    expect(hub.tasks.list(P)).toEqual([]);
  });

  it("en séance autonome, le plan part sans attendre et la séance compte ses chantiers", async () => {
    const { hub, orch, exec, thread, notes } = await setup();
    orch.plan = { ...PLAN, visuels: [], sons: [], chantiers: [PLAN.chantiers[1]!] };
    works(exec, "src/attaque.ts", "export const portee = 3;\n");
    works(exec, "test/attaque.test.ts", "// ok\n");
    orch.replies.push("Je bosse seul une heure.\n[[SEANCE: 1h | le boss]]\n[[PRODUCTION]]\nUne attaque de zone.\n[[/PRODUCTION]]");
    await hub.conversations.send(P, thread, "Bosse en autonomie 1 h sur le boss.");
    await settle(hub);
    const prod = hub.productions!.list(P)[0]!;
    expect(prod.auto).toBe(true);
    expect(notes()).toMatch(/part tout de suite, séance autonome oblige/);
    expect(hub.productions!.get(P, prod.id).status).toBe("done");
    // La séance a suivi les chantiers du plan comme les siens, et son bilan parle du plan.
    const ended = hub.journal.list({ project: P, limit: 5000 }).find((e) => e.type === "session.ended");
    expect((ended?.payload as { tasks: string[] }).tasks).toEqual(expect.arrayContaining([Object.values(prod.refs.tasks)[0], hub.productions!.get(P, prod.id).refs.final]));
    expect(notes()).toMatch(/■ Fin de la séance[\s\S]*Plans de production :\n- Plan P-0001 « Le boss Gardien » : terminé/);
  });

  it("sans clé ElevenLabs : « Continuer sans les sons » d'un coup, et le plan finit sans eux", async () => {
    const { sb, hub, orch, exec, notes, ask } = await setup();
    orch.plan = { ...PLAN, visuels: [], chantiers: [PLAN.chantiers[1]!] };
    const prod = await ask();
    works(exec, "src/attaque.ts", "export const portee = 3;\n");
    await hub.productions!.start(sb.human(), P, prod.id);
    await settle(hub);
    expect(hub.productions!.view(P, prod.id).steps.find((s) => s.kind === "son")?.state).toBe("you");
    works(exec, "test/attaque.test.ts", "// ok\n", (prompt) => expect(prompt).not.toMatch(/S-0001/));
    hub.productions!.skip(sb.human(), P, prod.id, "sons");
    await settle(hub);
    const v = hub.productions!.view(P, prod.id);
    expect(v.status).toBe("done");
    expect(v.steps.find((s) => s.kind === "sons")).toMatchObject({ state: "skipped" });
    expect(notes()).toMatch(/on continue sans « les sons du plan »/);
  });

  it("une préparation impossible est dite dans la discussion, sans rien lancer", async () => {
    const { hub, orch, notes, ask } = await setup();
    orch.plan = new Error("quota atteint");
    const prod = await ask();
    expect(prod.status).toBe("cancelled");
    expect(notes()).toMatch(/Je n'ai pas pu préparer le plan de production \(quota atteint\)/);
    expect(hub.tasks.list(P)).toEqual([]);
  });

  it("désactivé (STUDIO_PRODUCTION=0) : aucun plan, le directeur n'en entend pas parler et le bloc est ignoré", async () => {
    const { hub, orch, notes, ask } = await setup({ production: false });
    expect(hub.productions).toBeNull();
    orch.replies.push("Plan.\n[[PRODUCTION]]\nUn boss.\n[[/PRODUCTION]]");
    await ask().catch(() => null);
    expect(orch.calls.filter((c) => c.kind === "reply").every((c) => !c.systemPrompt.includes("plans_de_production"))).toBe(true);
    expect(orch.plans).toEqual([]);
    expect(notes()).not.toMatch(/plan de production P-/);
    expect(hub.tasks.list(P)).toEqual([]);
  });
});
