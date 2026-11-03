import { FILE_PATH, MAX_FILE, MAX_FILES, MAX_FILES_TOTAL, splitFrontmatter, type SkillFile } from "./hermes-library.ts";

/**
 * Catalogue public de skills (ADR-102) : une liste FIXE de dépôts GitHub reconnus, lus en texte seulement.
 * Rien n'est exécuté ; seules les licences libres passent ; chaque skill est relue puis essayée avant usage.
 */

/** Dépôts lus par défaut (STUDIO_SKILL_SOURCES remplace la liste, séparée par des virgules). */
export const DEFAULT_SOURCES = ["anthropics/skills", "wshobson/agents", "gamedev-skills/awesome-gamedev-agent-skills", "Donchitos/Claude-Code-Game-Studios", "obra/superpowers"];

/**
 * Dépôts dont on ne lit QUE certaines skills (nom du dossier qui porte le SKILL.md). Superpowers (ADR-108) est une
 * méthode complète : ses skills de déroulé (questions, plans, branches git, sous-agents, fusion) feraient doublon avec
 * le hub ou contrediraient son pipeline ; on ne garde que les méthodes de travail du Développeur et du Testeur.
 */
export const SOURCE_SKILLS: Record<string, readonly string[]> = {
  "obra/superpowers": ["systematic-debugging", "verification-before-completion", "test-driven-development", "receiving-code-review"],
};

const ALLOWED = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC0-1.0", "CC-BY-4.0", "Unlicense", "0BSD"]);
export const licenseAllowed = (spdx: string | null): boolean => !!spdx && ALLOWED.has(spdx);

/** Licence lue dans un fichier LICENSE (quand le dépôt n'en déclare pas une seule). */
export function licenseFromText(text: string): string | null {
  const t = text.slice(0, 2000);
  if (/Apache License[\s\S]{0,40}Version 2\.0/i.test(t)) return "Apache-2.0";
  if (/\bMIT License\b|Permission is hereby granted, free of charge/i.test(t)) return "MIT";
  if (/Creative Commons Attribution 4\.0/i.test(t)) return "CC-BY-4.0";
  if (/CC0 1\.0|Creative Commons Zero/i.test(t)) return "CC0-1.0";
  if (/This is free and unencumbered software released into the public domain/i.test(t)) return "Unlicense";
  if (/Redistribution and use in source and binary forms/i.test(t)) return /Neither the name/i.test(t) ? "BSD-3-Clause" : "BSD-2-Clause";
  return null;
}

/** Signaux qui font refuser une skill sans même la relire (texte caché, réseau, secrets, injonctions). */
export function suspicious(text: string): string[] {
  const out: string[] = [];
  if (/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/.test(text)) out.push("caractères invisibles");
  if (/ignore (all |any )?(the )?(previous|prior|above) (instructions|rules)|disregard (the )?(system|previous)/i.test(text)) out.push("demande d'ignorer des consignes");
  if (/\b(curl|wget|Invoke-WebRequest|iwr|nc|netcat)\b[^\n]{0,80}(https?:\/\/|\|\s*(sh|bash|iex))/i.test(text)) out.push("téléchargement ou envoi réseau");
  if (/(ANTHROPIC|OPENAI|GITHUB|AWS)_[A-Z_]*(KEY|TOKEN|SECRET)|\.env\b[^\n]{0,40}(cat|read|send|upload)/i.test(text)) out.push("accès à des secrets");
  if (/[A-Za-z0-9+/]{300,}={0,2}/.test(text)) out.push("long bloc encodé");
  if (/--dangerously-skip-permissions|bypassPermissions/i.test(text)) out.push("contournement des permissions");
  return out;
}

export type CatalogFetcher = {
  repo(repo: string): Promise<{ branch: string; license: string | null }>;
  tree(repo: string, branch: string): Promise<string[]>;
  raw(repo: string, branch: string, path: string): Promise<string>;
};

/** Lecture anonyme de GitHub : API pour la liste des fichiers (2 appels par dépôt), raw.githubusercontent pour le texte. */
export class GithubFetcher implements CatalogFetcher {
  async #get(url: string): Promise<Response> {
    const res = await fetch(url, { headers: { "User-Agent": "Nidavellir-hub", Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`GitHub ${res.status} sur ${url.replace(/^https:\/\/[^/]+/, "")}`);
    return res;
  }
  async repo(repo: string): Promise<{ branch: string; license: string | null }> {
    const j = (await (await this.#get(`https://api.github.com/repos/${repo}`)).json()) as { default_branch?: string; license?: { spdx_id?: string } | null };
    const spdx = j.license?.spdx_id && j.license.spdx_id !== "NOASSERTION" ? j.license.spdx_id : null;
    return { branch: j.default_branch ?? "main", license: spdx };
  }
  async tree(repo: string, branch: string): Promise<string[]> {
    const j = (await (await this.#get(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`)).json()) as { tree?: { path: string; type: string }[] };
    return (j.tree ?? []).filter((e) => e.type === "blob").map((e) => e.path);
  }
  async raw(repo: string, branch: string, path: string): Promise<string> {
    const res = await this.#get(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}`);
    const text = await res.text();
    return text.slice(0, MAX_FILE * 2);
  }
}

export type CatalogEntry = { source: string; path: string; name: string; description: string; license: string | null };

/** Les skills d'un dépôt : chemin de chaque SKILL.md, nom et description, licence (dépôt, sinon LICENSE du dossier). */
export async function readSource(fetcher: CatalogFetcher, source: string, limit = 250): Promise<{ branch: string; entries: CatalogEntry[] }> {
  const { branch, license } = await fetcher.repo(source);
  const paths = await fetcher.tree(source, branch);
  const only = SOURCE_SKILLS[source];
  const skills = paths.filter((p) => /(^|\/)SKILL\.md$/.test(p) && (!only || only.includes(p.split("/").slice(-2, -1)[0] ?? ""))).slice(0, limit);
  const entries: CatalogEntry[] = [];
  const queue = [...skills];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try {
        const raw = (await fetcher.raw(source, branch, p)).replace(/\r\n/g, "\n");
        const { front } = splitFrontmatter(raw);
        const dir = p.split("/").slice(0, -1).join("/");
        let lic = license;
        if (!lic) {
          const file = paths.find((f) => f.split("/").slice(0, -1).join("/") === dir && /^LICEN[CS]E(\.(md|txt))?$/i.test(f.split("/").pop()!));
          if (file) lic = licenseFromText(await fetcher.raw(source, branch, file));
        }
        entries.push({ source, path: p, name: (front.name ?? dir.split("/").pop() ?? p).trim(), description: (front.description ?? "").trim().slice(0, 400), license: lic });
      } catch {
        /* une skill illisible n'empêche pas les autres */
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  return { branch, entries };
}

/** Le texte complet d'une skill et ses annexes de référence (jamais les scripts). */
export async function fetchSkill(fetcher: CatalogFetcher, source: string, path: string): Promise<{ body: string; front: Record<string, string>; files: SkillFile[] }> {
  const { branch } = await fetcher.repo(source);
  const paths = await fetcher.tree(source, branch);
  const raw = (await fetcher.raw(source, branch, path)).replace(/\r\n/g, "\n");
  const { front, body } = splitFrontmatter(raw);
  const dir = path.split("/").slice(0, -1).join("/");
  const files: SkillFile[] = [];
  let total = 0;
  for (const p of paths) {
    if (!dir || !p.startsWith(`${dir}/`)) continue;
    const rel = p.slice(dir.length + 1);
    if (!FILE_PATH.test(rel) || rel.startsWith("scripts/") || !/\.(md|txt|json|ya?ml|gd|gdshader|glsl|csv)$/i.test(rel) || files.length >= MAX_FILES) continue;
    const content = await fetcher.raw(source, branch, p).catch(() => "");
    if (!content || content.length > MAX_FILE || total + content.length > MAX_FILES_TOTAL) continue;
    files.push({ path: rel, content });
    total += content.length;
  }
  return { body: body.trim(), front, files };
}
