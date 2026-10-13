# Architecture

Ce document présente l'état réel de l'environnement (audit du 13/10/2026), l'architecture proposée et les responsabilités de chaque composant. Les décisions associées sont numérotées `ADR-xx` dans [DECISIONS.md](DECISIONS.md).

---

## 1. Audit de l'environnement

Toutes les informations ci-dessous ont été **vérifiées par commande** sur la machine. Aucun secret n'a été lu : seuls les noms de variables et les clés de configuration non sensibles ont été inspectés.

### 1.1 Système et outils

| Élément | Constat | Impact |
|---|---|---|
| OS | Windows 11 Pro 10.0.26200, 64 bits | Cible unique. Chemins Windows, PowerShell et Git Bash disponibles. |
| Matériel | Ryzen 5 5600X, 32 Go de RAM, environ 350 Go libres sur C: | Largement suffisant. Aucun modèle local n'est prévu. |
| Git | 2.40.0.windows.1, `user.name` et `user.email` configurés, `core.autocrlf` et `init.defaultBranch` non définis | Utilisable. Une mise à jour est conseillée mais pas bloquante. Il faudra fixer la gestion des fins de ligne dans chaque dépôt (`.gitattributes`). |
| Node.js / npm | v24.19.0 / 11.17.0 | Suffisant pour le frontend **et** un backend TypeScript. `node:sqlite` fonctionne (SQLite 3.53.3), testé. |
| pnpm, yarn, bun | Absents | Non nécessaires : npm suffit. |
| .NET | SDK **9.0.300** uniquement. Runtimes ASP.NET Core 8.0.16 et 9.0.5. | .NET 9 est une version STS dont le support se termine le **10/11/2026**, à confirmer. Un backend C# exigerait d'installer le SDK .NET 10 (LTS). |
| Python | 3.10.9 (et 3.7 32 bits), uv 0.11.28 | Non requis par le hub. Hermes embarque son propre Python 3.14. |
| Java | 1.8.0_51 | Sans objet. |
| VS Code | 1.38.1 (ancienne version) | Sans objet pour le hub. |
| WSL | **Non installé** | Hermes est utilisable en natif Windows, donc WSL n'est pas nécessaire. |
| Docker | **Absent** | Pas d'isolation par conteneur disponible. L'isolation reposera sur les worktrees Git et le filtrage des permissions (voir SECURITY.md). |
| tmux | **Absent** | Le mode « PTY interactif via tmux » du skill `claude-code` d'Hermes est inutilisable sous Windows. |
| GitHub CLI (`gh`) | Absent | Le MVP fonctionne entièrement en local. |
| sqlite3 (CLI) | Absent | Non nécessaire, car `node:sqlite` est intégré à Node. |

### 1.2 Claude Code

| Élément | Constat |
|---|---|
| Version | 2.1.296, dans `~/.local/bin/claude` |
| Authentification | Connecté via OAuth (fichier d'identifiants présent mais non lu). `ANTHROPIC_API_KEY` non définie. |
| Mode non interactif | **Testé** : `claude -p … --output-format json` renvoie un JSON structuré (`result`, `session_id`, `permission_denials`, `total_cost_usd`, `num_turns`…). |
| Options utiles au hub (vérifiées dans `--help`) | `--output-format stream-json`, `--input-format stream-json`, `--json-schema` (sortie structurée validée), `--permission-mode`, `--permission-prompt-tool` (délègue chaque demande de permission à un outil MCP), `--allowedTools` / `--disallowedTools` / `--tools`, `--mcp-config` + `--strict-mcp-config`, `--settings`, `--add-dir`, `--session-id` / `--resume`, `--max-turns`, `--append-system-prompt`, `-w/--worktree`, `--bare` |
| Serveurs MCP | Un seul : connecteur claude.ai Claude Docs. Aucun serveur MCP local. |
| Agent SDK | Le paquet `@anthropic-ai/claude-agent-sdk` existe sur npm (0.3.296). Il n'est pas installé. |
| Réglages | `settings.json` sans permissions globales ni mode de contournement. C'est conforme. |

### 1.3 Hermes Agent

| Élément | Constat |
|---|---|
| Installation | **Présent** dans `%LOCALAPPDATA%\hermes\`, installé le 13/10/2026. `hermes.cmd` est dans le PATH utilisateur, mais un terminal ouvert avant l'installation ne le voit pas. |
| Version | `Hermes Agent v0.21.7+500.g8f81791 (2026.9.24)`, canal stable, installation via Git, Python 3.14.7 |
| État | Le fichier `.hermes-update-in-progress` vu lors du premier audit a disparu : la mise à jour est terminée. `hermes status` : modèle `claude-opus-5-5`, fournisseur Anthropic, passerelle arrêtée. |
| Fournisseur de modèle | Lors du premier audit, aucune clé n'était configurée. Depuis, Hermes utilise **votre connexion OAuth Claude Code** (`auth_type: oauth`, `source: claude_code`), reprise via `adopt_external_logins: true`. **Cet usage n'est pas conforme aux conditions d'Anthropic** (voir DECISIONS, ADR-11). |
| Sessions, mémoire | 0 session. Mémoire activée (`memory_enabled`, `user_profile_enabled`) avec des relances automatiques (`nudge_interval: 10`). |
| Approbations | Aucune section `approvals` dans la configuration, donc **mode par défaut `smart`** : un LLM auxiliaire auto-approuve les commandes jugées peu risquées. |
| Terminal | Backend `local`, sans isolation. |
| Skills | 12 catégories intégrées, dont `autonomous-ai-agents/claude-code` (v2.2.1). Ce skill pilote Claude Code via le terminal (`claude -p`, ou tmux). Ses consignes relèvent que le mode `-p` « ignore tous les dialogues interactifs ». L'auto-création de skills est active (`skill_manage`). `skills.write_approval` n'est pas activé. |
| Capacités documentées et vérifiées dans `--help` | Serveur API local (`hermes gateway`, `127.0.0.1:8642`, jeton obligatoire) avec les endpoints `/v1/runs` (événements, arrêt, **approbation**), `/api/sessions/*`, `/v1/responses`. Client MCP (stdio/HTTP) et serveur MCP (`hermes mcp serve`). Délégation (`delegate_task`, enfants isolés, `output_schema`, profondeur 1 par défaut). Profils isolés (`hermes profile create`). Activation et désactivation des outils (`hermes tools enable/disable`). Kanban, projets, ACP, dashboard. |
| Sécurité Hermes | Liste de blocage non contournable, protection de certains chemins, analyse des fichiers de contexte contre les injections (heuristique). La doc précise que **le terminal peut contourner les protections d'écriture** : ce n'est pas un bac à sable. |

**Conclusion de l'audit sur Hermes.** Hermes possède les briques nécessaires à un rôle d'orchestrateur : sessions persistantes, API locale avec flux d'événements, délégation à schéma de sortie, client MCP, profils et désactivation d'outils. En revanche :

- il doit passer sur une clé API (ou un autre fournisseur) avant d'être intégré (ADR-11) ;
- son intégration native avec Claude Code (skill `claude-code`) passe par son propre terminal, **hors du contrôle du hub**. Elle est incompatible avec l'exigence d'une validation humaine réellement imposée.

D'où le rôle retenu : **Hermes réfléchit et coordonne, mais n'agit que via les outils MCP du hub** (ADR-03).

### 1.4 Moteurs et outils créatifs

| Outil | Constat |
|---|---|
| Godot | `Godot_v4.6.2-stable_win64.exe` sur le Bureau (version standard GDScript, sans .NET). Le mode `--headless` fonctionne. Dossiers de données présents (`AppData\Local\Godot`, `AppData\Roaming\Godot`). Pas dans le PATH. |
| Blender | **Non trouvé** (recherche sur le profil, Program Files et C:\Games). |
| Autres moteurs | Aucun détecté. |

### 1.5 Dossier du projet et jeux existants

`C:\Games\Ambition` était vide et **n'est pas un dépôt Git**.

Dans `C:\Games`, on trouve aussi : `survivor_destiny` (Destiny Survivor), `assistant perso`, `ft`, `test2` et `toX`. **`survivor_destiny` n'est pas un projet Godot** : c'est un jeu web en TypeScript (Vite, Vitest, Playwright). Le dépôt Git est actif (dernier commit le 13/10/2026), il contient un `CLAUDE.md` de 12 Ko et des documents de conception (`docs/architecture.md`, `docs/balance-decisions.md`, `docs/prototype-analysis.md`). Le hub doit donc être **agnostique du moteur** dès la phase 1 ; l'intégration Godot reste prévue en phase 5.

---

## 2. Vue d'ensemble

Un seul processus backend local (Node.js/TypeScript) sert l'API, l'interface web et un serveur MCP. Le moteur de vision et le contrôle d'exécution vivent dans ce processus. Hermes et Claude Code sont des **processus externes**, accédés uniquement par des adaptateurs.

```
┌──────────────────────────── Navigateur (localhost) ───────────────────────────┐
│  Frontend React + TS : Dashboard · Conversation · Vision · Inbox · Tâches     │
└──────────────┬────────────────────────────────────────────────────────────────┘
               │ HTTP + SSE (127.0.0.1, cookie de session humaine + CSRF)
┌──────────────▼──────────────── Hub backend (1 processus Node) ────────────────┐
│  API HTTP ──▶ Services du domaine                                             │
│               ├─ ProjectService    (registre, isolation des répertoires)      │
│               ├─ ConversationSvc   (fils, modes exploration / décision)       │
│               ├─ VisionService     (items, statuts, liens, révisions)         │
│               ├─ CoherenceService  (conflits, impacts, obsolescence)          │
│               ├─ TaskService       (tâches, plans, cycle de vie)              │
│               ├─ ApprovalService   (validations humaines, liées à un hash)    │
│               ├─ PolicyEngine      (périmètres, niveaux de permission)        │
│               └─ Journal           (événements append-only)                   │
│  Serveur MCP « studio » (outils pour agents, droits par rôle)                 │
│  Ports et adaptateurs :                                                       │
│    OrchestratorPort ─▶ HermesAdapter (API :8642)  | DirectClaudeAdapter       │
│    ExecutorPort     ─▶ ClaudeCodeCliAdapter (claude -p, stream-json)          │
│    VcsPort          ─▶ GitAdapter (git CLI)                                   │
│    EnginePort       ─▶ GodotAdapter (headless)  [phase 5]                     │
│  Stockage : SQLite (.data/hub.db) + fichiers studio/ de chaque jeu            │
└───────────────────────────────────────────────────────────────────────────────┘
        │ MCP (outils du hub)                          │ sous-processus
┌───────▼──────────┐                         ┌─────────▼──────────────────────┐
│ Hermes (profil   │                         │ Claude Code CLI                │
│ « studio »)      │                         │ cwd = worktree de la tâche     │
│ sans terminal ni │                         │ permissions → outil MCP du hub │
│ écriture fichier │                         │ (--permission-prompt-tool)     │
└──────────────────┘                         └────────────────────────────────┘
```

## 3. Composants et responsabilités

### 3.1 Frontend (React + TypeScript + Vite)

- Il présente l'état et recueille les décisions. **Il ne contient aucune logique métier.**
- Écrans du MVP : liste des projets ; conversation (avec bascule exploration/décision) ; **Inbox de clarification** (éléments extraits à trier, propositions à valider, conflits à arbitrer) ; vue Vision (canon et brouillons, historique) ; tâches (plan, validation, suivi en direct, diff, résultat).
- Les boutons « Valider / Refuser / Annuler » sont les **seuls déclencheurs** des transitions humaines.

### 3.2 Backend (Node.js 24 + TypeScript, Fastify)

- Il porte toute la logique : machine à états des items et des tâches, validations, politique de permissions, journal.
- Les schémas de données sont définis une seule fois (Zod) et partagés par l'API, le serveur MCP, la validation des sorties LLM (`--json-schema`, `output_schema` d'Hermes) et le frontend.
- Il écoute **uniquement sur 127.0.0.1**.

### 3.3 Stockage

| Donnée | Lieu | Pourquoi |
|---|---|---|
| Vision, décisions, spécifications d'un jeu | `<jeu>/studio/**/*.md` (Markdown + en-tête YAML), versionné par Git | Lisible par vous et par Claude Code, diffable, historique Git gratuit, voyage avec le jeu. |
| Index des items et des liens | SQLite, **reconstructible** à partir des fichiers | Recherche rapide (FTS5) et parcours du graphe d'impacts. |
| Opérationnel : projets, conversations, messages, tâches, runs, validations, journal | SQLite `.data/hub.db` (ignoré par Git) | Données transactionnelles, pas faites pour être lues à la main. |
| Sorties brutes des runs (stream-json, logs) | `.data/runs/<run-id>/` | Volumineux, consultables au besoin. |

SQLite est utilisée via `node:sqlite` (intégré, testé), ce qui évite toute dépendance native à compiler.

### 3.4 Orchestrateur : `OrchestratorPort`

Interface minimale et indépendante d'Hermes :

```ts
interface OrchestratorPort {
  openSession(projectId, role): Promise<SessionRef>
  sendTurn(session, userMessage, contextPack): AsyncIterable<OrchestratorEvent>
  delegate(session, subtasks: DelegatedTask[]): Promise<DelegationResult[]>
  cancel(session | runId): Promise<void>
}
```

- **HermesAdapter** : profil Hermes dédié `studio`, appelé via l'API locale (`/api/sessions`, `/v1/runs` + événements). Les outils terminal, fichiers, navigateur et `cronjob` sont désactivés. Le seul outil d'action est le serveur MCP `studio` du hub. Les spécialistes sont des sous-agents (`delegate_task` avec `output_schema`) ou des sessions de rôle distinctes, selon les tests de la phase 3.
- **DirectClaudeAdapter** : Claude Code en mode `-p` sans outil de fichiers (`--tools ""`), avec uniquement le MCP `studio` (`--strict-mcp-config`), une invite système de rôle et une sortie `--json-schema`. Il **fonctionne dès aujourd'hui** (vérifié) et sert de solution de repli et de référence de test.

Le hub ne réimplémente pas la boucle d'agent, la délégation ni la gestion de session : il les consomme. Il réimplémente seulement **ce qu'Hermes ne doit pas posséder** : la vision officielle, les validations et le contrôle d'exécution.

### 3.5 Exécuteur : `ExecutorPort` → Claude Code CLI

Pour chaque tâche validée :

1. création d'un worktree Git `<jeu>/.worktrees/T-xxxx` sur la branche `studio/T-xxxx` ;
2. lancement de `claude -p` avec `cwd` = worktree, `--output-format stream-json`, `--permission-mode default`, `--allowedTools` dérivé du plan validé, et `--permission-prompt-tool mcp__studio__permission_gate`. Toute action hors liste est donc **arbitrée par le hub** : autorisation si elle est couverte par le plan, sinon escalade vers vous ;
3. un `--settings` dédié ajoute un hook `PreToolUse` en défense en profondeur (refus d'écrire dans `studio/` et hors du worktree) ;
4. l'événementiel est relayé en direct dans l'UI ; à la fin : diff, rapport, tests ; vous choisissez **fusionner / demander une correction / abandonner**.

Le choix du CLI plutôt que de l'Agent SDK est expliqué dans l'ADR-04. Le comportement exact de `--permission-prompt-tool` sera validé par un test préliminaire au début de la phase 2.

### 3.6 Serveur MCP « studio »

C'est l'interface unique entre les agents et le hub. Il est exposé en stdio pour Claude Code et en HTTP local avec jeton pour Hermes. Chaque connexion est liée à `{projectId, role, runId}`, ce qui détermine les outils visibles (matrice dans [AGENT_CONTRACTS.md](AGENT_CONTRACTS.md)). **Aucun outil ne permet de valider une décision, d'approuver un plan ou d'élargir ses propres droits.**

### 3.7 Git

- Chaque jeu est un dépôt Git distinct ; le hub en est un autre.
- Le hub commite les changements de `studio/` après chaque validation (message `vision: D-0012 validated (…)`). L'historique Git devient ainsi l'historique des décisions.
- Le travail des agents se fait toujours sur une branche ou un worktree, jamais directement sur `main`.

## 4. Flux principaux

**A. Exploration** : message → réponse du directeur + extraction asynchrone d'éléments candidats (statut `captured`) → Inbox. Aucune écriture dans le canon.

**B. Décision** : candidats choisis → le directeur formule une proposition (options, impacts, conflits) → vous validez → le hub crée `D-xxxx`, met à jour les fichiers, commite, recalcule les impacts.

**D. Import d'un projet existant (ADR-12)** : « Parcourir… » (boîte de dialogue Windows ouverte par le backend) ou chemin collé, ou un dossier suggéré parmi ceux de `C:\Games` qui contiennent un `.git` → **analyse en lecture seule** (moteur, état Git, documents) → écran de confirmation listant ce qui sera créé (`studio/` uniquement) → création et `git commit -- studio/` → amorçage : extraction des documents existants en items `captured` dans l'Inbox. Si le dossier n'est pas un dépôt Git, le hub propose `git init`, sans le faire d'office.

**C. Exécution** : décision ou spécification → tâche → plan (run en lecture seule) → votre validation, liée au hash du plan → exécution dans un worktree sous contrôle des permissions → rapport, diff et QA → fusion ou abandon.

## 5. Arborescence cible

```
C:\Games\Ambition\            (dépôt du hub)
  apps/web/                   frontend React
  apps/hub/                   backend Fastify + serveur MCP
  packages/contracts/         schémas Zod partagés
  docs/
  .data/                      hub.db, runs/  (gitignore)

<racine des jeux>\<slug>\     (un dépôt par jeu)
  studio/
    project.yaml              identité, moteur, périmètre autorisé
    vision.md                 pitch et piliers (items de type vision)
    items/D-0001.md …         un fichier par item structuré
    BRIEF.md                  synthèse générée, lecture seule, pour les agents
  …code du jeu…
  .worktrees/                 (gitignore) worktrees des tâches
```

## 6. Ce qui est volontairement exclu

Microservices, file de messages, base vectorielle (la recherche plein texte FTS5 et les liens explicites suffisent au volume d'un studio solo), système de plugins, agents qui tournent en permanence, Docker, accès réseau entrant, multi-utilisateur.
