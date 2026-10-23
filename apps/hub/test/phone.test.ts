import { createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HumanSessions, PairingError, type DeviceRecord, type DeviceStore } from "../src/auth/human-session.ts";
import { createHub } from "../src/hub.ts";
import { RemoteService, type Runner } from "../src/remote/tailscale.ts";
import { buildServer, SESSION_COOKIE } from "../src/server/http.ts";
import { FakeExecutor, REPORT, VERIFIED } from "./fake-executor.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, sandbox } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => cleanupSandboxes());

function memoryStore(): DeviceStore & { rows: DeviceRecord[] } {
  const rows: DeviceRecord[] = [];
  return {
    rows,
    load: () => [...rows],
    save: (r) => rows.push(r),
    remove: (id) => rows.splice(rows.findIndex((r) => r.id === id), 1),
    touch: () => {},
  };
}

describe("connexion d'un téléphone", () => {
  it("code à 6 chiffres : unique, 5 minutes, 5 essais ; la session survit au redémarrage et se révoque", () => {
    const store = memoryStore();
    const sessions = new HumanSessions(store);
    const pc = sessions.login(sessions.createLoginToken());
    const me = sessions.verify(pc.sessionId, pc.cookie, pc.csrf);

    expect(() => sessions.loginWithCode("123456", "Tel")).toThrow(PairingError);
    const { code } = sessions.createPairingCode(me, 1_000);
    expect(code).toMatch(/^\d{6}$/);
    expect(() => sessions.loginWithCode(code, "Tel", 1_000 + 5 * 60_000 + 1)).toThrow(/expiré/);

    const again = sessions.createPairingCode(me, 2_000).code;
    for (let k = 0; k < 5; k++) expect(() => sessions.loginWithCode(again === "000000" ? "000001" : "000000", "Tel", 2_000)).toThrow(/incorrect/);
    expect(() => sessions.loginWithCode(again, "Tel", 2_000)).toThrow(/Trop d'essais/);

    const ok = sessions.createPairingCode(me, 3_000).code;
    const phone = sessions.loginWithCode(ok, "Mon téléphone", 3_000);
    expect(() => sessions.loginWithCode(ok, "Autre", 3_000)).toThrow(PairingError);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ id: phone.sessionId, name: "Mon téléphone" });
    expect(JSON.stringify(store.rows[0])).not.toContain(phone.cookie);

    // Redémarrage du hub : le téléphone reste connecté, le PC non (lien à usage unique).
    const restarted = new HumanSessions(store);
    expect(restarted.check(phone.sessionId, phone.cookie)).toBe(true);
    expect(restarted.isDevice(phone.sessionId)).toBe(true);
    expect(restarted.check(pc.sessionId, pc.cookie)).toBe(false);

    const me2 = restarted.verify(phone.sessionId, phone.cookie, phone.csrf);
    restarted.revoke(me2, phone.sessionId);
    expect(restarted.check(phone.sessionId, phone.cookie)).toBe(false);
    expect(store.rows).toHaveLength(0);
    expect(() => sessions.createPairingCode({} as never)).toThrow(/humain/);
  });

  it("par HTTP : page de code, connexion durable, origine contrôlée", async () => {
    const sb = sandbox();
    const app = await buildServer(sb.hub, { port: 4317, gamesRoot: sb.dir, allowedHosts: ["127.0.0.1:4317"], folderPicker: { pick: async () => null } });
    const host = { host: "127.0.0.1:4317" };
    const page = await app.inject({ method: "GET", url: "/login", headers: host });
    expect(page.body).toMatch(/Connecter ce téléphone/);
    const { code } = sb.hub.sessions.createPairingCode(sb.human());
    const bad = await app.inject({ method: "POST", url: "/login/code", headers: { ...host, origin: "https://evil.example" }, payload: { code } });
    expect(bad.statusCode).toBe(403);
    const res = await app.inject({ method: "POST", url: "/login/code", headers: { ...host, origin: "http://127.0.0.1:4317" }, payload: { code, name: "Pixel" } });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(cookie.maxAge).toBe(90 * 86400);
    const session = await app.inject({ method: "GET", url: "/api/human/session", headers: { ...host, cookie: `${SESSION_COOKIE}=${cookie.value}` } });
    expect(session.json()).toMatchObject({ device: true });
    const devices = await app.inject({ method: "GET", url: "/api/human/devices", headers: { ...host, cookie: `${SESSION_COOKIE}=${cookie.value}` } });
    expect(devices.json()).toEqual([expect.objectContaining({ name: "Pixel", current: true })]);
    // Une adresse Tailscale publiée est acceptée.
    const ts = await app.inject({ method: "GET", url: "/login", headers: { host: "mon-pc.tail1234.ts.net" } });
    expect(ts.statusCode).toBe(403);
    sb.hub.extraHosts.add("mon-pc.tail1234.ts.net");
    expect((await app.inject({ method: "GET", url: "/login", headers: { host: "mon-pc.tail1234.ts.net" } })).statusCode).toBe(200);
    await app.close();
  });
});

describe("Tailscale", () => {
  const script = (answers: Record<string, { code?: number; stdout?: string; stderr?: string }>): { run: Runner; calls: string[][] } => {
    const calls: string[][] = [];
    return {
      calls,
      run: async (args) => {
        calls.push(args);
        const a = answers[args.join(" ")] ?? { code: 0, stdout: "{}" };
        return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
      },
    };
  };
  const RUNNING = JSON.stringify({ BackendState: "Running", Self: { DNSName: "mon-pc.tail1234.ts.net." } });

  it("absent, puis connecté mais pas publié, puis publié", async () => {
    const hosts: string[] = [];
    const absent = new RemoteService({ port: 4317, run: script({ "status --json": { code: 127, stderr: "not found" } }).run, onHost: (h) => hosts.push(h) });
    expect(await absent.status()).toMatchObject({ tailscale: "absent", serving: false });

    const ready = script({ "status --json": { stdout: RUNNING }, "serve status --json": { stdout: "{}" } });
    expect(await new RemoteService({ port: 4317, run: ready.run, onHost: (h) => hosts.push(h) }).status()).toMatchObject({ tailscale: "ready", dnsName: "mon-pc.tail1234.ts.net", serving: false });

    const served = script({
      "status --json": { stdout: RUNNING },
      "serve status --json": { stdout: JSON.stringify({ Web: { "mon-pc.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } } } } }) },
    });
    expect(await new RemoteService({ port: 4317, run: served.run, onHost: (h) => hosts.push(h) }).status()).toMatchObject({ serving: true, url: "https://mon-pc.tail1234.ts.net" });
    expect(hosts).toEqual(["mon-pc.tail1234.ts.net"]);
  });

  it("publier : la commande « serve » ; si HTTPS n'est pas activé, le lien à suivre vous est donné", async () => {
    const sb = sandbox();
    const s = script({
      "status --json": { stdout: RUNNING },
      "serve status --json": { stdout: "{}" },
      "serve --bg --https=443 http://127.0.0.1:4317": { code: 1, stderr: "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n" },
    });
    const remote = new RemoteService({ port: 4317, run: s.run, onHost: () => {} });
    const r = await remote.enable(sb.human());
    expect(s.calls).toContainEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:4317"]);
    expect(r).toMatchObject({ serving: false, link: "https://login.tailscale.com/f/serve?node=abc123" });
    expect(r.message).toMatch(/autorisez HTTPS/);
    // Jamais de « funnel » (publication sur Internet).
    expect(s.calls.flat()).not.toContain("funnel");
  });
});

describe("notifications", () => {
  it("un chantier qui attend votre avis envoie une notification chiffrée que seul le téléphone peut lire", async () => {
    // Le « téléphone » : ses clés d'abonnement.
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = randomBytes(16);
    const received: { headers: Headers; body: Buffer }[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      received.push({ headers: new Headers(init.headers), body: Buffer.from(init.body as Uint8Array) });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;

    const sb = sandbox();
    sb.hub.close();
    const exec = new FakeExecutor();
    const fake = new FakeOrchestrator();
    const hub = createHub({
      databasePath: join(sb.dir, "hub/.data/push.db"),
      registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
      clock: fakeClock(),
      orchestrator: fake,
      executor: exec,
      dataDir: join(sb.dir, "hub/.data"),
      autopilot: { synthesisDelayMs: 600_000 },
      pushFetch: fakeFetch,
    });
    sb.hub = hub;
    const root = sb.makeGameRepo("games/d", { "README.md": "# D\n" });
    await hub.projects.register(sb.human(), { path: root, slug: "d", name: "Destiny" });
    hub.notifications.subscribe(sb.human(), { endpoint: "https://fcm.googleapis.com/fcm/send/xyz", keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } }, null);

    // Le testeur refuse trois fois (deux corrections automatiques comprises) : le chantier attend votre avis, le téléphone est prévenu.
    for (const k of [1, 2, 3]) {
      exec.scripts.execute.push(async (t) => {
        await t.write("src/a.ts", `export const v = ${k};\n`);
        return REPORT;
      });
      exec.scripts.verify.push(() => ({ ...VERIFIED, verdict: "fail" }));
    }
    fake.replies.push("Ok.\n[[CHANTIER: Balles lumineuses]]\nObjectif : tirs premium.\n[[/CHANTIER]]");
    const t = hub.conversations.createThread("d", "x");
    await hub.conversations.send("d", t.id, "go");
    await hub.conversations.idle();
    await hub.tasks.idle();
    await hub.notifications.idle();

    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    expect(headers.get("content-encoding")).toBe("aes128gcm");
    expect(headers.get("authorization")).toMatch(/^vapid t=.+, k=.+$/);
    expect(body.toString()).not.toMatch(/Balles/);

    // Déchiffrement côté téléphone (RFC 8291).
    const salt = body.subarray(0, 16);
    const idlen = body[20]!;
    const asPublic = body.subarray(21, 21 + idlen);
    const data = body.subarray(21 + idlen);
    const h = (k: Buffer, d: Buffer) => createHmac("sha256", k).update(d).digest();
    const ikm = h(h(auth, ua.computeSecret(asPublic)), Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic, Buffer.from([1])]));
    const prk = h(salt, ikm);
    const cek = h(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "latin1")).subarray(0, 16);
    const nonce = h(prk, Buffer.from("Content-Encoding: nonce\0\x01", "latin1")).subarray(0, 12);
    const d = createDecipheriv("aes-128-gcm", cek, nonce);
    d.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
    expect(plain.at(-1)).toBe(2);
    expect(JSON.parse(plain.subarray(0, -1).toString())).toMatchObject({ title: "✋ Un chantier attend votre avis", body: "Balles lumineuses — le testeur a trouvé des problèmes", url: "#/p/d/tasks/T-0001" });
  });
});
