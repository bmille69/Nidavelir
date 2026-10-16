# Décisions d'architecture

Statuts : **Proposée** (en attente de votre accord) · **Non contestée** (présentée, sans objection de votre part, mais pas validée explicitement) · **Validée** (accord explicite) · **Remplacée**.

Dernière mise à jour : 13/10/2026, après vos réponses aux arbitrages A1 à A7.

---

## Décisions

### ADR-01 : un seul processus local, sans microservices
**Statut** : Non contestée
Un backend Node unique sert l'API, l'interface (fichiers statiques en production, Vite en développement) et le serveur MCP `studio`. Hermes et Claude Code restent des processus externes.
*Pourquoi* : utilisateur unique, machine unique ; un seul processus à lancer, à déboguer et à sauvegarder.

### ADR-02 : backend en TypeScript (Node 24 + Fastify) plutôt qu'en ASP.NET Core
**Statut** : **Validée** le 13/10/2026 (arbitrage A1)
1. **Un seul langage** pour le frontend, le backend et le serveur MCP. Les schémas de contrats (Zod) sont écrits **une fois** et servent à l'API, à l'UI, au MCP et à la validation des sorties LLM.
2. **Node 24 est déjà installé** et `node:sqlite` fonctionne (vérifié). Pour du C#, il aurait fallu installer .NET 10 LTS (seul le SDK 9 est présent, avec une fin de support au 10/11/2026, à confirmer).
3. L'écosystème Claude et MCP est d'abord TypeScript.

### ADR-03 : Hermes orchestre mais n'agit pas
**Statut** : Non contestée. La cible finale est Hermes (A2).
Hermes, dans un profil dédié `studio`, sert de directeur et de coordinateur des spécialistes, via son API locale. Ses outils terminal, fichiers, navigateur et cron sont désactivés. Il agit **uniquement** par les outils MCP du hub.
*Pourquoi* : son skill `claude-code` lance Claude Code depuis son propre terminal (`claude -p`, qui « ignore tous les dialogues interactifs », ou tmux, absent sous Windows). Le hub ne pourrait alors ni imposer le plan validé, ni intercepter les permissions. On réutilise ce qu'Hermes fait bien (sessions, délégation, schémas de sortie, interruption) sans lui confier le contrôle.
*Conséquence* : la mémoire et les skills d'Hermes ne sont pas des sources de vérité du projet.

### ADR-04 : l'exécution passe par Claude Code CLI, contrôlé par le hub
**Statut** : Non contestée. Confortée par ADR-11.
L'adaptateur lance `claude -p --output-format stream-json --permission-mode default --permission-prompt-tool mcp__studio__permission_gate --allowedTools <dérivés du plan> --strict-mcp-config --settings <hooks du run>` dans un worktree.
*Pourquoi le CLI plutôt que l'Agent SDK* : il est installé, authentifié et **testé** sur cette machine. C'est le binaire officiel non modifié, utilisé avec votre propre abonnement : un usage explicitement couvert par les conditions d'Anthropic (ADR-11). L'Agent SDK, lui, exige une clé API. Les options nécessaires existent dans `--help`.
*Risque* : le comportement exact de `--permission-prompt-tool` et des motifs `--allowedTools` avec chemins doit être confirmé par le test préliminaire de la phase 2. *Repli* : Agent SDK avec `canUseTool`, **avec une clé API**.

### ADR-05 : la vision vit dans le dépôt du jeu ; SQLite est un index et un stockage opérationnel
**Statut** : Non contestée
Items en Markdown avec en-tête YAML dans `<jeu>/studio/items/`, commit à chaque validation. SQLite contient l'index reconstructible (FTS5, liens) et les données opérationnelles (conversations, tâches, runs, approbations, journal).
*Pourquoi* : les fichiers sont lisibles par vous et par Claude Code, diffables, et ils voyagent avec le jeu ; Git fournit l'historique et la récupération.
*Compromis* : il faut garder fichiers et index synchronisés. Règle : un seul écrivain (VisionService), et l'index est reconstruit au démarrage si un écart est détecté.

### ADR-06 : SQLite via `node:sqlite`, sans ORM
**Statut** : Non contestée
Requêtes SQL explicites et petite couche de migrations maison, sans dépendance native à compiler sous Windows. Si l'API de `node:sqlite` se révèle limitante, on passe à `better-sqlite3`.

### ADR-07 : isolation par worktree Git et moteur de politique, sans Docker
**Statut** : Non contestée (le risque résiduel est accepté pour l'instant, A7)
Docker et WSL sont absents. Chaque tâche s'exécute dans un worktree sur une branche dédiée ; les permissions sont filtrées par le hub (SECURITY §3). Les limites sont documentées (SECURITY §9).

### ADR-08 : ports et adaptateurs, avec de faux adaptateurs pour les tests
**Statut** : Non contestée
Ports : `OrchestratorPort`, `ExecutorPort`, `VcsPort`, et plus tard `EnginePort`. Chacun a un adaptateur réel et un adaptateur factice enregistré, pour des tests déterministes et gratuits.

### ADR-09 : pas de base vectorielle
**Statut** : Non contestée
La recherche plein texte FTS5, les filtres par type et domaine et les liens explicites suffisent pour quelques milliers d'items par projet. On réévaluera si la recherche s'avère insuffisante sur un vrai projet.

### ADR-10 : ordre d'intégration des orchestrateurs, DirectClaude puis Hermes
**Statut** : **Validée** le 13/10/2026 (arbitrage A2 : choix délégué, avec Hermes comme finalité)
- Phase 1 : `DirectClaudeAdapter` (Claude Code CLI sans outils de fichiers, plus le MCP `studio`). Il fonctionne aujourd'hui, avec votre abonnement, de façon conforme (ADR-11).
- Phase 3 : `HermesAdapter` derrière le même `OrchestratorPort`. **Hermes devient alors l'orchestrateur par défaut.** DirectClaude reste disponible comme repli et comme référence pour les tests.
- Pour que la bascule ne coûte rien, la suite de tests de la phase 1 est écrite contre le **port**, pas contre l'adaptateur. Elle sera rejouée telle quelle sur Hermes.

### ADR-11 : authentification Claude conforme aux conditions d'Anthropic
**Statut** : Proposée. **Une action de votre part est nécessaire (A3).**
Constat (vérifié le 13/10/2026) : Hermes utilise votre connexion OAuth Claude Code (`credential_pool.anthropic`, `auth_type: oauth`, `source: claude_code`), reprise automatiquement grâce à `auth.adopt_external_logins: true`.
La [page officielle « Legal and compliance » de Claude Code](https://code.claude.com/docs/en/legal-and-compliance) indique que l'authentification OAuth des abonnements est « intended exclusively for […] ordinary use of Claude Code and other native Anthropic applications ». Elle précise aussi que les outils tiers ne doivent pas faire passer de requêtes par les identifiants d'un abonnement, ni stocker les jetons Claude.ai, et qu'Anthropic peut faire respecter ces règles sans préavis. Hermes est une application tierce qui a copié votre jeton dans son propre `auth.json` : cet usage sort de ce cadre et **expose votre compte**.
En revanche, la même page autorise explicitement l'utilisation du **binaire Claude Code non modifié** avec votre propre abonnement. C'est ce que fait le hub (ADR-04, ADR-10).
Décision proposée :
1. **Hub → Claude Code CLI** : votre abonnement, conforme.
2. **Hermes** : clé API Anthropic (Claude Console) ou un autre fournisseur, avec un plafond de dépenses, et `adopt_external_logins: false`.
3. Le hub **refuse de démarrer l'adaptateur Hermes** si le profil `studio` utilise un identifiant OAuth d'abonnement (vérification du champ `auth_type` dans `auth.json`, sans lire le secret).

### ADR-12 : import d'un projet existant en choisissant un dossier
**Statut** : **Validée** le 13/10/2026 (arbitrage A4, demande de fonctionnalité)
Les jeux vivent dans `C:\Games\<nom>`, un dépôt Git par jeu. Le hub permet d'**importer un projet existant** en choisissant son dossier dans l'application. Exemple : `C:\Games\survivor_destiny`. Le détail est dans ARCHITECTURE §4.D et VISION_ENGINE §8.
- **Choix du dossier** : bouton « Parcourir… » qui ouvre la boîte de dialogue Windows native (lancée par le backend local, car un navigateur ne transmet pas le chemin absolu d'un dossier), plus un champ « coller un chemin ». Les sous-dossiers de `C:\Games` contenant un `.git` sont proposés directement sur le dashboard.
- **Analyse en lecture seule** : moteur détecté (`project.godot` → Godot ; `package.json` + Vite → web/TypeScript ; sinon « inconnu »), état Git, documents existants (`README.md`, `CLAUDE.md`, `docs/*.md`).
- **Écriture seulement après confirmation** : un écran récapitule ce qui sera créé (`studio/` uniquement) et le commit prévu (`git commit -- studio/`, qui ne touche pas à vos autres modifications en cours).
- **Amorçage de la vision** : les documents existants sont analysés et produisent des items `captured`, avec `source.kind = file`, dans l'Inbox. Rien n'entre dans le canon sans votre validation. Les décisions déjà écrites (par exemple `docs/balance-decisions.md`) apparaissent comme « décisions existantes à confirmer », validables par lot.

### ADR-13 : orchestrateur sans état, le hub fournit tout le contexte à chaque tour
**Statut** : Retenue (étape 2 de la phase 1, 13/10/2026). Écart d'implémentation à valider.
Le hub n'utilise pas la reprise de session de Claude Code (`--resume`). Il renvoie à chaque tour le paquet de contexte et les 30 derniers messages.
*Pourquoi* : Claude Code fige le prompt système au premier tour d'une session (`--system-prompt-snapshot`, activé par défaut). Une décision validée en cours de discussion ne serait donc pas vue par le directeur. Cette approche rend aussi le hub indépendant de la mémoire de session de l'orchestrateur, ce qui prépare la bascule vers Hermes.
*Coût* : environ 0,04 $ par réponse sur un projet de 200 éléments (valeur indicative affichée par Claude Code). Les appels utilisent `--restricted --safe-mode --strict-mcp-config --tools "" --no-session-persistence` : sans outils, sans CLAUDE.md, sans MCP.

### ADR-14 : le serveur MCP « studio » est reporté à la phase 2
**Statut** : Retenue (13/10/2026)
En mode exploration, le directeur n'a besoin d'aucun outil : le hub appelle l'extraction lui-même, avec une sortie structurée (`--json-schema`). Le serveur MCP devient nécessaire quand un agent doit agir, c'est-à-dire pour le contrôle des permissions de l'exécuteur (phase 2) et pour Hermes (phase 3). La garantie « pas de proposition en mode exploration » est donc tenue plus fortement encore, puisque le directeur n'a aucun outil.

### ADR-15 : double barrière d'exécution, un hook qui voit tout et un gardien qui vous consulte
**Statut** : Retenue (phase 2, après trois essais réels le 13/10/2026)
Constats des essais (dépôt jetable, Claude Code 2.1.296) :
1. `--permission-prompt-tool mcp__studio__permission_gate` : Claude Code consulte bien le gardien pour chaque écriture non autorisée et **respecte un refus** (fichiers intacts). Il dit de lui-même ne pas avoir cherché à contourner les refus.
2. **Limite** : Claude Code exécute **sans consulter le gardien** les commandes qu'il juge en lecture seule (ex. `git status`). Le gardien seul ne suffit donc pas.
3. Un **hook `PreToolUse`** passé par `--settings` est appelé pour **toutes** les actions, auto-approuvées comprises. Il peut répondre `allow` (pas de question), `deny` (refus) ou `ask` (qui renvoie vers le gardien). Il a bloqué `rm`, `curl`, l'écriture via `node -e`, les commandes composées (`&&`) et l'écriture hors du dépôt.
4. `--setting-sources ""` fait ignorer un `.claude/settings.json` hostile placé dans le dépôt (« tout autoriser »). Le CLAUDE.md du projet n'est alors pas chargé : le hub le transmet lui-même, en le signalant comme consignes du projet.
5. Outils intégrés disponibles via `--tools` : `Read, Grep, Glob, Edit, Write, Bash, NotebookEdit` (pas de `MultiEdit` ni de `TodoWrite`).

Conception retenue : le hook et le gardien sont deux petits relais qui **interrogent le hub** (jeton propre à chaque exécution). Toute la politique est donc écrite et testée à un seul endroit, le `PolicyEngine`. Le hook a toujours le dernier mot : en cas d'erreur ou si le hub ne répond pas, il **refuse** (échec fermé).

---

## Constats de l'étape 2 (essai réel sur une copie de Destiny Survivor)

- L'amorçage des 5 documents a produit **194 éléments** (98 rien que pour `balance-decisions.md`), en environ 4 min et pour environ 0,71 $ (valeur indicative). Les citations sont exactes et sourcées à la ligne. 21 doublons ont été écartés automatiquement, une citation inventée a été rejetée, et 66 éléments sont marqués « décision existante ? ». Le dépôt n'a reçu qu'un commit limité à `studio/`.
- **Le volume est le vrai problème.** On ne trie pas 194 cartes une à une. Réponse immédiate : filtres (source, type, « décision existante ? ») et tri par lot. Réponse prévue à l'étape 3 : **regrouper** les éléments par sujet en propositions de synthèse, et confirmer les décisions existantes par lot.
- Une réponse du directeur prend environ 11 s. Il s'appuie correctement sur les brouillons (il cite leurs identifiants) et ne les présente pas comme validés.

### ADR-16 : dépendances partagées par jonction, jamais supprimées récursivement
**Statut** : Retenue (phase 2 bis, 14/10/2026)
La copie de travail reçoit une **jonction** `node_modules` → `node_modules` de votre projet, seulement si ce dossier est ignoré par Git. Les tests du jeu peuvent ainsi tourner sans copie (900 Mo) ni téléchargement.
**Danger constaté en essai, sur un dossier factice** : `git worktree remove --force` **suit les jonctions et efface leur cible**. Règles qui en découlent :
1. Avant toute suppression d'une copie de travail, le hub supprime **tous** les liens qu'elle contient (`unlinkAllLinks`), sans toucher à leur cible. Un test automatique vérifie qu'après abandon ou fusion, votre `node_modules` est intact.
2. L'agent ne peut ni écrire dans un dossier lié (le chemin réel sort de la copie, donc refus), ni créer de lien (`ln`, `mklink` interdits).
3. Installer ou retirer une dépendance (`npm install`, `npm ci`, `yarn add`…) est **interdit** à l'agent, puisque cela modifierait votre vrai `node_modules`. Un changement de dépendance se fait par vous, en dehors du studio, pour l'instant.
*Limite assumée* : les outils de test peuvent écrire leurs fichiers de cache dans `node_modules` (ex. `.vite`). C'est sans conséquence sur le code du jeu.

---

### ADR-17 : séparer décisions de créateur et règles techniques ; résumé en langage courant
**Statut** : **Validée** le 14/10/2026 (demande du directeur créatif : « plein de décisions techniques alors que je n'ai pas mis les mains dans le code »)
- Chaque fiche et chaque proposition porte une **nature** : `creative` (ce que vit le joueur, votre domaine) ou `technical` (comment le code est fait). Un groupe n'est jamais mélangé.
- À l'import, chaque document est déclaré « décrit le jeu » ou « décrit le code ». `CLAUDE.md`, `AGENTS.md` et les documents d'architecture sont « code » par défaut. Pour les fiches importées avant cette séparation, la nature est devinée d'après le nom du document.
- Onglet Décisions : d'abord **vos décisions de créateur** ; les **règles techniques existantes** sont repliées à part, avec « En prendre acte » (validation groupée). Plus tard, l'architecte les prendra en charge.
- Chaque proposition commence par un **résumé d'une ou deux phrases sans chiffres techniques** ; le détail chiffré est replié dessous.
- Essai réel (copie de Destiny Survivor, bouton « Refaire le regroupement ») : 193 fiches → **26 propositions créatives + 4 techniques**, aucun nom de code dans les propositions créatives, 74 s, environ 0,23 $ (valeur indicative).

### ADR-18 : Hermes reporté ; le hub reste son propre chef d'orchestre
**Statut** : **Validée** le 14/10/2026 (le directeur créatif : « Ok », après explication)
- Aujourd'hui, Hermes n'apporterait presque rien : le hub discute, regroupe et fait travailler Claude Code lui-même, avec votre abonnement et dans les règles d'Anthropic.
- Hermes coûterait une clé API (ou le crédit inclus dans Max, à vérifier), un programme de plus à faire tourner, et des inconnues sous Windows (H2, H3).
- Le module « Claude Subscription DirectSDK » d'Hermes (Nous Research, expérimental) n'est **pas retenu** : il fait transiter l'identification de l'abonnement par un relais tiers, ce que la page « Legal and compliance » d'Anthropic exclut.
- La phase 3 est donc **suspendue** et non annulée. Elle reprendra quand un besoin réel apparaîtra (par exemple faire travailler plusieurs spécialistes en même temps). L'interface `OrchestratorPort` permet de changer d'orchestrateur sans rien réécrire.

### ADR-19 : vue « Studio », l'équipe en direct
**Statut** : Retenue (14/10/2026, demande : « une vue hiérarchique sur les agents, idéalement en train de travailler »)
- Page d'accueil = organigramme : **Vous** → **le Directeur** → **l'Archiviste** (extraction), **le Développeur**, **le Testeur** (QA) ; **le Gardien** (contrôle des actions) sous le développeur. Ce sont les rôles réels du hub, pas des agents inventés.
- Chaque agent est un petit personnage animé : au repos, il somnole ; au travail, il tape et l'activité réelle s'affiche (ex. « Lit src/main.ts ») ; quand il vous attend, une bulle « ! » rebondit. Les liens de l'organigramme s'animent en vert (travail) ou en orange (attente de votre réponse).
- Le hub expose `GET /api/human/studio` : une photographie **en lecture seule** de l'activité (réponses du directeur, extractions, regroupements, runs, demandes d'autorisation, ce qui vous attend), interrogée toutes les 2,5 s. Les fiches notées une à une ne sont pas affichées dans le journal du studio, pour éviter le bruit.
- Thème sombre unique, polices système (aucune connexion externe), animations coupées si Windows demande de réduire les animations.

### ADR-20 : autonomie du directeur, réglable par projet
**Statut** : Retenue (14/10/2026, demande du directeur créatif après usage : « trop de confirmations », « le directeur doit être autonome et force de proposition », « je devrais pouvoir modifier le niveau d'autonomie »)
Cette ADR **assouplit** le principe « rien n'entre au canon sans votre clic » : vous pouvez déléguer, projet par projet.
- **Je valide tout** (`supervised`) : le comportement d'avant. Le directeur reformule et questionne, vous validez chaque proposition et chaque plan.
- **Équilibré** (`balanced`, par défaut, y compris pour les projets existants) :
  - le directeur est force de proposition : il répond par une solution concrète, sans demander de confirmation ;
  - il pose une question seulement en cas de conflit avec le canon, ou s'il y a deux ou trois façons vraiment différentes de faire ;
  - ses propres propositions sont notées comme les vôtres ;
  - environ 45 s après le dernier message d'une discussion, les idées sont regroupées. Les propositions **sans conflit ni question** sont décidées seules ; les autres vous attendent.
- **Autonome** (`autonomous`) : comme Équilibré, et en plus :
  - le directeur remplace une ancienne décision quand il n'y a pas de question ;
  - il valide et lance les plans du développeur sans risque : aucune suppression, aucune nouvelle dépendance, aucun problème ni question.
- **Ce qui ne se délègue jamais** : la fusion dans votre jeu, les demandes d'autorisation du gardien, l'import d'un projet.
- **Traçabilité** :
  - chaque décision déléguée porte `validated_by.kind = "delegated"` et une approbation de session `delegation:<niveau>` ;
  - elle est commitée dans `studio/` comme les autres, et le changement de niveau est journalisé ;
  - l'onglet Décisions liste « Décidé par le directeur », avec « Revenir dessus » (abandon) ;
  - un bouton « Laisser le directeur trancher ce qui ne fait pas débat » traite les propositions déjà en attente.
- En mode délégué, le tri manuel des idées disparaît : l'onglet « À trier » devient « Noté », et seul « Écarter cette idée » reste.

### ADR-21 : compteur d'utilisation Claude
**Statut** : Retenue (14/10/2026)
- Le hub lit Claude Code en `stream-json`. À chaque appel, Claude Code publie lui-même vos limites d'abonnement (`rate_limit_event` : fenêtre de 5 heures et fenêtre de la semaine, pourcentage et heure de remise à zéro) ainsi que les jetons consommés. **Aucun identifiant n'est lu** : ce sont des données que le programme officiel affiche.
- Barre latérale : les deux jauges (orange à partir de 70 %, rouge à partir de 90 %) et les jetons du hub aujourd'hui. « Mettre à jour » fait un appel minimal au plus petit modèle quand l'information a plus de 30 minutes.
- Vérifié pour de vrai le 14/10 : 26 % sur 5 heures, 70 % sur la semaine.

### ADR-22 : « go » : le directeur confie le travail au développeur
**Statut** : Retenue (14/10/2026). Défaut constaté en usage réel : le directeur, devenu force de proposition, annonçait « je démarre l'étape 1 » alors qu'il n'a aucun outil. Aucune tâche n'était créée.
- Ses consignes le disent maintenant explicitement : il ne code pas, ne lance ni tests ni captures ; c'est le Développeur qui réalise.
- Quand vous demandez de réaliser (« go », « vas-y »…), il termine sa réponse par `[[IMPLEMENTER: titre | objectif | D-xxxx…]]`. Le hub retire cette balise du texte affiché, puis :
  1. regroupe et décide tout de suite les idées de la discussion, sans attendre le délai de 45 s ;
  2. crée la tâche sur les décisions citées, plus celles issues de cette discussion qui ne sont pas déjà confiées à une tâche (10 au maximum) ;
  3. lance la préparation du plan, en lecture seule, et écrit dans la discussion « Tâche T-xxxx confiée au développeur ».
- Le plan suit les règles de l'ADR-20 : votre accord en « Équilibré », validation automatique s'il est sans risque en « Autonome ». La fusion reste à vous.
- En « Je valide tout », la balise est ignorée : vous lancez vous-même les tâches (« Vision validée » → « Faire implémenter »).
- Vérifié pour de vrai : à « ok go », le directeur a produit la balise avec D-0026 et D-0029.

### ADR-23 : plus d'onglet « Décisions » ; une bible à lire, des questions en boutons
**Statut** : **Validée** le 14/10/2026. Le directeur créatif : « je ne suis pas fan des décisions, je n'arrive pas à comprendre comment m'en servir sans que ça me pollue ». Il a choisi l'organisation en 3 onglets.
- Les décisions restent la mémoire du studio, mais vous ne les manipulez plus. Le projet a 3 onglets :
  - **Discussion** : vous parlez, le directeur avance ;
  - **Le jeu** : la bible, rangée par thème, avec recherche ;
  - **Chantiers** : le travail du Développeur.
- L'onglet « Décisions » n'existe plus qu'en mode « Je valide tout ».
- Quand le directeur a besoin de vous, la question apparaît **à droite de la discussion**, sous forme de boutons :
  - **vrai choix** : 2 ou 3 versions complètes, celle qu'il conseille marquée ★ ; un clic fait entrer la version choisie dans la bible ;
  - **changement d'une décision** : « Avant / Maintenant », avec « Adopter » ou « Garder l'ancienne » ;
  - **question restante** (rare) : « D'accord tel quel » ou « Écarter ».

  L'onglet Discussion affiche le nombre de questions en attente.
- Le regroupement produit désormais des `options` complètes (avec `recommended_option`) plutôt que des questions ouvertes. Les questions de détail sont interdites : le directeur fait le choix raisonnable lui-même.
- Dans la bible, chaque point affiche « décidé par vous » ou « décidé par le directeur », avec « Pourquoi ? », « Faire réaliser » et « Retirer de la bible ». Les règles du code et l'historique sont repliés.
- Correctif au passage : les enregistrements Git d'un même dépôt sont mis en file, et les fichiers `*.tmp` ne sont plus pris. Deux enregistrements simultanés (le directeur qui décide pendant que vous cliquez) pouvaient échouer.

### ADR-24 : mode « atelier » par défaut, un outil de développement d'abord
**Statut** : **Validée** le 14/10/2026. Constat du directeur créatif : « je n'ai pas l'impression que cet outil soit très efficace hormis augmenter ma consommation de tokens et perdre un temps monstre à valider des idées ». L'outil devait l'aider à développer, structurer le travail, formuler les consignes au développeur et faire des propositions cohérentes avec le développement de jeux vidéo.
- **Mesure qui a motivé le choix** : sur l'usage réel, 53 % de la consommation servait à noter et regrouper des fiches, 32 % aux réponses du directeur, et seulement 14 % au développeur. Aucune ligne de code n'avait été fusionnée.
- **Atelier**, qui devient le mode de tous les projets :
  - ni fiche, ni regroupement, ni décision à gérer ; un seul appel à Claude par message ;
  - le directeur est un chef de projet et lead game designer : il connaît `CLAUDE.md` et la liste des fichiers suivis par Git (lecture seule, mise en cache 5 minutes) ;
  - il propose des solutions cohérentes avec les pratiques du jeu vidéo, et découpe les gros sujets en chantiers ;
  - à « go », il rédige une **consigne** structurée dans un bloc `[[CHANTIER: titre]] … [[/CHANTIER]]` : objectif, à faire, où, contraintes, vérification, hors périmètre. Elle est affichée repliée dans la discussion ;
  - le chantier est créé depuis la discussion (`origin.thread`, sans décision requise), puis le plan est préparé ;
  - un plan sans problème, sans suppression ni nouvelle bibliothèque part tout seul ; sinon la discussion le signale ;
  - la discussion reçoit les nouvelles du chantier (lancé, terminé et vérifié, échec, fusionné). Le panneau de droite liste les chantiers et ce qui vous attend ;
  - **seule validation : relire et fusionner**. Les autorisations du Gardien restent possibles.
- « Le jeu » montre en tête ce qui a été **réalisé** (chantiers fusionnés), puis la bible existante.
- Les modes « Je valide tout », « Équilibré » et « Autonome » restent dans le code. Le sélecteur ne propose plus que « Atelier » et « Je valide tout ».
- **Correctif lié** : une commande refusée par le Gardien est retirée du plan et signalée, au lieu de bloquer tout le plan. Cas réel : `node tests/shots/ballistics.mjs`.
- **Vérifié pour de vrai sur une copie de Destiny Survivor** : la consigne cite les bons fichiers (`render3d/projectileView.ts`, `fx.ts`), les règles de `CLAUDE.md` (pas de changement dans `src/systems`, textes dans `fr.ts`) et les scripts du projet (`npm run validate`, `npm run shots`). Coût : un appel, environ 0,06 $ (valeur indicative).

### ADR-25 : atelier sans interruption, compte rendu de fin de chantier, « ▶ Essayer »
**Statut** : Retenue (14/10/2026). Retour réel sur T-0002 : « trop de demandes d'autorisation » (6 pour un chantier, dont un simple `cat`), « à la fin je n'ai même pas de retour de ce qui a été fait ni de comment tester », « avant via ma fenêtre Claude Code j'avais un bon suivi ».
- **Autorisations** : en atelier, une action hors plan mais sans danger est accordée automatiquement, journalisée (`escalation.auto_allowed`) et visible dans le suivi.
  - Cela concerne une modification de fichier dans la copie ou une commande non prévue.
  - Le Gardien refuse toujours : réseau, Git en écriture, interpréteurs, chemins hors du jeu, secrets, `studio/`.
  - La copie de travail et la fusion manuelle restent le filet de sécurité.
  - Les autres modes continuent de demander.
- **Compte rendu** dans la discussion, une fois la vérification enregistrée :
  - ce qui a changé ;
  - l'avis du testeur, avec les critères en échec et les régressions (« ⚠ » si échec, au lieu de « vérifié ») ;
  - les écarts au plan et ce qui reste à faire ;
  - **« Pour essayer »** : des étapes concrètes, nouveau champ `how_to_test` du rapport du développeur.
- **Suivi en direct** : sous chaque chantier en cours, le panneau de droite montre les dernières actions du développeur, comme une fenêtre Claude Code.
- **« ▶ Essayer »** : lance le jeu en mode développement dans la copie du chantier, ou le jeu lui-même avec « ▶ Lancer le jeu », et l'ouvre dans un onglet. C'est une action humaine ; un seul jeu tourne à la fois par projet.
- **Cause réelle du « problème » relevé par le testeur sur T-0002** (403 sur les polices), reproduite puis corrigée :
  - la copie emprunte `node_modules` au jeu par une jonction ; Vite résout le vrai chemin et refuse de servir ce qui est hors de la copie ;
  - « ▶ Essayer » passe par une configuration d'enrobage, rangée dans les données du hub, qui reprend celle du jeu et autorise ce dossier. Résultat : 403 sans enrobage, 200 avec ;
  - le développeur et le testeur sont prévenus que ces 403 viennent de la copie et non du jeu.

### ADR-26 : économies de consommation
**Statut** : Retenue (14/10/2026). Demande du directeur créatif : « applique tout ce que tu juges optimal ».
- **Analyse du 14/10** (équivalent API, à titre indicatif) :
  - le hub a consommé 4,62 $ dans la journée : développeur 59 %, directeur 22 %, testeur 11 %, fiches 8 % (supprimées depuis l'atelier) ;
  - un chantier coûtait de 0,72 à 1,47 $ ;
  - la session de construction du hub elle-même (Claude Code, plus gros modèle, très longue) prend sur le même abonnement : c'est probablement la plus grosse part de la consommation de la journée.
- **Exécution directe en atelier** : plus de phase « plan » séparée, qui relisait le code une seconde fois pour un plan validé de toute façon automatiquement.
  - La consigne du directeur tient lieu de plan.
  - Les commandes de vérification autorisées sont les scripts du projet : `typecheck`, `lint`, `test`, `build`, `validate`.
  - Le gardien refuse toujours ce qui est dangereux ; le reste est accordé et journalisé, sans bruit dans le suivi.
  - Le développeur ne supprime pas de fichier et n'ajoute pas de bibliothèque ; il le signale.
- **Testeur sur un modèle plus léger** (`haiku` par défaut, variable `STUDIO_MODEL_QA`), avec 30 tours au plus.
- **Historique compact du directeur** : une consigne déjà envoyée est réduite à son titre, un long message à 1 500 caractères.
- **Cache vérifié** : d'un message à l'autre, le contexte stable (consignes du projet, fichiers) est relu depuis le cache. Les ratés venaient de l'ancien mode à fiches, dont le contexte changeait à chaque message.
- **Coût affiché** par chantier : dans le panneau, sur la page du chantier et dans le compte rendu.
- **Essai réel sur une copie de Destiny Survivor** (« ajoute au README les paramètres d'URL de test, go ») :
  - 56 s de bout en bout, aucune demande d'autorisation, uniquement `README.md` modifié ;
  - développeur 0,17 $, testeur 0,01 $, directeur environ 0,05 $ ;
  - compte rendu avec « Pour essayer » ;
  - défaut relevé puis corrigé : le testeur ne pouvait lancer aucun test sans plan.

### ADR-27 : juger le workflow, votre avis et le tableau « Qualité »
**Statut** : Retenue (14/10/2026). Question du directeur créatif : « comment juger si mon workflow est optimal, et comment l'améliorer ? »
- Un bon workflow se juge sur la durée, avec cinq critères :
  - **réussite** : fusionnés parmi les chantiers terminés, et part fusionnée du premier coup ;
  - **qualité** : avis du testeur ;
  - **vitesse** : travail des agents, en médiane ;
  - **coût par chantier fusionné** : il inclut les abandons, c'est le vrai prix d'un résultat ;
  - **votre effort** : plans validés à la main, autorisations et corrections, par chantier.
- **Votre avis** (👍 / 👎 et un mot facultatif) : sur la page du chantier dès qu'il est à relire, et dans « Fusionnés récemment ». Le message de fusion vous y invite. C'est le signal le plus important : un chantier peut être réussi techniquement sans être ce que vous vouliez. Stocké dans `task_ratings`, journalisé (`task.rated`).
- **Page « Qualité »**, depuis la barre latérale :
  - six chiffres clés, chacun expliqué au survol ;
  - un tableau semaine par semaine ;
  - le détail par chantier ;
  - un filtre par projet ;
  - une alerte si le testeur trouve des problèmes dans plus de 30 % des chantiers.
- **Étape suivante** prévue, après 10 à 20 vrais chantiers :
  - un banc d'essai de chantiers de référence, rejoués sur une copie à chaque changement important (modèle, consignes), pour comparer avec des chiffres ;
  - une mémoire des leçons du projet, utilisée par le directeur.

### ADR-28 : le Concepteur, l'architecte avant le chef de chantier
**Statut** : **Validée** le 14/10/2026. Choix du directeur créatif : nouveaux projets et grosses fonctionnalités, recherche web sans demander, « Créer le projet » prépare tout jusqu'au premier lancement.
- **Rôles** : le **Concepteur** intervient avant. Il prend une idée floue, pose les bonnes questions, cherche ce qui existe, tranche les choix structurants, puis rédige le dossier et les chantiers. Le **directeur** intervient pendant : demandes qui tiennent en un chantier, réalisation au quotidien. Le directeur propose d'ouvrir une conception quand une demande est trop grosse.
- **À chaque tour, en arrière-plan**, le Concepteur rend :
  - une réponse courte ;
  - 0 à 5 questions, chacune avec 2 à 4 réponses toutes prêtes et sa recommandation ★ ; « Choisis pour moi » les prend toutes ;
  - le dossier complet, réécrit à chaque tour : en une phrase, piliers, boucle, périmètre de la première version jouable, hors périmètre, choix techniques, faisabilité et risques, estimation, étapes, choix faits pour vous, questions ouvertes ;
  - les chantiers de la première étape, rédigés comme des consignes pour le développeur ;
  - un indicateur « prêt » et ses sources web.
- **Modèle et outils** : le modèle le plus capable par défaut (`STUDIO_MODEL_CONCEPT`, `opus`), car les appels sont rares et décisifs. Outils web en lecture seule uniquement (`WebSearch`, `WebFetch`, liste fermée `WEB_TOOLS`) ; aucun accès aux fichiers ni au terminal.
- **Nouveau projet** : « Créer le projet » crée `C:\Games\<nom>`, Git, `CLAUDE.md` (rédigé par le Concepteur), `studio/conception.md`, une discussion « Conception » et les chantiers **en attente**, avec un bouton « ▶ Lancer ce chantier ».
- **Fonctionnalité** : le Concepteur reçoit `CLAUDE.md`, les fichiers et la bible du projet. « Ajouter les chantiers » range le dossier dans `studio/conceptions/` et prépare les chantiers.
- Le Concepteur apparaît dans l'organigramme. Les conceptions en cours sont listées dans la barre latérale ; une conception qui attend vos réponses vous est signalée.
- **Essai réel** (« un roguelike avec des chats un peu comme hades ») : 104 s, environ 0,27 $ pour le tour.
  - Concept proposé : « Neuf Vies », les Grands Félins à la place des dieux.
  - 4 questions utiles, un dossier complet, et Godot 4.7 avec les tests GUT vérifiés sur le web avec sources.
  - 6 chantiers centrés sur le plus gros risque, le plaisir du combat.
  - Estimation : environ 27 chantiers, de 15 à 35 $.

### ADR-29 : compétences des agents et mémoire des leçons
**Statut** : Retenue (14/10/2026, « vas-y » du directeur créatif).
- Jusqu'ici, les agents ne voyaient aucune skill, et c'était voulu : mode verrouillé, réglages ignorés. Le hub fournit désormais lui-même des **compétences choisies**, agent par agent, depuis la page « Compétences ».
- **Comment elles arrivent aux agents** :
  - **Développeur et testeur** : de vraies skills, dans un plugin écrit dans le dossier du run (`studio-skills`) et chargé avec `--plugin-dir`, plus l'outil `Skill`. Le gardien n'autorise **que** `studio-skills:*` : les skills intégrées de Claude Code (« schedule », « run »…) sont refusées.
  - **Directeur et Concepteur**, qui n'ont pas d'outils : la compétence est ajoutée à leurs consignes, dans la limite de 9 000 caractères.
- **Leçons du projet** :
  - une compétence propre à chaque projet, lue par le directeur, le Concepteur et le développeur ;
  - elle s'apprend de **vos** signaux : un 👎, un mot laissé avec un avis, une correction demandée, un abandon. Un 👍 sans mot n'apprend rien. Les « échecs » du testeur ne sont pas retenus, car ils peuvent venir de l'environnement ;
  - elle est réécrite par le modèle en 25 leçons concrètes au plus (« À faire », « À éviter », « Goûts du directeur créatif ») ;
  - elle reste modifiable à la main.
- **Compétences de départ**, livrées désactivées : `game-feel` (directeur, Concepteur, développeur), `testeur-joueur` (testeur), `perf-web-3d` (développeur). Vous pouvez aussi ajouter les vôtres ou coller un SKILL.md. Une compétence ajoutée arrive désactivée, avec un avertissement : un texte écrit par d'autres doit être relu. Le hub ne télécharge jamais rien seul.
- **Essai réel sur une copie de Destiny Survivor** :
  - leçon « toute nouvelle section du README commence par 🎮 » ;
  - le directeur l'a reprise dans sa consigne, et la section créée s'appelle « 🎮 Remerciements » ;
  - 52 s, environ 0,19 $ ;
  - le chargement d'une skill par `--plugin-dir` et son utilisation via l'outil `Skill` ont été vérifiés séparément.

### ADR-30 : le hub sur le téléphone (Tailscale, code de connexion, notifications)
**Statut** : **Validée** le 14/10/2026 : Tailscale, notifications ; pas de lancement automatique au démarrage du PC.
- **Principe** : le PC reste le studio (agents, Claude Code, jeux), et le téléphone devient une télécommande. Le PC doit rester allumé, sans veille, avec le hub lancé.
- **Accès** : le hub écoute toujours sur `127.0.0.1` seulement. Depuis la page « Téléphone », `tailscale serve --bg --https=443 http://127.0.0.1:<port>` le publie en **HTTPS dans votre réseau Tailscale uniquement**, jamais `funnel`, donc jamais sur Internet.
  - L'adresse `https://<pc>.<réseau>.ts.net` est acceptée dynamiquement comme hôte et comme origine.
  - HTTPS est indispensable aux notifications et à l'installation sur l'écran d'accueil.
  - La première fois, Tailscale peut demander d'autoriser HTTPS sur votre réseau : le hub ouvre le lien.
- **Connexion d'un téléphone** :
  - un **code à 6 chiffres**, affiché par le PC : valable 5 minutes, un seul à la fois, 5 essais au plus ;
  - le téléphone le saisit sur `/login` et reçoit une **session durable de 90 jours** qui survit aux redémarrages ;
  - seul un hachage du cookie est conservé ;
  - la liste des appareils (« vu il y a… ») permet de **déconnecter** un téléphone ;
  - le téléphone ne voit pas les réglages réservés au PC.
- **Notifications** : le Web Push est implémenté sans dépendance, avec le chiffrement RFC 8291 (vérifié au caractère près contre l'exemple de la RFC) et la signature VAPID RFC 8292. Elles partent quand :
  - un chantier est prêt à essayer, ou en échec ;
  - un plan attend votre accord ;
  - une autorisation est demandée ;
  - le Concepteur attend vos réponses, ou sa conception est prête.

  Le service de notification du téléphone (Google, Apple) achemine des messages qu'il ne peut pas lire. Sur iPhone, il faut d'abord ajouter le hub à l'écran d'accueil.
- **Application installable** : manifeste, icônes, service worker (notifications seulement, pas de cache hors ligne).
- **Affichage mobile** (860 px et moins) :
  - barre du haut et menu qui se replie ;
  - en-tête de projet compact et onglets défilants ;
  - discussion, chantiers et conception empilés ;
  - cibles tactiles d'au moins 40 px, champs en 16 px (pas de zoom automatique sur iPhone), aucun défilement horizontal.
- **Non vérifié automatiquement** : le vrai Tailscale (absent de ce PC au moment de l'écriture ; son état et ses commandes sont testés par simulation) et la réception d'une notification sur un vrai téléphone. Le chiffrement et l'envoi sont testés de bout en bout avec un faux service de notification.

### ADR-31 : fusion automatique, un chantier à la fois, séances autonomes
**Statut** : **Validée** le 15/10/2026, à la demande du directeur créatif (« le technique, c'est toi qui gères »).
- **Incident à l'origine** (14/10, projet `bordee`) : T-0013 est parti du jeu sans T-0012, encore à relire. T-0012 a été fusionné pendant que T-0013 travaillait ; les deux touchaient les mêmes fichiers, et T-0013 n'a jamais pu être fusionné (5 essais), il a fallu le refaire (T-0014).
- **Un chantier à la fois par projet (atelier)** : tant qu'un chantier est en cours ou à relire, les suivants sont **en file** (`queued_at`) et partent tout seuls, dans l'ordre, chacun à partir du jeu qui contient les précédents. Le bouton « ▶ Lancer » suit la même règle. Après un arrêt du hub, la file est vidée : rien ne repart sans vous.
- **Fusion automatique (atelier)** : quand le testeur valide (`pass` ou `pass_with_notes`), le hub fusionne lui-même. Il s'agit d'une validation déléguée de type `merge`, liée au commit exact et journalisée comme les autres. Votre jeu doit être propre (pas de modifications non commitées), sinon le chantier attend et vous êtes prévenu. Annulable avec un `git revert`.
- **Testeur pas d'accord** : le développeur corrige **une fois** d'office dans la même copie, avec les remarques du testeur, puis le testeur revérifie. Si le testeur n'est toujours pas d'accord, ou s'il n'a pas pu rendre d'avis, le chantier attend votre mot. Vous êtes prévenu dans la discussion et sur le téléphone. Cette correction d'office ne compte pas comme une intervention dans « Qualité ».
- **Votre mot dans la discussion suffit** : le directeur voit la liste des chantiers et traduit « fusionne », « corrige… », « laisse tomber », « lance T-0004 » en balises (`[[FUSIONNER]]`, `[[CORRIGER]]`, `[[ABANDONNER]]`, `[[LANCER]]`) que le hub exécute. Les boutons de l'onglet « Chantiers » restent disponibles.
- **Séance autonome** : « bosse en autonomie 2 h » → le directeur annonce `[[SEANCE: 2h | objectif]]` et ses premiers chantiers. Le hub les enchaîne. Quand la file est vide, il redonne la main au directeur (message `<hub>`) avec le point d'étape : le directeur propose la suite ou termine par `[[FIN_SEANCE]]`. La séance s'arrête aussi :
  - à la fin du temps (pas de nouveau chantier dans les 5 dernières minutes ; celui en cours se termine, les suivants redeviennent des brouillons) ;
  - après 2 chantiers en échec, ou au bout de 12 chantiers ;
  - sur « stop » ;
  - si le directeur ne propose pas de suite.

  Le bilan (fusionnés, en attente, coût) est donné dans la discussion et sur le téléphone. La séance est gardée en mémoire : un arrêt du hub la termine.
- **Hors atelier**, rien ne change : le reste du temps, c'est vous qui fusionnez.

### ADR-32 : une « Qualité » fondée sur des faits
**Statut** : **Validée** le 15/10/2026 (idées 1, 2 et 3 retenues par le directeur créatif).
- **Problème** : avec la fusion automatique (ADR-31), « fusionné » ne veut plus dire « réussi ». C'est le testeur, un agent, qui décide, et le tableau se contentait de le croire.
- **1. Vérifications du hub avant chaque fusion automatique** (`CheckService`, table `checks`) :
  - les **tests du jeu** (`npm test`) dans la copie du chantier ;
  - **le jeu se lance** : `npm run dev`, puis Edge invisible pendant 6 s, sans erreur dans la page ni page vide. Le serveur de jeu est séparé de celui de « ▶ Essayer » : votre essai en cours n'est jamais coupé.

  Si une vérification échoue, la même est refaite sur le jeu actuel. C'est une **régression** seulement si c'était bon avant : elle empêche la fusion et repart au développeur (même règle d'une correction d'office qu'à l'ADR-31), sinon le chantier attend votre avis. Un échec déjà présent avant le chantier est signalé, sans bloquer. Le résultat est donné dans le compte rendu (« Vérifié par le hub : tests du jeu ✓, le jeu se lance ✓ »). Un jeu sans script `test` ou `dev` n'est pas vérifié sur ce point.
- **2. Chantiers à refaire** :
  - le directeur marque un chantier qui reprend un chantier fusionné : `[[CHANTIER: titre | reprend T-0012]]`. Seul un chantier fusionné peut être « repris », et le directeur voit les 8 derniers ;
  - une fusion annulée par un `git revert` est repérée dans l'historique du jeu.

  « Réussite » et « Du premier coup » ne comptent que les chantiers qui **ont tenu**.
- **3. Fiabilité du testeur** : parmi les chantiers qu'il a validés et dont on connaît la suite, la part qui a tenu. C'est raté si le hub a trouvé une régression, si le chantier a été repris ou s'il a été annulé. Un avertissement apparaît en dessous de 80 % (à partir de 5 validations).
- **Mesuré sur `bordee` le 15/10** : tests 5 s, lancement 9 s ; le dossier du jeu n'est pas modifié.

### ADR-33 : gardien plus fin, capture du jeu, carnet « État du jeu »
**Statut** : **Validée** le 15/10/2026 (points 1, 2 et 3 de la revue d'ensemble). Pas de nouvel agent : les agents existants reçoivent des outils et du contexte.
- **Constat sur 28 chantiers** :
  - 90 commandes refusées, dont 66 pour « enchaînement » (`npm test 2>&1 | tail`, plusieurs lectures séparées par `;`, `|` entre guillemets dans un `grep`) ;
  - le testeur ne pouvait pas lancer la simulation de `bordee`, ni lire les modules partagés ;
  - aucun avis 👍/👎 donné.
- **1. Gardien** : une commande est découpée en morceaux (`;`, `&&`, `||`, `|`) et chaque morceau est jugé seul. Un refus l'emporte, puis une demande.
  - **Permis** :
    - les lectures (`ls`, `cat`, `grep`, `find` sans `-exec` ni `-delete`, `sed -n`, `git status/diff/log/show/grep`…) ;
    - après `|`, seulement des filtres (`grep`, `head`, `tail`, `sort`, `wc`…) ;
    - `2>&1` et `>/dev/null` ;
    - `cd` à l'intérieur de la copie ;
    - **les scripts du projet** (`npm test`, `npm run <script>` existant, sauf deploy/publish/release/install…) et **ses outils** (`npx <outil>` présent dans `node_modules/.bin`), y compris pour le testeur.
  - **Refusé, avec la marche à suivre dans le message** :
    - les redirections vers un fichier et les `<<EOF` (« utilise Write ou Edit ») ;
    - `$`, les accolades et les parenthèses, les commandes en arrière-plan ;
    - tout chemin hors de la copie ;
    - les secrets.
  - **Inchangé** : les interdictions de fond (réseau, interpréteurs, Git en écriture, installations).
  - **Lecture seule** du dossier du jeu (cible des modules partagés) et des captures du hub ; jamais d'écriture.
  - **Rejoué** sur les 96 commandes refusées : 71 permises, 12 soumises à autorisation (accordée d'office en atelier), 13 toujours refusées, à raison.
- **2. Capture du jeu** : les vérifications du hub (ADR-32) ont lieu désormais **entre le développeur et le testeur**. Le hub lance le jeu, prend une capture pleine page après 6 s (`.data/shots/<projet>/<chantier>.png`, hors du jeu) et transmet au testeur les faits mesurés (tests, lancement, régression ou non) ainsi que la capture, qu'il regarde avec Read. La capture apparaît dans le compte rendu de la discussion et sur la page du chantier. Une régression que le testeur valide quand même est journalisée (`tester.missed`, fiabilité du testeur).
- **3. Carnet « État du jeu »** : après chaque fusion en atelier, un appel structuré réécrit un carnet court (« Ce qui existe », « Choix déjà faits », « Limites connues et reste à faire », 600 mots au plus) à partir du carnet précédent et du rapport du chantier. Le premier carnet part des 25 derniers chantiers fusionnés. Le carnet est :
  - gardé par le hub (table `game_state`, aucune écriture Git, donc aucun risque pour les fusions) ;
  - donné au directeur à chaque message et au développeur, au testeur et au planificateur à chaque run ;
  - visible dans l'onglet « Le jeu ».

  Un échec de mise à jour garde l'ancien carnet.

### ADR-34 : le Concepteur, le directeur et le développeur se passent la main
**Statut** : **Validée** le 15/10/2026, à la suite d'un incident.
- **Incident** (`bordee`, conception « Résolution en 3D ») : le dossier et les 7 chantiers étaient prêts, mais un bouton (« Ajouter les chantiers ») restait à cliquer, ce que rien n'indiquait. Le Concepteur a affirmé les avoir « mis dans un dossier », introuvable. Le directeur créatif a dû copier-coller la réponse au directeur, qui l'a résumée (T-0029) : de la consigne a été perdue.
- **« Transmets » au Concepteur** (`transmettre` dans sa réponse, seulement si `ready`) : le hub écrit le dossier dans le jeu (`studio/conceptions/<titre>.md`, commit), crée les chantiers dans l'ordre et, en atelier, les met **tout de suite en file** (ADR-31). Le Concepteur confirme avec le lien vers la discussion. Pour un nouveau jeu, la même phrase crée le projet. Les boutons restent disponibles. S'il n'est pas prêt, il le dit et ne crée rien.
- **Pas de résumé en route** : chaque chantier garde la consigne complète écrite par le Concepteur, suivie du chemin du dossier, que le développeur lit dans sa copie du jeu.
- **Le Concepteur connaît le projet** : pour une fonctionnalité, il reçoit, comme le directeur, le carnet « État du jeu », la liste des chantiers et la séance en cours. Il ne refait donc pas ce qui existe, et il sait retirer un chantier déjà fait avant de transmettre. Ses consignes lui interdisent de demander un copier-coller.
- **Le directeur confie une grosse demande** : `[[CONCEVOIR]] sujet et contexte [[/CONCEVOIR]]`. Le hub ouvre une conception liée à la discussion et donne le lien vers la page du Concepteur ; à la transmission, les chantiers reviennent **dans cette discussion**. Le directeur voit les conceptions du projet (`<conceptions>` : en cours, questions en attente, prête, transmise).
- Les liens internes (`#/c/…`, `#/p/…`) sont cliquables dans les messages.
- **Au passage** : un brouillon jamais lancé puis abandonné n'apprend plus de « leçon » et ne compte plus dans « Qualité ». Les 5 anciens brouillons de `bordee` (T-0002 à T-0006, refaits sous T-0007 à T-0011) ont été abandonnés.

### ADR-35 : des discussions qui ne se perdent pas
**Statut** : **Validée** le 15/10/2026, à la demande du directeur créatif. Constats : un clic de trop sur « Nouvelle discussion » en créait une vide ; on ne pouvait pas renommer ; on s'y perdait quand le Concepteur ouvrait une autre fenêtre de discussion.
- **Nouvelle discussion = page blanche** (`#/p/<projet>/nouvelle`) : rien n'est créé avant le premier message. Les discussions sans message ne sont plus affichées.
- **Renommer** : crayon sur la discussion ouverte, ou double-clic sur son titre (`POST …/threads/:id/rename`).
- **Ordre et activité** : la liste est triée par dernière activité (messages du hub et du Concepteur compris), avec l'heure et le titre sur deux lignes. En ouvrant un projet, on arrive directement sur la discussion **en vigueur**, la plus récemment active.
- **Pastilles** : le nombre de messages du studio arrivés depuis votre dernier passage dans chaque discussion. Le suivi est mémorisé dans ce navigateur ; à la première visite, tout compte comme lu. Un bandeau « Du nouveau dans « … » » s'affiche en haut de la discussion ouverte, en un clic.
- **« Concevoir » depuis une discussion** : la conception est rattachée à cette discussion. Une note avec le lien vers le Concepteur y est postée, et les chantiers transmis y reviennent (ADR-34) au lieu d'ouvrir une nouvelle fenêtre.

### ADR-36 : Fable 5 pour le Concepteur et le développeur
**Statut** : **Validée** le 15/10/2026 par le directeur créatif. Fable 5 est accessible avec l'abonnement Max (essai réel : `claude -p --model fable` répond, modèle `claude-fable-5-1`).
- **Concepteur** (`STUDIO_MODEL_CONCEPT`) : `fable` au lieu d'`opus`. Appels rares et décisifs.
- **Développeur** (`STUDIO_MODEL_DEV`, plan et exécution) : `fable` au lieu de `sonnet`. C'est lui qui écrit le code : moins d'erreurs veut dire moins de corrections et de chantiers repris, donc une production plus rapide.
- **Inchangés** : le directeur (`sonnet`), pour des réponses rapides dans la discussion, et le testeur (`haiku`), puisque la qualité repose d'abord sur des vérifications réelles (ADR-32).
- **Contrepartie** : le quota de l'abonnement s'épuise plus vite. Chaque rôle peut revenir à l'ancien modèle par sa variable d'environnement, sans toucher au code.

### ADR-37 : le modèle de chaque agent se choisit dans « Le studio en direct »
**Statut** : **Validée** le 15/10/2026, à la demande du directeur créatif.
- **Sous chaque carte** (Concepteur, directeur, archiviste, développeur, testeur) : le modèle en service, une liste pour le changer (Fable 5, Opus, Sonnet, Haiku), le modèle **recommandé** (★) avec sa raison, et un bouton « Conseillé : … » pour y revenir. Le gardien n'a pas de modèle : il applique des règles fixes.
- **Consommation** : jetons d'aujourd'hui et des 7 derniers jours, et part de l'agent dans la consommation du studio. L'équivalent en dollars au tarif de l'API est indicatif (survol), puisque tout passe par l'abonnement. Le modèle des runs du développeur et du testeur est désormais enregistré ; les « leçons » comptent pour l'archiviste, dont elles utilisent le modèle.
- **Effet** : le choix est mémorisé dans le hub (table `settings`, clé `models`) et lu **à chaque appel**. Il vaut dès le prochain appel, sans redémarrage ; un travail déjà lancé garde son modèle. Chaque changement est inscrit au journal et apparaît dans le fil du studio.
- **Défauts** : les variables `STUDIO_MODEL_*` restent les défauts tant qu'aucun choix n'est fait ; sinon, le modèle recommandé (ADR-36).
- **Correspondance** : directeur = discussion (`chat`), archiviste = appels structurés (fiches, regroupement, carnet, leçons), Concepteur = `concept`, développeur = plan et exécution, testeur = vérification.

### ADR-38 : analyse du flux — copies fidèles, lancement fiable, gardien qui suit le terminal
**Statut** : **Validée** le 15/10/2026 (analyse demandée par le directeur créatif ; correctifs techniques, ADR-31). Faits relevés dans `.data/hub.db` :
- **Le flux est serré** : aucun temps mort entre deux chantiers (moins d'une seconde) ; un chantier dure environ 6 à 8 min (développeur 2 à 4 min, tests et lancement 15 s, testeur 1 à 3 min). Le temps perdu est ailleurs : les heures sans demande (nuit, pauses) et les trois défauts ci-dessous.
- **Défaut 1, copies infidèles (npm workspaces)** : dans une copie, `node_modules` était une jonction vers celui du jeu, dont `@bordee/rules` vise `packages/rules` **du jeu principal**. Le client du chantier testait et lançait donc les anciennes règles. C'est la cause des « vérifications qui échouent dans cette copie » (T-0019 à T-0021) et des contournements hors périmètre. Correctif : pour un jeu en espaces de travail, la copie reçoit un vrai dossier `node_modules` fait de jonctions vers chaque dépendance du jeu, sauf les paquets du projet, qui visent ceux de la copie. Les caches (`.vite`) sont propres à la copie. Rien n'est téléchargé, et le nettoyage retire tous les liens avant toute suppression. Vérifié sur une copie réelle de bordee : tests 6 s, lancement 9 s, jeu principal intact.
- **Défaut 2, lancement aveugle** : bordee lance `npm run dev -w @bordee/client`, donc Vite sur le port fixe 5173 (`strictPort`). Si le jeu tourne déjà (vous l'essayez, ou « ▶ Essayer »), le lancement échoue, avant comme après le chantier, donc « pas de régression » : depuis T-0037, la vérification de lancement ne vérifiait plus rien. Correctif : le hub trouve l'espace de travail visé et y lance Vite lui-même, sur un port libre.
- **Défaut 3, gardien trop strict par erreur** : le terminal de l'agent garde son dossier d'une commande à l'autre, mais le gardien jugeait chaque commande depuis la racine. Après `cd packages/client`, un `cat ../../package.json` (dans la copie) était refusé ; un `cd /c/Games/…` vers la copie aussi. Environ 60 % des 43 refus depuis ADR-33 étaient de ce type. Correctif : le hook transmet le dossier courant (`cwd`) ; le gardien part de là s'il est dans la copie, sinon de la racine. Les chemins à la Git Bash (`/c/…`) sont compris.
- **Utilité du gardien** : il reste la seule barrière entre un agent qui a un terminal et votre PC. En 2 jours, il a arrêté un `npm install`, qui aurait réécrit les dépendances du jeu principal partagées par lien, ainsi que des appels réseau (`curl`) et des interpréteurs (`python`). En atelier, les actions hors plan passent d'office (681 notées) : il ne bloque que l'interdit.

### ADR-39 : identité visuelle Nidavellir
**Statut** : **Validée** le 15/10/2026, d'après la direction artistique fournie par le directeur créatif (`DA.png`).
- **Nom** : l'application s'appelle **Nidavellir — le hub de création de jeux vidéo** (menu, titre de l'onglet, écran d'accueil du téléphone, page de connexion, notifications). Les noms internes (code, dépôt) ne changent pas.
- **Éléments tirés de la DA** (`apps/web/src/assets`, `apps/web/public`) : le N, et le nom avec sa signature, détourés sur fond transparent (luminance → transparence, via ffmpeg) ; la bannière de la forge en tête de l'accueil ; l'icône d'application pour le téléphone et l'onglet (180, 192 et 512 px).
- **Couleurs** : nuit `#080B12`, glace `#00E5FF` (boutons, liens, sélection, focus), braise `#FF5A00` (ce qui vous attend, le Concepteur, l'accent chaud). Le violet de la charte précédente disparaît. La signature « moitié glace, moitié braise » (`--grad-brand`) souligne l'accueil.
- **Lettres** : Exo 2 pour les titres et les boutons, Orbitron pour les sur-titres et les rubriques du menu, Segoe UI pour le texte courant (lisibilité). Les polices sont **incluses dans l'application** : aucun appel à Google au chargement, et tout fonctionne hors ligne.
- **Accueil** : la bannière à droite du « Bonjour », fondue dans la page, et le motif « Idées › Outils › Jeux ». Sur le téléphone, la bannière passe au-dessus.
- **Rien n'est retiré** : seules l'apparence et le nom changent ; les 22 parcours du navigateur passent à l'identique.

### ADR-40 : l'Atelier de démontage et l'Archéologue
**Statut** : **Validée** le 15/10/2026, à la demande du directeur créatif : démonter un jeu qu'il possède pour le comprendre, s'en inspirer (réécriture) ou le modifier (mods), pour son usage personnel.
- **Cadre** : jeux possédés, usage personnel, aucune republication de code ou de ressources d'autrui. **Les jeux protégés sont refusés d'office** (Easy Anti-Cheat, BattlEye, GameGuard, Ricochet, Vanguard, XIGNCODE, Denuvo, VMProtect) : c'est interdit, et un anti-triche peut bannir le compte. Aucun outil de contournement n'est intégré.
- **Détection** (`reverse/detect.ts`, lecture seule) : Godot C# et GDScript, Unity Mono et IL2CPP, Unreal, GameMaker, Electron, Ren'Py, RPG Maker. Elle indique ce qui est honnêtement récupérable et si le jeu embarque un outil de mods (Harmony, BepInEx, dossier de mods). **Seul Godot est démonté pour l'instant**, avec GDRE Tools, qui décompile aussi le C#. Les autres moteurs viendront à la demande.
- **Outils** : catalogue fermé. Téléchargement depuis la page GitHub officielle, **seulement sur votre clic**, dans `.data/tools`. Le démontage se fait dans `.data/dissections/<id>/jeu` : le jeu installé n'est jamais écrit. Deux modes : « code seulement » (`--scripts-only`, rapide) ou « projet complet » (ressources comprises, plusieurs Go).
- **L'Archéologue** (nouveau rôle, modèle réglable, Sonnet recommandé) : un appel Claude Code avec seulement `Read`, `Grep` et `Glob`, le dossier démonté comme dossier de travail, et aucun `--allowedTools`. Claude Code refuse lui-même toute lecture en dehors (vérifié en vrai le 15/10). Il a un emplacement d'appel à lui, pour ne jamais ralentir le directeur. Il écrit d'abord une fiche « Vue d'ensemble » (systèmes, données, chargement des mods, idées réutilisables), puis une fiche par question. Il explique avec ses mots et ne recopie pas de longs passages.
- **S'inspirer** : « Envoyer au directeur » ouvre une discussion « Inspiration : … » dans le projet choisi, avec **la fiche seulement, jamais le code décompilé**. Le directeur propose une réécriture à la façon du studio. Le développeur n'a aucun accès au jeu démonté.
- **Modifier** (jeux C#) : « Créer un projet de mod » crée un dépôt à part dans vos jeux, avec les fiches et le chemin des assemblages du jeu. Le directeur en pose la base : projet C#, premier patch, installation dans le dossier de mods, sans toucher aux fichiers d'origine.
- **Classifieur de Claude Code** : pendant ce chantier, le mode automatique a refusé plusieurs actions liées à la décompilation, même sur de faux jeux. Le directeur créatif a ajouté des règles d'autorisation (`.claude/settings.local.json`), puis est passé en mode manuel pour valider chaque action. Le premier vrai démontage se fait par lui, depuis Nidavellir.

### ADR-41 : économies de consommation, deuxième passe
**Statut** : **Validée** le 16/10/2026 (analyse demandée par le directeur créatif ; il a choisi « le modèle selon la taille du chantier »). Faits relevés dans `.data/hub.db` et dans les journaux des runs, du 14 au 16/10 (équivalent API, à titre indicatif) :
- 106 $ au total, dont le **développeur pour 83 %**. Avant Fable (ADR-36), un chantier coûtait 0,20 à 0,70 $ pour 2 à 4 min ; après, 3 à 10 $ pour 10 à 29 min. Le 15/10 au soir, la **limite de session** a été atteinte : T-0052 a tourné 40 min pour rien, puis T-0053 et T-0054 ont échoué d'emblée.
- Le coût d'un chantier est environ nombre d'actions × taille du contexte × prix du modèle : à chaque action, l'agent relit tout le contexte accumulé (jusqu'à 230 000 jetons, 100 à 140 actions pour les chantiers « (gros) »). Fable coûte environ 10 fois Sonnet par action, et 2 fois Opus. Des fichiers de 35 000 à 39 000 caractères du jeu étaient lus en entier, ainsi que `smoke.spec.ts` et le dossier de conception, à chaque chantier.

Mesures :
- **Deux modèles pour le développeur** : `developer` (chantiers ordinaires, Sonnet recommandé) et `developer_big` (titre contenant « (gros) », Fable recommandé ; variable `STUDIO_MODEL_DEV_BIG`). Les deux se choisissent sur la carte du développeur dans « Le studio en direct ». Le testeur garde son modèle. Migration : un réglage `developer = fable` devient `developer = sonnet` et `developer_big = fable`.
- **Chantiers plus petits** : le Concepteur et le directeur visent une demi-heure de travail d'agent, et ne marquent « (gros) » que le travail vraiment indivisible ou délicat. Les estimations de coût du Concepteur sont mises à jour.
- **Lecture économe** : le développeur cherche avant de lire, lit des extraits des gros fichiers, ne relit pas ce qu'il a déjà lu, lance d'abord les tests ciblés. Il consulte les sections utiles du dossier de conception au lieu de tout relire.
- **File en pause avant le mur** : si la fenêtre de 5 heures dépasse 85 % (ou la semaine 95 %), le chantier suivant attend la remise à zéro, plus une minute, au lieu d'échouer. Le studio l'affiche (`queue.paused`).
- **Non retenu pour l'instant** (environ 5 % du total) : l'archiviste qui réécrit tout le carnet « État du jeu » après chaque chantier, et le cache du directeur, peu réutilisé d'un message à l'autre. Les sessions de construction du hub, hors compteur, prennent aussi sur le même abonnement.

### ADR-42 : l'Atelier de démontage, deuxième passe (inspirée de REA)
**Statut** : **Validée** le 16/10/2026, à la demande du directeur créatif (« consulte REA, inspire-toi »). REA (« Reverse Engineer Anything », github.com/morluto/rea) est un serveur MCP qui branche un agent sur des outils d'analyse (Ghidra, IDA, Hopper, inspection .NET, JavaScript, Android…). Nous reprenons sa **méthode**, pas l'outil.
- **Carte du jeu** (« l'inventaire d'abord ») : après chaque démontage, le hub calcule sans IA `carte.md` (scène de départ, autoloads, dossiers, familles de classes, espaces de noms, données, gros fichiers) et `index-code.txt` (un type par ligne, avec `fichier:ligne`). L'Archéologue commence par là au lieu d'explorer à l'aveugle : moins d'actions, donc moins de jetons.
- **Preuves** : chaque fiche cite `chemin:ligne`, marque les déductions « (déduit) », ne prétend jamais avoir vu le jeu tourner, et se termine par « Zones d'ombre » (ce qui n'a pas été trouvé, où il a cherché, et pour chaque partie de la question : répondu, en partie, pas trouvé).
- **Mémoire** : l'Archéologue lit maintenant tout le dossier du démontage (`jeu/`, carte, index, `fiches/`, `outil.log`), toujours en lecture seule et sans rien d'autre. Il relit ses fiches précédentes au lieu de refaire le travail.
- **Mises à jour du jeu** (comparaison entre versions) : le hub retient l'empreinte du jeu installé (taille et date du pack et de l'assemblage) et affiche un bandeau quand elle change. Redémonter garde la version précédente dans `ancien/` (une seule), calcule `changements.md` (fichiers de code et de données modifiés, ajoutés, retirés, types apparus ou disparus) et l'Archéologue écrit la fiche « Mise à jour : ce qui a changé ». S'il existe un projet de mod, il liste ce qui pourrait casser les patches Harmony. La vue d'ensemble n'est pas refaite.
- **Critères de recette** : une fiche envoyée au directeur pour s'en inspirer lui demande d'abord la liste des règles à reproduire (garder, adapter, laisser), qui servira au testeur. Les zones d'ombre sont des choix, pas des règles. Une fiche envoyée au projet de mod parle des patches, pas d'inspiration.
- **Non retenu (REA)** : brancher REA lui-même. Pour nos cibles (Godot, C#), un décompilateur rend du code lisible, plus utile que l'analyse binaire de REA. REA demanderait Java et Ghidra et modifie la configuration des agents, et ses outils natifs s'adressent surtout aux jeux C/C++ (Unreal). À reconsidérer si un tel jeu devient une cible. L'observation du jeu en marche (REA « runtime ») est écartée : c'est intrusif, et le classifieur de Claude Code la bloquerait.

### ADR-43 : le Directeur artistique (étape 1, avec Midjourney à la main)
**Statut** : **Validée** le 16/10/2026. Le directeur créatif se dit faible en visuel et veut un agent à qui confier idées et moodboards, qui centralise, cherche des références, propose une direction cohérente, fait produire et valider les visuels, puis s'entend avec le développeur pour les brancher. Ses choix (boutons) : la DA a son propre espace dans le projet, on avance par étapes, et la 3D passera par Tripo + Blender. Il n'a pour l'instant que Midjourney, qui n'a pas d'API, et vise à terme une génération locale sur sa carte graphique (RTX 3080 Ti) pour la cohérence.
- **Où vivent les visuels** : dans le dépôt du jeu, sous `studio/art/`, commité par le hub. On y trouve `bible.md` (la bible visuelle), `assets.json` (le manifeste : chaque visuel `A-0001` avec usage, spécifications, statut, prompts, rendus et verdict), `moodboard/` (vos images et `notes.json`) et `production/` (les rendus). `studio/` reste en lecture seule pour le développeur.
- **L'agent** : nouveau rôle de modèle `art_director` (Sonnet recommandé, réglable ; variable `STUDIO_MODEL_ART`). Une discussion par projet (table `art_messages`), onglet « Direction artistique ». Chaque tour est un appel Claude Code qui lit `studio/art/` (images comprises, il les voit) et peut chercher sur le web : `buildChatArgs` accepte désormais `readDir` + `WebSearch`/`WebFetch`, et rien d'autre. Ces appels ont leur propre file, pour ne jamais retarder le directeur ni l'Archéologue. Sa réponse arrive en arrière-plan.
- **Balises** appliquées par le hub : `[[BIBLE]]` (bible complète), `[[ASSET]]` (fiche JSON, nouvelle ou modifiée), `[[MIDJOURNEY: A-0001 | références]]` (prompts à copier et images du moodboard à joindre en `--sref`), `[[NOTE: moodboard/x.png]]` et `[[CHOIX: question]] a | b | c` (questions de goût en boutons, sans réglages techniques).
- **Images** : elles sont déposées par glisser-déposer ou bouton, en PNG, JPEG ou WebP, 15 Mo au plus. Le type est vérifié sur le contenu du fichier, pas sur son nom. Les images sont servies seulement depuis `studio/art`. Celles jointes à un message vont au moodboard et sont citées dans le message (`§IMAGE§`).
- **Validateur artistique** : un rendu déposé sur un visuel est jugé par un appel structuré du même rôle, selon une grille stricte (bible, cohérence, lisibilité à la taille prévue, fiche, défauts). Il répond conforme ou à retoucher, avec ses remarques et un prompt corrigé. Le directeur créatif garde le dernier mot (« Valider quand même », « Refaire »).
- **Vers le jeu** : « Faire intégrer » ouvre une discussion avec le directeur du projet, avec le fichier, l'usage et la consigne de titrer le chantier par l'identifiant. Le directeur voit aussi dans son contexte les visuels validés en attente. Quand un chantier dont le titre ou la consigne cite `A-xxxx` est fusionné, le visuel passe « dans le jeu ». La politique du développeur autorise `cp studio/art/<fichier> <destination>` et `mkdir [-p]` dans la copie, hors zones protégées, car Write ne sait pas écrire une image.
- **Plus tard** : étape 2, génération locale (ComfyUI + Flux installés sur clic, style par référence puis un style entraîné sur les visuels validés, le validateur qui boucle) ; étape 3, la 3D (Tripo pour le modèle, le squelette et les animations à la place de Mixamo, qui n'a pas d'API ; Blender en arrière-plan pour nettoyer, alléger et exporter en `.glb`, et faire un rendu sous tous les angles pour le validateur).

---

## Constats de la phase 2 (essai réel avec Claude Code, 14/10/2026)

Tâche réelle sur la copie de Destiny Survivor : « la documentation ne doit plus décrire le jeu comme 2D top-down » (contradiction relevée par le regroupement).
- **1er essai, échec instructif** : Claude Code rend sa réponse au format `--json-schema` via un outil interne, `StructuredOutput`. Le hook, qui refuse tout outil inconnu, l'a bloqué. Claude a respecté le refus sans chercher de contournement. Correctif : `StructuredOutput` est toujours permis (aucun effet) ; un test est ajouté.
- **2e essai, réussi** : plan (3 fichiers à modifier, 2 commandes de vérification, risques et hypothèses explicites) → validation → exécution → vérification QA. Coût indicatif : 0,05 $ (plan) + 0,11 $ (exécution) + 0,09 $ (QA). Seuls les 3 fichiers prévus ont changé, et la politique n'a rien eu à refuser. Le QA a conclu « conforme avec remarques » : il a déclaré **non vérifiables** les tests du jeu, absents faute de `node_modules` dans la copie de travail, au lieu de prétendre qu'ils passaient.
- ~~Limite : pas de `node_modules` dans la copie de travail, donc les tests du jeu ne tournent pas.~~ Résolue en phase 2 bis (ADR-16).
- **Phase 2 bis, consigne piégée** : voir ROADMAP, critère 8. C'est le comportement attendu, et la politique aurait bloqué ces actions de toute façon (suppression récursive, réseau, `studio/`, `.env`).
- **Phase 2 bis, bug corrigé** : le journal renvoyait les 200 événements les plus *anciens* au lieu des plus récents.
- Claude Code tente spontanément des commandes avec redirection (`npm test 2>&1 | tail`). Elles sont refusées, et il les relance sans enchaînement. C'est un comportement utile, à garder en tête : chaque refus apparaît dans les écarts déclarés.
- Les chemins affichés dans les demandes d'autorisation étaient absolus (dossier technique du worktree). Corrigé : ils sont maintenant relatifs au jeu.

---

## Constats de l'étape 3 (mode décision)

- **Regroupement réel** sur la copie de Destiny Survivor : **196 fiches → 33 propositions** en un passage, pour environ 0,26 $ (valeur indicative), sans aucune correction nécessaire de la part du hub (identifiants inventés, doublons). 1 fiche a été laissée de côté. Rien n'a été validé automatiquement.
- Le directeur a fait remonter de **vraies contradictions internes aux documents**, sous forme de questions ouvertes. Par exemple : « Espace = saut ou super ? », « coffre de 60 ou 100 places ? », « deux courbes d'XP différentes », « README en 2D alors que le rendu est en 3D ».
- **Écart avec la ROADMAP (critère 4 de la phase 1)** : une contradiction avec le canon n'est pas un élément `K-` séparé. Elle est portée par la proposition elle-même (« Remplacerait D-xxxx » + explication), et la validation passe par un remplacement explicite. C'est plus simple à lire et à arbitrer, en une seule carte. Les éléments `K-` restent prévus pour la vérification de cohérence globale (phase 4).
- Le test dans un vrai navigateur (Edge) a révélé **deux bugs que vous auriez rencontrés**, corrigés depuis : page blanche après le premier message (incompatibilité avec les navigateurs récents), et conversation qui se vidait à l'écran juste après l'envoi.

---

## Hypothèses à vérifier

| # | Hypothèse | Vérifiée quand | Si elle est fausse |
|---|---|---|---|
| H1 | `--permission-prompt-tool` permet au hub d'accepter ou de refuser chaque demande de permission de Claude Code en mode `-p` | **Confirmée** (essais du 13/10/2026, voir ADR-15) | — |
| H2 | L'API d'Hermes (`/v1/runs`, `/api/sessions`) expose assez d'événements pour suivre et interrompre un tour | Phase 3 | Utiliser seulement `/v1/responses` en flux, ou rester sur DirectClaude |
| H3 | Hermes en natif Windows est stable pour notre usage (pas besoin de PTY ni de terminal) | Phase 3 | Rester sur DirectClaude, ou installer WSL2 (avec votre accord) |
| H4 | Le volume d'items reste de l'ordre de quelques milliers par projet | Phase 4 | Pagination, puis éventuellement recherche sémantique |
| H5 | Les appels `claude -p` du hub restent dans un « usage individuel ordinaire » de l'abonnement (`total_cost_usd` = 0,09 $ affiché pour un appel minimal : valeur indicative) | Phase 1, à surveiller | Modèle plus léger pour l'extraction, regroupement des appels |
| H6 | La boîte de dialogue Windows native de choix de dossier peut être ouverte depuis le backend (PowerShell `-STA` + `FolderBrowserDialog`) et apparaît au premier plan | Implémentée ; **à confirmer par vous** (non testée automatiquement, car elle ouvrirait une fenêtre sur votre écran) | Navigateur de dossiers intégré à l'application, limité à la lecture |

---

## Arbitrages

| # | Sujet | Résolution |
|---|---|---|
| A1 | Langage du backend | **TypeScript**, validé le 13/10 (ADR-02) |
| A2 | Orchestrateur du MVP | Choix délégué, avec **Hermes comme finalité** → ADR-10. **Hermes reporté le 14/10** → ADR-18 |
| A3 | Fournisseur de modèle pour Hermes | Branché sur votre OAuth Claude Code : **non conforme**, voir ADR-11. Sans objet tant qu'Hermes est reporté (ADR-18). |
| A4 | Emplacement des jeux | `C:\Games\<nom>`, plus import d'un dossier existant (ADR-12) |
| A5 | Git pour le dépôt du hub | Accord de principe ; à faire au démarrage de la phase 1 |
| A6 | Configuration du profil Hermes `studio` | Reporté au début de la phase 3. La liste exacte des commandes vous sera soumise. |
| A7 | Absence de bac à sable système | Accepté pour l'instant ; à réévaluer si nécessaire |

### Recommandations non bloquantes
- Mettre à jour Git (2.40 date de 2023) et VS Code (1.38). Ce n'est pas nécessaire au hub.
- Ajouter Godot au PATH, ou le placer dans un dossier fixe (par exemple `C:\Tools\Godot\`), plutôt que de le laisser sur le Bureau.
