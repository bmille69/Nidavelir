import { execFile } from "node:child_process";
import { cpus, freemem, totalmem } from "node:os";
import type { Hub } from "../hub.ts";

/**
 * Le moniteur du studio (ADR-64) : la file de chaque projet (en cours, en pause et jusqu'à quand), la machine (processeur,
 * mémoire, carte graphique) et la consommation de la dernière heure. Tout en lecture : rien n'est modifié.
 */
export type Monitor = {
  at: string;
  queues: { project: string; name: string; running: { id: string; title: string; status: string } | null; alongside: { id: string; title: string; status: string }[]; next: { id: string; title: string } | null; queued: number; paused: { until: string; window: string } | null }[];
  machine: { cpu: number | null; ram: { used: number; total: number }; gpu: { name: string; load: number; memUsed: number; memTotal: number } | null };
  tokens: ReturnType<Hub["usage"]["recent"]>;
};

let lastCpu: { idle: number; total: number } | null = null;
// Une première mesure dès le chargement : la suivante a déjà de quoi comparer.
setTimeout(() => cpuLoad(), 0);

/** Le processeur occupé depuis la dernière mesure, en %. */
function cpuLoad(): number | null {
  const now = cpus().reduce(
    (acc, c) => {
      const t = c.times;
      acc.idle += t.idle;
      acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
      return acc;
    },
    { idle: 0, total: 0 },
  );
  const prev = lastCpu;
  lastCpu = now;
  if (!prev || now.total <= prev.total) return null;
  return Math.round(100 * (1 - (now.idle - prev.idle) / (now.total - prev.total)));
}

let gpuCache: { at: number; value: Monitor["machine"]["gpu"] } = { at: 0, value: null };
let gpuMissing = false;

/** La carte graphique NVIDIA (celle de ComfyUI et de Blender), lue au plus toutes les 5 s ; null sans nvidia-smi. */
function gpu(): Promise<Monitor["machine"]["gpu"]> {
  if (gpuMissing || Date.now() - gpuCache.at < 5000) return Promise.resolve(gpuCache.value);
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 3000 }, (err, out) => {
      if (err) {
        gpuMissing = (err as NodeJS.ErrnoException).code === "ENOENT";
        return resolve(gpuCache.value);
      }
      const [name, load, used, total] = out.split("\n")[0]!.split(",").map((s) => s.trim());
      gpuCache = { at: Date.now(), value: name ? { name, load: Number(load), memUsed: Number(used), memTotal: Number(total) } : null };
      resolve(gpuCache.value);
    });
  });
}

export async function studioMonitor(hub: Hub): Promise<Monitor> {
  const queues = hub.projects.list().map((p) => {
    const tasks = hub.tasks.list(p.slug);
    const running = hub.tasks.busy(p.slug);
    const queued = hub.tasks.queued(p.slug);
    const paused = queued.length ? hub.tasks.limitInfo() : null;
    return {
      project: p.slug,
      name: p.name,
      running: running ? { id: running.id, title: running.title, status: running.status } : null,
      // Chef de chantier (ADR-104) : les autres chantiers en cours sur le même jeu.
      alongside: hub.tasks.occupying(p.slug).filter((t) => t.id !== running?.id).map((t) => ({ id: t.id, title: t.title, status: t.status })),
      next: queued[0] ? { id: queued[0].id, title: queued[0].title } : null,
      queued: queued.length,
      paused: paused ? { until: paused.until, window: paused.window } : null,
      total: tasks.length,
    };
  });
  return {
    at: hub.clock.now(),
    queues: queues.filter((q) => q.running || q.queued).map(({ total: _t, ...q }) => q),
    machine: { cpu: cpuLoad(), ram: { used: totalmem() - freemem(), total: totalmem() }, gpu: await gpu() },
    tokens: hub.usage.recent(),
  };
}
