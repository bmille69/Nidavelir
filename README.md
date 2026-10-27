# Nidavellir : Game Studio Hub (projet « Ambition »)

Studio personnel de développement de jeux vidéo assisté par IA, pour **un seul utilisateur sous Windows**, qui reste **directeur créatif et décideur final**. Le hub (un processus Node local) fait travailler une équipe d'agents sur vos jeux, sous son contrôle : c'est lui qui applique les règles, pas les consignes données aux modèles.

> État au 27/10/2026 : phases 1 et 2 de la [feuille de route](docs/ROADMAP.md) terminées, puis une soixantaine de décisions nées de l'usage réel (ADR-19 à ADR-80). Trois jeux pilotés (Survivor Destiny et Bordée en web, Néon Saloon sous Godot), 186 chantiers fusionnés. Le détail de chaque choix est dans [docs/DECISIONS.md](docs/DECISIONS.md).

## L'équipe

| Agent | Rôle | Ce que le hub lui permet |
|---|---|---|
| **Concepteur** | Idée floue → dossier de conception complet, choix de la technologie, chantiers de la première version jouable (ADR-28, 73, 74) | Recherche web en lecture seule, aucun fichier |
| **Directeur** | Chef de projet et lead game designer au quotidien ; rédige les consignes de chantier (« go ») (ADR-24) | Lecture de `CLAUDE.md` et de la liste des fichiers |
| **Développeur** | Réalise un chantier dans une copie isolée (worktree Git) (ADR-04, 25, 26) | Claude Code filtré par le **Gardien** (hook + outil de permission) |
| **Testeur** | Vérifie le chantier et **joue au jeu** (web dans Edge, ou le vrai Godot via un relais) avant de donner son avis (ADR-69, 73) | Lecture, commandes de test, outil « jouer » |
| **Directeur artistique** | Visuels : images, planches, 3D Tripo + atelier Blender, intégration et bilan dans le jeu (ADR-43 à 71, 79, 80) | Ses outils seulement, crédits Tripo comptés et plafonnés |
| **Archéologue** | Atelier de démontage de jeux du commerce (Godot, Unity) pour s'en inspirer (ADR-40, 42, 45) | Lecture seule |

Autour d'eux : une file de chantiers fusionnés automatiquement en atelier (ADR-31), un poste de **Pilotage** (ADR-68), une page **Qualité** fondée sur des faits (ADR-27, 32), des **compétences** par agent (ADR-29, 78), le **téléphone** via Tailscale avec notifications (ADR-30), le **Jeu express** (ADR-44) et un **studio de modding** pour vos jeux Steam (ADR-65).

## Lancer le studio

```powershell
cd C:\Games\Ambition
npm install        # la première fois
npm start          # compile l'interface puis lance le hub sur http://127.0.0.1:4317
```

Le navigateur s'ouvre sur un **lien de connexion à usage unique**, également affiché dans le terminal. Arrêt : `Ctrl+C`.
Les appels aux modèles passent par votre Claude Code (votre abonnement). Godot est trouvé tout seul (bureau, téléchargements) ou via `STUDIO_GODOT`.

Variables facultatives :
- serveur : `STUDIO_PORT`, `STUDIO_GAMES_ROOT` (défaut `C:\Games`), `STUDIO_DATA_DIR` (défaut `.data`), `STUDIO_NO_BROWSER=1` ;
- modèles : `STUDIO_MODEL_CHAT`, `STUDIO_MODEL_STRUCTURED`, `STUDIO_MODEL_CONCEPT`, `STUDIO_MODEL_DEV`, `STUDIO_MODEL_DEV_BIG`, `STUDIO_MODEL_QA`, `STUDIO_MODEL_ART`, `STUDIO_MODEL_ARCHEOLOGUE` (ils se règlent aussi dans « Le studio en direct ») ;
- 3D : `STUDIO_TRIPO_MODEL`, `STUDIO_TRIPO_MULTIVIEW_MODEL`, `STUDIO_TRIPO_MONTHLY_CREDITS` ; plafond par visuel `STUDIO_ART_ASSET_USD` (défaut 6) et `STUDIO_ART_ASSET_CREDITS` (défaut 250). Les clés des services se saisissent dans l'interface.

## Développement

Prérequis : Node.js 24 et Git (voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §1) ; Blender et Godot pour les tests qui les utilisent.

```powershell
npm test           # suite Vitest (dépôts Git temporaires, orchestrateur factice : aucun appel à un LLM)
npm run typecheck  # backend et interface
npm run build && npm run test:e2e   # parcours dans Edge (headless) et le vrai Godot, captures dans .data/screenshots
```

| Dossier | Contenu |
|---|---|
| `packages/contracts` | Schémas Zod partagés : items, approbations, événements, projets, tâches |
| `apps/hub/src/vision`, `approvals`, `journal` | Bible du jeu (`studio/`), validations humaines liées au hash, journal en ajout seul |
| `apps/hub/src/conversation`, `conception` | Discussions avec le directeur, le Concepteur et son dossier |
| `apps/hub/src/executor` | Chantiers : `TaskService`, `PolicyEngine` (le Gardien), lanceur Claude Code, aperçu « ▶ Essayer », progression |
| `apps/hub/src/autonomy` | File de chantiers, fusion automatique, carnet « État du jeu » |
| `apps/hub/src/quality` | Contrôles du hub (tests, lancement, photo), manette du testeur, tableau Qualité |
| `apps/hub/src/godot` | Godot : outillage, socle d'un nouveau jeu, tests StudioTest, relais du testeur |
| `apps/hub/src/art` | Directeur artistique : images, Tripo, atelier Blender (`blender/workshop.py`), carnet Tripo, bilan |
| `apps/hub/src/reverse`, `express`, `mods` | Atelier de démontage, Jeu express, studio de modding |
| `apps/hub/src/skills`, `usage`, `remote` | Compétences des agents, compteur d'utilisation, téléphone et notifications |
| `apps/hub/src/server`, `auth`, `projects`, `vcs` | Serveur HTTP local (Host, cookie, CSRF), registre et isolation des jeux, Git |
| `apps/web` | Interface React : accueil, Pilotage, discussions, chantiers, DA, galerie, qualité… |

## Principes directeurs

| Principe | Conséquence concrète |
|---|---|
| L'humain décide | Les autorisations du Gardien et l'import d'un projet ne se délèguent jamais ; la fusion automatique en atelier est votre choix (ADR-31). |
| Le hub impose, les agents proposent | Permissions, périmètre, budgets et contrôles sont appliqués par le code du hub. |
| Des faits plutôt que des avis | Tests, lancement, photo, fichiers chargés : le hub mesure ; le testeur dit ce qu'il n'a pas vérifié. |
| La mémoire vit dans le jeu | Bible, conception, visuels et captures sont dans `studio/` du dépôt de chaque jeu, versionnés par Git. |
| Pas de sur-ingénierie | Un processus, une base SQLite, des fichiers texte, une interface web locale. |

## Documentation

| Document | Contenu |
|---|---|
| [docs/DECISIONS.md](docs/DECISIONS.md) | **Toutes** les décisions (ADR-01 et suivantes), avec ce qui a été vérifié |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phases, état réel et prochains chantiers du studio |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Audit initial de l'environnement, composants, flux |
| [docs/VISION_ENGINE.md](docs/VISION_ENGINE.md) | Modèle de données de la bible (items, statuts, liens) |
| [docs/AGENT_CONTRACTS.md](docs/AGENT_CONTRACTS.md) | Rôles, droits et formats d'échange |
| [docs/SECURITY.md](docs/SECURITY.md) | Modèle de menaces, niveaux de permission, injections de consignes |
