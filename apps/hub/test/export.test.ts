import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureIgnored, ensurePreset, type Build } from "../src/godot/export.ts";
import { installWindowsTemplates, readCentralDirectory, templatesDir, templatesUrl } from "../src/godot/templates.ts";
import { createHub } from "../src/hub.ts";
import { cleanupSandboxes, fakeClock, git, sandbox } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => cleanupSandboxes());

/** Un petit zip (méthodes 0 et 8), comme l'archive des modèles de Godot. */
function zip(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const deflate = data.length > 20;
    const body = deflate ? deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(deflate ? 8 : 0, 8);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(n.length, 26);
    locals.push(h, n, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

describe("l'export local des jeux Godot (ADR-90)", () => {
  it("les modèles Windows sont lus dans l'archive par plages, sans la télécharger entière", async () => {
    const big = Buffer.alloc(200_000, 7);
    const archive = zip({
      "templates/linux_release.x86_64": Buffer.alloc(300_000, 1),
      "templates/windows_release_x86_64.exe": big,
      "templates/windows_release_x86_64_console.exe": Buffer.from("console wrapper release ....."),
      "templates/windows_debug_x86_64.exe": Buffer.alloc(50_000, 9),
      "templates/windows_debug_x86_64_console.exe": Buffer.from("console wrapper debug ......."),
      "templates/version.txt": Buffer.from("4.6.2.stable"),
    });
    expect(templatesUrl("4.6.2")).toBe("https://github.com/godotengine/godot/releases/download/4.6.2-stable/Godot_v4.6.2-stable_export_templates.tpz");
    const appdata = process.env.APPDATA;
    const sb = sandbox();
    process.env.APPDATA = sb.dir;
    const fetched: number[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(Buffer.alloc(1), { status: 206, headers: { "content-range": `bytes 0-0/${archive.length}` } })) as typeof fetch;
    try {
      const steps: string[] = [];
      const dir = await installWindowsTemplates("4.6.2", (s) => steps.push(s), async (_url, from, to) => {
        fetched.push(to - from + 1);
        return archive.subarray(from, to + 1);
      });
      expect(dir).toBe(templatesDir("4.6.2"));
      expect(dir).toBe(join(sb.dir, "Godot", "export_templates", "4.6.2.stable"));
      expect(readFileSync(join(dir, "windows_release_x86_64.exe")).equals(big)).toBe(true);
      expect(readFileSync(join(dir, "version.txt"), "utf8")).toBe("4.6.2.stable");
      expect(existsSync(join(dir, "linux_release.x86_64"))).toBe(false);
      // Le modèle Linux (300 Ko) n'a jamais été demandé.
      expect(fetched.reduce((a, b) => a + b, 0)).toBeLessThan(archive.length - 250_000 + 256 * 1024);
      expect(steps.at(-1)).toBe("Modèles installés");
    } finally {
      globalThis.fetch = realFetch;
      if (appdata === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = appdata;
    }
    // Le sommaire lu sans tout recharger : déjà dans la fin du fichier.
    const entries = await readCentralDirectory(archive, 0, async () => {
      throw new Error("inutile");
    });
    expect(entries.map((e) => e.name)).toContain("templates/windows_debug_x86_64.exe");
  });

  it("le réglage d'export est ajouté sans toucher aux autres, build/ est ignoré par Git", () => {
    const sb = sandbox();
    const root = sb.makeGameRepo("jeu", { "project.godot": "config_version=5\n", ".gitignore": ".godot/\n", "export_presets.cfg": '[preset.0]\n\nname="Web"\nplatform="Web"\n' });
    expect(ensurePreset(root)).toBe(true);
    expect(ensurePreset(root)).toBe(false);
    const cfg = readFileSync(join(root, "export_presets.cfg"), "utf8");
    expect(cfg).toMatch(/^\[preset\.0\]\n\nname="Web"/);
    expect(cfg).toMatch(/\[preset\.1\]\n\nname="Windows Desktop"[\s\S]*exclude_filter="studio\/\*, tests\/\*, build\/\*"[\s\S]*binary_format\/embed_pck=true/);
    expect(ensureIgnored(root)).toBe(true);
    expect(ensureIgnored(root)).toBe(false);
    writeFileSync(join(root, "build.txt"), "");
    expect(git(root, "check-ignore", "build/x/jeu.exe").trim()).toBe("build/x/jeu.exe");
  });

  it("exporter : réservé aux jeux Godot et à votre clic ; le réglage commité, l'export rangé et gardé, une erreur dite", async () => {
    const sb = sandbox();
    sb.hub.close();
    const hub = createHub({
      databasePath: join(sb.dir, "hub/.data/export.db"),
      registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
      clock: fakeClock(),
      dataDir: join(sb.dir, "hub/.data"),
      godot: () => ({ exe: "godot.exe", version: "4.6.2", mono: false }),
    });
    sb.hub = hub;
    const root = sb.makeGameRepo("games/neon", { "project.godot": "config_version=5\n", ".gitignore": ".godot/\n" });
    await hub.projects.register(sb.human(), { path: root, slug: "neon", name: "Néon Saloon" });
    const exp = hub.exports;
    let templates = false;
    exp.hasTemplates = () => templates;
    exp.installer = async (_v, progress) => {
      progress?.("Téléchargement", 0.5);
      templates = true;
      return "dir";
    };
    expect(exp.state("neon")).toMatchObject({ available: true, godot: "4.6.2", templates: false, builds: [] });
    expect(() => exp.start(sb.human(), "neon")).toThrow(/modèles d'export/);
    expect(() => exp.installTemplates({ id: "x" } as never, "neon")).toThrow();
    exp.installTemplates(sb.human(), "neon");
    await exp.idle();
    expect(exp.state("neon").templates).toBe(true);

    const calls: string[] = [];
    exp.exporter = async (godot, cwd, input) => {
      calls.push(`${godot} ${input.name} ${input.id}`);
      const dir = join(cwd, "build", input.id);
      mkdirSync(dir, { recursive: true });
      const build: Build = { id: input.id, exe: `build/${input.id}/Néon_Saloon.exe`, bytes: 90_000_000, at: input.at, commit: input.commit, seconds: 12, smoke: { ok: true, detail: "ok" } };
      writeFileSync(join(dir, "Néon_Saloon.exe"), "MZ");
      writeFileSync(join(dir, "build.json"), JSON.stringify(build));
      return build;
    };
    for (let k = 0; k < 6; k++) {
      exp.start(sb.human(), "neon");
      await exp.idle();
    }
    expect(calls).toHaveLength(6);
    expect(calls[0]).toMatch(/^godot\.exe Néon Saloon \d{8}-\d{6}$/);
    const st = exp.state("neon");
    expect(st.builds).toHaveLength(5);
    expect(st.builds[0]!.commit).toMatch(/^[0-9a-f]{40}$/);
    // Le réglage d'export et .gitignore commités ; build/ jamais : le jeu reste propre.
    expect(git(root, "log", "-1", "--format=%s").trim()).toBe("studio: réglage d'export Windows (build/ jamais commité)");
    expect(git(root, "status", "--porcelain").trim()).toBe("");

    exp.exporter = async () => {
      throw new Error("L'export a échoué : modèles d'export absents");
    };
    exp.start(sb.human(), "neon");
    await exp.idle();
    expect(exp.state("neon").error).toMatch(/modèles d'export absents/);

    const web = sb.makeGameRepo("games/web", { "package.json": "{}" });
    await hub.projects.register(sb.human(), { path: web, slug: "web", name: "Web" });
    expect(() => exp.start(sb.human(), "web")).toThrow(/jeux Godot/);
  });
});
