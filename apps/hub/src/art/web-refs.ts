import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Les références trouvées sur le web (ADR-58) : le Directeur artistique donne des adresses (une image, ou la page qui
 * la montre), le hub télécharge l'image pour la planche d'inspiration. Seulement des adresses publiques (jamais la
 * machine ni le réseau local), seulement de vraies images, 8 Mo au plus. Les images restent des références : elles
 * ne vont jamais dans le jeu.
 */
export interface WebRefsPort {
  fetchImage(url: string): Promise<{ data: Buffer; mime: string; url: string }>;
}

const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_PAGE = 2 * 1024 * 1024;
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) nidavellir-hub/1.0 (references d'inspiration)" };
const MAGIC: [string, (b: Buffer) => boolean][] = [
  ["image/png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
];

export class RealWebRefs implements WebRefsPort {
  async fetchImage(url: string): Promise<{ data: Buffer; mime: string; url: string }> {
    const first = await get(url, MAX_PAGE);
    const type = sniff(first.body);
    if (type) return { data: first.body, mime: type, url: first.url };
    // Une page : son image d'aperçu (celle que les réseaux sociaux affichent), qui la représente.
    const image = pageImage(first.body.toString("utf8"), first.url);
    if (!image) throw new Error("ni image ni aperçu sur cette page");
    const img = await get(image, MAX_IMAGE);
    const mime = sniff(img.body);
    if (!mime) throw new Error("l'aperçu de la page n'est pas une image PNG, JPEG ou WebP");
    return { data: img.body, mime, url: img.url };
  }
}

export function sniff(b: Buffer): string | null {
  return MAGIC.find(([, ok]) => ok(b))?.[0] ?? null;
}

/** L'image d'aperçu d'une page : og:image, twitter:image ou image_src. */
export function pageImage(html: string, base: string): string | null {
  const head = html.slice(0, 400_000);
  for (const re of [
    /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|og:image:url)["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i,
    /<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["']/i,
  ]) {
    const m = re.exec(head);
    if (m) {
      try {
        return new URL(m[1]!.replace(/&amp;/g, "&"), base).toString();
      } catch {
        /* adresse illisible : la suivante */
      }
    }
  }
  return null;
}

/** Une adresse publique : http(s), pas d'identifiants, un hôte qui ne pointe ni vers la machine ni vers le réseau local. */
export async function assertPublic(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("adresse illisible");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("seules les adresses web (http, https) sont acceptées");
  if (u.username || u.password) throw new Error("adresse avec identifiants refusée");
  if (u.port && u.port !== "80" && u.port !== "443") throw new Error("port inhabituel refusé");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal|.*\.lan)$/i.test(host)) throw new Error("adresse locale refusée");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(privateAddress)) throw new Error("adresse du réseau local refusée");
  return u;
}

export function privateAddress(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

/** GET borné : redirections suivies à la main (chaque étape revérifiée), délai, taille maximale. */
async function get(raw: string, max: number): Promise<{ body: Buffer; url: string }> {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublic(url);
    const res = await fetch(u, { headers: UA, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) throw new Error(`redirection sans destination (${res.status})`);
      url = new URL(next, u).toString();
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`le site répond ${res.status}`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > max) throw new Error(`fichier trop lourd (plus de ${Math.round(max / 1024 / 1024)} Mo)`);
      chunks.push(Buffer.from(chunk));
    }
    return { body: Buffer.concat(chunks), url: u.toString() };
  }
  throw new Error("trop de redirections");
}
