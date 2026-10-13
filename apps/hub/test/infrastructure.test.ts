import { afterEach, describe, expect, it } from "vitest";
import { HumanSession, HumanSessionRequiredError } from "../src/auth/human-session.ts";
import { redactSecrets } from "../src/journal/redact.ts";
import { parseItem, serializeItem } from "../src/vision/item-file.ts";
import { cleanupSandboxes, sandbox, type Sandbox } from "./helpers.ts";

let sb: Sandbox;
afterEach(cleanupSandboxes);

describe("journal append-only", () => {
  it("refuse toute modification ou suppression d'événement, même en SQL direct", () => {
    sb = sandbox();
    sb.hub.journal.append({ project: null, actor: { kind: "system" }, type: "test", payload: {} });
    expect(() => sb.hub.db.exec("UPDATE events SET type = 'x'")).toThrow(/append-only/);
    expect(() => sb.hub.db.exec("DELETE FROM events")).toThrow(/append-only/);
    expect(sb.hub.journal.list()).toHaveLength(1);
  });

  it("masque les secrets avant écriture", () => {
    const out = redactSecrets({
      note: "clé sk-ant-api03-ABCDEFGHIJKLMNOP et Bearer abcdefghijklmnop123",
      api_key: "whatever",
      nested: [{ token: "t0ps3cret" }],
    });
    expect(JSON.stringify(out)).not.toMatch(/ABCDEFGHIJ|abcdefghijklmnop123|whatever|t0ps3cret/);
  });
});

describe("sessions humaines", () => {
  it("ne peuvent pas être fabriquées hors du module d'authentification", () => {
    expect(() => new HumanSession(Symbol("human-session"), "fake")).toThrow(HumanSessionRequiredError);
  });

  it("exigent le bon cookie et le bon jeton CSRF", () => {
    sb = sandbox();
    const { sessionId, cookie, csrf } = sb.hub.sessions.login(sb.hub.sessions.createLoginToken());
    expect(() => sb.hub.sessions.verify(sessionId, cookie, "mauvais")).toThrow(HumanSessionRequiredError);
    expect(() => sb.hub.sessions.verify(sessionId, "mauvais", csrf)).toThrow(HumanSessionRequiredError);
    expect(sb.hub.sessions.verify(sessionId, cookie, csrf).id).toBe(sessionId);
  });

  it("le jeton de connexion est à usage unique", () => {
    sb = sandbox();
    const token = sb.hub.sessions.createLoginToken();
    sb.hub.sessions.login(token);
    expect(() => sb.hub.sessions.login(token)).toThrow(HumanSessionRequiredError);
  });
});

describe("fichiers d'items", () => {
  const base = {
    id: "D-0001",
    project: "demo",
    type: "decision" as const,
    status: "validated",
    tier: "canon" as const,
    title: "Sauvegarde aux feux de camp",
    statement: "Le jeu ne sauvegarde qu'aux feux.\nPas de sauvegarde manuelle.",
    domain: ["gameplay"],
    source: { kind: "item" as const, ref: "P-0001" },
    authored_by: { kind: "agent" as const, role: "director" as const, run: "RUN-0001" },
    validated_by: { kind: "human" as const, at: "2026-10-13T12:00:00.000Z", approval: "A-0001" },
    links: [{ rel: "derived_from" as const, to: "P-0001" }],
    vision_rev: 1,
    created_at: "2026-10-13T12:00:00.000Z",
    updated_at: "2026-10-13T12:00:00.000Z",
  };

  it("aller-retour Markdown + YAML sans perte", () => {
    expect(parseItem(serializeItem(base))).toEqual(base);
  });

  it("tolère les fins de ligne Windows", () => {
    expect(parseItem(serializeItem(base).replace(/\n/g, "\r\n"))).toEqual(base);
  });

  it("rejette un item canon sans validated_by", () => {
    const { validated_by: _v, ...rest } = base;
    expect(() => serializeItem(rest as never) && parseItem(serializeItem(rest as never))).toThrow(/validated_by/);
  });

  it("rejette un statut incompatible avec le type", () => {
    expect(() => parseItem(serializeItem({ ...base, status: "captured" }))).toThrow(/statut/);
  });
});
