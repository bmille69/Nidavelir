import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHub } from "../src/hub.ts";
import { ElevenLabs, looksLikeMp3, type EffectRequest, type MusicRequest, type SoundGenPort } from "../src/sound/elevenlabs.ts";
import { FakeExecutor, REPORT, VERIFIED } from "./fake-executor.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, git, sandbox } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => cleanupSandboxes());
const P = "neon";
const KEY = "sk_" + "0".repeat(40); // clé factice
const MP3 = (n: number) => Buffer.concat([Buffer.from("ID3"), Buffer.alloc(2000, n)]);

class FakeSoundGen implements SoundGenPort {
  readonly name = "fake";
  key: string | null = null;
  used = 0;
  readonly asked: (EffectRequest | MusicRequest)[] = [];
  configured() {
    return this.key !== null;
  }
  async setKey(k: string) {
    this.key = k;
  }
  async credits() {
    return { used: this.used, limit: 30_000, tier: "creator", resetsAt: null };
  }
  async effect(req: EffectRequest) {
    this.asked.push(req);
    this.used += 80;
    return MP3(this.asked.length);
  }
  async music(req: MusicRequest) {
    this.asked.push(req);
    this.used += 900;
    return MP3(99);
  }
}

describe("le directeur sonore (ADR-91)", () => {
  it("ElevenLabs : la clé vérifiée puis gardée dans les données du hub, effets et musique demandés comme il faut, erreurs dites", async () => {
    const sb = sandbox();
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (status !== 200) return new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } }), { status });
      if (url.endsWith("/v1/user/subscription")) return new Response(JSON.stringify({ character_count: 1200, character_limit: 100_000, tier: "creator", next_character_count_reset_unix: 1_800_000_000 }));
      return new Response(MP3(1));
    }) as unknown as typeof fetch;
    const el = new ElevenLabs(join(sb.dir, "data"), fake);
    expect(el.configured()).toBe(false);
    await expect(el.setKey("pas-une-cle")).rejects.toThrow(/commence par « sk_ »/);
    status = 401;
    await expect(el.setKey(KEY)).rejects.toThrow(/refuse la clé : Invalid API key/);
    expect(el.configured()).toBe(false);
    status = 200;
    await el.setKey(KEY);
    expect(el.configured()).toBe(true);
    expect(JSON.parse(readFileSync(join(sb.dir, "data", "elevenlabs", "key.json"), "utf8"))).toEqual({ key: KEY });
    expect(await el.credits()).toMatchObject({ used: 1200, limit: 100_000, tier: "creator", resetsAt: "2027-01-15T08:00:00.000Z" });

    expect(looksLikeMp3(await el.effect({ prompt: "short laser zap", seconds: 0.8, loop: false }))).toBe(true);
    const fx = calls.at(-1)!;
    expect(fx.url).toBe("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128");
    expect((fx.init.headers as Record<string, string>)["xi-api-key"]).toBe(KEY);
    expect(JSON.parse(fx.init.body as string)).toEqual({ text: "short laser zap", prompt_influence: 0.5, loop: false, duration_seconds: 0.8 });
    await el.music({ prompt: "neon western, tense, instrumental, seamless loop", seconds: 45 });
    expect(calls.at(-1)!.url).toBe("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128");
    expect(JSON.parse(calls.at(-1)!.init.body as string)).toEqual({ prompt: "neon western, tense, instrumental, seamless loop", music_length_ms: 45_000, force_instrumental: true });
    status = 429;
    await expect(el.effect({ prompt: "x", seconds: null, loop: false })).rejects.toThrow(/crédits épuisés ou limite atteinte/);
  });

  it("proposer, écouter, choisir, intégrer par un chantier, puis vérifier que chaque son est joué", async () => {
    const sb = sandbox();
    const exec = new FakeExecutor();
    const orch = new FakeOrchestrator();
    const gen = new FakeSoundGen();
    sb.hub.close();
    const hub = createHub({
      databasePath: join(sb.dir, "hub/.data/sound.db"),
      registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
      clock: fakeClock(),
      orchestrator: orch,
      executor: exec,
      soundGen: gen,
      dataDir: join(sb.dir, "hub/.data"),
    });
    sb.hub = hub;
    const root = sb.makeGameRepo("games/neon", { "project.godot": "config_version=5\n", "studio/BRIEF.md": "# Néon Saloon\nTower defense dans un saloon néon.\n" });
    await hub.projects.register(sb.human(), { path: root, slug: P, name: "Néon Saloon" });
    hub.projects.setAutonomy(sb.human(), P, "workshop");

    // Proposer.
    orch.extractions.push({
      note: "Western électrique : cuivres saturés, néons qui grésillent.",
      sounds: [
        { name: "Tir de tourelle", kind: "effet", usage: "à chaque tir d'une tourelle Gatling", prompt: "short gatling burst, electric crackle", seconds: 0.6, loop: false },
        { name: "Thème du saloon", kind: "musique", usage: "pendant les vagues", prompt: "neon western, tense, instrumental, seamless loop", seconds: 60, loop: true },
      ],
    } as never);
    expect(() => hub.sound.propose({ id: "x" } as never, P, "")).toThrow();
    hub.sound.propose(sb.human(), P, "les tirs et une musique");
    await hub.sound.idle();
    expect(orch.calls.at(-1)!.prompt).toMatch(/Tower defense dans un saloon néon[\s\S]*Demande du directeur créatif : les tirs et une musique/);
    let st = await hub.sound.state(P);
    expect(st.configured).toBe(false);
    expect(st.sounds.map((s) => [s.id, s.name, s.status])).toEqual([
      ["S-0001", "Tir de tourelle", "propose"],
      ["S-0002", "Thème du saloon", "propose"],
    ]);
    expect(git(root, "log", "-1", "--format=%s").trim()).toBe("studio: le directeur sonore propose 2 son(s)");

    // Écouter : rien sans la clé, puis deux essais chacun, crédits comptés.
    expect(() => hub.sound.generate(sb.human(), P, "S-0001")).toThrow(/clé ElevenLabs/);
    await hub.sound.setKey(sb.human(), KEY);
    hub.sound.edit(sb.human(), P, "S-0001", { prompt: "short gatling burst, electric crackle, dry" });
    hub.sound.generate(sb.human(), P, "S-0001", 2);
    hub.sound.generate(sb.human(), P, "S-0002", 1);
    await hub.sound.idle();
    expect(gen.asked).toEqual([
      { prompt: "short gatling burst, electric crackle, dry", seconds: 0.6, loop: false },
      { prompt: "short gatling burst, electric crackle, dry", seconds: 0.6, loop: false },
      { prompt: "neon western, tense, instrumental, seamless loop", seconds: 60 },
    ]);
    st = await hub.sound.state(P);
    expect(st.credits).toMatchObject({ used: 1060, limit: 30_000 });
    expect(st.sounds[0]).toMatchObject({ status: "a_choisir", takes: [{ file: "S-0001-1.mp3", credits: 80 }, { file: "S-0001-2.mp3", credits: 80 }] });
    expect(hub.sound.takeFile(P, "S-0001-2.mp3")).toBeTruthy();
    expect(hub.sound.takeFile(P, "../../secret.mp3")).toBeNull();
    // Les essais restent dans les données du hub : le jeu ne reçoit que le son choisi.
    expect(existsSync(join(root, "studio", "sound", "takes"))).toBe(false);

    // Choisir, intégrer.
    await expect(hub.sound.integrate(sb.human(), P)).rejects.toThrow(/Aucun son choisi/);
    hub.sound.choose(sb.human(), P, "S-0001", "S-0001-2.mp3");
    hub.sound.choose(sb.human(), P, "S-0002", "S-0002-1.mp3");
    exec.scripts.execute.push(async (t, req) => {
      expect(req.prompt).toMatch(/S-0001 « Tir de tourelle » \(effet\) : res:\/\/assets\/audio\/effet\/tir_de_tourelle\.mp3 — à chaque tir/);
      expect(req.prompt).toMatch(/S-0002 « Thème du saloon » \(musique, en boucle\) : res:\/\/assets\/audio\/musique\/theme_du_saloon\.mp3/);
      // Le développeur ne branche que le tir : la musique est oubliée.
      await t.write("scripts/sound.gd", 'extends Node\nconst TIR := preload("res://assets/audio/effet/tir_de_tourelle.mp3")\n');
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);
    const { task } = await hub.sound.integrate(sb.human(), P);
    expect(task.title).toBe("S-0001, S-0002 : brancher 2 sons");
    expect(readFileSync(join(root, "assets", "audio", "effet", "tir_de_tourelle.mp3")).equals(MP3(2))).toBe(true);
    expect(hub.sound.sounds(P).map((s) => s.status)).toEqual(["en_integration", "en_integration"]);
    expect(() => hub.sound.choose(sb.human(), P, "S-0001", "S-0001-1.mp3")).toThrow(/déjà dans le jeu/);
    await hub.tasks.idle();
    const review = await hub.tasks.review(P, task.id);
    await hub.tasks.merge(sb.human(), P, task.id, review.head!);
    await hub.tasks.idle();
    await hub.sound.idle();
    expect(hub.sound.sounds(P).map((s) => [s.id, s.status, s.note])).toEqual([
      ["S-0001", "integre", null],
      ["S-0002", "non_branche", "copié dans le jeu, mais aucun script ni scène ne le joue"],
    ]);
    // La musique oubliée repart dans un nouveau chantier, sans être recopiée.
    exec.scripts.execute.push(async (t, req) => {
      expect(req.prompt).toMatch(/Brancher[\s\S]*S-0002 « Thème du saloon »/);
      expect(req.prompt).not.toMatch(/S-0001/);
      await t.write("scripts/music.gd", 'extends Node\nconst THEME := preload("res://assets/audio/musique/theme_du_saloon.mp3")\n');
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);
    const again = await hub.sound.integrate(sb.human(), P);
    expect(again.task.title).toBe("S-0002 : brancher le son « Thème du saloon »");
    await hub.tasks.idle();
    expect(hub.tasks.get(P, again.task.id).status).toBe("review");
    await hub.tasks.merge(sb.human(), P, again.task.id, (await hub.tasks.review(P, again.task.id)).head!);
    await hub.tasks.idle();
    await hub.sound.idle();
    expect(hub.sound.sounds(P).map((s) => s.status)).toEqual(["integre", "integre"]);
    // La clé n'apparaît ni dans le jeu ni dans le journal.
    expect(() => git(root, "grep", "-l", KEY)).toThrow(); // aucun fichier ne la contient
    expect(JSON.stringify(hub.journal.list({ limit: 5000 }))).not.toContain(KEY);
  });
});
