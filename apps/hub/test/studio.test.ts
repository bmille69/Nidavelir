import { afterEach, describe, expect, it } from "vitest";
import { studioSnapshot } from "../src/studio/activity.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, DIRECTOR, msg, sandbox } from "./helpers.ts";

afterEach(() => cleanupSandboxes());

describe("vue Studio", () => {
  it("au repos, puis ce qui vous attend et ce que fait le directeur", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = new (class extends FakeOrchestrator {
      override async reply(input: { systemPrompt: string; prompt: string }) {
        await gate;
        return super.reply(input);
      }
    })();
    const sb = sandbox(fake);
    const root = sb.makeGameRepo("games/destiny");
    await sb.hub.projects.register(sb.human(), { path: root, slug: "destiny", name: "Destiny Survivor" });
    sb.hub.projects.setAutonomy(sb.human(), "destiny", "balanced");

    const idle = studioSnapshot(sb.hub);
    expect(idle.agents.map((a) => [a.id, a.state])).toEqual([
      ["you", "idle"],
      ["director", "idle"],
      ["archivist", "idle"],
      ["developer", "idle"],
      ["qa", "idle"],
      ["guardian", "idle"],
    ]);

    sb.hub.vision.capture("destiny", DIRECTOR, { type: "idea", title: "Calme", statement: "Calme avant le boss", source: msg("m", "x") });
    sb.hub.vision.submitProposal("destiny", DIRECTOR, { title: "Calme", statement: "Calme avant le boss.", source: { kind: "message", ref: "m" }, details: { based_on: ["I-0001"] } });
    const thread = sb.hub.conversations.createThread("destiny", "Les boss");
    const sending = sb.hub.conversations.send("destiny", thread.id, "Un moment de calme avant le boss");

    const busy = studioSnapshot(sb.hub);
    const by = new Map(busy.agents.map((a) => [a.id, a]));
    expect(by.get("you")).toMatchObject({ state: "waiting", activities: [{ text: "1 proposition(s) à arbitrer", href: "#/p/destiny/decisions" }] });
    expect(by.get("director")).toMatchObject({ state: "working", activities: [{ text: "Vous répond dans « Les boss »" }] });
    expect(by.get("archivist")!.state).toBe("working");
    expect(busy.projects[0]).toMatchObject({ slug: "destiny", busy: true, waiting: 1, proposals: 1 });

    release();
    await sending;
    await sb.hub.conversations.idle();
    const after = studioSnapshot(sb.hub);
    expect(after.agents.find((a) => a.id === "director")!.state).toBe("idle");
    expect(after.events.map((e) => e.type)).toContain("message.replied");
    expect(after.events.map((e) => e.type)).not.toContain("item.captured");
  });
});
