import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodePng } from "../src/art/visual-diff.ts";
import { createHub } from "../src/hub.ts";
import { encodeGif, fit } from "../src/journal/gif.ts";
import { weekOf } from "../src/journal/logbook.ts";
import type { CheckerPort } from "../src/quality/checks.ts";
import { FakeExecutor, REPORT, VERIFIED } from "./fake-executor.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, sandbox } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => cleanupSandboxes());
const P = "jeu";

/** Une vraie image PNG unie de `w` × `h`. */
function png(rgb: [number, number, number], w = 160, h = 90): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Array.from({ length: h }, (_, y) => Buffer.from([0, ...Array.from({ length: w }, (_, x) => (x < w / 2 || y < h / 2 ? rgb : [255, 255, 255])).flat()]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

describe("le journal de bord (ADR-89)", () => {
  it("la semaine commence le lundi", () => {
    expect(weekOf("2026-10-27T15:00:00")).toBe("2026-10-26");
    expect(weekOf("2026-10-26T00:30:00")).toBe("2026-10-26");
    expect(weekOf("2026-11-01T23:00:00")).toBe("2026-10-26");
  });

  it("le GIF est lisible par un vrai décodeur, image par image", () => {
    const frames = [png([200, 30, 30]), png([30, 200, 30]), png([30, 30, 200], 320, 90)].map((b) => fit(decodePng(b), 160, 90));
    const gif = encodeGif(frames, [100, 100, 300]);
    expect(gif.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    expect(gif.at(-1)).toBe(0x3b);
    let ffmpeg = "";
    try {
      ffmpeg = execFileSync("ffmpeg", ["-version"], { encoding: "utf8" });
    } catch {
      /* pas de ffmpeg : on s'en tient à la structure */
    }
    if (ffmpeg) {
      const out = execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { input: gif, maxBuffer: 1 << 24 });
      expect(out.length).toBe(160 * 90 * 3 * 3);
      // Première image : rouge en haut à gauche ; deuxième : vert.
      expect([out[0], out[1], out[2]]).toEqual([expect.toSatisfy((v: number) => v > 150), expect.toSatisfy((v: number) => v < 80), expect.toSatisfy((v: number) => v < 80)]);
      const second = 160 * 90 * 3;
      expect(out[second + 1]).toBeGreaterThan(150);
    }
  });

  it("chaque fusion avec sa capture, ses vérifications et son coût ; le GIF de la semaine ; le récit du directeur sur demande", async () => {
    const sb = sandbox();
    const exec = new FakeExecutor();
    const fake = new FakeOrchestrator();
    const colors: [number, number, number][] = [
      [200, 40, 40],
      [40, 200, 40],
    ];
    const checker: CheckerPort = {
      tests: async () => ({ status: "pass", detail: "ok" }),
      launch: async (_k, _cwd, screenshot) => {
        if (screenshot) writeFileSync(screenshot, png(colors.shift() ?? [40, 40, 200]));
        return { status: "pass", detail: "ok", screenshot: screenshot ?? null };
      },
    };
    sb.hub.close();
    const hub = createHub({
      databasePath: join(sb.dir, "hub/.data/log.db"),
      registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
      clock: fakeClock(),
      orchestrator: fake,
      executor: exec,
      checker,
      dataDir: join(sb.dir, "hub/.data"),
    });
    sb.hub = hub;
    const root = sb.makeGameRepo("jeu", { "README.md": "# Jeu\n" });
    await hub.projects.register(sb.human(), { path: root, slug: P, name: "Jeu" });
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    expect(hub.logbook.week(P)).toMatchObject({ entries: [], gif: false, previous: null, next: null });

    for (const [k, name] of ["Les boss", "Le menu"].entries()) {
      const thread = hub.conversations.createThread(P, name);
      const task = hub.tasks.createFromConversation(P, { title: name, goal: `Faire ${name}` }, thread.id);
      exec.scripts.execute.push(async (t) => (await t.write(`src/f${k}.ts`, "export {};\n"), { ...REPORT, summary_simple: `${name} sont là.` }));
      exec.scripts.verify.push(() => VERIFIED);
      await hub.tasks.launch(P, task.id);
      await hub.tasks.idle();
      const review = await hub.tasks.review(P, task.id);
      await hub.tasks.merge(sb.human(), P, task.id, review.head!);
    }

    const week = hub.logbook.week(P);
    expect(week.week).toBe(weekOf("2026-10-13T12:00:00Z"));
    expect(hub.logbook.weeks(P)).toEqual([week.week]);
    expect(week.entries).toMatchObject([
      { task: "T-0001", title: "Les boss", summary: "Les boss sont là.", shot: true, checks: expect.stringMatching(/tests du jeu ✓/) },
      { task: "T-0002", title: "Le menu", shot: true },
    ]);
    expect(week.entries[0]!.costUsd).toBe(0.02);
    expect(week.facts).toMatchObject({ merged: 2, failed: 0, costUsd: 0.04 });
    expect(week.gif).toBe(true);

    const gif = hub.logbook.gif(P, week.week)!;
    expect(gif.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    expect(existsSync(join(sb.dir, "hub/.data/logbook", P, `${week.week}-2.gif`))).toBe(true);
    expect(hub.logbook.gif(P, week.week)!.equals(gif)).toBe(true);

    await expect(hub.logbook.tell({ id: "x" } as never, P, week.week)).rejects.toThrow();
    fake.replies.push("Cette semaine, les boss sont arrivés et le menu a pris forme.");
    const told = await hub.logbook.tell(sb.human(), P, week.week);
    expect(told.story?.text).toBe("Cette semaine, les boss sont arrivés et le menu a pris forme.");
    expect(fake.calls.at(-1)!.prompt).toMatch(/2 chantier\(s\) fusionné\(s\)[\s\S]*T-0001 « Les boss » : Les boss sont là\./);
    expect(hub.logbook.week(P, week.week).story?.text).toMatch(/^Cette semaine/);
  });
});
