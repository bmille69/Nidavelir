import { useCallback, useEffect, useState } from "react";
import { api, type Device, type RemoteStatus, type SessionInfo } from "../api.ts";
import { formatDate } from "../pages/labels.ts";
import { ago } from "./agents.ts";
import { useNow } from "./context.tsx";
import { currentSubscription, disablePush, enablePush, needsHomeScreen, pushSupported } from "./push.ts";

/**
 * Page « Téléphone » (ADR-30) : accès depuis partout avec Tailscale, connexion d'un téléphone
 * par code, appareils connectés, notifications.
 */
export function PhoneView({ session }: { session: SessionInfo }) {
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useCallback(() => api.remoteStatus().then(setRemote, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    void check();
  }, [check]);

  async function act(fn: () => Promise<RemoteStatus>) {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      setRemote(r);
      if (r.link) window.open(r.link, "_blank");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const url = remote?.url ?? null;
  return (
    <main className="studio-page phone">
      <header className="studio-hero">
        <div>
          <h1>Téléphone</h1>
          <p className="hero-sub">
            Votre PC reste le studio ; le téléphone devient une télécommande. Le PC doit rester allumé (sans veille) avec le hub lancé.
          </p>
        </div>
      </header>
      {error && <p className="error">{error}</p>}

      {!session.device && (
        <section className="panel-card step">
          <h2>
            <span className="step-n">1</span> Accès depuis partout, avec Tailscale
          </h2>
          {!remote && <p className="muted">Vérification…</p>}
          {remote?.tailscale === "absent" && (
            <>
              <p>Tailscale relie vos appareils par un réseau privé chiffré : le hub reste invisible depuis Internet.</p>
              <ol className="steps-explained">
                <li>
                  Sur ce PC : installez Tailscale depuis{" "}
                  <a href="https://tailscale.com/download/windows" target="_blank" rel="noreferrer">
                    tailscale.com/download
                  </a>{" "}
                  et connectez-vous (compte Google, Microsoft ou GitHub).
                </li>
                <li>Sur le téléphone : installez l'application Tailscale et connectez-vous avec le même compte.</li>
                <li>Revenez ici et cliquez « Vérifier ».</li>
              </ol>
            </>
          )}
          {remote?.tailscale === "stopped" && <p>{remote.message}</p>}
          {remote?.tailscale === "ready" && !remote.serving && (
            <>
              <p>
                Tailscale est prêt sur ce PC (<code>{remote.dnsName}</code>). Il reste à publier le hub dans votre réseau Tailscale (en HTTPS, visible seulement par vos appareils).
              </p>
              <button disabled={busy} onClick={() => act(api.remoteEnable)}>
                {busy ? "Publication…" : "Publier le hub dans mon réseau Tailscale"}
              </button>
            </>
          )}
          {remote?.serving && url && (
            <>
              <p className="remote-url">
                ✓ Le hub est accessible depuis vos appareils à l'adresse <a href={url}>{url}</a>
              </p>
              <button className="secondary small" disabled={busy} onClick={() => act(api.remoteDisable)}>
                Arrêter la publication
              </button>
            </>
          )}
          {remote?.message && remote.tailscale === "ready" && <p className="notice small">{remote.message}{remote.link && <> — <a href={remote.link} target="_blank" rel="noreferrer">ouvrir la page Tailscale</a></>}</p>}
          {remote?.tailscale !== "ready" && (
            <button className="secondary" disabled={busy} onClick={() => void check()}>
              Vérifier
            </button>
          )}
        </section>
      )}

      {!session.device && <Pairing url={url} />}
      <Devices />
      <Notifications />
    </main>
  );
}

function Pairing({ url }: { url: string | null }) {
  const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(1000);
  const left = code ? Math.max(0, Math.round((Date.parse(code.expires_at) - now) / 1000)) : 0;
  const address = `${url ?? window.location.origin}/login`;
  return (
    <section className="panel-card step">
      <h2>
        <span className="step-n">2</span> Connecter un téléphone
      </h2>
      <ol className="steps-explained">
        <li>
          Sur le téléphone (Tailscale allumé), ouvrez <code>{address}</code>
        </li>
        <li>Saisissez le code ci-dessous. Le téléphone restera connecté ; vous pourrez le déconnecter d'ici.</li>
      </ol>
      {code && left > 0 ? (
        <div className="pair-code">
          <b>{code.code.replace(/(\d{3})(\d{3})/, "$1 $2")}</b>
          <span className="muted small">
            valable encore {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
          </span>
        </div>
      ) : (
        <button
          onClick={() =>
            api.pairingCode().then(
              (c) => {
                setCode(c);
                setError(null);
              },
              (e: Error) => setError(e.message),
            )
          }
        >
          {code ? "Afficher un nouveau code" : "Afficher un code"}
        </button>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

function Devices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const now = useNow(30_000);
  const load = useCallback(() => api.devices().then(setDevices, () => {}), []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);
  return (
    <section className="panel-card step">
      <h2>
        <span className="step-n">3</span> Appareils connectés
      </h2>
      {devices.length === 0 && <p className="muted small">Aucun téléphone connecté pour l'instant.</p>}
      <ul className="device-list">
        {devices.map((d) => (
          <li key={d.id}>
            <div className="grow">
              <strong>
                {d.name}
                {d.current && <span className="badge">cet appareil</span>}
              </strong>
              <span className="muted small">
                connecté le {formatDate(d.created_at)} · vu {ago(d.last_seen, now)}
              </span>
            </div>
            <button
              className="secondary danger small"
              onClick={async () => {
                if (!window.confirm(`Déconnecter « ${d.name} » ? Il devra saisir un nouveau code pour revenir.`)) return;
                await api.revokeDevice(d.id);
                await load();
              }}
            >
              Déconnecter
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Notifications() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const supported = pushSupported();
  useEffect(() => {
    currentSubscription().then((s) => setOn(!!s), () => setOn(false));
  }, []);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setOn(!!(await currentSubscription()));
      setMsg(done);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel-card step">
      <h2>
        <span className="step-n">4</span> Notifications sur cet appareil
      </h2>
      <p className="muted small">Chantier prêt à essayer ou en échec, plan ou autorisation qui vous attend, Concepteur qui attend vos réponses.</p>
      {window.nidavellir?.desktop ? (
        <div className="row">
          <span className="badge status-ok">Notifications Windows</span>
          <span className="muted small">Dans l'application, elles sont toujours actives quand la fenêtre n'est pas au premier plan.</span>
          <button className="secondary small" disabled={busy} onClick={() => run(api.pushTest, "Notification de test envoyée.")}>
            Envoyer un test
          </button>
        </div>
      ) : !supported ? (
        <p className="notice small">
          {!window.isSecureContext
            ? "Les notifications demandent une adresse sécurisée : ouvrez le hub par son adresse Tailscale (https://…)."
            : needsHomeScreen()
              ? "Sur iPhone : touchez « Partager » puis « Sur l'écran d'accueil », ouvrez le hub depuis cette icône, puis revenez ici."
              : "Ce navigateur ne gère pas les notifications web."}
        </p>
      ) : (
        <div className="row">
          {on ? (
            <>
              <span className="badge status-ok">Activées</span>
              <button className="secondary small" disabled={busy} onClick={() => run(api.pushTest, "Notification de test envoyée.")}>
                Envoyer un test
              </button>
              <button className="secondary danger small" disabled={busy} onClick={() => run(disablePush, "Notifications désactivées sur cet appareil.")}>
                Désactiver
              </button>
            </>
          ) : (
            <button disabled={busy || on === null} onClick={() => run(enablePush, "Notifications activées.")}>
              Activer les notifications
            </button>
          )}
        </div>
      )}
      {msg && <p className="small">{msg}</p>}
    </section>
  );
}
