// Nidavellir en application Windows.
// Electron lance le hub tel quel, avec le Node du PC, et l'affiche dans sa propre fenêtre : barre de titre maison,
// Mica sous le menu, icône près de l'horloge, notifications Windows, raccourci global.
// Le hub reste un vrai serveur local : le navigateur et le téléphone (Tailscale) fonctionnent comme avant.
import { app, BrowserWindow, dialog, globalShortcut, Menu, nativeImage, nativeTheme, Notification, screen, shell, Tray } from "electron";
import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { release } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const assets = join(here, "assets");
/** Le dépôt du hub : STUDIO_HUB_ROOT, sinon celui gravé dans l'installateur (scripts/dist.mjs), sinon celui d'où l'on lance. */
const root = resolve(process.env.STUDIO_HUB_ROOT ?? (app.isPackaged ? readOwnPackage().nidavellirRoot : null) ?? join(here, "..", ".."));
const cliPort = process.argv.find((a) => a.startsWith("--port="))?.slice(7);
const port = Number(cliPort ?? process.env.STUDIO_PORT ?? 4317);
const base = `http://127.0.0.1:${port}`;
const hidden = process.argv.includes("--hidden"); // lancement avec Windows : directement près de l'horloge.
const BG = "#08090d"; // --bg de l'interface : pas d'éclair blanc.
const TITLEBAR_H = 40;
const SHORTCUT = "CommandOrControl+Alt+N";
const AUMID = "Nidavellir.Studio";

app.setName("Nidavellir");
// Une seconde copie isolée (essais) : ses propres réglages, et elle ne réveille pas la fenêtre déjà ouverte.
if (process.env.STUDIO_APP_DATA) app.setPath("userData", resolve(process.env.STUDIO_APP_DATA));
if (process.platform === "win32") app.setAppUserModelId(AUMID);
nativeTheme.themeSource = "dark";

/** @type {import("node:child_process").ChildProcess | null} */
let hub = null;
/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;
const logTail = [];
const notices = new Map();

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => reveal());

// ── État conservé entre deux lancements : place de la fenêtre, conseil de l'icône déjà donné ──
const statePath = () => join(app.getPath("userData"), "window-state.json");
function loadState() {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}
function saveState(patch) {
  try {
    writeFileSync(statePath(), JSON.stringify({ ...loadState(), ...patch }, null, 2));
  } catch {
    /* état non écrit : la fenêtre repartira simplement à sa place par défaut */
  }
}

// ── Icônes : .ico multi-tailles (fenêtre, barre des tâches, menu Démarrer) et icône de la zone de notification ──
function icons() {
  const full = nativeImage.createFromPath(join(assets, "icon.png"));
  const ico = join(app.getPath("userData"), "nidavellir.ico");
  if (!existsSync(ico) && !full.isEmpty()) {
    const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
    const pngs = sizes.map((s) => full.resize({ width: s, height: s, quality: "best" }).toPNG());
    const head = Buffer.alloc(6 + 16 * sizes.length);
    head.writeUInt16LE(0, 0);
    head.writeUInt16LE(1, 2);
    head.writeUInt16LE(sizes.length, 4);
    let offset = head.length;
    sizes.forEach((s, k) => {
      const e = 6 + 16 * k;
      head.writeUInt8(s >= 256 ? 0 : s, e);
      head.writeUInt8(s >= 256 ? 0 : s, e + 1);
      head.writeUInt16LE(1, e + 4);
      head.writeUInt16LE(32, e + 6);
      head.writeUInt32LE(pngs[k].length, e + 8);
      head.writeUInt32LE(offset, e + 12);
      offset += pngs[k].length;
    });
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(ico, Buffer.concat([head, ...pngs]));
  }
  const mark = nativeImage.createFromPath(join(assets, "logo-mark.png"));
  const trayImage = nativeImage.createEmpty();
  for (const scale of [1, 1.25, 1.5, 2]) {
    const s = Math.round(16 * scale);
    trayImage.addRepresentation({ scaleFactor: scale, width: s, height: s, buffer: mark.resize({ width: s, height: s, quality: "best" }).toPNG() });
  }
  return { ico, trayImage };
}

/** Raccourci du menu Démarrer : relance l'application comme ce lancement-ci, et donne son nom aux notifications Windows.
 *  L'application installée a déjà le sien (posé par l'installateur). */
function startMenuShortcut(ico) {
  if (process.platform !== "win32" || app.isPackaged) return;
  const link = join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Nidavellir (dev).lnk");
  const args = [`"${here.replace(/[\\/]$/, "")}"`, ...(cliPort || process.env.STUDIO_PORT ? [`--port=${port}`] : [])].join(" ");
  try {
    shell.writeShortcutLink(link, existsSync(link) ? "replace" : "create", {
      target: process.execPath,
      args,
      cwd: root,
      icon: ico,
      iconIndex: 0,
      appUserModelId: AUMID,
      description: "Nidavellir — le studio de jeux",
    });
  } catch {
    /* sans raccourci, les notifications portent seulement un nom moins joli */
  }
}

/** Mica (Windows 11 22H2 et plus) ; ailleurs, fond opaque. STUDIO_MATERIAL=none le coupe. */
function material() {
  if (process.platform !== "win32" || process.env.STUDIO_MATERIAL === "none") return "";
  const build = Number(release().split(".")[2] ?? 0);
  return build >= 22621 ? (process.env.STUDIO_MATERIAL ?? "mica") : "";
}

function readOwnPackage() {
  try {
    return JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8"));
  } catch {
    return {};
  }
}

// ── Lancement avec Windows : l'application démarre rangée près de l'horloge ──
function autostartArgs() {
  return [...(app.isPackaged ? [] : [here.replace(/[\\/]$/, "")]), ...(cliPort ? [`--port=${port}`] : []), "--hidden"];
}
function autostart() {
  return app.getLoginItemSettings({ path: process.execPath, args: autostartArgs() }).openAtLogin;
}
function setAutostart(on) {
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: autostartArgs() });
}

// ── Interface à jour : si ses sources ont changé depuis la dernière compilation, on la recompile avant d'ouvrir ──
function newest(dir) {
  let max = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    max = Math.max(max, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return max;
}
function uiStale() {
  const web = join(root, "apps", "web");
  try {
    const built = statSync(join(web, "dist", "index.html")).mtimeMs;
    return Math.max(newest(join(web, "src")), newest(join(web, "public")), statSync(join(web, "index.html")).mtimeMs) > built;
  } catch {
    return true;
  }
}
function splashStatus(text) {
  if (win && win.webContents.getURL().startsWith("file:")) void win.webContents.executeJavaScript(`document.querySelector("p").textContent = ${JSON.stringify(text)}`).catch(() => {});
}
function buildUi() {
  splashStatus("Mise à jour de l'interface…");
  return new Promise((done) => {
    const child = spawn("npm run build", { cwd: root, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => process.stdout.write(d));
    child.on("error", () => done(false));
    child.on("exit", (code) => done(code === 0));
  }).then((ok) => {
    // Échec : on ouvre l'interface déjà compilée s'il y en a une ; sinon le hub le dira.
    if (!ok) console.error("Compilation de l'interface en échec : la version précédente est utilisée.");
    splashStatus("Le studio s'éveille…");
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const { ico, trayImage } = icons();
  startMenuShortcut(ico);
  openWindow(ico);
  createTray(trayImage);
  globalShortcut.register(SHORTCUT, () => (win?.isVisible() && win.isFocused() ? win.hide() : reveal()));

  let url;
  try {
    url = await obtainEntry();
  } catch (err) {
    dialog.showErrorBox("Nidavellir n'a pas pu démarrer", `${err.message}\n\n${logTail.slice(-15).join("\n")}`);
    quitting = true;
    return app.exit(1);
  }
  if (!url) return quit();
  void win?.loadURL(url);
});

/** Adresse à ouvrir : lien de connexion du hub qu'on vient de lancer, ou hub déjà présent. */
async function obtainEntry() {
  while (await portBusy(port)) {
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      title: "Nidavellir",
      message: "Un hub tourne déjà sur ce PC",
      detail:
        "Il a sans doute été lancé avec « npm start ». Fermez-le (Ctrl+C dans sa fenêtre) pour que l'application le prenne en charge, puis cliquez sur Réessayer.\n\n« Ouvrir quand même » l'affiche ici, mais il faudra vous reconnecter avec son lien.",
      buttons: ["Réessayer", "Ouvrir quand même", "Quitter"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 1) return base;
    if (response === 2) return null;
  }
  return startHub();
}

async function startHub() {
  const entry = join(root, "apps", "hub", "src", "main.ts");
  if (!existsSync(entry)) throw new Error(`Le hub est introuvable dans ${root}.\nLe dépôt a-t-il été déplacé ? Lancez Nidavellir avec STUDIO_HUB_ROOT, ou refaites l'installateur depuis le dépôt.`);
  if (uiStale()) {
    if (win?.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));
    await buildUi();
  }
  const logDir = join(app.getPath("userData"), "logs");
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(join(logDir, "hub.log"), { flags: "a" });
  log.write(`\n=== ${new Date().toISOString()} ===\n`);

  const child = spawn(process.env.STUDIO_NODE ?? "node", [entry], {
    cwd: root,
    env: { ...process.env, STUDIO_PORT: String(port), STUDIO_NO_BROWSER: "1", STUDIO_DESKTOP: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  hub = child;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) logTail.push(line), logTail.length > 50 && logTail.shift();
    });
  }
  child.on("message", (m) => m?.type === "notice" && showNotice(m));

  return new Promise((resolveLink, reject) => {
    let ready = false;
    const timer = setTimeout(() => reject(new Error("Le hub ne répond pas après 90 secondes.")), 90_000);
    child.on("message", (m) => {
      if (m?.type !== "ready") return;
      ready = true;
      clearTimeout(timer);
      resolveLink(m.link);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Node introuvable ou inutilisable (${err.message}). Node 24 ou plus doit être installé.`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      hub = null;
      log.end();
      if (quitting) return;
      if (!ready) return reject(new Error(`Le hub s'est arrêté (code ${code}).`));
      // Arrêt après l'ouverture : on le dit au lieu de laisser une fenêtre morte.
      dialog.showErrorBox("Le hub s'est arrêté", `Code ${code}. Journal : ${join(logDir, "hub.log")}\n\n${logTail.slice(-15).join("\n")}`);
      quit();
    });
  });
}

function openWindow(ico) {
  const state = loadState();
  const mat = material();
  const bounds = state.bounds && screen.getAllDisplays().some((d) => intersects(d.workArea, state.bounds)) ? state.bounds : null;
  win = new BrowserWindow({
    ...(bounds ?? { width: 1480, height: 920 }),
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: "Nidavellir",
    icon: ico,
    backgroundColor: mat ? "#00000000" : BG,
    ...(mat ? { backgroundMaterial: mat } : {}),
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#00000000", symbolColor: "#a9aeb8", height: TITLEBAR_H },
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      additionalArguments: [`--nid-material=${mat}`],
    },
  });
  win.webContents.session.setSpellCheckerLanguages(["fr", "en-US"]);
  win.once("ready-to-show", () => {
    if (hidden) return;
    if (state.maximized ?? true) win.maximize();
    win.show();
  });
  win.on("page-title-updated", (e) => e.preventDefault());

  // Place de la fenêtre, gardée pour le prochain lancement.
  let saveTimer = null;
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isMinimized()) return;
      saveState({ maximized: win.isMaximized(), ...(win.isMaximized() || win.isFullScreen() ? {} : { bounds: win.getBounds() }) });
    }, 400);
  };
  for (const ev of ["resize", "move", "maximize", "unmaximize"]) win.on(ev, remember);

  const sameOrigin = (target) => {
    try {
      return new URL(target).origin === base;
    } catch {
      return false;
    }
  };
  // Liens externes (documentation, aperçus de jeux sur un autre port…) : navigateur par défaut.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (sameOrigin(target)) return { action: "allow", overrideBrowserWindowOptions: { backgroundColor: BG, autoHideMenuBar: true, icon: ico } };
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, target) => {
    if (sameOrigin(target)) return;
    e.preventDefault();
    if (/^https?:/.test(target)) void shell.openExternal(target);
  });

  // Sans menu, on garde les raccourcis d'un navigateur : recharger, zoom, plein écran, outils de développement.
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const ctrl = input.control || input.meta;
    const wc = win.webContents;
    const key = input.key.toLowerCase();
    if (input.key === "F5" || (ctrl && key === "r")) wc.reload();
    else if (input.key === "F12" || (ctrl && input.shift && key === "i")) wc.toggleDevTools();
    else if (input.key === "F11") win.setFullScreen(!win.isFullScreen());
    else if (ctrl && (key === "=" || key === "+")) wc.setZoomLevel(wc.getZoomLevel() + 0.5);
    else if (ctrl && key === "-") wc.setZoomLevel(wc.getZoomLevel() - 0.5);
    else if (ctrl && key === "0") wc.setZoomLevel(0);
    else return;
    e.preventDefault();
  });

  // Clic droit : couper, copier, coller, et les corrections d'orthographe (Electron n'en propose aucun seul).
  win.webContents.on("context-menu", (_e, p) => {
    const items = [];
    for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
    if (p.misspelledWord) {
      items.push({ label: "Ajouter au dictionnaire", click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
      items.push({ type: "separator" });
    }
    if (p.linkURL && /^https?:/.test(p.linkURL) && !p.linkURL.startsWith(base)) {
      items.push({ label: "Ouvrir dans le navigateur", click: () => shell.openExternal(p.linkURL) });
      items.push({ type: "separator" });
    }
    if (p.isEditable) {
      items.push({ label: "Couper", role: "cut", enabled: p.editFlags.canCut });
      items.push({ label: "Copier", role: "copy", enabled: p.editFlags.canCopy });
      items.push({ label: "Coller", role: "paste", enabled: p.editFlags.canPaste });
      items.push({ type: "separator" }, { label: "Tout sélectionner", role: "selectAll" });
    } else if (p.selectionText.trim()) {
      items.push({ label: "Copier", role: "copy" });
    } else if (p.mediaType === "image") {
      items.push({ label: "Copier l'image", click: () => win.webContents.copyImageAt(p.x, p.y) });
    }
    while (items.at(-1)?.type === "separator") items.pop();
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  // Fermer la fenêtre la range près de l'horloge : le studio et ses chantiers continuent.
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!loadState().trayHintShown && Notification.isSupported()) {
      new Notification({ title: "Nidavellir continue en arrière-plan", body: "Les chantiers avancent. Retrouvez le studio près de l'horloge, ou avec Ctrl+Alt+N.", icon: ico, silent: true }).show();
      saveState({ trayHintShown: true });
    }
  });
  win.on("closed", () => (win = null));
  void win.loadFile(join(here, "splash.html"));
}

function createTray(image) {
  tray = new Tray(image);
  tray.setToolTip("Nidavellir");
  tray.on("click", () => (win?.isVisible() && win.isFocused() ? win.hide() : reveal()));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Ouvrir Nidavellir", click: () => reveal() },
      { label: "Rechercher…", click: () => palette() },
      { type: "separator" },
      { label: "Le studio en direct", click: () => go("#/direct") },
      { label: "Pilotage", click: () => go("#/pilotage") },
      { type: "separator" },
      { label: "Lancer avec Windows", type: "checkbox", checked: autostart(), click: (item) => setAutostart(item.checked) },
      { type: "separator" },
      { label: "Quitter Nidavellir", click: () => quit() },
    ]),
  );
}

function reveal() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function go(hash) {
  reveal();
  if (win && hash.startsWith("#")) void win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
}

function palette() {
  reveal();
  void win?.webContents.executeJavaScript('window.dispatchEvent(new Event("studio:palette"))').catch(() => {});
}

function quit() {
  quitting = true;
  app.quit();
}

/** Notification Windows pour un avis du hub, quand la fenêtre n'est pas sous vos yeux. Un clic mène au bon endroit. */
function showNotice(n) {
  const watching = Boolean(win?.isVisible() && win.isFocused() && !win.isMinimized());
  if ((watching && n.tag !== "test") || !Notification.isSupported()) return;
  if (n.tag) notices.get(n.tag)?.close();
  const note = new Notification({ title: n.title, body: n.body, silent: false });
  note.on("click", () => go(n.url || "#/"));
  note.on("close", () => n.tag && notices.get(n.tag) === note && notices.delete(n.tag));
  if (n.tag) notices.set(n.tag, note);
  note.show();
  if (!watching) win?.flashFrame(true);
}

app.on("browser-window-focus", () => win?.flashFrame(false));
app.on("before-quit", () => (quitting = true));
app.on("window-all-closed", () => {
  if (quitting) app.quit();
});

// Arrêt propre du hub (même chemin que Ctrl+C), puis arrêt forcé de son arbre s'il traîne.
app.on("will-quit", (e) => {
  quitting = true;
  globalShortcut.unregisterAll();
  if (!hub) return;
  e.preventDefault();
  tray?.destroy();
  tray = null;
  const child = hub;
  const force = setTimeout(() => killTree(child.pid), 15_000);
  child.once("exit", () => {
    clearTimeout(force);
    hub = null;
    app.quit();
  });
  try {
    child.send({ type: "shutdown" });
  } catch {
    killTree(child.pid);
  }
});

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  else process.kill(pid, "SIGKILL");
}

function intersects(a, b) {
  return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
}

function portBusy(p) {
  return new Promise((done) => {
    const sock = createConnection({ host: "127.0.0.1", port: p });
    sock.once("connect", () => (sock.destroy(), done(true)));
    sock.once("error", () => done(false));
  });
}
