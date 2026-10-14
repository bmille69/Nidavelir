import { createECDH, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptPayload, generateVapidKeys, vapidAuthorization } from "../src/remote/web-push.ts";

const b = (s: string) => Buffer.from(s, "base64url");

describe("Web Push (RFC 8291 / 8292)", () => {
  it("reproduit exactement l'exemple de la RFC 8291 (section 5)", () => {
    const uaPrivate = b("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94");
    const ua = createECDH("prime256v1");
    ua.setPrivateKey(uaPrivate);
    expect(ua.getPublicKey().toString("base64url")).toBe("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
    const out = encryptPayload(
      Buffer.from("When I grow up, I want to be a watermelon"),
      { endpoint: "https://push.example.net/x", keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: "BTBZMqHH6r4Tts7J_aSIgg" } },
      { asPrivate: b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), salt: b("DGv6ra1nlYgDCS1FRnbzlw") },
    );
    expect(out.toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("signe un jeton VAPID vérifiable avec la clé publique", () => {
    const keys = generateVapidKeys();
    const auth = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "mailto:studio@localhost", Date.UTC(2026, 9, 14));
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth)!;
    expect(m[4]).toBe(keys.publicKey);
    expect(JSON.parse(b(m[2]!).toString())).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "mailto:studio@localhost" });
    const pub = b(keys.publicKey);
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: "ieee-p1363" }, b(m[3]!))).toBe(true);
  });
});
