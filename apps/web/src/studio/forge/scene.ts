import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { buildDwarf, type Dwarf } from "./dwarf.ts";
import { ACTOR_INFO, dayLight, type Actor, type ForgeState } from "./model.ts";
import { buildWorld, hdr, type Fire, type P, type Station, type World } from "./world.ts";

/**
 * La scène de la Forge (ADR-106) : three.js, caméra isométrique, nains en voxels qui suivent les vrais états du hub.
 * Chargée à la demande (import dynamique) : le reste de l'interface ne télécharge pas three.js.
 */

export type ForgeSceneOptions = {
  canvas: HTMLCanvasElement;
  /** Calque HTML pour les étiquettes (noms, chantiers) ; absent dans l'aperçu de l'accueil. */
  overlay?: HTMLElement | null;
  mini?: boolean;
  /** L'heure affichée (0 à 24), lue à chaque image : l'heure réelle, ou le cycle accéléré. */
  hour: () => number;
  /** Animations réduites (interrupteur du studio) : la scène se fige et ne se redessine qu'à chaque changement. */
  reduced: () => boolean;
  onPick?: (id: string | null) => void;
};

export type ForgeScene = {
  update(state: ForgeState): void;
  select(id: string | null): void;
  resetView(): void;
  dispose(): void;
};

type Walker = {
  actor: Actor;
  dwarf: Dwarf;
  pos: THREE.Vector3;
  yaw: number;
  path: THREE.Vector3[];
  target: Station | null;
  at: Station | null;
  phase: number;
  bang: number;
  /** Vient d'apparaître : posé directement à son poste. */
  fresh: boolean;
  /** Son poste a bougé (nombre d'établis changé) : il y retourne à pied. */
  reroute: boolean;
  bubble: THREE.Mesh;
  tag: HTMLDivElement | null;
};

const BACK = 5.3;
const FRONT = 10.45;
const LEFT = 9.6;
const RIGHT = 16.4;
const SPEED = 1.9;

/** Un chemin simple dans la salle : deux allées (fond, devant) reliées par deux couloirs autour du foyer. */
function route(from: Station | P, to: Station): P[] {
  const pts: P[] = [];
  const fromExit = "exit" in from && from.exit ? from.exit : [];
  const a: P = fromExit.at(-1) ?? from;
  const b: P = to.exit?.at(-1) ?? to;
  if (Math.hypot(from.x - to.x, from.z - to.z) < 0.05) return [to];
  pts.push(...fromExit);
  const onNet = (p: P): P[] => {
    if (p.z <= BACK + 0.01) return [{ x: p.x, z: BACK }];
    if (p.z >= FRONT) return [...(p.x < 3.5 ? [{ x: 3.8, z: p.z }] : []), { x: Math.max(p.x, 3.8), z: FRONT }];
    return [{ x: p.x < 13 ? LEFT : RIGHT, z: p.z }];
  };
  const na = onNet(a);
  const nb = onNet(b);
  const ea = na.at(-1)!;
  const eb = nb.at(-1)!;
  pts.push(...na);
  if (Math.abs(ea.z - eb.z) > 0.01) {
    const cx = Math.abs(ea.x - LEFT) + Math.abs(eb.x - LEFT) <= Math.abs(ea.x - RIGHT) + Math.abs(eb.x - RIGHT) ? LEFT : RIGHT;
    pts.push({ x: cx, z: ea.z }, { x: cx, z: eb.z });
  }
  pts.push(...[...nb].reverse());
  if (to.exit) pts.push(...[...to.exit].reverse());
  pts.push(to);
  // Pas de points en double.
  return pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1]!.x, p.z - pts[i - 1]!.z) > 0.02);
}

const lerpAngle = (a: number, b: number, t: number) => {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

export function createForgeScene(o: ForgeSceneOptions): ForgeScene {
  const mini = !!o.mini;
  const renderer = new THREE.WebGLRenderer({ canvas: o.canvas, antialias: !mini, alpha: true, powerPreference: mini ? "low-power" : "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mini ? 1.25 : 2));
  // Pas de courbe de tons : le métal en fusion et les runes, plus clairs que le blanc, restent saturés et alimentent
  // le halo ; une courbe (ACES) les pâlissait en jaune. Les lumières sont réglées en conséquence (LIGHT_GAIN).
  renderer.toneMapping = THREE.NoToneMapping;
  if (!mini) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#07090e");
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const world: World = buildWorld(material, mini);
  scene.add(world.group);
  const LIGHT_GAIN = 1.6;

  const hemi = new THREE.HemisphereLight("#bcd4ff", "#2a2018", 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight("#fff1d6", 1.6);
  sun.target.position.set(13, 0, 9);
  scene.add(sun, sun.target);
  if (!mini) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -20;
    c.right = 20;
    c.top = 20;
    c.bottom = -20;
    c.near = 1;
    c.far = 80;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.02;
  }

  // ── Caméra isométrique, orientable à la souris ──
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
  // Le halo (bloom) : seuls le métal en fusion, les feux et les runes, plus clairs que le blanc, le déclenchent.
  let composer: EffectComposer | null = null;
  let bloom: UnrealBloomPass | null = null;
  if (!mini) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.95, 0.6, 1.0);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }
  const center = new THREE.Vector3(12, 0.6, 9.8);
  const view = { az: 0.72, el: 0.62, zoom: mini ? 1.05 : 1 };
  const placeCamera = () => {
    const r = 60;
    camera.position.set(center.x + Math.sin(view.az) * Math.cos(view.el) * r, center.y + Math.sin(view.el) * r, center.z + Math.cos(view.az) * Math.cos(view.el) * r);
    camera.lookAt(center);
    camera.zoom = view.zoom;
    camera.updateProjectionMatrix();
  };
  const resize = () => {
    const w = o.canvas.clientWidth || 300;
    const h = o.canvas.clientHeight || 200;
    renderer.setSize(w, h, false);
    composer?.setPixelRatio(renderer.getPixelRatio());
    composer?.setSize(w, h);
    const aspect = w / h;
    // Toute la salle tient dans le cadre, quel que soit son format.
    const H = Math.max(mini ? 14.5 : 16, (mini ? 25 : 31.5) / aspect);
    camera.left = (-H * aspect) / 2;
    camera.right = (H * aspect) / 2;
    camera.top = H / 2;
    camera.bottom = -H / 2;
    placeCamera();
    dirty = true;
  };

  // ── Particules : étincelles de la forge, braises du foyer, or du trésor ──
  const MAXP = 220;
  const sparks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false }), MAXP);
  sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sparks.frustumCulled = false;
  scene.add(sparks);
  const parts = Array.from({ length: MAXP }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, max: 1, g: 9 }));
  const m4 = new THREE.Matrix4();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const col = new THREE.Color();
  for (let i = 0; i < MAXP; i++) {
    sparks.setMatrixAt(i, zero);
    sparks.setColorAt(i, col.set("#ffb040"));
  }
  let nextP = 0;
  const emit = (at: THREE.Vector3, n: number, color: string, speed: number, up: number, gravity: number, life: number) => {
    for (let k = 0; k < n; k++) {
      const q = parts[nextP]!;
      q.p.copy(at);
      q.v.set((Math.random() - 0.5) * speed, up * (0.5 + Math.random()), (Math.random() - 0.5) * speed);
      q.life = q.max = life * (0.6 + Math.random() * 0.6);
      q.g = gravity;
      sparks.setColorAt(nextP, col.set(color).multiplyScalar(2.2));
      nextP = (nextP + 1) % MAXP;
    }
    if (sparks.instanceColor) sparks.instanceColor.needsUpdate = true;
  };

  // ── Sélection : un carré cyan au sol ──
  const ring = new THREE.Group();
  const ringMat = new THREE.MeshBasicMaterial({ color: "#00e5ff", transparent: true, opacity: 0.9, toneMapped: false });
  for (const [w, d, x, z] of [[1.3, 0.08, 0, -0.62], [1.3, 0.08, 0, 0.62], [0.08, 1.3, -0.62, 0], [0.08, 1.3, 0.62, 0]] as const) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.03, d), ringMat);
    m.position.set(x, 0.03, z);
    ring.add(m);
  }
  ring.visible = false;
  scene.add(ring);
  let selected: string | null = null;

  // ── Étiquettes HTML ──
  const overlay = o.overlay ?? null;
  const tags = new Map<string, { el: HTMLDivElement; anchor: THREE.Object3D | (() => THREE.Vector3) }>();
  const tag = (id: string, anchor: THREE.Object3D | (() => THREE.Vector3), cls: string) => {
    if (!overlay) return null;
    const el = document.createElement("div");
    el.className = `forge-tag ${cls}`;
    el.dataset.id = id;
    overlay.appendChild(el);
    tags.set(id, { el, anchor });
    return el;
  };
  const setTag = (id: string, html: string | null, extra?: string) => {
    const t = tags.get(id);
    if (!t) return;
    t.el.style.display = html === null ? "none" : "";
    if (html !== null && t.el.innerHTML !== html) t.el.innerHTML = html;
    if (extra !== undefined) t.el.dataset.state = extra;
  };
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  world.anvils.forEach((a, i) => tag(`bench:${i}`, a.sign, "forge-sign"));
  tag("queue", world.anchors.queue, "forge-prop");
  tag("table", world.anchors.table, "forge-prop forge-you");
  tag("vault", world.anchors.vault, "forge-prop");

  // ── Les nains ──
  const walkers = new Map<string, Walker>();
  const bubbleGeo = (() => {
    const g = new THREE.BoxGeometry(0.12, 0.34, 0.12);
    g.translate(0, 0.28, 0);
    return g;
  })();
  const bubbleMat = new THREE.MeshBasicMaterial({ color: hdr("#ff5a00", 1.6), toneMapped: false });
  const dotGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);

  const stationFor = (w: Walker, idleIndex: Map<string, number>): Station => {
    const a = w.actor;
    if (a.kind === "developer" && a.bench !== undefined) {
      if (a.mode !== "idle") return world.anvils[a.bench]!.station;
    } else if (a.mode !== "idle" || a.kind === "guardian") return world.stations[a.kind as keyof World["stations"]];
    return world.idle[(idleIndex.get(a.id) ?? 0) % world.idle.length]!;
  };

  const ensureWalker = (a: Actor): Walker => {
    let w = walkers.get(a.id);
    if (!w) {
      const dwarf = buildDwarf(a.kind, ACTOR_INFO[a.kind].color, material, a.bench ?? 0);
      dwarf.root.traverse((m) => {
        m.userData.pick = `actor:${a.id}`;
      });
      const bubble = new THREE.Mesh(bubbleGeo, bubbleMat);
      const dot = new THREE.Mesh(dotGeo, bubbleMat);
      bubble.add(dot);
      bubble.position.y = 1.5;
      bubble.visible = false;
      dwarf.root.add(bubble);
      scene.add(dwarf.root);
      w = { actor: a, dwarf, pos: new THREE.Vector3(), yaw: 0, path: [], target: null, at: null, phase: Math.random() * 10, bang: 0, fresh: true, reroute: false, bubble, tag: null };
      const walker = w;
      w.tag = tag(`actor:${a.id}`, () => new THREE.Vector3(walker.pos.x, walker.pos.y + 1.55, walker.pos.z), "forge-name");
      walkers.set(a.id, w);
    }
    w.actor = a;
    return w;
  };

  let state: ForgeState | null = null;
  let mergedSeen: Set<string> | null = null;
  // Wagonnet : chargé devant le banc d'essai, il roule jusqu'au trésor, décharge, puis revient à vide.
  const carts: { t: number; crate: string }[] = [];
  const CART_GO = 3.4;
  const CART_HOLD = 1.0;
  const CART_BACK = 3.0;
  let lidOpen = 0;
  let firstLayout = true;
  let dirty = true;

  const update = (s: ForgeState) => {
    state = s;
    if (world.layoutBenches(s.benches.length)) for (const w of walkers.values()) if (w.actor.kind === "developer") w.reroute = true;
    const ids = new Set(s.actors.map((a) => a.id));
    for (const [id, w] of walkers) {
      if (ids.has(id)) continue;
      scene.remove(w.dwarf.root);
      w.tag?.remove();
      tags.delete(`actor:${id}`);
      walkers.delete(id);
    }
    const idleIndex = new Map<string, number>();
    s.actors.filter((a) => a.mode === "idle" && a.kind !== "guardian").forEach((a, k) => idleIndex.set(a.id, k));
    for (const a of s.actors) {
      const w = ensureWalker(a);
      const st = stationFor(w, idleIndex);
      // Les postes sont des objets stables : un nouveau trajet seulement quand la destination change vraiment.
      if (w.target !== st || w.reroute || w.fresh) {
        w.reroute = false;
        if (firstLayout || o.reduced() || w.fresh) {
          w.fresh = false;
          w.pos.set(st.x, 0, st.z);
          w.yaw = st.yaw;
          w.path = [];
          w.at = st;
        } else {
          const from = w.path.length ? { x: w.pos.x, z: w.pos.z } : (w.at ?? { x: w.pos.x, z: w.pos.z });
          w.path = route(from, st).map((p) => new THREE.Vector3(p.x, 0, p.z));
          w.at = null;
        }
        w.target = st;
      }
      w.bubble.visible = a.mode === "wait";
      const name = esc(a.name);
      // Au survol, la ligne d'activité, ou à défaut le rôle : l'étiquette dit toujours qui c'est et ce qu'il fait.
      const line = `<small>${esc(a.line ?? a.role)}</small>`;
      setTag(`actor:${a.id}`, `<b>${name}</b>${line}`, a.mode);
    }
    firstLayout = false;

    // Les établis.
    world.anvils.forEach((an, i) => {
      const b = s.benches[i];
      const d = b?.data ?? null;
      an.crate.visible = !!d && d.phase !== "verify";
      const review = d?.phase === "review" || d?.phase === "plan_review";
      an.crateMat.emissiveIntensity = review ? 0.6 : 0;
      if (i >= s.benches.length) setTag(`bench:${i}`, null);
      else setTag(`bench:${i}`, d ? `<b>${esc(d.task.id)}</b><small>${esc(d.task.title.length > 34 ? `${d.task.title.slice(0, 33)}…` : d.task.title)}</small>` : `<small>Établi ${i + 1} libre</small>`, d ? (review ? "wait" : d.phase === "verify" ? "verify" : "work") : "idle");
    });
    world.queueCrates.forEach((c, i) => (c.visible = i < s.queue.length));
    world.qaCrate.visible = !!s.testing;
    const forYou = s.review.length + s.escalations.length;
    world.scrolls.forEach((c, i) => (c.visible = i < forYou));
    setTag("queue", s.queue.length ? `<b>File · ${s.queue.length}</b>${s.paused ? "<small>pause de quota</small>" : ""}` : "<small>File vide</small>", s.queue.length ? "work" : "idle");
    setTag("table", forYou ? `<b>Pour vous · ${forYou}</b>` : "<small>Votre table</small>", forYou ? "wait" : "idle");
    setTag("vault", `<b>Trésor</b><small>${s.today.merged} fusion${s.today.merged > 1 ? "s" : ""} aujourd'hui</small>`, "idle");

    // Une fusion nouvelle : le wagonnet part du banc d'essai vers le trésor.
    const ids2 = s.merged.map((m) => m.id);
    if (mergedSeen === null) mergedSeen = new Set(ids2);
    else
      for (const id of ids2)
        if (!mergedSeen.has(id)) {
          mergedSeen.add(id);
          carts.push({ t: 0, crate: id });
        }
    dirty = true;
  };

  // ── Poses ──
  const pose = (w: Walker, t: number, moving: boolean, night: boolean, reduced: boolean) => {
    const d = w.dwarf;
    const a = w.actor;
    const T = reduced ? 0 : t + w.phase;
    d.legL.rotation.set(0, 0, 0);
    d.legR.rotation.set(0, 0, 0);
    d.armL.rotation.set(0, 0, 0);
    d.armR.rotation.set(0, 0, 0);
    d.head.rotation.set(0, 0, 0);
    d.body.rotation.set(0, 0, 0);
    d.body.position.y = 0.3;
    d.root.position.y = 0;
    if (moving) {
      const s = Math.sin(T * 11);
      d.legL.rotation.x = s * 0.7;
      d.legR.rotation.x = -s * 0.7;
      d.armL.rotation.x = -s * 0.5;
      d.armR.rotation.x = s * 0.5;
      d.root.position.y = Math.abs(Math.cos(T * 11)) * 0.05;
      return;
    }
    const st = w.target;
    if (a.mode === "idle" && st?.sit) {
      d.legL.rotation.x = d.legR.rotation.x = -1.45;
      d.armL.rotation.x = -0.35;
      if (night) {
        d.head.rotation.x = 0.45; // il dort
        d.armR.rotation.x = -0.3;
      } else {
        // Il se chauffe les mains à la grande forge.
        d.armL.rotation.x = d.armR.rotation.x = -1.15 + Math.sin(T * 1.1) * 0.08;
        d.armL.rotation.z = -0.25;
        d.armR.rotation.z = 0.25;
        d.head.rotation.x = 0.1 + Math.sin(T * 0.4) * 0.08;
      }
      return;
    }
    if (a.mode === "idle") {
      d.head.rotation.y = Math.sin(T * 0.5) * 0.4;
      d.armR.rotation.x = -0.15;
      if (night && a.kind !== "guardian") d.head.rotation.x = 0.3;
      return;
    }
    if (a.mode === "wait") {
      d.armR.rotation.x = -2.7 + Math.sin(T * 7) * 0.25; // il vous fait signe
      d.armR.rotation.z = 0.25;
      d.head.rotation.x = -0.15;
      d.root.position.y = Math.abs(Math.sin(T * 3.5)) * 0.06;
      return;
    }
    switch (a.kind) {
      case "developer": {
        if (a.phase !== "execute" && a.phase !== "changes") {
          // Plan, contrôles du hub, installation : il lit sa consigne, bras croisés.
          d.armL.rotation.x = d.armR.rotation.x = -1.2;
          d.armL.rotation.z = -0.5;
          d.armR.rotation.z = 0.5;
          d.head.rotation.x = 0.25 + Math.sin(T * 1.3) * 0.08;
          return;
        }
        const phase = (T * 1.6) % 1;
        const raise = phase < 0.72 ? phase / 0.72 : 1 - (phase - 0.72) / 0.28;
        d.armR.rotation.x = -0.5 - raise * 2.1;
        d.armL.rotation.x = -0.6;
        d.body.rotation.x = 0.12 - raise * 0.12;
        d.head.rotation.x = 0.3;
        if (!reduced && w.bang > phase && w.at && w.actor.bench !== undefined) emit(world.anvils[w.actor.bench]!.spark, 7, Math.random() > 0.5 ? "#ffb040" : "#ff6a1a", 2.2, 2.2, 9, 0.5);
        w.bang = phase;
        return;
      }
      case "director":
        d.armR.rotation.x = -1.2 + Math.sin(T * 1.8) * 0.25;
        d.armR.rotation.z = Math.sin(T * 0.9) * 0.2;
        d.head.rotation.y = Math.sin(T * 0.6) * 0.3;
        return;
      case "concepteur":
      case "foreman":
        d.armL.rotation.x = -1.1;
        d.armR.rotation.x = -0.95 + Math.sin(T * 9) * 0.08;
        d.armR.rotation.z = Math.sin(T * 3) * 0.1;
        d.head.rotation.x = 0.35;
        return;
      case "archivist":
        d.armL.rotation.x = -1.0;
        d.armR.rotation.x = -0.9 + Math.sin(T * 10) * 0.07;
        d.head.rotation.x = 0.4;
        d.head.rotation.y = Math.sin(T * 0.8) * 0.15;
        return;
      case "art_director":
        d.armR.rotation.x = -1.4 + Math.sin(T * 2.6) * 0.35;
        d.armR.rotation.z = Math.sin(T * 1.7) * 0.35;
        d.head.rotation.y = Math.sin(T * 0.7) * 0.2;
        return;
      case "qa":
        d.body.rotation.x = 0.18;
        d.armR.rotation.x = -1.25 + Math.sin(T * 1.2) * 0.1;
        d.armR.rotation.y = Math.sin(T * 0.9) * 0.3;
        d.head.rotation.x = 0.35;
        return;
      case "guardian":
        d.head.rotation.y = Math.sin(T * 0.6) * 0.7; // il surveille
        d.armR.rotation.x = -0.2;
        return;
    }
  };

  const flicker = (f: Fire, t: number, strength: number, reduced: boolean) => {
    const n = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * 13 + f.phase) * Math.sin(t * 7.3 + f.phase * 2);
    const s = 0.8 + n * 0.35;
    for (const fl of f.flames) fl.scale.set(1, s * Math.max(0.25, strength), 1);
    if (f.light) f.light.intensity = f.base * strength * (0.85 + n * 0.3);
  };

  // ── Boucle ──
  let raf = 0;
  let last = performance.now();
  let t = 0;
  let visible = true;
  let lastLight = -1;
  let frame = 0;
  const io = new IntersectionObserver((e) => {
    visible = e.some((x) => x.isIntersecting);
  });
  io.observe(o.canvas);

  const v3 = new THREE.Vector3();
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!visible || document.hidden) return;
    frame++;
    if (mini && frame % 2) return;
    const reduced = o.reduced();
    if (reduced && !dirty) return;
    t += mini ? dt * 2 : dt;
    const step = mini ? dt * 2 : dt;

    // Lumière du jour, recalculée au plus quelques fois par seconde.
    const hour = o.hour();
    const light = dayLight(hour);
    if (Math.abs(hour - lastLight) > 0.01) {
      lastLight = hour;
      world.sky.color.set(light.sky);
      sun.color.set(light.sun);
      sun.intensity = light.sunIntensity * LIGHT_GAIN;
      hemi.color.set(light.ambient);
      hemi.intensity = light.ambientIntensity * LIGHT_GAIN;
      const a = ((hour - 6) / 15) * Math.PI;
      sun.position.set(13 - Math.cos(a) * 16, 14 + Math.max(0, Math.sin(a)) * 10, 26);
      // Le soleil traverse la fenêtre de droite le jour, la lune celle de gauche la nuit.
      const dayT = Math.min(1, Math.max(0, (hour - 6) / 15.5));
      world.sun.visible = !light.night && hour > 6.2 && hour < 21.3;
      world.sun.position.set(15.5 + dayT * 1.0, 1.4 + Math.sin(dayT * Math.PI) * 2.2, -0.66);
      world.moon.visible = light.night || light.label === "Crépuscule";
      const nightT = ((hour + 24 - 19) % 24) / 11;
      world.moon.position.set(9.4 + nightT * 1.2, 1.5 + Math.sin(Math.min(1, nightT) * Math.PI) * 2, -0.66);
    }

    // Feux : les torches brillent davantage la nuit ; les fourneaux suivent le travail de leur établi.
    for (const f of world.fires) flicker(f, t, f === world.hearth ? 0.75 + light.torches * 0.25 : f === world.tableLamp ? (state && state.review.length + state.escalations.length ? 1 + Math.sin(t * 4) * 0.35 : 0.15) : light.torches, reduced);
    world.anvils.forEach((a, i) => {
      const working = state?.actors.find((x) => x.bench === i)?.mode === "work";
      flicker(a.furnace, t, working ? 1 : 0.25, reduced);
      a.furnace.mat.color.copy(working ? hdr("#ff6a1a", 2.4 + (reduced ? 0 : Math.sin(t * 9 + i) * 0.3)) : hdr("#7a2a0c", 0.9));
      if (a.crateMat.emissiveIntensity > 0) a.crateMat.emissiveIntensity = 0.35 + (reduced ? 0.2 : Math.abs(Math.sin(t * 3)) * 0.5);
    });
    const blocked = !!state?.escalations.length;
    world.gateLamp.mat.color.copy(blocked ? (reduced || Math.sin(t * 6) > 0 ? hdr("#ff5a00", 2.6) : hdr("#7a2a0c", 1)) : hdr("#00e5ff", 2.2));
    // Le métal en fusion respire, les runes pulsent lentement.
    if (!reduced) {
      world.lava.color.copy(hdr("#ff3c00", 2.2 + Math.sin(t * 1.7) * 0.25 + Math.sin(t * 5.3) * 0.1));
      world.runes.color.copy(hdr("#00e5ff", 1.1 + Math.sin(t * 0.8) * 0.25));
    }
    if (world.gateLamp.light) {
      world.gateLamp.light.color.set(blocked ? "#ff5a00" : "#00e5ff");
      world.gateLamp.light.intensity = blocked ? 8 : 3 + light.torches * 2;
    }
    // Braises qui montent de la grande forge et de la rigole.
    if (!reduced && !mini && Math.random() < step * 14) {
      const src = world.embers[Math.floor(Math.random() * world.embers.length)]!;
      emit(v3.set(src.x + (Math.random() - 0.5) * 0.6, src.y, src.z + (Math.random() - 0.5) * 0.3), 1, Math.random() > 0.3 ? "#ff8a30" : "#ffd27a", 0.35, 0.8, -0.25, 2.2);
    }

    // Les nains marchent puis prennent la pose de leur état.
    for (const w of walkers.values()) {
      let moving = false;
      if (w.path.length) {
        if (reduced) {
          const end = w.path.at(-1)!;
          w.pos.copy(end);
          w.path = [];
        } else {
          const goal = w.path[0]!;
          const dx = goal.x - w.pos.x;
          const dz = goal.z - w.pos.z;
          const dist = Math.hypot(dx, dz);
          const stepLen = SPEED * step;
          if (dist <= stepLen) {
            w.pos.copy(goal);
            w.path.shift();
          } else {
            w.pos.x += (dx / dist) * stepLen;
            w.pos.z += (dz / dist) * stepLen;
            w.yaw = lerpAngle(w.yaw, Math.atan2(dx, dz), Math.min(1, step * 12));
            moving = true;
          }
        }
        if (!w.path.length) w.at = w.target;
      }
      if (!moving && w.target) w.yaw = reduced ? w.target.yaw : lerpAngle(w.yaw, w.target.yaw, Math.min(1, step * 6));
      w.dwarf.root.position.set(w.pos.x, 0, w.pos.z);
      w.dwarf.root.rotation.y = w.yaw;
      pose(w, t, moving, light.night, reduced);
      w.dwarf.root.position.x = w.pos.x;
      w.dwarf.root.position.z = w.pos.z;
      if (w.target?.sit && !moving && w.actor.mode === "idle") w.dwarf.root.position.y = 0.02;
      if (w.bubble.visible) w.bubble.position.y = 1.5 + (reduced ? 0 : Math.sin(t * 4) * 0.06);
      // Zzz : la nuit, les nains au repos dorment.
      if (w.tag) w.tag.classList.toggle("sleep", light.night && w.actor.mode === "idle" && w.actor.kind !== "guardian" && !moving);
    }

    // Le wagonnet des fusions.
    const r = world.rails;
    const seg1 = r[0]!.distanceTo(r[1]!);
    const seg2 = r[1]!.distanceTo(r[2]!);
    const placeCart = (u: number) => {
      const ease = u * u * (3 - 2 * u);
      const d = ease * (seg1 + seg2);
      if (d <= seg1) world.cart.position.lerpVectors(r[0]!, r[1]!, d / seg1);
      else world.cart.position.lerpVectors(r[1]!, r[2]!, (d - seg1) / seg2);
      world.cart.position.y = 0.08;
      world.cart.rotation.y = d <= seg1 ? 0 : Math.PI / 2;
    };
    if (carts.length) {
      const c = carts[0]!;
      const before = c.t;
      c.t += reduced ? CART_GO + CART_HOLD + CART_BACK : step;
      if (c.t < CART_GO) {
        placeCart(c.t / CART_GO);
        world.cartCrate.visible = true;
      } else if (c.t < CART_GO + CART_HOLD) {
        placeCart(1);
        if (before < CART_GO) {
          // Déchargé au trésor : le coffre s'ouvre, l'or jaillit.
          lidOpen = 1;
          if (!reduced) emit(v3.set(24.4, 1.1, 9.4), 30, "#f0c040", 2.6, 3, 7, 1.2);
        }
        world.cartCrate.visible = false;
      } else if (c.t < CART_GO + CART_HOLD + CART_BACK) {
        placeCart(1 - (c.t - CART_GO - CART_HOLD) / CART_BACK);
        world.cartCrate.visible = false;
      } else {
        carts.shift();
        placeCart(0);
        world.cartCrate.visible = false;
        if (reduced) lidOpen = 1;
      }
    }
    lidOpen = Math.max(0, lidOpen - step * 0.6);
    world.vaultLid.rotation.x = -Math.sin(Math.min(1, lidOpen * 1.5) * Math.PI * 0.5) * 1.1;

    // Particules.
    if (!reduced) {
      for (let i = 0; i < MAXP; i++) {
        const q = parts[i]!;
        if (q.life <= 0) continue;
        q.life -= step;
        if (q.life <= 0) {
          sparks.setMatrixAt(i, zero);
          continue;
        }
        q.v.y -= q.g * step;
        q.p.addScaledVector(q.v, step);
        if (q.p.y < 0.02) {
          q.p.y = 0.02;
          q.v.multiplyScalar(0.3);
        }
        const s = Math.max(0.2, q.life / q.max);
        m4.makeScale(s, s, s).setPosition(q.p);
        sparks.setMatrixAt(i, m4);
      }
      sparks.instanceMatrix.needsUpdate = true;
    }

    // Sélection.
    if (selected) {
      const p = positionOf(selected);
      ring.visible = !!p;
      if (p) ring.position.set(p.x, 0, p.z);
      ring.scale.setScalar(reduced ? 1 : 1 + Math.sin(t * 4) * 0.05);
    } else ring.visible = false;

    if (composer) composer.render();
    else renderer.render(scene, camera);
    placeTags();
    dirty = false;
  };

  const positionOf = (id: string): THREE.Vector3 | null => {
    if (id.startsWith("actor:")) {
      const w = walkers.get(id.slice(6));
      return w ? w.pos : null;
    }
    if (id.startsWith("bench:")) {
      const a = world.anvils[Number(id.slice(6))];
      return a ? v3.set(a.group.position.x, 0, a.group.position.z + 0.9) : null;
    }
    const an = world.anchors[id as keyof World["anchors"]];
    return an ? v3.set(an.position.x, 0, an.position.z) : null;
  };

  const proj = new THREE.Vector3();
  const placeTags = () => {
    if (!overlay) return;
    const w = o.canvas.clientWidth;
    const h = o.canvas.clientHeight;
    for (const [id, t] of tags) {
      if (t.el.style.display === "none") continue;
      if (typeof t.anchor === "function") proj.copy(t.anchor());
      else t.anchor.getWorldPosition(proj);
      proj.project(camera);
      const x = (proj.x * 0.5 + 0.5) * w;
      const y = (-proj.y * 0.5 + 0.5) * h;
      t.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      t.el.classList.toggle("selected", id === selected);
    }
  };

  // ── Souris : tourner, zoomer, choisir ──
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pickAt = (cx: number, cy: number): string | null => {
    const r = o.canvas.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const targets = [...world.pickables, ...[...walkers.values()].map((w) => w.dwarf.root)];
    const hit = ray.intersectObjects(targets, true)[0];
    let obj: THREE.Object3D | null = hit?.object ?? null;
    while (obj && !obj.userData.pick) obj = obj.parent;
    return (obj?.userData.pick as string | undefined) ?? null;
  };
  let drag: { x: number; y: number; az: number; el: number; moved: boolean } | null = null;
  const onDown = (e: PointerEvent) => {
    drag = { x: e.clientX, y: e.clientY, az: view.az, el: view.el, moved: false };
    o.canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) {
        view.az = Math.min(1.3, Math.max(0.2, drag.az - dx * 0.006));
        view.el = Math.min(1.05, Math.max(0.42, drag.el + dy * 0.004));
        placeCamera();
        dirty = true;
      }
      return;
    }
    const id = pickAt(e.clientX, e.clientY);
    o.canvas.style.cursor = id ? "pointer" : "grab";
    for (const [tid, t] of tags) t.el.classList.toggle("hover", tid === id);
    dirty = true;
  };
  const onUp = (e: PointerEvent) => {
    const d = drag;
    drag = null;
    if (d && !d.moved) o.onPick?.(pickAt(e.clientX, e.clientY));
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    view.zoom = Math.min(2.6, Math.max(0.8, view.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
    placeCamera();
    dirty = true;
  };
  if (!mini) {
    o.canvas.addEventListener("pointerdown", onDown);
    o.canvas.addEventListener("pointermove", onMove);
    o.canvas.addEventListener("pointerup", onUp);
    o.canvas.addEventListener("wheel", onWheel, { passive: false });
    o.canvas.style.cursor = "grab";
  }
  const ro = new ResizeObserver(resize);
  ro.observe(o.canvas);
  resize();
  raf = requestAnimationFrame(tick);

  return {
    update,
    select(id) {
      selected = id;
      dirty = true;
    },
    resetView() {
      view.az = 0.72;
      view.el = 0.62;
      view.zoom = 1;
      placeCamera();
      dirty = true;
    },
    dispose() {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      o.canvas.removeEventListener("pointerdown", onDown);
      o.canvas.removeEventListener("pointermove", onMove);
      o.canvas.removeEventListener("pointerup", onUp);
      o.canvas.removeEventListener("wheel", onWheel);
      for (const t of tags.values()) t.el.remove();
      scene.traverse((m) => {
        const mesh = m as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      composer?.dispose();
      renderer.dispose();
    },
  };
}
