# Game Studio Hub (projet « Ambition »)

Studio personnel de développement de jeux vidéo assisté par IA, conçu pour **un seul utilisateur sous Windows**, qui reste **directeur créatif et décideur final**.

> État actuel : **Phases 1 et 2 terminées**.
> - Phase 1 : importer ou créer un projet, discuter librement, faire regrouper les fiches en propositions, décider, consulter la vision validée et le « Pourquoi ? ».
> - Phase 2 : faire implémenter une décision par Claude Code sous contrôle. Le développeur propose un plan, vous le validez ; il travaille dans une copie isolée et chaque action est filtrée ; il vous demande pour tout imprévu ; le QA vérifie ; vous fusionnez ou abandonnez.

## Lancer le studio

```powershell
cd C:\Games\Ambition
npm install        # la première fois
npm start          # compile l'interface puis lance le hub sur http://127.0.0.1:4317
```

Le navigateur s'ouvre sur un **lien de connexion à usage unique**, également affiché dans le terminal. Arrêt : `Ctrl+C`.
Les appels à Claude passent par votre Claude Code (votre abonnement), sans outils et sans accès à vos fichiers.

Variables facultatives : `STUDIO_PORT`, `STUDIO_GAMES_ROOT` (défaut `C:\Games`), `STUDIO_DATA_DIR` (défaut `.data`), `STUDIO_MODEL_CHAT` et `STUDIO_MODEL_STRUCTURED` (défaut `sonnet`), `STUDIO_NO_BROWSER=1`.

## Développement

Prérequis : Node.js 24 et Git (vérifiés dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §1).

```powershell
npm test           # suite Vitest (dépôts Git temporaires, orchestrateur factice : aucun appel à un LLM)
npm run typecheck  # backend et interface
npm run build && npm run test:e2e   # parcours complet dans Edge (headless), captures dans .data/screenshots
```

| Dossier | Contenu |
|---|---|
| `packages/contracts` | Schémas Zod partagés : items, approbations, événements, projets |
| `apps/hub/src/vision` | `VisionService`, seul écrivain de la vision ; fichiers d'items ; `BRIEF.md` |
| `apps/hub/src/approvals` | Validations humaines liées au hash, à usage unique |
| `apps/hub/src/auth` | Sessions humaines (cookie + CSRF), impossibles à fabriquer hors du module |
| `apps/hub/src/projects` | Registre, isolation des répertoires, analyse et import d'un projet existant |
| `apps/hub/src/journal` | Journal en ajout seul, avec masquage des secrets |
| `apps/hub/src/vcs` | Git : commits restreints à `studio/` |
| `apps/hub/src/conversation` | Fils de discussion, paquet de contexte, prompts du directeur |
| `apps/hub/src/orchestrator`, `llm` | Port d'orchestration ; adaptateur Claude Code CLI sans outils |
| `apps/hub/src/server` | Serveur HTTP local : contrôle du Host, cookie de session, CSRF |
| `apps/hub/src/executor` | Phase 2 : `PolicyEngine` (allow / deny / ask), `TaskService`, lanceur Claude Code, relais hook et gardien |
| `apps/web` | Interface React : projets, import, discussion, décisions, vision, tâches |

## Le problème à résoudre

Le goulot d'étranglement n'est pas le code, c'est la **clarté de la vision**. Les idées arrivent en vrac, en langage naturel, parfois contradictoires. Le studio doit :

1. écouter une expression libre, sans exiger de structure ;
2. en extraire des éléments structurés (idées, hypothèses, questions, contraintes…) **sans jamais modifier la vision officielle tout seul** ;
3. transformer ce qui mérite de l'être en **propositions** soumises à validation ;
4. conserver les **décisions validées** comme référence commune, versionnée et traçable, pour tous les agents ;
5. détecter les contradictions et les impacts d'un changement ;
6. faire exécuter le travail technique (Claude Code) **sous contrôle** : plan validé, périmètre borné, résultat présenté, annulation possible.

## Principes directeurs

| Principe | Conséquence concrète |
|---|---|
| L'humain décide | Seule une action explicite dans l'interface peut faire passer un élément au statut `validated`. Aucun outil d'agent ne le permet. |
| La vision est un artefact, pas une mémoire d'agent | Elle vit dans des fichiers Markdown/YAML versionnés par Git dans le dépôt de chaque jeu, pas dans la mémoire d'Hermes ni de Claude. |
| Le hub impose, les agents proposent | Les contrôles (permissions, validations, périmètre) sont appliqués par le code du hub, pas par des consignes données aux modèles. |
| Un agent suffit souvent | Le directeur traite seul les demandes simples ; les spécialistes ne sont sollicités que lorsque c'est utile. |
| Pas de sur-ingénierie | Un processus backend, une base SQLite, des fichiers texte, un frontend web local. Ni microservices, ni base vectorielle, ni agents permanents. |

## Fonctionnement en une image

```
 Vous ──(conversation libre)──▶ Hub (UI web locale)
                                  │
            ┌─────────────────────┼──────────────────────────┐
            ▼                     ▼                          ▼
   Moteur de vision        Orchestrateur (port)        Exécuteur (port)
   items, statuts,         Hermes Agent  ou            Claude Code CLI
   liens, conflits         Claude direct               dans un worktree Git,
            │              (directeur + spécialistes)  permissions filtrées
            ▼                     │ outils MCP du hub        │ par le hub
   studio/ dans le dépôt          └──────────────┬───────────┘
   Git de chaque jeu                             ▼
   (source de vérité)                   SQLite : tâches, validations,
                                        événements, journal
```

## Documentation

| Document | Contenu |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Résultats de l'audit, composants, flux, choix techniques |
| [docs/VISION_ENGINE.md](docs/VISION_ENGINE.md) | Modèle de données de la vision, modes exploration et décision, cohérence et impacts |
| [docs/AGENT_CONTRACTS.md](docs/AGENT_CONTRACTS.md) | Rôles, droits et formats d'échange (propositions, questions, décisions, tâches, rapports) |
| [docs/SECURITY.md](docs/SECURITY.md) | Modèle de menaces, niveaux de permission, validation imposée, injections de consignes |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phases, MVP et critères d'acceptation |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Décisions d'architecture, hypothèses et arbitrages en attente de votre accord |

## Prochaine étape

Lire [docs/DECISIONS.md](docs/DECISIONS.md), section « Arbitrages ouverts », et valider ou amender les décisions proposées. La phase 1 ne démarre qu'après votre accord.
