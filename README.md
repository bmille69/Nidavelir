# Nidavellir : Game Studio Hub (projet « Ambition »)

*English overview: [README.en.md](README.en.md)*

Studio personnel de développement de jeux vidéo assisté par IA, pour **un seul utilisateur sous Windows**, qui reste **directeur créatif et décideur final**. Le hub (un processus Node local) fait travailler une équipe d'agents sur vos jeux, sous son contrôle : c'est lui qui applique les règles, pas les consignes données aux modèles.

> État au 27/10/2026 : phases 1 et 2 de la [feuille de route](docs/ROADMAP.md) terminées, puis une soixantaine de décisions nées de l'usage réel (ADR-19 à ADR-80), et la phase 6 « le studio mesure le jeu » (ADR-81 à ADR-91). Trois jeux pilotés (Survivor Destiny et Bordée en web, Néon Saloon sous Godot), 186 chantiers fusionnés. Le détail de chaque choix est dans [docs/DECISIONS.md](docs/DECISIONS.md).

## L'équipe

| Agent | Rôle | Ce que le hub lui permet |
|---|---|---|
| **Concepteur** | Idée floue → dossier de conception complet, choix de la technologie, chantiers de la première version jouable (ADR-28, 73, 74) | Recherche web en lecture seule, aucun fichier |
| **Directeur** | Chef de projet et lead game designer au quotidien ; rédige les consignes de chantier (« go ») (ADR-24) | Lecture de `CLAUDE.md` et de la liste des fichiers |
| **Développeur** | Réalise un chantier dans une copie isolée (worktree Git) (ADR-04, 25, 26) | Claude Code filtré par le **Gardien** (hook + outil de permission) |
| **Testeur** | Vérifie le chantier et **joue au jeu** (web dans Edge, ou le vrai Godot via un relais) avant de donner son avis (ADR-69, 73) | Lecture, commandes de test, outil « jouer » |
| **Directeur artistique** | Visuels : images, planches, 3D Tripo + atelier Blender, intégration et bilan dans le jeu (ADR-43 à 71, 79, 80) | Ses outils seulement, crédits Tripo comptés et plafonnés |
| **Directeur sonore** | Effets, ambiances et musiques : il propose, vous écoutez des essais ElevenLabs et choisissez, un chantier les branche, le hub vérifie qu'ils sont joués (ADR-91) | Proposition seulement ; génération sur votre clic |
| **Archéologue** | Atelier de démontage de jeux du commerce (Godot, Unity, C# par ILSpy, code des fonctions IL2CPP par Cpp2IL) et données publiques (Swarm de League of Legends) ; dossiers de feature à réécrire dans vos jeux (ADR-40, 42, 45, 95, 96) | Lecture seule |

Autour d'eux : une file de chantiers fusionnés automatiquement en atelier (ADR-31), un poste de **Pilotage** (ADR-68), une page **Qualité** fondée sur des faits (ADR-27, 32), des **compétences** par agent qui se nourrissent et se vérifient seules (apprises des chantiers, reprises d'Hermes, trouvées dans des dépôts publics reconnus, essayées avant usage ; ADR-29, 78, 97, 102), le **téléphone** via Tailscale avec notifications (ADR-30), le **Jeu express** (ADR-44) et un **studio de modding** pour vos jeux Steam (ADR-65).

**Une équipe qui se parle (ADR-98 à 101)** : le directeur, le Concepteur et le DA **consultent leurs collègues** pendant qu'ils vous répondent (le DA demande au Concepteur, le directeur au Testeur…). Chaque échange vous est montré, replié, sous leur message. Ils **lisent le jeu** avant d'affirmer, en lecture seule et sans les secrets, et vous **proposent de retenir** vos préférences durables dans une **mémoire du studio** commune à tous les agents et à tous vos jeux : vous gardez ou non, d'un clic (page « Mémoire et équipe »). Avant les projets, l'**Atelier d'idées** garde vos idées et vos inspirations, que le Concepteur enrichit puis transforme en conception quand vous le décidez. `STUDIO_TEAM=0` éteint l'équipe.

**Une chaîne de production en béton (ADR-103)** : quand le testeur renvoie un chantier, le développeur reçoit ce que sa passe précédente avait fait et **tous** les points relevés ; le testeur revérifie d'abord ce qu'il avait signalé et juge la consigne **exigence par exigence**. La dernière correction automatique passe sur le modèle des gros chantiers. Le gardien laisse passer les commandes sans danger qu'il refusait (et prévient l'agent qui tourne en rond), une fusion ne vous demande plus d'enregistrer ce que le hub a lui-même écrit dans `studio/`, et un **réservoir d'agents** plafonne le nombre de passages simultanés.

**Plusieurs développeurs sur le même jeu (ADR-104)** : un **chef de chantier** prévoit les fichiers que chaque chantier va toucher et ceux dont il dépend. Deux chantiers qui ne se croisent pas avancent en même temps ; les autres attendent, et la discussion dit pourquoi. Avant chaque fusion, le chantier est réuni avec ce qui a été fusionné depuis son départ et revérifié par le hub ; si deux chantiers ont touché les mêmes lignes, le développeur réconcilie les deux versions avant que rien n'entre dans votre jeu.

**La Forge (ADR-106)** : un onglet de chaque jeu montre l'équipe en voxels, dans une salle de nains. Chaque nain est à son poste : le conseil, le scriptorium, l'atelier d'art, un établi par chantier simultané, le banc d'essai, la porte du Gardien. Il travaille, vous fait signe quand il vous attend, ou se repose au foyer, selon les vrais états du hub. Un clic ouvre sa fiche : chantier, étape, dernières actions, raison d'une attente. L'éclairage suit l'heure (jour, nuit) et un aperçu de la Forge figure sur l'accueil.

**Le plan de production (ADR-107)** : pour une fonctionnalité qui demande plusieurs métiers (« un boss avec son look et son rugissement »), le Directeur propose un plan dans la discussion : chantiers, visuels du Directeur artistique, sons du directeur sonore, et 3 à 8 critères d'acceptation. Vous le validez d'un clic, puis tout s'enchaîne par les circuits habituels : file des chantiers, file des visuels avec provisoires et intégration automatique, sons à écouter puis branchés. Une vérification d'ensemble contrôle ensuite chaque critère dans le jeu et le fixe par des tests. Vous n'êtes appelé que pour vos choix (boîte « À vous » de la discussion, « À vous de jouer » ; les plans se relisent sous Récap → « Plans de production »). Une étape en échec met le plan en pause, sans rien sauter. En séance autonome, le plan part tout seul et ses choix attendent le bilan.

Phase 6 (ADR-81 à 91) : plafond de coût par visuel, budget de performance Godot, contrôle des vitrines après fusion, vos parties rejouées comme tests, **équilibreur** par simulation, **banc d'essai** des agents, passe **game feel**, **journal de bord** (GIF de la semaine), **export** Windows local (`build/`), **directeur sonore**. Tout est dans Pilotage (onglets Son, Journal, Équilibrage, Banc d'essai) ; le son est aussi dans l'onglet « Art & son » de chaque jeu.

**La vue d'un jeu (ADR-113)** : quatre onglets, **Discussion · Récap · Le jeu · Art & son**, et un seul endroit pour décider, quel que soit le niveau d'autonomie : la boîte **« À vous »**, à droite de la discussion (Gardien, chantier à relire, choix du directeur, croquis du DA, plan, son à écouter…), chaque décision prise sur place. La discussion range vos fils à part de ceux que le hub ouvre seul (« Automatiques » : intégrer un visuel, le retoucher, brancher des sons) et montre chaque fin de chantier en carte lisible : ce qui change en clair, la photo « en jeu » du Testeur, son avis, « ▶ Lancer le jeu », le technique replié. Le **Récap** raconte les chantiers semaine par semaine, avec leurs chiffres ; **Le jeu** donne la bible en clair, ce que le directeur a décidé seul (à reprendre d'un clic), l'état du jeu en rubriques et ce qui a été réalisé ; **Art & son** la galerie des visuels, le son, la discussion du Directeur artistique dans un panneau et les réglages techniques derrière la roue crantée. Les anciennes adresses (`/tasks`, `/plans`, `/decisions`, `/son`) mènent toujours à leur contenu.

**La qualité de rendu automatique (ADR-121 à 125)** : aucune validation de plus pour vous, des vérifications plus dures à la place de votre œil. Vos mots, tels quels, priment sur la consigne du Directeur et suivent les chantiers qui en reprennent d'autres. Un relecteur contre-expertise chaque consigne avant son lancement (`STUDIO_RELECTEUR=0` le coupe). Un jeu Godot déclare des **poses de contrôle** que le hub photographie à chaque chantier dans le vrai jeu ; le Testeur doit les regarder. Une plainte sur le rendu devient un test qui mesure le défaut tel que le joueur le voit. Enfin, un point de rendu ou de votre demande qui n'est pas prouvé ne fusionne plus, même si le Testeur est plutôt d'accord : le Développeur corrige, et vous n'êtes prévenu qu'après les tentatives automatiques.

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
- modèles : `STUDIO_MODEL_CHAT`, `STUDIO_MODEL_STRUCTURED`, `STUDIO_MODEL_CONCEPT`, `STUDIO_MODEL_DEV`, `STUDIO_MODEL_DEV_BIG`, `STUDIO_MODEL_QA`, `STUDIO_MODEL_ART`, `STUDIO_MODEL_ARCHEOLOGUE` (ils se règlent aussi dans la fiche de chaque agent, dans « La Forge ») ;
- 3D : `STUDIO_TRIPO_MODEL`, `STUDIO_TRIPO_MULTIVIEW_MODEL`, `STUDIO_TRIPO_MONTHLY_CREDITS` ; plafond par visuel `STUDIO_ART_ASSET_USD` (défaut 6) et `STUDIO_ART_ASSET_CREDITS` (défaut 250) ;
- Godot : `STUDIO_GODOT` (l'exécutable), `STUDIO_PERF_MIN_FPS` (plancher du budget de performance, défaut 60). Les clés des services se saisissent dans l'interface.
- Son : `STUDIO_ELEVENLABS_KEY` (sinon la clé saisie dans Art & son ou Pilotage → Son, gardée dans `.data/elevenlabs/`).
- Chef de chantier (ADR-104) : `STUDIO_PARALLEL` (défaut 2) : chantiers en même temps sur un même jeu, quand leurs fichiers ne se croisent pas ; 1 = un seul à la fois.
- Douceur pour le PC (ADR-130) : le hub tourne en priorité basse (`STUDIO_PRIORITY=normal` l'éteint) ; les files reprennent 90 s après le démarrage, un jeu par minute (`STUDIO_RESUME_DELAY_S`, 0 = tout de suite) ; un seul contrôle du hub à la fois pour tout le studio (`STUDIO_HEAVY`, défaut 1).
- Plans de production (ADR-107) : `STUDIO_PRODUCTION=0` les éteint (le directeur n'en propose plus, le bloc `[[PRODUCTION]]` est ignoré).
- Réservoir d'agents (ADR-103) : `STUDIO_MAX_AGENTS` (défaut 3) : développeurs et testeurs au travail en même temps, tous jeux confondus.
- Équipe (ADR-98) : `STUDIO_TEAM=0` coupe les consultations entre agents, la mémoire proposée et la lecture du jeu en conversation.
- Essai Caveman (ADR-92, éteint par défaut) : `STUDIO_CAVEMAN=record` (le relais mesure sans rien modifier) ou `compress`, `STUDIO_CAVEMAN_SHARE` (part des chantiers routés, défaut 0.5), `STUDIO_CAVEMAN_PORT` (défaut 8797). Prérequis : `npm i -g @caveman-ai/cli` puis `caveman setup --install` (et surtout pas `caveman setup --yes`, qui réécrit vos réglages Claude Code et Hermes). Comparaison dans Qualité.

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
| `apps/hub/src/sound` | Directeur sonore : ElevenLabs, essais, intégration et vérification |
| `apps/hub/src/production` | Plans de production : préparation par le Directeur, enchaînement des métiers par les circuits existants, vérification d'ensemble ; « Plans de production » sous Récap (`apps/web/src/studio/Plans.tsx`) |
| `apps/hub/src/art` | Directeur artistique : images, Tripo, atelier Blender (`blender/workshop.py`), carnet Tripo, bilan |
| `apps/hub/src/reverse`, `express`, `mods` | Atelier de démontage, Jeu express, studio de modding |
| `apps/hub/src/skills`, `usage`, `remote` | Compétences des agents, compteur d'utilisation, téléphone et notifications |
| `apps/hub/src/team`, `ideas` | L'équipe : consultations entre agents (serveur MCP du hub), lecture du jeu, mémoire du studio ; Atelier d'idées |
| `apps/hub/src/server`, `auth`, `projects`, `vcs` | Serveur HTTP local (Host, cookie, CSRF), registre et isolation des jeux, Git |
| `apps/web` | Interface React : accueil, Pilotage, vue d'un jeu (Discussion et « À vous », Récap, Le jeu, Art & son : `src/studio/projet/`), qualité… |
| `apps/web/src/studio/forge` | La Forge : scène three.js en voxels (décor, nains, cycle jour / nuit), fiches, aperçu de l'accueil ; données par `apps/hub/src/studio/forge.ts` |

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
