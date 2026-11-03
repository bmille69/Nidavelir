import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conflictBetween, type Scope } from "../src/executor/foreman.ts";
import { isRegistre, mergeCsv3, mergeJson3, mergeJsonTexte3, mergeTexte3 } from "../src/executor/registres.ts";
import { createHub, type Hub } from "../src/hub.ts";
import { FakeExecutor, REPORT, VERIFIED } from "./fake-executor.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, git, sandbox, type Sandbox } from "./helpers.ts";

/** Les registres du jeu : fusion clé par clé, pour que le parallèle ne s'y bloque plus (ADR-119). */
vi.setConfig({ testTimeout: 40_000 });
afterEach(() => cleanupSandboxes());

const P = "jeu";
const BALANCE = `{\n  "joueur": {\n    "vie": 100\n  }\n}\n`;
const CSV = "keys,fr\nmenu,Menu\n";

describe("fusion à trois d'un JSON", () => {
  it("clés disjointes des deux côtés : l'union, sans conflit", () => {
    expect(mergeJson3({ a: 1 }, { a: 1, b: 2 }, { a: 1, c: 3 })).toEqual({ ok: true, value: { a: 1, b: 2, c: 3 } });
  });

  it("même clé : mêmes valeurs, accord ; valeurs différentes, conflit qui dit où", () => {
    expect(mergeJson3({}, { a: 1 }, { a: 1 })).toEqual({ ok: true, value: { a: 1 } });
    expect(mergeJson3({ a: 0 }, { a: 1 }, { a: 2 })).toEqual({ ok: false, ou: "a" });
    expect(mergeJson3({}, { a: 1 }, { a: 2 })).toEqual({ ok: false, ou: "a" });
  });

  it("une clé ajoutée ou retirée d'un seul côté est prise telle quelle", () => {
    expect(mergeJson3({ a: 1 }, { a: 1, b: 2 }, { a: 1 })).toEqual({ ok: true, value: { a: 1, b: 2 } });
    expect(mergeJson3({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2, c: 3 })).toEqual({ ok: true, value: { a: 1, c: 3 } });
    // Retirée d'un côté, modifiée de l'autre : on ne choisit pas.
    expect(mergeJson3({ a: 1 }, {}, { a: 2 })).toEqual({ ok: false, ou: "a" });
  });

  it("un tableau n'est sûr que si un seul côté l'a changé", () => {
    expect(mergeJson3({ t: [1] }, { t: [1, 2] }, { t: [1] })).toEqual({ ok: true, value: { t: [1, 2] } });
    expect(mergeJson3({ t: [1] }, { t: [1, 2] }, { t: [1, 3] })).toEqual({ ok: false, ou: "t" });
  });

  it("imbrication profonde : le chemin du désaccord est donné", () => {
    const base = { joueur: { stats: { vie: 1 } } };
    expect(mergeJson3(base, { joueur: { stats: { vie: 1, mana: 2 } } }, { joueur: { stats: { vie: 1, force: 3 } } })).toEqual({ ok: true, value: { joueur: { stats: { vie: 1, mana: 2, force: 3 } } } });
    expect(mergeJson3(base, { joueur: { stats: { vie: 2 } } }, { joueur: { stats: { vie: 3 } } })).toEqual({ ok: false, ou: "joueur.stats.vie" });
  });

  it("une clé nommée comme une propriété d'Object reste une donnée", () => {
    const ours = JSON.parse('{"__proto__": {"x": 1}, "constructor": 2}') as unknown;
    const res = mergeJson3({}, ours, { b: 1 });
    expect(res.ok && JSON.stringify(res.value)).toBe('{"__proto__":{"x":1},"constructor":2,"b":1}');
  });
});

describe("fusion à trois d'un fichier JSON : le texte source est gardé", () => {
  const BASE = `{\n  "joueur": {\n    "vitesse_marche": 6.0,\n    "gravite": -14.0,\n    "chute": 1e3,\n    "nom": "caf\\u00e9"\n  },\n  "liste": [1.0,   2.50],\n  "ennemis": {\n    "rat": { "vie": 0.0 }\n  }\n}\n`;
  const ajoute = (texte: string, ajout: string) => texte.replace(/\n {2}\},\n {2}"liste"/, `,\n${ajout}\n  },\n  "liste"`);
  const ours = ajoute(BASE, `    "A": { "valeur": 1.50 }`);
  const theirs = ajoute(BASE, `    "B": [2.0,\n      3.0]`);
  const texte = (res: ReturnType<typeof mergeJsonTexte3>) => {
    if (!res.ok) throw new Error(`conflit sur ${res.ou}`);
    return res.value;
  };

  it("toutes les lignes de « ours » restent identiques et dans le même ordre ; les littéraux ne bougent pas", () => {
    const sortie = texte(mergeJsonTexte3(BASE, ours, theirs));
    const lignes = sortie.split("\n");
    let curseur = -1;
    for (const ligne of ours.split("\n")) {
      // À part la virgule ajoutée à la ligne qui n'est plus la dernière de son objet.
      const trouvee = lignes.findIndex((l, n) => n > curseur && l.replace(/,$/, "") === ligne.replace(/,$/, ""));
      expect(trouvee, ligne).toBeGreaterThan(curseur);
      curseur = trouvee;
    }
    expect(sortie).toContain(`"vitesse_marche": 6.0`);
    expect(sortie).not.toMatch(/"vitesse_marche": 6\s*,/);
    expect(sortie).toContain(`"liste": [1.0,   2.50]`);
    expect(sortie).toContain(`"nom": "caf\\u00e9"`);
    // La clé de l'autre camp arrive avec son texte d'origine, et le tout reste du JSON valide.
    expect(sortie).toContain(`"A": { "valeur": 1.50 },\n    "B": [2.0,\n      3.0]\n  },`);
    expect(JSON.parse(sortie)).toMatchObject({ joueur: { vitesse_marche: 6, A: { valeur: 1.5 }, B: [2, 3] } });
    expect(sortie.split("\n")).toHaveLength(ours.split("\n").length + 2);
  });

  it("un seul camp a changé : sa version, au caractère près", () => {
    expect(texte(mergeJsonTexte3(BASE, ours, BASE))).toBe(ours);
    expect(texte(mergeJsonTexte3(BASE, BASE, theirs))).toBe(theirs);
  });

  it("CRLF, BOM et absence de dernier retour à la ligne sont ceux de « ours »", () => {
    const crlf = (s: string) => s.replace(/\n/g, "\r\n");
    const sortie = texte(mergeJsonTexte3(crlf(BASE), `﻿${crlf(ours).trimEnd()}`, theirs));
    expect(sortie.startsWith("﻿{")).toBe(true);
    expect(sortie.endsWith("}")).toBe(true);
    expect(sortie.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(sortie).toContain(`"B": [2.0,\r\n      3.0]`);
  });

  it("une clé d'un fichier autrement retiré : décalée à sa nouvelle place sans changer son pas ; un fichier vide s'additionne", () => {
    const reste = texte(mergeJsonTexte3("{}", `{\n  "a": 1.0\n}\n`, `{\n    "b": {\n        "c": 2.0\n    }\n}\n`));
    expect(reste).toBe(`{\n  "a": 1.0,\n  "b": {\n      "c": 2.0\n  }\n}\n`);
    expect(texte(mergeJsonTexte3("{}", "{}\n", `{\n  "b": 2.0\n}\n`))).toBe(`{\n  "b": 2.0\n}\n`);
  });

  it("un retrait de clé garde le reste intact, y compris la virgule", () => {
    const b = `{\n  "a": 1.0,\n  "b": 2.0\n}\n`;
    expect(texte(mergeJsonTexte3(b, `{\n  "a": 1.0\n}\n`, `{\n  "a": 1.0,\n  "b": 2.0,\n  "c": 3.0\n}\n`))).toBe(`{\n  "a": 1.0,\n  "c": 3.0\n}\n`);
  });

  it("un désaccord, un tableau changé des deux côtés, un JSON invalide, une clé en double : conflit", () => {
    expect(mergeJsonTexte3(`{"a": 1.0}`, `{"a": 2.0}`, `{"a": 3.0}`)).toEqual({ ok: false, ou: "a" });
    expect(mergeJsonTexte3(`{"j": {"t": [1]}}`, `{"j": {"t": [2]}}`, `{"j": {"t": [3]}}`)).toEqual({ ok: false, ou: "j.t" });
    expect(mergeJsonTexte3("{}", `{"a": }`, "{}")).toMatchObject({ ok: false });
    expect(mergeJsonTexte3("{}", `{"a": 1, "a": 2}`, `{"b": 1}`)).toMatchObject({ ok: false });
  });

  it("le même littéral des deux côtés est un accord ; un littéral réécrit d'un seul côté est un changement", () => {
    expect(texte(mergeJsonTexte3(`{"a": 1}`, `{"a": 2.0}`, `{"a": 2.0}`))).toBe(`{"a": 2.0}`);
    expect(texte(mergeJsonTexte3(`{"a": 6.0}`, `{"a": 6.0}`, `{"a": 6}`))).toBe(`{"a": 6}`);
  });
});

describe("fusion à trois d'un CSV", () => {
  it("ajouts des deux côtés : la version « ours » d'abord, puis les nouvelles clés de « theirs »", () => {
    expect(mergeCsv3(CSV, `${CSV}a,A\n`, `${CSV}b,B\n`)).toEqual({ ok: true, value: `${CSV}a,A\nb,B\n` });
  });

  it("clé modifiée d'un seul côté : la modification ; des deux côtés : conflit", () => {
    expect(mergeCsv3(CSV, "keys,fr\nmenu,Accueil\n", `${CSV}b,B\n`)).toEqual({ ok: true, value: "keys,fr\nmenu,Accueil\nb,B\n" });
    expect(mergeCsv3(CSV, "keys,fr\nmenu,Accueil\n", "keys,fr\nmenu,Départ\n")).toEqual({ ok: false, ou: "menu" });
    expect(mergeCsv3(CSV, `${CSV}a,A\n`, `${CSV}a,Autre\n`)).toEqual({ ok: false, ou: "a" });
  });

  it("une clé en double dans un côté : conflit, plutôt que d'en perdre une", () => {
    expect(mergeCsv3(CSV, `${CSV}a,A\na,B\n`, CSV)).toEqual({ ok: false, ou: "a" });
  });

  it("le CRLF est conservé", () => {
    const crlf = CSV.replace(/\n/g, "\r\n");
    expect(mergeCsv3(crlf, `${crlf}a,A\r\n`, `${crlf}b,B\r\n`)).toEqual({ ok: true, value: `${crlf}a,A\r\nb,B\r\n` });
  });

  it("une cellule entre guillemets peut contenir une virgule ou un retour à la ligne", () => {
    const ours = `${CSV}"a,b","deux\nlignes"\n`;
    expect(mergeCsv3(CSV, ours, `${CSV}c,C\n`)).toEqual({ ok: true, value: `${ours}c,C\n` });
    expect(mergeCsv3(CSV, `${CSV}"a,b",X\n`, `${CSV}"a,b",Y\n`)).toEqual({ ok: false, ou: "a,b" });
    expect(mergeCsv3(CSV, `${CSV}a,"ouvert\n`, CSV).ok).toBe(false);
  });

  it("la première ligne n'est jamais tranchée au hasard", () => {
    expect(mergeCsv3(CSV, "keys,fr,en\nmenu,Menu\n", `${CSV}a,A\n`)).toEqual({ ok: true, value: "keys,fr,en\nmenu,Menu\na,A\n" });
    expect(mergeCsv3(CSV, "keys,fr,en\nmenu,Menu\n", "keys,fr,de\nmenu,Menu\n")).toEqual({ ok: false, ou: "première ligne" });
  });
});

describe("carnet markdown", () => {
  it("garde les ajouts des deux versions", () => {
    const res = mergeTexte3("# Carnet\n", "# Carnet\n- a\n", "# Carnet\n- b\n");
    expect(res).toContain("- a\n");
    expect(res).toContain("- b\n");
    expect(res).not.toMatch(/<{7}/);
  });

  it("garde une ligne vide avant un titre qui suit du texte, sans rien retirer", () => {
    const res = mergeTexte3("# Carnet\n", "# Carnet\n\n## A\n- [ ] visuel de A (provisoire)\n", "# Carnet\n\n## B\n- [ ] visuel de B\n")!;
    expect(res).toContain("- [ ] visuel de A (provisoire)\n\n## B\n");
    expect(res).not.toMatch(/\n\n\n/);
    for (const ligne of ["# Carnet", "## A", "- [ ] visuel de A (provisoire)", "## B", "- [ ] visuel de B"]) expect(res).toContain(ligne);
    expect(mergeTexte3("x\r\n", "x\r\n# A\r\n", "x\r\n")).toBe("x\r\n\r\n# A\r\n");
    // Un « # » dans un bloc de code n'est pas un titre.
    expect(mergeTexte3("", "```\nx\n# commentaire\n```\n", "")).toBe("```\nx\n# commentaire\n```\n");
  });
});

describe("ce qu'est un registre", () => {
  it("data/**.json, data/**.csv et le carnet des visuels, rien d'autre", () => {
    for (const p of ["data/balance.json", "data/translations.csv", "docs/visuels_en_attente.md", "data/waves.json", "data/niveaux/un.json", "DATA\\Balance.JSON", "./data/a.csv"]) expect(isRegistre(p), p).toBe(true);
    for (const p of ["scripts/player/player.gd", "src/data/a.json", "data/a.tres", "docs/autre.md", "project.godot", "data/"]) expect(isRegistre(p), p).toBe(false);
  });

  it("un registre commun n'est plus un croisement ; tout autre fichier commun, si", () => {
    const scope = (files: string[]): Scope => ({ files, depends_on: [], confident: true, note: "", at: "" });
    const shared = ["data/balance.json", "data/translations.csv", "docs/visuels_en_attente.md"];
    expect(conflictBetween({ id: "T-0001", scope: scope([...shared, "src/a.ts"]) }, { id: "T-0002", scope: scope([...shared, "src/b.ts"]) })).toBeNull();
    expect(conflictBetween({ id: "T-0001", scope: scope(["src/a.ts"]), touched: ["data/balance.json"] }, { id: "T-0002", scope: scope(["data/balance.json"]) })).toBeNull();
    expect(conflictBetween({ id: "T-0001", scope: scope(["data/a.json", "src/a.ts"]) }, { id: "T-0002", scope: scope(["data/a.json", "src/a.ts"]) })).toMatch(/touchent tous deux src\/a\.ts/);
  });
});

/** Orchestrateur de test : le chef de chantier rend la fiche préparée pour chaque chantier. */
class Orchestrator extends FakeOrchestrator {
  readonly scopes = new Map<string, Partial<Scope>>();
  override async structured(input: { systemPrompt: string; prompt: string; jsonSchema: object; skillsDir?: string }) {
    if (!input.systemPrompt.includes("CHEF DE CHANTIER")) return super.structured(input);
    const id = /<chantier id="(T-\d+)">/.exec(input.prompt)![1]!;
    return { data: { files: [], depends_on: [], confident: false, note: "?", ...this.scopes.get(id) }, costUsd: 0.002 };
  }
}

async function settle(hub: Hub) {
  for (let k = 0; k < 8; k++) {
    await hub.conversations.idle();
    await hub.tasks.idle();
    await hub.autopilot?.idle();
    await hub.gameState.idle();
  }
}

async function setup() {
  const orch = new Orchestrator();
  const exec = new FakeExecutor();
  const sb: Sandbox = sandbox();
  sb.hub.close();
  const hub = createHub({
    databasePath: join(sb.dir, "hub/.data/registres.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    clock: fakeClock(),
    orchestrator: orch,
    executor: exec,
    dataDir: join(sb.dir, "hub/.data"),
    autopilot: { synthesisDelayMs: 0 },
    parallel: 2,
  });
  sb.hub = hub;
  const root = sb.makeGameRepo("games/jeu", { "README.md": "# Jeu\n", "src/main.ts": "export {};\n", "data/balance.json": BALANCE, "data/translations.csv": CSV });
  await hub.projects.register(sb.human(), { path: root, slug: P, name: "Jeu" });
  hub.projects.setAutonomy(sb.human(), P, "workshop");
  const thread = hub.conversations.createThread(P, "Chantiers").id;
  const chantier = (title: string, goal: string) => hub.tasks.createFromConversation(P, { title, goal }, thread);
  const events = (type: string) => hub.journal.list({ project: P, limit: 5000 }).filter((e) => e.type === type);
  const executions = () => exec.requests.filter((r) => r.kind === "execute");
  return { hub, orch, exec, root, chantier, events, executions, sb };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

const REGISTRES = ["data/balance.json", "data/translations.csv"];
const balance = (cle: string, valeur: number) => `{\n  "joueur": {\n    "vie": 100,\n    "${cle}": ${valeur}\n  }\n}\n`;

describe("deux chantiers sur les mêmes registres", () => {
  /** Deux chantiers qui écrivent chacun leurs clés et leur fichier de code, et travaillent en même temps. */
  function deuxChantiers({ orch, exec, chantier }: Awaited<ReturnType<typeof setup>>, aLaVerif: () => void = () => {}) {
    const a = chantier("Mana", "Où : src/mana.ts");
    const b = chantier("Force", "Où : src/force.ts");
    orch.scopes.set(a.id, { files: [...REGISTRES, "src/mana.ts"], confident: true });
    orch.scopes.set(b.id, { files: [...REGISTRES, "src/force.ts"], confident: true });
    const together = gate();
    exec.scripts.execute.push(async (t) => {
      await together.opened;
      await t.write("data/balance.json", balance("mana", 50));
      await t.write("data/translations.csv", `${CSV}mana,Mana\n`);
      await t.write("src/mana.ts", "export const mana = 50;\n");
      return REPORT;
    });
    exec.scripts.execute.push(async (t) => {
      together.open();
      await t.write("data/balance.json", balance("force", 7));
      await t.write("data/translations.csv", `${CSV}force,Force\n`);
      await t.write("src/force.ts", "export const force = 7;\n");
      return REPORT;
    });
    const verdict = () => {
      aLaVerif();
      return VERIFIED;
    };
    exec.scripts.verify.push(verdict, verdict);
    return { a, b };
  }

  it("ils travaillent en même temps et fusionnent sans réconciliation ; le jeu contient les clés des deux", async () => {
    const ctx = await setup();
    const { hub, root, events, executions } = ctx;
    const { a, b } = deuxChantiers(ctx);
    await hub.tasks.launch(P, a.id);
    await hub.tasks.launch(P, b.id);
    await settle(hub);

    expect([hub.tasks.get(P, a.id).status, hub.tasks.get(P, b.id).status]).toEqual(["merged", "merged"]);
    expect(events("task.parallel")).toHaveLength(1);
    expect(executions()).toHaveLength(2);
    expect(JSON.parse(git(root, "show", "HEAD:data/balance.json"))).toEqual({ joueur: { vie: 100, mana: 50, force: 7 } });
    const csv = git(root, "show", "HEAD:data/translations.csv");
    expect(csv.startsWith(CSV)).toBe(true);
    expect(csv).toContain("mana,Mana\n");
    expect(csv).toContain("force,Force\n");
    expect(git(root, "show", "HEAD:src/mana.ts")).toMatch(/mana/);
    expect(git(root, "show", "HEAD:src/force.ts")).toMatch(/force/);
    expect(git(root, "status", "--porcelain")).toBe("");
    const merged = events("task.registers_merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.payload).toMatchObject({ resolved: expect.arrayContaining(REGISTRES) });
    expect(events("task.integrated").map((e) => e.payload)).toContainEqual(expect.objectContaining({ conflicts: [] }));
  });

  it("le développeur ne voit pas un registre comme un fichier tenu par l'autre", async () => {
    const ctx = await setup();
    const { hub, executions } = ctx;
    const { a, b } = deuxChantiers(ctx);
    await hub.tasks.launch(P, a.id);
    await hub.tasks.launch(P, b.id);
    await settle(hub);
    const second = executions().map((r) => r.prompt).find((p) => /a en main/.test(p))!;
    expect(second).toMatch(/a en main : src\/mana\.ts\./);
    expect(second).toMatch(/fusionne clé par clé/);
  });

  it("fusion directe dans le dépôt du joueur, sans intégration préalable : les registres se fusionnent aussi", async () => {
    const ctx = await setup();
    const { hub, root, sb, events } = ctx;
    const { a, b } = deuxChantiers(ctx, () => hub.projects.setAutonomy(sb.human(), P, "supervised"));
    await hub.tasks.launch(P, a.id);
    await hub.tasks.launch(P, b.id);
    await settle(hub);
    const first = await hub.tasks.review(P, a.id);
    const second = await hub.tasks.review(P, b.id);
    await hub.tasks.merge(sb.human(), P, a.id, first.head!);
    const { sha } = await hub.tasks.merge(sb.human(), P, b.id, second.head!);
    expect(sha).toBe(git(root, "rev-parse", "HEAD").trim());
    // Une vraie fusion : deux parents, annulable comme les autres.
    expect(git(root, "log", "-1", "--format=%P").trim().split(" ")).toHaveLength(2);
    expect(JSON.parse(git(root, "show", "HEAD:data/balance.json"))).toEqual({ joueur: { vie: 100, mana: 50, force: 7 } });
    expect(events("task.registers_merged")).toHaveLength(1);
    expect(events("task.merged")).toHaveLength(2);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("fusion directe avec un vrai désaccord : le même refus qu'avant, le dépôt du joueur intact", async () => {
    const { hub, root, sb, orch, exec, chantier, events } = await setup();
    const a = chantier("Vie haute", "Où : src/a.ts");
    const b = chantier("Vie basse", "Où : src/b.ts");
    orch.scopes.set(a.id, { files: ["data/balance.json", "src/a.ts"], confident: true });
    orch.scopes.set(b.id, { files: ["data/balance.json", "src/b.ts"], confident: true });
    const secondDone = gate();
    for (const vie of [150, 80]) {
      exec.scripts.execute.push(async (t) => {
        if (vie === 150) await secondDone.opened;
        await t.write("data/balance.json", BALANCE.replace("100", String(vie)));
        if (vie === 80) secondDone.open();
        return REPORT;
      });
      // « Je valide tout » une fois le travail fait : personne ne fusionne à la place du joueur, donc pas d'intégration avant.
      exec.scripts.verify.push(() => {
        hub.projects.setAutonomy(sb.human(), P, "supervised");
        return VERIFIED;
      });
    }
    await hub.tasks.launch(P, a.id);
    await hub.tasks.launch(P, b.id);
    await settle(hub);
    const first = await hub.tasks.review(P, a.id);
    const second = await hub.tasks.review(P, b.id);
    await hub.tasks.merge(sb.human(), P, a.id, first.head!);
    const before = git(root, "rev-parse", "HEAD");
    await expect(hub.tasks.merge(sb.human(), P, b.id, second.head!)).rejects.toThrow(/^Conflit de fusion sur : data\/balance\.json\. Rien n'a été modifié dans votre projet\.$/);
    expect(git(root, "rev-parse", "HEAD")).toBe(before);
    expect(existsSync(join(root, ".git/MERGE_HEAD"))).toBe(false);
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(events("task.registers_merged")).toEqual([]);
    expect(hub.tasks.get(P, b.id).status).toBe("review");
  });

  it("un fichier de code commun bloque toujours : le second attend, rien ne part en parallèle", async () => {
    const { hub, orch, exec, root, chantier, events } = await setup();
    const a = chantier("Vie", "Où : src/main.ts");
    const b = chantier("Mana", "Où : src/main.ts");
    orch.scopes.set(a.id, { files: ["src/main.ts", "data/balance.json"], confident: true });
    orch.scopes.set(b.id, { files: ["src/main.ts", "data/balance.json"], confident: true });
    exec.scripts.execute.push(async (t) => {
      await t.write("src/main.ts", "export const vie = 100;\n");
      return REPORT;
    });
    exec.scripts.execute.push(async (t) => {
      await t.write("src/main.ts", "export const vie = 100;\nexport const mana = 50;\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED, () => VERIFIED);
    await hub.tasks.launch(P, a.id);
    await hub.tasks.launch(P, b.id);
    await settle(hub);
    expect(events("task.parallel")).toEqual([]);
    expect(events("task.registers_merged")).toEqual([]);
    expect(git(root, "show", "HEAD:src/main.ts")).toBe("export const vie = 100;\nexport const mana = 50;\n");
  });

  it("un désaccord sur la même clé : le développeur réconcilie, avec les marqueurs, et rien n'est perdu", async () => {
    const { hub, orch, exec, root, chantier, events, executions } = await setup();
    const a = chantier("Vie haute", "Où : src/a.ts");
    const b = chantier("Vie basse", "Où : src/b.ts");
    orch.scopes.set(a.id, { files: ["data/balance.json", "src/a.ts"], confident: true });
    orch.scopes.set(b.id, { files: ["data/balance.json", "src/b.ts"], confident: true });
    const together = gate();
    exec.scripts.execute.push(async (t) => {
      await together.opened;
      await t.write("data/balance.json", BALANCE.replace("100", "150"));
      await t.write("src/a.ts", "export const a = 1;\n");
      return REPORT;
    });
    exec.scripts.execute.push(async (t) => {
      together.open();
      await t.write("data/balance.json", BALANCE.replace("100", "80"));
      await t.write("src/b.ts", "export const b = 1;\n");
      return REPORT;
    });
    exec.scripts.execute.push(async (t, req) => {
      expect(req.prompt).toMatch(/Réconciliation avec la version actuelle du jeu[\s\S]*- data\/balance\.json/);
      const text = readFileSync(join(req.cwd, "data/balance.json"), "utf8");
      expect(text).toMatch(/^<{7} /m);
      expect(text).toContain('"vie": 150');
      expect(text).toContain('"vie": 80');
      await t.write("data/balance.json", BALANCE.replace("100", "120"));
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED, () => VERIFIED, () => VERIFIED);
    await hub.tasks.launch(P, a.id);
    await hub.tasks.launch(P, b.id);
    await settle(hub);
    expect([hub.tasks.get(P, a.id).status, hub.tasks.get(P, b.id).status]).toEqual(["merged", "merged"]);
    expect(executions()).toHaveLength(3);
    expect(events("task.registers_merged")).toEqual([]);
    expect(events("task.integrated").map((e) => e.payload)).toContainEqual(expect.objectContaining({ conflicts: ["data/balance.json"] }));
    expect(JSON.parse(git(root, "show", "HEAD:data/balance.json"))).toEqual({ joueur: { vie: 120 } });
    expect(git(root, "show", "HEAD:src/a.ts")).toMatch(/a = 1/);
    expect(git(root, "show", "HEAD:src/b.ts")).toMatch(/b = 1/);
  });
});
