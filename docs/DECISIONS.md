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
- **Un chantier à la fois par projet (atelier)** : tant qu'un chantier est en cours ou à relire, les suivants sont **en file** (`queued_at`) et partent tout seuls, dans l'ordre, chacun à partir du jeu qui contient les précédents. Le bouton « ▶ Lancer » suit la même règle. ~~Après un arrêt du hub, la file est vidée : rien ne repart sans vous.~~ Remplacé par ADR-61 : la file survit au redémarrage.
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

### ADR-44 : le Jeu express
**Statut** : **Validée** le 16/10/2026. Le directeur créatif veut une fonction de « pur vibecoding » : une idée, de quelques mots à quelques lignes, devient un jeu jouable en 5 à 10 minutes. Elle sert de vitrine quand il montre Nidavellir, et de premier essai pour un jeu. Ses choix (boutons) : 2D ou 3D selon l'idée, et deux vitesses.
- **Parcours** : accueil « Jeu express » (menu Créer, tuile d'accueil) → idée et vitesse → écran en direct (chronomètre, étapes Idée → Code → Test → [Finition] → Jouable, fil des actions du développeur, dernière capture, fiche avec la palette) → le jeu se joue dans le studio, sur PC comme sur téléphone. Ensuite : « Améliorer » (une phrase, nouvelle version), « En faire un vrai projet » (enregistré dans le studio en mode Atelier, le directeur propose de le passer sur Vite avec des tests), ou « Retirer de la galerie » (le dossier reste).
- **Vitesses** : Éclair sur Sonnet (environ 5 min) ; Soigné sur Opus (environ 10 min), avec une passe de finition. Les améliorations passent sur Sonnet. Le modèle est imposé par run (`ExecRequest.model`).
- **Fabrication** :
  - une fiche de jeu en un appel structuré, sans question à l'utilisateur ;
  - un dossier neuf `prototypes/<nom>` dans la racine des jeux, avec Git ;
  - un modèle de départ sans aucune installation : `index.html`, `style.css`, `src/main.js` ;
  - un seul passage du développeur, sans plan, chronométré ;
  - un test par le hub dans un navigateur invisible (petit serveur local, clic, Entrée et flèches, capture). En cas d'erreur, une seule correction automatique, puis un nouvel essai ;
  - un commit à chaque étape.
- **3D** : Three.js est une dépendance du hub (`three@0.180.0`). Il est copié dans `lib/three/` du prototype, avec les modules `controls`, `postprocessing`, `shaders` et `math`, et déclaré par une importmap. Il n'y a rien à télécharger pendant le chantier, où le réseau reste bloqué.
- **Sécurité** : mêmes règles que les chantiers. Le gardien refuse ce qui est interdit (réseau, installation…). Le reste est permis dans le seul dossier du prototype, puisqu'il n'y a pas de plan. Ce sont des runs `XRUN-…` sur les mêmes routes d'agent.
- **Garde-fous** :
  - un seul jeu express à la fois ;
  - refus de lancer si l'abonnement dépasse 90 % sur 5 heures (97 % sur la semaine), pour éviter un échec en pleine démonstration ;
  - durée bornée par passage, au-delà de laquelle on garde ce qui est écrit ;
  - notification sur le téléphone quand le jeu est prêt.
- **Le jeu est servi par le hub lui-même** (`/api/human/express/:id/play/…`, chemins confinés au dossier, `.git` exclu). Il n'y a pas de serveur de développement : c'est ce qui rend le jeu jouable aussitôt.

### ADR-43 : le Directeur artistique (étape 1, avec Midjourney à la main)
**En pause** depuis le 16/10/2026, à la demande du directeur créatif. C'est un élément important du flux de travail, à reprendre à l'étape 2.
**Statut** : **Validée** le 16/10/2026. Le directeur créatif se dit faible en visuel et veut un agent à qui confier idées et moodboards, qui centralise, cherche des références, propose une direction cohérente, fait produire et valider les visuels, puis s'entend avec le développeur pour les brancher. Ses choix (boutons) : la DA a son propre espace dans le projet, on avance par étapes, et la 3D passera par Tripo + Blender. Il n'a pour l'instant que Midjourney, qui n'a pas d'API, et vise à terme une génération locale sur sa carte graphique (RTX 3080 Ti) pour la cohérence.
- **Où vivent les visuels** : dans le dépôt du jeu, sous `studio/art/`, commité par le hub. On y trouve `bible.md` (la bible visuelle), `assets.json` (le manifeste : chaque visuel `A-0001` avec usage, spécifications, statut, prompts, rendus et verdict), `moodboard/` (vos images et `notes.json`) et `production/` (les rendus). `studio/` reste en lecture seule pour le développeur.
- **L'agent** : nouveau rôle de modèle `art_director` (Sonnet recommandé, réglable ; variable `STUDIO_MODEL_ART`). Une discussion par projet (table `art_messages`), onglet « Direction artistique ». Chaque tour est un appel Claude Code qui lit `studio/art/` (images comprises, il les voit) et peut chercher sur le web : `buildChatArgs` accepte désormais `readDir` + `WebSearch`/`WebFetch`, et rien d'autre. Ces appels ont leur propre file, pour ne jamais retarder le directeur ni l'Archéologue. Sa réponse arrive en arrière-plan.
- **Balises** appliquées par le hub : `[[BIBLE]]` (bible complète), `[[ASSET]]` (fiche JSON, nouvelle ou modifiée), `[[MIDJOURNEY: A-0001 | références]]` (prompts à copier et images du moodboard à joindre en `--sref`), `[[NOTE: moodboard/x.png]]` et `[[CHOIX: question]] a | b | c` (questions de goût en boutons, sans réglages techniques).
- **Images** : elles sont déposées par glisser-déposer ou bouton, en PNG, JPEG ou WebP, 15 Mo au plus. Le type est vérifié sur le contenu du fichier, pas sur son nom. Les images sont servies seulement depuis `studio/art`. Celles jointes à un message vont au moodboard et sont citées dans le message (`§IMAGE§`).
- **Validateur artistique** : un rendu déposé sur un visuel est jugé par un appel structuré du même rôle, selon une grille stricte (bible, cohérence, lisibilité à la taille prévue, fiche, défauts). Il répond conforme ou à retoucher, avec ses remarques et un prompt corrigé. Le directeur créatif garde le dernier mot (« Valider quand même », « Refaire »).
- **Vers le jeu** : « Faire intégrer » ouvre une discussion avec le directeur du projet, avec le fichier, l'usage et la consigne de titrer le chantier par l'identifiant. Le directeur voit aussi dans son contexte les visuels validés en attente. Quand un chantier dont le titre ou la consigne cite `A-xxxx` est fusionné, le visuel passe « dans le jeu ». La politique du développeur autorise `cp studio/art/<fichier> <destination>` et `mkdir [-p]` dans la copie, hors zones protégées, car Write ne sait pas écrire une image.
- **Plus tard** : étape 2, génération locale (ComfyUI + Flux installés sur clic, style par référence puis un style entraîné sur les visuels validés, le validateur qui boucle) ; étape 3, la 3D (Tripo pour le modèle, le squelette et les animations à la place de Mixamo, qui n'a pas d'API ; Blender en arrière-plan pour nettoyer, alléger et exporter en `.glb`, et faire un rendu sous tous les angles pour le validateur).

### ADR-45 : l'Atelier de démontage prend en charge Unity (AssetRipper)
**Statut** : **Validée** le 17/10/2026, à la demande du directeur créatif, pour Mycopunk (Unity Mono) et les deux Vampire Survivors (Unity IL2CPP).
- **Outil** : AssetRipper (github.com/AssetRipper/AssetRipper, version Windows x64, environ 45 Mo), ajouté au catalogue fermé et installé seulement sur votre clic, comme GDRE Tools.
- **Pilotage** : AssetRipper n'a pas de ligne de commande, c'est un petit serveur web local. Le hub le lance sans fenêtre (`--headless`, port libre sur 127.0.0.1), lui fait lire le dossier du jeu (`/LoadFolder`), puis exporter le projet Unity dans `jeu/` (`/Export/UnityProject`). Il réessaie l'export tant que la lecture n'est pas finie (3 h au plus), puis arrête le serveur. Le journal d'AssetRipper va dans `assetripper.log`, à côté du démontage.
- **Un seul mode** : AssetRipper exporte tout d'un coup (code, scènes, images, sons). Pour Unity, la page n'affiche donc qu'un bouton « Démonter ».
- **Ce qu'on récupère** : pour Mono, le code C# lisible, et le projet de mod reste possible (`Assembly-CSharp.dll`). Pour IL2CPP, seulement la structure du code (classes, champs, méthodes vides) : l'Archéologue est prévenu et cherche les règles dans les données (`.asset`, `.json`). Pas de projet de mod pour IL2CPP pour l'instant.
- **Carte du jeu** : section « Projet Unity », avec les scènes dans l'ordre du jeu (`EditorBuildSettings.asset`). Les `.asset` (ScriptableObjects, souvent les nombres du jeu) comptent comme données et entrent dans la comparaison entre versions. L'empreinte des mises à jour suit le dossier `_Data`, `Assembly-CSharp.dll` ou `GameAssembly.dll`.
- **Jeux déjà ajoutés** : au démarrage, le hub refait la détection des jeux restés sans outil. Les jeux Unity ajoutés avant ce changement reçoivent donc l'outil sans être retirés puis ajoutés de nouveau.
- **Non vérifié en vrai** : le dialogue avec AssetRipper suit son code source (version 2.0.0) mais n'a pas tourné sur un vrai jeu. Le premier démontage, lancé par le directeur créatif, sert d'essai.

### ADR-46 : le générateur d'images local du Directeur artistique (étape 2 d'ADR-43)
**Statut** : **Validée** le 17/10/2026. Le directeur créatif veut « un workflow de création visuelle propre, qui génère les bons assets, avec validation automatique, et les intègre au jeu ». Il m'a laissé l'ordre des étapes : d'abord les images (elles servent aussi de point de départ à la 3D), puis la 3D (Tripo + Blender), puis l'intégration automatique avec la vérification dans le jeu.
- **Outil** : ComfyUI, version autonome Windows NVIDIA (GitHub Comfy-Org/ComfyUI, environ 2 Go, Python compris), et le modèle Flux.1 dev en fp8 tout-en-un (Hugging Face Comfy-Org/flux1-dev, 17 Go, sans compte). Le tout fait environ 19 Go dans `.data/tools/comfyui`. L'installation se lance **sur votre clic**, en arrière-plan, avec son avancement à l'écran. Un téléchargement interrompu reprend là où il s'était arrêté. La RTX 3080 Ti (12 Go) et les 32 Go de mémoire suffisent pour la version fp8.
- **Fonctionnement** : le hub démarre ComfyUI sans fenêtre (127.0.0.1, port libre) à la première demande. Il envoie le graphe Flux (20 étapes, guidance 3,5) par l'API `/prompt`, puis récupère l'image. Les demandes passent une par une. Le serveur s'arrête après 10 minutes sans demande, pour rendre la carte graphique aux jeux. Son journal va dans `comfyui.log`.
- **Boucle automatique** : la DA écrit `[[GENERER: A-0001 | 1024x1024]] prompt Flux [[/GENERER]]`, en phrases anglaises, avec la « phrase de style » de la bible recopiée mot pour mot. Le hub fait 3 essais, puis le validateur les regarde tous, choisit le meilleur et le juge (`PICK_SCHEMA`). S'il refuse, le hub refait un tour avec le prompt corrigé, et au plus 3 tours. Ensuite, soit le visuel est « Validé », soit le meilleur essai attend votre décision (« Valider quand même », « Refaire »). « Refaire » relance la fabrication. Un bouton « Générer / Regénérer » existe sur chaque fiche.
- **Repli** : tant que le générateur n'est pas installé, la DA continue de donner des prompts Midjourney. Son contexte lui dit lequel des deux utiliser.
- **Pas encore** : référence de style par image (Flux Redux demande un compte Hugging Face), style entraîné (LoRA) sur les visuels validés, détourage (fond transparent) des icônes. Viendront ensuite l'étape 3 (3D) et l'intégration automatique.
- **Non vérifié en vrai** : le dialogue avec ComfyUI suit son API documentée, et la décompression du `.7z` par le `tar` de Windows a été vérifiée. Mais rien n'a été installé ni généré sur le PC : le directeur créatif lance l'installation à son retour.

### ADR-47 : l'atelier 3D du Directeur artistique (Tripo + Blender)
**Statut** : **Validée** le 17/10/2026, à la demande du directeur créatif (« fais tout ce qu'il faut », même jour qu'ADR-46).
- **Quand** : la DA marque un asset `[[MODELE3D: A-0001 | taille 12 | triangles 6000 | animations walk, slash]]`. La taille est la plus grande dimension, en mètres. Avec « squelette » ou des animations, le modèle est animé. Un objet rigide (navire, caisse) n'a ni l'un ni l'autre. On fabrique et on valide d'abord l'image, de face ou de trois-quarts, objet entier et fond uni. Une fois validée (par le validateur ou par vous), elle part seule à l'atelier 3D.
- **Tripo** (service en ligne payant, API v3 `openapi.tripo3d.ai`, d'après le SDK officiel) : envoi de l'image (`/v3/files`), puis modèle (`/v3/generation/image-to-model`, `face_limit` = budget). Si besoin : vérification (`rig-check`), squelette (`rig`) et animations toutes prêtes (`retarget`, 5 au plus, sur place). La clé (`tsk_…`) se colle dans l'onglet Visuels. Elle est vérifiée auprès de Tripo, puis gardée dans `.data/tools/tripo/`, jamais dans un dépôt. **Plafond mensuel** : 2000 crédits par défaut (`STUDIO_TRIPO_MONTHLY_CREDITS`), comptés à partir des crédits que Tripo annonce pour chaque tâche.
- **Blender 4.5 LTS** (environ 400 Mo, téléchargé depuis download.blender.org sur votre clic, dans `.data/tools/blender`), lancé sans fenêtre avec un script. Il allège au budget de triangles, met à la taille, pose au sol et centre le modèle. Il réduit les textures à 1024 px, puis exporte un `.glb` (Y en haut, 1 unité = 1 m, animations comprises) dans `studio/art/models/`. Il prend enfin quatre photos (face, trois-quarts, profil, dos) dans `production/`. Le modèle brut de Tripo n'entre pas dans le dépôt.
- **Validateur 3D** : il compare les photos à l'image de départ et à la bible, et vérifie les mesures, le budget et les défauts. Au plus 2 tours, car chaque tour coûte des crédits. Ensuite, vous tranchez (« Valider la 3D quand même », « Refaire la 3D »).
- **Non vérifié en vrai** : ni Tripo ni Blender n'ont tourné sur le PC (pas d'installation ni de clé en l'absence du directeur créatif). La syntaxe du script Blender est vérifiée, et le reste du circuit est testé avec des outils factices.

### ADR-48 : l'intégration automatique et la vérification dans le jeu
**Statut** : **Validée** le 17/10/2026, à la demande du directeur créatif (« intègre directement au jeu »).
- **Automatique** : un visuel validé part seul au directeur du projet, dans une discussion « Intégrer A-xxxx », que la validation vienne du validateur ou de vous. Pour un modèle 3D, c'est le modèle validé qui part, avec ses mesures et ses animations. En atelier, le directeur lance le chantier sans attendre (ADR-31). « Faire intégrer » reste disponible à la main.
- **Vérification en situation** : à la fusion du chantier, le validateur regarde la capture du jeu prise par les vérifications du hub (ADR-32), copiée dans `production/<id>-en-jeu-<chantier>.png`. Il dit d'abord si le visuel est visible ; s'il ne l'est pas (menu, autre scène), il le dit sans deviner. S'il est visible mais rend mal, une retouche part au directeur, **une seule fois** (discussion « Retoucher A-xxxx dans le jeu »), sans changer le fichier validé. Le résultat s'affiche sur la fiche (« Dans le jeu : … »). Sans capture, la DA le signale.
- La consigne d'intégration demande au directeur de rendre le visuel visible au lancement quand c'est raisonnable, pour que la capture serve. *(Remplacé par la scène vitrine, ADR-49.)*

### ADR-49 : le circuit visuel refait (cadrage, croquis, atelier Blender, scène vitrine)
**Statut** : **Validée** le 20/10/2026, à la demande du directeur créatif (« refais tout le circuit »). Le constat venait des premières fabrications réelles du Grouillot et du Titan (survivor-destiny). Le validateur refusait ce que Flux ne sait pas faire : un code couleur exact, compter des pattes, le côté d'une épaulière, des rivets. Il y a eu 9 images refusées pour l'un et 36 pour l'autre, puis un « valider quand même » par lassitude. Les questions de goût arrivaient pendant la fabrication et ne changeaient plus rien. Blender ne faisait que mesurer et photographier, sans toucher aux matières : les modèles sortaient en « plastique bleuté », avec des photos mal orientées. Le 2e tour 3D repayait Tripo sans rien pouvoir corriger. La marche du Grouillot avait disparu. La capture « dans le jeu » montrait le menu. Modèle suivi : le circuit Blender + Tripo décrit sur Twitter (Blender comme atelier où Claude travaille en regardant le résultat, Tripo seulement pour les objets complexes).
- **1. Cadrage** : toutes les questions de goût sur un visuel, d'un coup, avant toute fabrication. Une réponse de la DA qui pose une question ne lance rien : le hub ignore alors `[[CROQUIS]]`, `[[GENERER]]` et `[[MODELE3D]]` et l'écrit (« fabrication en attente de vos réponses »).
- **2. Croquis** : `[[CROQUIS: A-xxxx | format]] # nom \n prompt --- …` donne 2 à 4 directions. Le hub en fait une image chacune, sans validateur, et vous demande laquelle d'un clic, dans la discussion ou sur la fiche (« Choisir »). Votre clic lance la fabrication sans tour de la DA. « Aucun » relance la discussion.
- **3. Fabrication** : le croquis choisi est lui-même un candidat, avec deux variantes de lui (Flux image vers image, `denoise` 0,5, puis 0,75 au 2e tour). Il y a **deux tours** au plus (trois avant). Pour un modèle 3D, le validateur juge **la forme** (silhouette, pose de face, netteté, ni halo ni ombre que Tripo recopierait), pas la peinture, car Blender la refait. Il connaît les limites de Flux, qui ne bloquent jamais à elles seules. Au dernier tour, un essai « utilisable » est gardé au lieu de vous faire trancher sur des détails. Les prompts nomment les couleurs en mots : Flux ignore les codes hexadécimaux.
- **4. Atelier Blender** : Tripo travaille **une seule fois** (rien pour un objet `simple` : mur, caisse, étagère, modélisé directement). Blender prépare une scène hors du dépôt (`.data/tools/blender/atelier/`). L'**artisan 3D** la retouche ensuite pas à pas, douze pas au plus. À chaque pas, il regarde cinq photos (face, trois-quarts, profil, dos, vue de jeu de haut et de loin) et les mesures, puis rend un peu de Python. Le hub l'exécute dans Blender (`workshop.py`, liste noire et imports limités, SECURITY §9). Ses outils : `tourner`, `matiere` (mat), `quantifier(palette)` (aplats aux couleurs de la fiche, points isolés effacés), `lueur(couleur)` (émissif), `aplat`, `nouveau_materiau`, `boite`, `cylindre`. Le hub exporte le `.glb` (devant vers +Z, Y en haut, 1 u = 1 m, taille, budget et pose au sol réappliqués). Le validateur 3D dit si la **forme** est bonne : si oui, une 2e passe de l'artisan reprend la même scène avec ses remarques, sans repayer Tripo. Sinon, il s'arrête et propose « Refaire la 3D » ou de nouveaux croquis. Essai réel le 20/10/2026 sur le Titan : orientation, trois aplats, visière lumineuse et animations conservées.
- **Animations** : l'animation demandée suit la forme que Tripo reconnaît vraiment. Une marche « 4 pattes » sur un modèle vu à 8 pattes devient la marche à 8 pattes au lieu de disparaître. Ce qui manque est dit (fiche et discussion). **Pas de Mixamo** : il n'a pas d'API, et Tripo a déjà une bibliothèque d'une centaine d'animations de bipède, plus un squelette au format Mixamo si besoin un jour.
- **5. Dans le jeu** : la consigne d'intégration demande au chantier d'ajouter une fois pour toutes une **scène vitrine**. L'adresse `?vitrine=A-xxxx` montre l'asset seul, dans les conditions du jeu, à côté du joueur, animé. Après la fusion, le hub photographie cette vitrine sur le jeu lui-même (`production/<id>-vitrine-<chantier>.png`). À défaut, il reprend la capture de lancement.
- **Écarté** : un serveur MCP « blender » donné à l'agent, comme sur Twitter. `--safe-mode` coupe les serveurs MCP (vérifié), et le retirer affaiblirait les appels. La boucle pilotée par le hub fait la même chose sans outil d'exécution pour l'agent.

### ADR-50 : la planche avant la 3D (quatre vues)
**Statut** : **Validée** le 20/10/2026, à la demande du directeur créatif (« on met ça en place »). Avec une seule image de face, Tripo invente le dos et les côtés : c'était le défaut du Titan (« dos incohérent », profil voûté).
- **Quand** : tout modèle 3D qui passe par Tripo (pas les objets simples). Il n'y a aucune étape de plus pour vous : la planche s'affiche dans la discussion et sur la fiche.
- **Comment** : Tripo dessine les quatre vues (face, gauche, dos, droite) à partir de l'image retenue (`/v3/generation/image-to-multiview`). Le validateur juge la cohérence et la forme, pas la couleur : même sujet sous les quatre angles, pièce asymétrique toujours du même côté du corps, dos plausible. Il peut demander **une** retouche par vue fautive, en anglais (`/v3/generation/edit-multiview`), puis la planche retouchée est rejugée pour information. La 3D est ensuite construite à partir des quatre vues (`/v3/generation/multiview-to-model`, modèle `v3.1-20260211`, réglable par `STUDIO_TRIPO_MULTIVIEW_MODEL`).
- **Ensuite** : la planche est rangée dans `production/<id>-planche-<vue>`, copiée dans l'atelier Blender (`vue-face`…, l'artisan compare son modèle à chaque angle) et citée au validateur 3D.
- **Repli** : si la planche échoue (Tripo refuse, vue manquante, validateur en panne), le modèle est tiré de l'image seule, comme avant, et l'étape le dit.
- **Coût** : quelques crédits Tripo de plus par modèle (planche et retouche éventuelle), à mesurer au premier essai réel, et un appel du validateur de plus. Flux n'est pas concerné.
- **Non vérifié en vrai** : les formes des requêtes suivent le nœud ComfyUI officiel de Tripo (`comfy_api_nodes/nodes_tripo.py`, v0.41.0), mais aucune planche n'a encore été demandée à Tripo depuis le hub.

### ADR-51 : Flux Kontext, retouches par consigne et air de famille
**Statut** : **Validée** le 20/10/2026, à la demande du directeur créatif (bouton « Oui, ajoute-le »). Flux ne sait pas regarder une image de référence. Il repartait donc de zéro pour un détail (une épaulière du mauvais côté, des rivets), ce qui a coûté 36 images au Titan, et rien ne garantissait un air de famille entre les personnages.
- **Outil** : Flux Kontext dev (fp8), dans le ComfyUI déjà installé. Le modèle (11,9 Go, `Comfy-Org/flux1-kontext-dev_ComfyUI`), ses encodeurs de texte (`clip_l`, `t5xxl_fp8_e4m3fn`, `comfyanonymous/flux_text_encoders`) et son décodeur (`ae`, `Comfy-Org/Lumina_Image_2.0_Repackaged`) viennent de dépôts publics, sans compte (vérifié le 20/10/2026), soit environ 17 Go. Ces fichiers sont séparés pour ne pas charger aussi le Flux tout-en-un : cela saturerait les 32 Go de mémoire. L'installation se fait **sur votre clic** (onglet Visuels, une fois le générateur installé) et reprend là où elle s'était arrêtée. Licence : celle de Flux dev, la même que le générateur actuel.
- **Graphe** : celui du modèle de ComfyUI. Chaque image passe par `FluxKontextImageScale`, `VAEEncode` puis `ReferenceLatent` (les références s'enchaînent), avec une guidance de 2,5 et un négatif `ConditioningZeroOut`. La première image sert de toile.
- **Retouches** : quand Kontext est prêt, le validateur peut donner une consigne `edit` en anglais si le meilleur essai est proche et que ses défauts sont localisés. Le tour suivant fait alors trois retouches de cet essai au lieu de trois images neuves.
- **Air de famille** : `| ref A-xxxx` (un asset retenu) ou `| ref moodboard/x.png` sur `[[CROQUIS]]` et `[[GENERER]]`. Les croquis et les essais sont alors dessinés dans le style de cette image (`styleRef` sur la fiche, citée au validateur). Sans Kontext, la référence est ignorée et la DA le sait.
- **Non vérifié en vrai** : le graphe suit les nœuds de ComfyUI v0.41.0 (tous présents), mais Kontext n'est pas encore téléchargé : la première retouche réelle sert d'essai.

### ADR-52 : l'artisan 3D sur son propre modèle, le meilleur rig et l'avancement visible
**Statut** : **Validée** le 20/10/2026, à la demande du directeur créatif, pendant la première fabrication réelle du Titan avec le nouveau circuit.
- **Modèle de l'artisan** : nouveau rôle `art_workshop`, Fable par défaut, réglable à part dans « Le studio en direct », sous le Directeur artistique (« Artisan 3D (Blender) »). La discussion et les validations gardent le réglage `art_director` (Opus aujourd'hui). L'orchestrateur prend `role: "artisan"` pour les pas de l'atelier. Leur consommation reste comptée sous le Directeur artistique.
- **Rig et animations** : un humanoïde garde le squelette Tripo v1.0, fait pour lui. Ses animations viennent maintenant de la **bibliothèque des bipèdes** (`preset:biped:*`, plus de 90 mouvements faits pour ce squelette : coups reçus, chute, sort, victoire…), avec repli sur l'animation générique. Les autres formes gardent le squelette v2.5 et leur marche. Il y a **8 animations** au plus (5 avant). Les noms montrés au jeu restent courts (« walk »). Un modèle à squelette est demandé en géométrie et texture **détaillées**, car il se déforme en bougeant ; cela coûte quelques crédits de plus. La DA est invitée à prévoir au moins attente, marche, course, coup reçu et chute.
- **Avancement visible** : chaque fiche en fabrication montre les étapes du circuit (croquis, image de référence, planche, modèle Tripo, atelier Blender, contrôle 3D, dans le jeu), l'étape en cours, la phrase en clair, ce que l'artisan dit faire à son pas, et la dernière image produite : croquis, essai, planche, photo de l'atelier ou rendu final. Les photos de l'atelier restent hors du dépôt et sont servies une à une (`/art/atelier/:id/:nom`, seulement les noms `photo-N-<vue>.png`). L'onglet se rafraîchit toutes les 2,5 s pendant une fabrication.
- **Plus tard** : une photo du modèle en mouvement (une image prise au milieu de chaque animation) pour que le validateur juge aussi la déformation. Elle demande de modifier le script Blender de l'atelier, ce qui ne se fait pas pendant une fabrication. *(Fait avec ADR-53.)*

### ADR-53 : la figurine, des pièces nettes sur le squelette de Tripo
**Statut** : **Validée** le 20/10/2026, à la demande du directeur créatif (« résultat abominable »). Le Titan est passé par tout le circuit, avec une planche cohérente, deux passes de l'atelier et 115 crédits Tripo. Pourtant le corps de Tripo reste une pâte à modeler bosselée, et ses limites de couleur suivent les triangles. La DA a proposé d'abandonner Tripo et de construire le Titan en pièces. L'idée est retenue, mais **sans perdre le squelette ni les animations**, que l'atelier ne sait pas faire seul.
- **`[[MODELE3D: … | figurine]]`** : pour un personnage ou une créature aux formes dures (armure, robot, carapace). Tripo ne sert plus qu'au squelette et aux animations, sans qualité détaillée inutile. Son corps devient un **calque** : il est caché sur les photos, retiré à l'export, et il donne seulement les tailles. L'artisan construit le corps en **pièces d'une seule couleur**, sans texture. Chaque pièce est **accrochée à un os** (parent d'os) : elle suit son os, sans peau qui s'étire. Dans le `.glb`, chaque pièce est enfant du nœud de son os, et Three.js l'anime telle quelle (vérifié sur l'export du Titan).
- **Reprise sans repayer** : un asset qui a déjà un modèle Tripo avec squelette, et dont la scène d'atelier existe, est repris tel quel (mode `calque` du script). Le passage en figurine relance l'atelier tout seul après le tour de la DA. La planche existante est réutilisée.
- **Outils de l'atelier** (`workshop.py`) : `squelette()` (os, têtes, queues), `zones()` (pour chaque os, la boîte du calque qu'il porte, les os de torsion comptés avec leur os principal), `membre(nom, sur, epaisseur…)` (une pièce couchée le long d'un os), `piece(nom, forme, dims, position, rotation, couleur, sur, biseau, lueur)`, `fixer`, `pieces()`, `calque(visible)`. Les pièces se posent en pose de repos. Le paramètre s'appelle `sur`, car le garde-fou refuse le mot `os`. Une figurine a **30 pas** par passe (12 sinon).
- **Photos en mouvement** : chaque série de photos ajoute jusqu'à trois poses, prises au milieu des animations (marche ou course, coup reçu, coup d'épée…), avec la caméra qui suit le modèle. Le validateur juge aussi la déformation. Dans Blender 4.5, une action ne joue que par son « slot » et l'emporte seulement si le NLA est coupé : les deux sont réglés le temps des poses. Les `.glb` exportés, eux, animaient déjà bien leurs os (vérifié : 21 à 23 os sur 41 bougent par animation).
- **Essai réel** : sur une copie de la scène du Titan, 18 pièces posées en un pas ont donné 2700 triangles, une course et un coup d'épée corrects, et un export avec les 5 animations.
- *(Abandonnée par ADR-54.)*

### ADR-54 : la qualité vient de Tripo, Blender range sans repeindre
**Statut** : **Validée** le 20/10/2026. Le directeur créatif a donné carte blanche (« pour que ce soit 10/10 »). Bilan de la figurine sur le Titan : deux passes, 31 appels Fable (l'équivalent de 26 $ au tarif API), et un jouet en mousse noté 3/10. Le rapport qualité/coût est mauvais. La comparaison des rendus est sans appel : le meilleur Titan reste l'ancien rendu **brut** de Tripo (ADR-47). Ce sont nos retouches qui l'ont abîmé : le repeint en aplats (`quantifier`) a fait baver les couleurs le long des triangles, et le budget de 6000 triangles a écrasé la forme.
- **La figurine est retirée** du vocabulaire de la DA, de la lecture des directives et du hub (reprise de scène, calque, relance automatique). Une ancienne fiche qui la porte passe par Tripo comme les autres. Les outils de pièces de `workshop.py` restent, pour les objets simples et les accessoires.
- **Tripo au mieux** :
  - modèle `v3.1-20260211` par défaut, au lieu de v2.5 qui recevait en plus un `geometry_quality` qu'il ne connaît pas ;
  - texture **détaillée** toujours, et géométrie détaillée pour un modèle animé ;
  - depuis une seule image, texture **v3.5 avec `delight`** (l'éclairage peint dans l'image est retiré) et `orientation: align_image` (le modèle regarde comme l'image) ;
  - textures gardées en 2048 px pour un personnage animé, 1024 sinon.
- **Budgets réalistes** : la DA vise 15 000 à 25 000 triangles pour un personnage principal, 8 000 à 15 000 pour un ennemi et 1 000 à 5 000 pour un objet. Three.js les affiche sans peine.
- **L'artisan range, il ne repeint plus** :
  - sur un modèle Tripo, il a **4 pas par passe** (orientation, matière, lueurs, débris) et l'interdiction de repeindre ou de remodeler le corps ; « fini » au premier pas si tout est juste ;
  - un objet simple garde 12 pas ;
  - consigne d'économie : ne relire que les photos utiles.
  - Au pire, deux passes coûtent 8 appels, au lieu de 24 à 60.
- **Un pas trop long ne ruine plus l'atelier** : l'artisan a 15 minutes par pas (8 auparavant). Un pas perdu est recommencé plus petit. Au second échec de suite, la scène est exportée telle quelle et le validateur juge.
- **Validateur** : la peinture de Tripo (nuances, détails peints) est voulue ; il juge sa fidélité à l'image. Une 3D déjà faite ne repart plus d'une directive : la DA renvoie vers « Refaire la 3D », qui repaie Tripo.
- **Titan** : sa fiche est remise sur Tripo, à 20 000 triangles, sans consigne de figurine, et décrite d'après l'image validée. Le compte Tripo n'a plus que 45 crédits : il en faut environ 130 pour le refaire avec squelette et animations.

### ADR-55 : teintes justes, photos debout, finition reprise sans Tripo, vitrine exigée
**Statut** : **Validée** le 20/10/2026, dans la suite de la carte blanche. Le premier essai réel de l'ADR-54 coûte 145 crédits Tripo et seulement 2 appels Fable (0,38 $). Le Titan est une vraie armure, validé du premier coup et intégré. Je le note 7/10, pour quatre défauts constatés :
- l'armure est gris craie et bleutée ;
- la visière est ambre et ne brille pas ;
- les photos le montrent voûté ;
- la capture du jeu montre l'écran d'accueil.
- **La teinte** : Tripo peint son armure en métal. `matiere()` retirait le métal sans rien changer à la couleur, et une couleur de métal devenue peinture mate paraît bien plus claire. `matiere()` assombrit désormais chaque pixel selon la carte de métal, avant de la retirer (`assombrir=0.35`).
- **Deux outils pour l'artisan** :
  - `couleurs(n)` donne les couleurs vraiment peintes, échantillonnées aux coordonnées UV des faces, donc sans les vides de l'atlas, avec leur part de la surface ;
  - `teinter(de, vers, tolerance)` déplace la teinte moyenne d'une zone vers la fiche en gardant ses détails, avec un fondu sur les bords. C'est la seule retouche de peinture permise.

  `lueur` s'applique sur la couleur réellement peinte, donc après `teinter` si besoin. Essai réel sur une copie de la scène du Titan : `couleurs` trouve l'armure #525657 et la visière #BCA97E ; après `teinter` et `lueur`, l'armure est gris-pierre chaud, la combinaison charbon, et la visière ivoire allumée (2050 pixels).
- **Photos debout** : les quatre photos principales et la vue de jeu montrent le début de l'attente, ou à défaut la pose de repos. Toutes les pistes NLA jouées ensemble voûtaient le personnage. Les poses en mouvement restent à part.
- **Validateur plus exigeant, sans bloquer** : `ok` veut dire qu'il n'y a plus rien à retoucher. Une teinte ou une lueur à reprendre donne `mineur`, et l'artisan fait la seconde passe. Si ces retouches mineures résistent à la dernière passe, le modèle, jouable, part quand même au jeu (« jouable, quelques retouches mineures restent »), sans « Valider quand même ».
- **« Reprendre la finition »**, un bouton sur la fiche (`POST …/art/assets/:id/retouch`) : l'artisan reprend la scène d'atelier gardée, avec les dernières remarques du validateur, sans Tripo ni préparation. Le modèle est jugé puis repart au jeu. S'il y était déjà, la demande d'intégration dit de remplacer l'ancien fichier sans rien changer d'autre.
- **Vitrine exigée** : le chantier T-0043 a branché le Titan sans faire la scène vitrine, et la capture a montré l'accueil. Une vitrine qui ne montre pas l'asset lance maintenant, une fois, un chantier dédié pour la faire marcher, vérifiée par un test de bout en bout. La consigne précise aussi « dès le chargement, sans menu ni écran d'accueil ».
- **Résultat réel** : finition du Titan en 6 appels Fable (≈ 1 $), 0 crédit Tripo, armure gris-pierre et visière allumée ; version 8 intégrée (T-0044) et vitrine refaite (T-0045), le validateur le voit « bien » dans le jeu. Note 8,5/10 ; restent une combinaison un peu bleutée et deux défauts de forme venus de Tripo (visière en fente, franges aux genoux).

### ADR-56 : les animations jugées, coupées, et remplacées sans refaire le modèle
**Statut** : **Validée** le 20/10/2026 (« on travaille de la même manière pour les animations »). Bilan des animations du Titan, sur des bandes de six images rendues dans Blender : **4/10**. « hurt » est une chute qui reste au sol 13,8 s (en jeu, à chaque coup reçu, le Titan se couchait) ; « slash » est un enchaînement de 6,6 s accroupi ; « run » est un sprint penché pour un chevalier lourd ; idle et jump vont. Personne ne regardait les mouvements, la DA choisissait des noms à l'aveugle, rien n'était découpé.
- **Tour des outils** (recherche du 20/10) : Tripo garde 90 mouvements tout faits pour humanoïdes à 10 crédits, sans sur-mesure. **Meshy** pose un squelette sur un `.glb` importé (5 crédits), a 600 mouvements (3 crédits) et des mouvements **décrits en mots** (3 à 10 crédits), API complète, Pro 19 €/mois ; qualité non vérifiée. Mixamo : gratuit mais sans API, en fin de vie. HY-Motion (Tencent, ouvert) demande 24 à 26 Go de mémoire vidéo : la RTX 3080 Ti en a 12. Kimodo (NVIDIA) tient en mémoire, mais sa variante humanoïde est sous licence recherche. Décision du directeur créatif : étape 1 gratuite maintenant, puis essai Meshy sur le Titan.
- **Étape 1, faite** :
  - `bandes()` dans `workshop.py` : une bande de six images par animation à chaque export, caméra calée sur le squelette posé (la boîte du maillage ne suit pas la déformation ; le sol de la vue de jeu est retiré après la photo, sinon il faussait tout). Les bandes sont montrées dans la discussion et sous le modèle dans l'onglet Visuels.
  - **Validateur d'animations** (`ANIM_VALIDATOR_SYSTEM`) : sens, durée (repères de jeu : frappe 0,5 à 1,5 s, cycle de course 0,8 à 1,5 s…), allure. Il rend des consignes en secondes pour l'artisan, et des **remplacements** (nom du catalogue) quand le sens est faux. Son verdict se combine à celui du modèle (`ok`, `mineur`).
  - **Ciseaux de l'artisan** : `animations()`, `couper(nom, debut_s, fin_s)` (poses aux bords conservées, piste NLA refaite), `vitesse(nom, facteur)`. Vérifié dans Blender sur la scène du Titan : slash coupé de 0,3 à 1,6 s donne une seule frappe ; run à 0,8 passe de 1,23 à 1,54 s. L'artisan ne crée ni ne modifie une pose.
  - **Catalogue** (`ANIMATION_CATALOG`) dans la consigne de la DA et du validateur : les 90 mouvements par sens, avec les pièges (hurt = chute, slash = enchaînement) et les durées mesurées.
  - **Remplacer sans refaire** : la tâche Tripo du squelette est gardée (`model.rigTask`). Une directive MODELE3D qui change la liste d'animations d'un modèle fait ne repaie que les animations ajoutées (10 crédits chacune, `animate`), Blender les range dans la scène gardée (mode `animations`, les autres retirées), l'artisan applique les consignes, le validateur rejuge, et le fichier remplace l'ancien dans le jeu. Si Tripo a oublié le squelette (ses tâches expirent), le modèle est refait en entier. Une animation au sens faux arrête la passe et dit quoi demander à la DA.
- **Titan** : à dire à la DA « remplace hurt par hit_to_body_01 » (10 crédits) ; le validateur fera couper slash et ralentir run.
- **Étape 2, à venir** : Meshy (clé API du directeur créatif), essai sur le Titan pour une course « lourde et droite » décrite en mots, jugé sur bandes.

### ADR-57 : le Concepteur transmet les chantiers de toutes les étapes
**Statut** : Retenue le 22/10/2026, sur constat du directeur créatif : « transmets » n'envoyait que l'étape 1 ; les étapes suivantes restaient du texte dans le dossier et n'arrivaient jamais en chantier, d'où des conceptions à moitié réalisées. Remplace le choix du 17/10 (étapes suivantes lancées à la main).
- Les chantiers du Concepteur couvrent **toutes** les étapes de la section « Étapes », dans l'ordre, chacun avec le nom de son étape (`etape`). Plafond relevé de 12 à 40.
- Pour limiter le coût des tours de cadrage : consignes d'une ou deux phrases tant que la conception n'est pas prête, complètes (environ 800 caractères) dès qu'elle l'est.
- « Transmets » crée tous les chantiers ; en atelier ils partent un par un, dans l'ordre (ADR-31). Chaque consigne commence par « Étape : … ». Le panneau et la discussion les regroupent par étape.

### ADR-58 : une vraie étape de conception visuelle, en images
**Statut** : Retenue le 22/10/2026 (« fais tout, mais que le workflow de A à Z soit fluide, pas de données perdues, des informations réutilisées : une vraie étape de conception visuelle »). Constat sur Destiny Survivor (≈ 130 messages relus) : chaque clic sur une question envoyait la réponse seule, le DA reposait les autres (« Quelle place pour les couleurs ? » trois fois) ; il mêlait des questions hors sujet (carte 3 en plein ennemi, « quel visuel ensuite ? ») ; il demandait en mots ce qui se juge à l'œil (« gris-pierre chaud ou brun froid ? ») ; rien ne gardait les réponses.
- **Questions** : on choisit toutes ses réponses puis un seul envoi ; l'option choisie reste marquée dans l'historique. Règles du DA : seulement le sujet en cours, jamais une question tranchée, pas de planning parmi les questions de goût, et une question visuelle est **illustrée** (« libellé => prompt Flux » ou « => moodboard/x.jpg ») : le hub dessine une vignette 512×512 par option avant d'afficher la question (8 au plus par message, dans `choix/`). Sans générateur, les options restent en mots.
- **Planche de références** (`[[REFERENCES: thème]] adresse | titre | ce qu'on en prend`) : le hub télécharge l'image, ou l'image d'aperçu de la page (og:image), dans `moodboard/web-…`, avec sa source. Adresses publiques seulement (pas la machine ni le réseau local, redirections revérifiées), PNG/JPEG/WebP, 8 Mo au plus. Vous dites image par image « J'aime » ou « À éviter », plus un mot ; le DA le reçoit en message. Ce sont des inspirations, jamais des images du jeu.
- **Duel de styles** (`[[STYLES: sujet]]`) : un même sujet, une même graine, 2 à 4 styles (`styles/`) ; un clic, et le style retenu devient la référence `| ref style` des visuels ; le DA met la bible à jour (phrase de style).
- **Rien ne se perd** : `studio/art/direction.json` (commité dans le jeu) garde les choix (question, réponse, image), les planches et les avis, les duels et le style retenu. Le DA le reçoit à chaque tour (`<direction_visuelle>`, avec l'étape où l'on en est : intentions, références, styles, bible, visuels). Pour un projet d'avant, il est rempli la première fois depuis l'historique de la discussion ; un projet qui a déjà une bible continue ses visuels, planches et duels restent possibles pour enrichir.
- **Onglet « Direction »** (remplace « Bible ») : les étapes, le style du jeu, la palette en pastilles (codes de la bible), vos choix en vignettes, « On s'en inspire » et « On évite », les visuels validés, puis le texte de la bible. Le moodboard montre la source des images du web et l'avis, modifiable. L'onglet ouvert au départ est choisi une fois (Direction tant que rien n'est posé, sinon Visuels) et ne change plus tout seul.
- Les croquis d'un visuel (ADR-49) deviennent eux aussi une question illustrée.

### ADR-59 : le Concepteur confie aussi le travail visuel au Directeur artistique
**Statut** : Retenue le 22/10/2026 (« si je demande au concepteur de refaire la map, il faut aussi des assets graphiques : qu'il donne également le travail au directeur artistique »).
- Le Concepteur liste les **visuels** du projet (`visuels` : clé V1…, nom, type, usage, contraintes ; 25 au plus) quand le projet change ce qu'on voit, sans redemander ce qui existe : il reçoit la liste des visuels du projet. Chaque chantier cite les clés dont il dépend. La page de conception a un onglet « Visuels ».
- À « transmets », avant les chantiers : une fiche « proposé » par visuel chez le DA (numéros A-xxxx), et un message au DA (dossier de conception, fiches) qui déclenche son tour : il cadre le style avec vous (questions illustrées, croquis, ADR-58) avant toute fabrication.
- Le développement **n'attend jamais** un visuel : chaque chantier concerné reçoit les numéros des visuels à venir et la consigne de poser un visuel provisoire facile à remplacer. Le vrai visuel entre dans le jeu par son propre chantier d'intégration une fois validé (circuit existant, ADR-48).

### ADR-60 : un visuel validé entre dans le jeu au bon moment
**Statut** : Retenue le 22/10/2026 (« le DA génère les assets en parallèle : est-ce qu'ils vont se parler pour déposer les assets dans le jeu, sans que ce soit trop tôt pour le dev ou trop tard ? »).
- Constat : un visuel validé partait aussitôt chez le directeur, et son chantier d'intégration se mettait **au bout** de la file. Deux défauts en découlaient. D'abord, il passait après tous les chantiers de la conception, y compris les « corrections finales ». Ensuite, il pouvait arriver avant que le jeu ait la place prévue. Dernier piège : un chantier qui posait un provisoire citait le numéro du visuel, et sa fusion faisait passer le visuel pour « intégré ».
- **Trop tôt** : si des chantiers de la conception posent un provisoire pour ce visuel (section « Visuels confiés au Directeur artistique, pas encore faits ») et qu'aucun n'est encore fusionné, l'intégration attend le premier dans l'ordre de la file. L'attente est notée sur la fiche (`waitsFor`) et annoncée par le DA. Une fois ce chantier fusionné, la demande part et dit au développeur quel chantier a posé le provisoire à remplacer. Si tous ces chantiers sont annulés ou échouent, le visuel part sans attendre. « Faire intégrer » à la main n'attend jamais.
- **Trop tard** : un chantier dont le titre commence par « A-xxxx » passe devant la file d'attente. Le chantier en cours n'est jamais interrompu. Les chantiers suivants trouvent le vrai visuel déjà branché, et leur consigne leur dit de s'en servir plutôt que d'un provisoire.
- La fusion d'un chantier qui pose un provisoire ne fait plus passer un visuel en « intégré » : pour ce chantier, seul son titre compte, pas sa consigne.


### ADR-61 : redémarrer le hub ne casse rien
**Statut** : Retenue le 22/10/2026 (« j'ai peur de tout casser puisque les chantiers s'enchaînent et le directeur artistique travaille en même temps »).
- Constat : un redémarrage mettait le chantier en cours en échec et vidait la file : 20 chantiers redevenaient des brouillons à relancer un par un. Les travaux du DA en cours (croquis, fabrication, planches, duels) étaient perdus en silence, et une conception « en réflexion » restait bloquée.
- **La file est gardée** et repart d'elle-même quand le hub est prêt (fin de l'ADR-31 « file vidée »). Un chantier d'atelier coupé en plein travail est annulé et **repart de zéro sous un nouveau numéro, en tête de file**. Seule une intégration de visuel (ADR-60) passe devant lui. Sa discussion le dit (« ↻ … »). Les chantiers hors atelier gardent l'ancien comportement : ils passent en échec.
- **Le DA note ses travaux longs** (table `art_jobs`) pendant qu'ils durent. Au démarrage, croquis, fabrications, planches et duels repartent, et un message resté sans réponse en reçoit une. La 3D ne repart pas seule, parce que Tripo se paie : le DA le dit, et « Fabriquer la 3D » la reprend.
- Constaté au passage : le DA ne lit que `studio/art/`, il n'avait donc pas pu ouvrir le dossier de conception transmis (ADR-59). Le dossier y est désormais copié (`studio/art/conceptions/`).
- **Une conception coupée** vous revient avec un mot : « renvoyez votre dernier message ». Elle ne repart pas seule, car une transmission coupée en route ne doit pas créer les chantiers deux fois.

### ADR-62 : la file des visuels, la mise de côté, et Fable en renfort de l'atelier 3D
**Statut** : Retenue le 22/10/2026 (« s'assurer de ne pas perdre en qualité avec Opus sur la 3D ; un bouton pour retirer les visuels en attente, aujourd'hui je ne veux pas qu'on s'occupe de A-0003 et A-0004 ; comment je lance les chantiers visuels, et qu'ils s'intègrent au workflow du directeur »).
- **Qualité 3D** : l'atelier passe sous Opus (choix du 22/10), et le validateur ne change pas : c'est toujours lui qui juge chaque passe. Si la finition résiste aux deux passes, une **troisième passe se fait avec Fable en renfort**, sans repayer Tripo. Ce renfort n'existe que si l'atelier n'est pas déjà réglé sur Fable. Le journal note le modèle de chaque passe (`art.model_validated` / `art.model_rejected`, champ `model`), ce qui permet de comparer. Premier constat réel : le kit A-0006, refusé deux fois sous Fable, a été validé à la deuxième passe d'une retouche sous Opus.
- **La file des visuels**, construite comme celle des chantiers :
  - Les fiches proposées sont rangées dans l'ordre où les chantiers en file les attendent ; celles qu'aucun chantier n'attend viennent à la fin.
  - Le hub en confie **une à la fois** au Directeur artistique, par le message « (File des visuels) Occupe-toi maintenant de A-xxxx… ». Il la mène jusqu'à la validation.
  - La file avance seulement quand rien n'est en cours : ni fabrication, ni jugement, ni réponse, ni question en attente de la vôtre, ni visuel confié qui attend votre avis. Elle attend aussi quand la jauge d'abonnement est presque pleine, comme les chantiers.
  - **« Lancer maintenant »** confie tout de suite une fiche, avant son tour.
  - La fiche affiche sa place dans la file et le chantier qui l'attend. La DA voit la file dans son contexte, et ne lance pas d'elle-même la fabrication des fiches suivantes.
- **« Mettre de côté »** : un visuel pas encore validé prend le statut `ecarte` (« Mis de côté »). Il sort de la file. La DA sait qu'elle ne doit pas y toucher, et ni ses balises ni la fabrication ne le relancent. **« Remettre dans la file »** le rend « proposé ».
- Au passage : les mesures d'une fiche en pixels sont dites en pixels au validateur 3D et dans la discussion, plus en mètres.

### ADR-63 : l'atelier 3D connaît sa version de Blender et mesure ce que les photos cachent
**Statut** : Retenue le 22/10/2026, inspirée de l'article « Opus 5.5 Writes Blender Python for the Wrong Blender » (@0xCodio, 11/10/2026).
- L'article fait deux constats. D'abord, une IA écrit souvent pour une autre version de Blender que celle installée. Ensuite, un rendu ne montre pas tous les défauts : faces à l'envers, morceaux détachés, faces nulles. Les règles d'impression 3D de l'article ne nous concernent pas.
- **Version** : l'artisan sait qu'il travaille sous **Blender 4.5 LTS (Python 3.11)**, la version que le hub installe, et pas sous Blender 5.
- **Contrôle géométrique** (`controle()` dans workshop.py) : il compte, par objet, les faces à l'envers (seulement sur les morceaux fermés), les petits morceaux détachés (moins de 2 % de la diagonale, quand un objet en a plusieurs), les faces nulles et les arêtes ouvertes.
  - `mesures()` le rend à chaque pas de l'artisan. `reparer()` remet les faces à l'endroit, supprime les petits morceaux détachés et les faces nulles.
  - L'export le transmet au validateur. Faces à l'envers ou débris : le modèle n'est pas « ok », mais « forme_ok », donc réparable dans Blender. Des arêtes ouvertes seules sont sans gravité pour un jeu.
  - Vérifié sur Blender 4.5.14 : 2 faces retournées et un débris détectés, puis réparés.

### ADR-64 : « À vous de jouer », la chaîne de production et le moniteur
**Statut** : Retenue le 22/10/2026 (« 2-3 upgrades visuelles » ; « un petit monitoring de qui tourne, ressources du PC, consommation en live »).
- **« À vous de jouer »** : une cloche « n à vous » (en bas à droite sur PC, dans la barre du haut sur téléphone) ouvre la liste de tout ce qui attend votre action, tous projets confondus. Chaque ligne mène au bon endroit. Elle comprend désormais :
  - un chantier qui attend votre mot (le lien ouvre sa discussion) ;
  - une question du Directeur artistique sans réponse ;
  - un croquis à choisir ;
  - une 3D ou une image à trancher, et un rendu à valider (`ArtService.waiting`).
- **La chaîne de production** (panneau « Chantiers ») : la file s'affiche dans son vrai ordre (l'intégration de visuel passe devant), avec « n° k dans la file ». Un chantier repris après un redémarrage porte la mention « ancien T-xxxx ». Sous chaque chantier, les visuels qu'il attend ont une étiquette d'état : provisoire, chez le DA, validé, en intégration, dans le jeu, mis de côté.
- **Le moniteur** (un seul bandeau en haut de la page du projet, et dans « En direct », `GET /studio/monitor`, interrogé toutes les 5 s) :
  - la file : en cours, en attente de votre mot, ou « ⏸ en pause, jauge à n %, repart seule à HH:MM » ;
  - qui travaille ;
  - processeur et mémoire ; carte graphique (via nvidia-smi : charge et mémoire) ;
  - les jetons des 15 dernières minutes, avec un mini-graphique de la dernière heure par tranches de 5 min ;
  - la jauge des 5 h.
- Les jetons sont comptés à la fin de chaque appel : un chantier long n'apparaît dans le mini-graphique qu'une fois fini.

### ADR-65 : le studio de modding (jeux du commerce, une recette par jeu)
**Statut** : Retenue le 22/10/2026 (« un studio de modding complet, pour créer des mods de la manière la plus simple possible » ; jeux du commerce ; premier jeu : Vampire Survivors).
- **Principe** :
  - Vous décrivez un mod en français. Le Concepteur de mods en fait un plan clair (changements, réglages, risques), que vous validez ou faites revoir.
  - « Fabriquer » : le développeur (Claude Code, Sonnet) écrit le mod **dans son propre dossier** (`<jeux>/mods/<recette>/<NomDuMod>`, en git) et le construit. Le hub reconstruit lui-même ; en cas d'échec, jusqu'à deux corrections.
  - « Installer » : le hub copie la DLL dans le dossier des mods du jeu (chemin vérifié, rien n'est écrasé, empreintes notées). Vos sauvegardes sont copiées à l'abri la première fois.
  - « J'ai joué » : le hub lit le journal du chargeur. Une erreur du mod lance une correction, puis une réinstallation.
  - « Désinstaller » retire exactement ce qui a été posé.
- **Recettes** (`mods/recipes.ts`) : une par jeu. Chacune décrit les marques du jeu, le chargeur (version épinglée, page officielle), le dossier des mods, le journal, les sauvegardes, la commande de construction permise, les fichiers verrouillés, le gabarit, la consigne de l'agent et les avertissements.
  - Première recette : **Vampire Survivors** (Unity IL2CPP, sans support officiel). Elle utilise **MelonLoader v0.7.3**, C# .NET 6 et Harmony.
- **Outillage, sur votre clic** :
  1. MelonLoader extrait dans le jeu. L'archive est vérifiée : aucun chemin ne sort du jeu, aucun fichier du jeu n'est remplacé. La liste des fichiers posés est gardée, et le chargeur se retire d'un clic.
  2. Le premier lancement du jeu, que vous faites, génère les assemblies.
  3. La **carte des types** (`mods/typemap`, un petit outil .NET 9 sans paquet NuGet) liste les noms des types, méthodes, champs et propriétés. Seulement des noms, jamais de code décompilé : c'est là que l'agent cherche où brancher ses patchs.
- **Garde-fous de l'agent** :
  - Mêmes règles que les chantiers (`PolicyEngine`, écriture seulement dans le dossier du mod, carte en lecture seule).
  - Le `.csproj`, les `.props`/`.targets`/`Directory.Build.*`/`nuget.config` sont **verrouillés** : la construction les exécuterait.
  - Seule la commande exacte `dotnet build -c Release` est permise. Toute autre commande « hors plan » est refusée (là où Express la laisse passer).
  - Le dossier du jeu n'est jamais écrit par l'agent.
- **Jeux refusés** : avec anti-triche (`detectGame`). Pour un jeu avec du jeu en ligne, l'avertissement « mods pour le solo » s'affiche. Rien n'est publié.
- **Version** : le `buildid` Steam est noté à la construction. Si Steam met le jeu à jour, le mod est signalé « à reconstruire », et l'installation est refusée tant qu'il ne l'est pas.
- **Jeux Steam** (`mods/steam.ts`) : `libraryfolders.vdf` et les `appmanifest_*.acf` de chaque bibliothèque. Constaté : 36 jeux sur 4 bibliothèques ; VS dans `E:games`, reconnu, sans protection.
- **Sprites** :
  - Le plan peut demander des images : fichier, sujet, taille 16 à 64 px.
  - Avant le code, le générateur local (Flux) les dessine dans le style du jeu, sur un fond magenta uni, à 1024 px. ComfyUI les réduit ensuite au plus proche voisin à la taille du sprite (`GenRequest.scale`, nœud `ImageScale`).
  - Le développeur reçoit la liste des images et la manière de les charger (Texture2D, magenta rendu transparent, Sprite.Create au même pixelsPerUnit).
  - Les images s'installent une par une dans `Mods/<NomDuMod>/`.
  - « Redessiner », avec une précision facultative, refait une image et la réinstalle.
  - L'interface montre les sprites comme en jeu : le magenta est rendu transparent dans le navigateur.
  - Sans générateur, le mod se fait sans images.
- **Reste à faire** :
  - l'essai réel sur votre VS : installer MelonLoader, premier lancement, carte, premier mod.

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

### ADR-66 : le squelette humanoïde v3.0 de Tripo quand les animations le permettent
**Statut** : Retenue le 23/10/2026 (annonce Tripo d'octobre 2026 : « comment profiter de la mise à jour ? »).
- Tripo propose un squelette humanoïde **v3.0** (`v3.0-20260909`), mieux ajusté aux articulations, au même prix. Il n'est pas activé par défaut : il faut le demander. Mais il ne connaît que les **11 animations de base** (idle, walk, run, dive, climb, jump, slash, shoot, hurt, fall, turn, noms nus `preset:walk`). La bibliothèque des 90+ animations (`preset:biped:…`) reste réservée au v1.0.
- **Choix automatique** (`rigAnimations`, `model3d.ts`) : un bipède dont toutes les animations sont de base prend le v3.0. Une seule animation de la bibliothèque (hit_to_body_01, chop…) fait prendre le v1.0. Les autres formes restent en v2.5.
- La version est gardée dans la fiche (`model.rigModel` ; absente = v1.0). Une animation ajoutée plus tard sur un squelette gardé (ADR-56) suit ce squelette. Une animation de la bibliothèque demandée sur un v3.0 fait refaire le modèle avec le v1.0 (Tripo repayé, c'est rare).
- La consigne du DA le dit : choisir la bibliothèque quand le sens l'exige, pas par défaut.
- Rien à faire de plus pour le reste de l'annonce. Le nouvel algorithme d'application des animations sert déjà, sans changement de requête. L'animation générée à partir d'un texte n'existe que sur leur site, pas encore pour les programmes : à surveiller, elle remplacerait l'essai Meshy (ADR-56).
- Pas encore essayé contre le vrai Tripo : le prochain humanoïde aux animations de base sera le test.
- **Correctif du 23/10/2026, les kits** : l'export remettait tout le modèle à la « taille » de la fiche. Un kit (plusieurs pièces sans squelette, écartées côte à côte pour les photos) voyait toute sa rangée écrasée dans cette taille. A-0013 a ainsi été refusé 5 fois de suite, pour ~12 $. Désormais, c'est la plus grande pièce du kit qui mesure la « taille » (`kit_pieces()` dans workshop.py, boîtes disjointes vues de dessus). Un objet fait de pièces imbriquées reste mesuré en entier. Vérifié sur Blender 4.5.14 : kit, objet assemblé, objet seul.

### ADR-67 : le renfort Fable de l'atelier 3D réservé aux personnages animés
**Statut** : Retenue le 23/10/2026 (« quelle est la meilleure solution pour ne pas perdre en qualité ? » puis « oui, mets en place »). La fenêtre de 5 h a été vidée en ~2 h : ~50 $, dont 70 % sur Fable.
- **Constat depuis l'ADR-62** : Opus a validé 5 visuels en 16 passes, à ~0,70 $ la passe. Le renfort Fable n'en a sauvé qu'un sur 4 essais, à 5-8 $ la passe : 25-50 000 jetons écrits par pas, contre 1-4 000 pour Opus. Deux de ses échecs (A-0013) venaient du bug d'échelle des kits.
- **Désormais** : la 3e passe reste. Elle se fait en **Fable** seulement pour un modèle à squelette (personnage, ennemi animé), là où un détail se voit en jeu. Pour un décor, un kit ou un objet, elle se fait avec le modèle réglé pour l'atelier (Opus).
- La qualité de la 3D vient surtout de Tripo, de l'image validée et du validateur. L'artisan range, oriente et retouche. Les gros chantiers restent sur Fable (choix de l'utilisateur le 23/10).

### ADR-68 : refonte « premium sobre », le poste de pilotage et la discussion du téléphone
**Statut** : Retenue le 23/10/2026 (« d'un coup d'œil voir tout ce qu'il se passe… une interface plus premium, plus sobre/épurée, sans perdre de fonctions » ; le bandeau mange la discussion du téléphone, lecture pénible).
- **Style** : tokens `:root` réécrits (`styles.css`). Fond ardoise neutre, surfaces pleines (plus de verre flou), un seul accent bleu calme, ambre pour « à vous ». Plus de lueurs ni de dégradés néon, une seule famille de lettres (Segoe UI Variable, celle de Windows, sans fichier ajouté). Ajout d'échelles d'espacement et de tailles. Les couleurs néon codées en dur sont converties. Le logo et la bannière restent, mais désaturés.
- **Pilotage** (`#/pilotage`, `studio/Pilotage.tsx`, entrée sous « Accueil ») :
  - une ligne d'état : file, pause jusqu'à quand, jauge des 5 h, jetons du quart d'heure ;
  - les cartes « à vous » ;
  - deux colonnes. **Chantiers** : celui en cours avec sa barre de progression, la file, les fusionnés récents. **Visuels** : en fabrication avec aperçu et passe, à trancher, en file, prêts en attente d'un chantier ;
  - les liens : survoler un chantier allume ses visuels, et inversement ; un clic sur une puce y mène ;
  - **Galerie** (`studio/Gallery.tsx`) : filtres par statut et par 3D ou image. Un visualiseur feuillette toutes les images d'un asset (croquis, image, planche, photos 3D, bandes, capture en jeu) au clavier (← →, ↑ ↓, Échap), avec le verdict, les chantiers liés, « Lancer maintenant », « Mettre de côté » et un lien vers la Direction artistique.
- **Progression d'un chantier** (`executor/progress.ts`, champ `progress` de `GET /projects/:slug/tasks`), estimée sans appel à un modèle :
  - plan : 5 % ;
  - exécution : 10 à 80 %, selon les étapes du plan dont un fichier a été modifié, ou à défaut le temps écoulé face à la médiane des exécutions ;
  - contrôles du hub : 84 % ; testeur : 90 à 96 % ; fusion : 97 %.
  - Affichée « ≈ ».
- **Téléphone** : le bandeau du moniteur disparaît des pages du projet. Une pastille de l'en-tête (« T-0074 +3 », « Pause → 13:40 ») ouvre le moniteur complet dans une feuille du bas, avec un lien vers le Pilotage. Les messages passent à 16 px, plus larges et plus aérés. « Concevoir » devient une icône et le nom du projet s'abrège.
- Vérifié : `pilotage.e2e.ts` (PC 1400×900 et téléphone 390×844, captures examinées) ; les 32 autres tests navigateur sont verts. Celui du Concepteur (`conception.e2e.ts`) échouait déjà avec le site d'avant (expire au bout de 25 s) : il est à remettre à jour depuis l'ADR-57.
- **Complément du 26/10/2026, couleurs de la DA rendues** (choix de l'utilisateur : « habiller le hub en Nidavellir », en touches, fond sobre gardé). Les pastels sont remplacés par le cyan `#00E5FF` (guide) et l'orange `#FF5A00` (« à vous ») de `DA.png`. Le fond ardoise devient la nuit bleue `#080B12`, avec des surfaces teintées. Les barres de progression et la jauge passent au dégradé cyan → orange. Le logo et la bannière ne sont plus désaturés, et les notifications du téléphone s'appellent « Nidavellir ». Toujours pas de verre flou, et une seule famille de lettres. Vérifié avec `pilotage.e2e.ts` (captures examinées).
- **Complément du 23/10/2026 (ADR-31)** : en atelier ou en autonomie, un chantier refusé par le testeur est corrigé **deux fois** automatiquement (trois vérifications, `VERIFY_ROUNDS` dans `autopilot.ts`) avant d'attendre votre mot. Avant, il s'arrêtait dès le 2e refus. Choisi par l'utilisateur : la file s'arrêtait trop souvent.

### ADR-69 : la manette du testeur, il joue au jeu avant de donner son avis
**Statut** : Retenue le 23/10/2026, après l'analyse d'OhMyGame (WhiteTowerAI/ohmygame, outil `game_use`). C'était notre plus gros manque : aucun agent ne jouait au jeu. Le lancement de 6 s et la photo de l'écran de départ ne prouvent pas que le jeu se joue. Choix de l'utilisateur : « ok vas-y » (n°1 des propositions).
- **L'outil `jouer`** (relais MCP du studio, `bridge/gate.mjs`) existe seulement pour le testeur (`STUDIO_PLAY=1`). Il n'est donné que si la copie a un script `dev`, comme « ▶ Essayer ».
  - Le gardien l'autorise en vérification et le refuse au développeur et au plan (`PLAY_TOOL`).
  - La route `POST /api/agent/runs/:run/play` vérifie le jeton du run et refuse tout run qui n'est pas une vérification.
- **Ce qu'il fait** (`quality/playtest.ts`) : le hub lance le jeu de la **copie du chantier** (`npm run dev`, instance de prévisualisation à part) dans Edge invisible, via playwright-core.
  - `open` : écran `pc` (1280×720) ou `phone` (390×844, tactile, le jeu redémarre).
  - `act` : jusqu'à 20 étapes d'affilée. Clic par texte, sélecteur ou coordonnées (toucher au téléphone), touche maintenue (`hold_ms` ≤ 5 s), texte, attente ≤ 5 s, pont de test.
  - `capture` : photo JPEG, rendue en image au modèle. 15 au plus par chantier.
  - `close` ferme la partie.
- **Après chaque appel**, sans le demander, le testeur reçoit : le texte visible, les boutons avec leur position, les zones de jeu (canvas), les **nouvelles** erreurs de la page, les fichiers non chargés, et l'état exposé par le jeu.
- **Pont de test** : `window.__STUDIO_TEST__ = { snapshot, reset, setSeed, step }`, seulement avec `?studioTest=1` dans l'adresse. Le développeur peut l'ajouter quand un état ne se voit pas bien à l'écran (score, vies) ; ce n'est pas obligatoire. Le testeur doit quand même jouer avec de vraies touches.
- **Sécurité** :
  - la manette n'ouvre que l'adresse du jeu : pas de `//`, pas de `:`, origine vérifiée ;
  - fenêtres surgissantes fermées, et retour au jeu si la page part ailleurs ;
  - une seule demande à la fois par run ;
  - la partie est fermée à la fin du run, même si le testeur l'oublie, ou après 10 min sans action ;
  - le hub ne rejoue rien : aucune écriture dans le jeu.
- **Consignes du testeur** (`PLAYTEST_RULES`, d'après la méthode `game-playtest` d'OhMyGame) :
  - jouer ce que la consigne change (y entrer, voir l'effet, en sortir), puis l'action principale et une défaite ou une remise à zéro ;
  - rejouer au téléphone si l'affichage est touché ;
  - examiner chaque photo ; 3 à 8 appels en général ;
  - « pas de réflexes » : chaque paquet est joué d'un bloc ;
  - **ne jamais dire avoir vérifié en jouant ce qui n'a pas été joué**.
  - Ses tours passent de 30 à 60 quand il a la manette.
- **Compte rendu** : le champ `playtest` du verdict (`played`, `summary`, `unverified`) donne dans la discussion « ▶ Essayé en jouant : … » et « Pas vérifié en jeu : … ». S'il n'a pas joué, le compte rendu le dit. Ces lignes figurent aussi sur la fiche du chantier. Le journal note `playtest.done` (actions, photos).
- **Limites assumées** : comme chez OhMyGame, pas de jeu en temps réel au réflexe ; jeux web seulement ; le jugement visuel est celui du modèle. Différence avec eux : chez nous, c'est un agent **distinct** du développeur qui joue, et les contrôles du hub (ADR-32) restent des faits mesurés.
- **Vérifié** :
  - `playtest.test.ts` : 8 tests (service, relais MCP réel face à un faux hub, gardien, parcours en atelier) ;
  - `playtest.e2e.ts` : vrai Edge sur un petit jeu lancé par `npm run dev`. Clic sur « Jouer », flèche maintenue, score, erreur vue, pont reset, téléphone, serveur arrêté à la fin. Photos examinées ;
  - un vrai run Claude Code (Haiku) avec les arguments du hub : il a vu l'outil, joué, décrit la photo (« carré bleu clair, à droite ») et lu x = 340, pour 0,0035 $.
  - Pas encore vu sur un vrai chantier de Bordée : ce sera le prochain chantier qui passe au testeur.

### ADR-70 : le carnet de commandes Tripo, une commande payée n'est jamais repassée
**Statut** : Retenue le 23/10/2026. C'est le n°2 des idées tirées d'OhMyGame (leur `model3d-journal.ts`). L'utilisateur : « ok on continue ».
- **Le trou** : le numéro d'une commande Tripo n'était connu que pendant l'attente. Un arrêt du hub, ou un échec à l'étape suivante, faisait tout repayer. Seul le modèle d'un personnage était gardé (`pending.json`), et seulement une fois fini. Une animation ratée faisait repayer le squelette et les animations déjà posées.
- **Le carnet** (`art/tripo-journal.ts`, fichier `tools/tripo/journal.json` dans les données du hub, sans la clé) :
  - chaque commande payante est notée **dès que Tripo rend son numéro** : planche, retouche, modèle, contrôle du squelette, squelette, chaque animation, et les animations ajoutées sur un squelette gardé ;
  - elle est notée sous l'**empreinte** de la demande (adresse et contenu, clés triées). Pour le modèle, l'empreinte prend l'empreinte de l'image et non le jeton d'envoi, et ni les graines : une relance retrouve la même commande ;
  - **une demande déjà notée reprend sa commande**. En cours, on attend sa fin ; finie, on la récupère sans repayer et sans renvoyer l'image. Ses crédits ne sont comptés qu'une fois (`counted`) ;
  - **repassée seulement** si Tripo l'a fait échouer ou ne la connaît plus (404). Une commande refusée parce qu'elle part d'une tâche reprise fait oublier celle-ci, qui sera refaite ;
  - **une fabrication réussie vide ses commandes** : « Refaire la 3D » achète bien un nouveau modèle ;
  - les commandes de plus de 7 jours sont oubliées ;
  - écriture d'un bloc (fichier temporaire puis renommage).
- Les crédits sont comptés au moment où chaque tâche réussit, plus à la fin de l'appel : un arrêt ne fait plus perdre le compte du plafond mensuel.
- **Redémarrage (ADR-61 modifiée)** : une 3D interrompue **repart seule**, avec un mot du DA (« je la reprends, ce que Tripo avait commencé est repris, pas repayé »). Une reprise de finition reste une reprise de finition (`retouch` gardé dans `art_jobs`). Avant, elle attendait votre clic, justement pour ne pas repayer.
- **Déjà là, rien à ajouter** : le contrôle gratuit « peut-on poser un squelette ? » avant de payer, et la fiche technique du modèle (triangles, mesures, animations, via l'export Blender).
- **Pas repris d'OhMyGame** : le refus de repasser une commande dont l'envoi est incertain (réponse perdue en route). C'est rare, et cela demanderait votre intervention. Le risque restant : payer une étape deux fois dans ce cas précis.
- **Vérifié** :
  - `tripo-journal.test.ts` (6 tests), avec un faux Tripo réglable : hub coupé pendant la fabrication puis repris avec une autre graine (aucun nouvel envoi, crédits comptés une fois) ; animation ratée (seule elle est repassée) ; carnet vidé après succès ; tâche oubliée par Tripo, puis tâche échouée ; animations sur squelette gardé ; carnet lui-même ;
  - les 8 tests Tripo existants passent, le test de redémarrage du DA est mis à jour ;
  - 239 tests au vert. Pas encore vu contre le vrai Tripo : ce sera la prochaine 3D.

### ADR-71 : le bilan des visuels, la liste face au jeu réel
**Statut** : Retenue le 26/10/2026. C'est le n°3 des idées tirées d'OhMyGame (« check the asset list against actual files and runtime usage », et dire ce qui reste non vérifié). L'utilisateur : « ok on continue ».
- **Le manque** : un visuel passait « intégré » dès la fusion d'un chantier qui citait son identifiant. Le hub regardait une photo (ADR-48/49), mais ne vérifiait jamais que le **bon fichier** était dans le jeu, ni que le jeu le **chargeait**. Une version retouchée jamais recopiée, ou un chantier suivant qui débranche le fichier, passaient inaperçus.
- **Le bilan** (`art/bilan.ts`, sans appel à un modèle) : pour chaque visuel « intégré » ou « en intégration », le hub fait trois choses.
  - Il cherche dans les fichiers du jeu (hors `studio/`, dépendances et sorties de construction) la **copie exacte** du fichier validé, octet pour octet. Le nom du fichier ne compte pas : le développeur renomme souvent (`a-0002-3d-8.glb` → `assets/studio/guardian_titan.glb`).
  - Sinon, il cherche une **ancienne version** : un autre fichier `studio/art/` du même visuel retrouvé dans le jeu.
  - Il regarde la **preuve au lancement** : les fichiers que le jeu a chargés sur la scène vitrine du visuel (`proof` dans le manifeste).
  - Les empreintes sont gardées tant que le fichier ne bouge pas : 0,5 s la première fois sur Survivor Destiny (484 ressources), 0,08 s ensuite.
- **Niveaux** :
  - **vérifié** : chargé par le jeu, et le validateur l'a vu rendre bien ;
  - **chargé par le jeu**, ou chargé mais **à retoucher** ;
  - **pas vérifié** : copié, jamais vu chargé. Ce n'est pas forcément cassé ;
  - **intégration en cours** ;
  - **fichier validé perdu** ;
  - trois **problèmes** : **absent du jeu**, **ancienne version dans le jeu**, **pas chargé** sur sa scène vitrine.
- **La preuve au lancement** : le lancement du hub (`RealChecker.launch`) note désormais les images, modèles et sons que le jeu reçoit (`loaded`).
  - La vitrine prise après chaque intégration l'enregistre.
  - « **Vérifier en lançant le jeu** » relance la vitrine des visuels copiés, en arrière-plan. Un visuel déjà chargé par un lancement précédent n'en demande pas d'autre : un jeu charge souvent tout au départ, et sur Survivor Destiny un seul lancement a prouvé les 14 visuels.
  - Le manifeste est commité une fois, à la fin, et le DA résume dans sa discussion.
- **Réparer** : « Faire réintégrer » sur un problème remet le visuel en intégration. Le directeur reçoit ce que le bilan a vu (« le jeu a encore une ancienne version… ») et la consigne de copier ce fichier-là, tel quel, puis de vérifier qu'il est chargé. Rien n'est réparé tout seul : une copie convertie volontairement (autre format) apparaîtrait « absente ».
- **Où** : onglet **Bilan** du Pilotage, problèmes en tête ; routes `GET /projects/:slug/art/bilan`, `POST …/art/bilan/verify`, `POST …/art/assets/:id/reintegrate`.
- **Pas repris** : les fichiers du jeu sans fiche (Survivor Destiny en a 332, surtout des packs du commerce : trop de bruit) ; la recherche du nom dans le code, peu fiable (des jeux chargent par dossier entier).
- **Vérifié** :
  - `bilan.test.ts` ;
  - un test du DA de bout en bout : absent, puis copié non prouvé, prouvé au lancement depuis `public/`, ancienne version, réintégration ;
  - `pilotage.e2e.ts` avec l'onglet Bilan sur PC et téléphone (captures examinées) ;
  - 241 tests au vert ; les tests navigateur aussi, sauf celui du Concepteur, déjà en échec ;
  - essai réel, sur une copie de Survivor Destiny : bilan à blanc (14 visuels copiés, pas vérifiés) puis deux vrais lancements dans Edge, qui ont bien reçu les 14 fichiers `assets/studio/`.

### ADR-72 : montrer au lieu de décrire, les captures annotées
**Statut** : Retenue le 26/10/2026. C'est le n°4 des idées tirées d'OhMyGame (leur mode « Draw » : « dessinez sur l'aperçu pour montrer à l'IA ce que vous voulez dire »). L'utilisateur : « ok on continue dans l'ordre ».
- **Le manque** : pour signaler un défaut visuel, il fallait le décrire avec des mots (« le score déborde en haut à droite… »). Le directeur ne voyait aucune image : il répondait sans aucun outil.
- **Dessiner** (`studio/Annotator.tsx`) : une fenêtre ouvre la photo du jeu.
  - Vous entourez ou touchez ce qui ne va pas, à la souris ou au doigt (traits rouges, toucher seul = point).
  - « Annuler le trait », « Tout effacer », un mot facultatif, « Envoyer au directeur ».
  - Les traits sont gardés en pixels de l'image, puis redessinés sur une copie exportée en JPEG, 1600 px de large au plus.
- **Trois entrées** :
  - **joindre** une capture dans la discussion (bouton image du champ de saisie) ;
  - la **coller** dans le champ, après un Win+Maj+S ;
  - **« Montrer un défaut »** sous chaque capture de chantier : dans la discussion, ou sur la page du chantier, qui l'envoie dans la discussion d'où vient le chantier.
- **Où vont les images** (`conversation/captures.ts`) : `studio/captures/` du dépôt du jeu, commitées par le hub (« captures: image annotée … »), PNG, JPEG ou WebP vérifiés par leurs premiers octets, 8 Mo au plus. Le message porte une ligne `§IMAGE§ studio/captures/…`, affichée comme une image.
- **Le directeur regarde** : pour ce tour seulement, il reçoit la lecture du dossier `studio/captures`, et rien d'autre.
  - Son modèle reste le sien (`images` dans le port, au lieu du modèle de l'Archéologue).
  - La ligne devient une consigne : regarder l'image, dire ce qu'il y voit, et recopier son chemin dans la consigne d'un chantier.
  - Le développeur et le testeur la retrouvent dans leur copie : règle « Captures » des consignes communes.
- **Pas repris** : dessiner sur le jeu en train de tourner. L'aperçu « ▶ Essayer » est une autre adresse, que le site ne peut pas photographier. La capture Windows collée fait le même travail.
- **Vérifié** :
  - `http.test.ts` : envoi, commit, image servie, faux PNG refusé, chemin piégé refusé ; le directeur a la lecture de `studio/captures` pour le tour avec image, et plus aucun accès au tour suivant ;
  - `annotate.e2e.ts` dans Edge : joindre, entourer à la souris (PC) puis au doigt (téléphone 390 px), envoyer. L'image annotée, à la taille de la capture (1280×720), est dans la discussion et commitée, le directeur répond. Captures examinées ;
  - 242 tests au vert ; les tests navigateur aussi, sauf celui du Concepteur, déjà en échec.

### ADR-73 : les jeux Godot dans le studio, et un Concepteur qui n'oublie rien
**Statut** : Retenue le 26/10/2026, avant le lancement d'un nouveau projet Godot (« j'ai besoin qu'avec le concepteur on fasse tout le nécessaire sans rien oublier »). Choix de l'utilisateur : les trois blocs, dans l'ordre. Le testeur joue dans le vrai Godot sur le PC, pas dans une version web.
- **Le manque** : toute la chaîne de vérification était faite pour les jeux web (`npm`, Vite, navigateur). Avec Godot :
  - le gardien bloquait toute commande `godot` ;
  - le hub ne lançait ni les tests ni le jeu, et ne prenait pas de photo ;
  - le testeur ne pouvait pas jouer, et « ▶ Essayer » ne marchait pas ;
  - le premier chantier devait tout installer, sans rien pouvoir télécharger ;
  - la version de Godot n'était pas fixée : le Concepteur avait proposé la 4.7 pour un PC qui a la 4.6.2.
  Claude Code sait tester Godot quand il est libre ; c'étaient les règles du hub qui l'en empêchaient.
- **Bloc 1, Godot dans le hub** (`apps/hub/src/godot/`) :
  - **Trouver Godot** (`toolchain.ts`) : la variable `STUDIO_GODOT`, sinon le bureau, les téléchargements et les dossiers d'installation habituels. La version la plus récente l'emporte ; la version .NET (« mono ») est reconnue.
  - Le hub pose une commande `godot` (script pour Git Bash et `.cmd`) dans `.data/tools/godot/bin`, mise en tête du PATH : les agents l'héritent.
  - **Le gardien** (`godotCommand`) laisse passer, toujours avec `--headless` et dans la copie :
    - l'import du projet ;
    - le lanceur de tests du studio (`-- --only=<nom>` permis) ;
    - une scène qui tourne quelques images (`--quit-after`/`--quit`) ;
    - `--version`.
  - Le reste est demandé : éditeur, export, autre script, débogage à distance, fenêtre.
  - **Nos tests, sans GUT** (`addons/studio_tests`) : `tests/**/test_*.gd` qui « extends StudioTest ». Ils offrent assert_eq, assert_true, assert_almost_eq, assert_gt… ; add_scene, wait_frames, wait_seconds, hold_action ; before/after each/all.
    - Le bilan « STUDIO_TESTS: n réussis, m échoués » et le code de sortie font foi.
    - Une erreur de script pendant les tests (« SCRIPT ERROR »), qui n'arrête pas Godot, fait échouer la vérification.
    - Pourquoi pas GUT : il aurait fallu télécharger et exécuter du code extérieur (refusé sans votre accord), et suivre sa version à chaque mise à jour de Godot. GUT pourra s'ajouter plus tard.
  - **Le relais du testeur** (`addons/studio_bridge`, autoload `StudioBridge`) : inactif dans une partie normale. Lancé par le hub avec `-- --studio-bridge=<port>`, il écoute en local et permet :
    - de jouer : touches, actions de l'Input Map, clics sur un bouton par son texte ou par coordonnées, toucher en mode téléphone, texte, attente ;
    - de prendre des photos (JPEG ou PNG) ;
    - de lire ce que voit le joueur : textes, boutons et leur position, actions du projet ;
    - de lire l'état du jeu : le nœud du groupe `studio_test`, avec `snapshot()`, et `reset`, `set_seed`, `step` ;
    - de lister les fichiers utilisés par la scène (pour le bilan, ADR-71) ;
    - d'ouvrir la scène vitrine `res://vitrines/<id>.tscn` avec `--vitrine=<id>`.
    - La fenêtre du jeu est placée hors de l'écran : elle s'affiche, donc les photos marchent, sans gêner celui qui travaille sur le PC.
  - **Vérifications du hub** (`RealChecker`) pour un jeu Godot :
    - tests : import, puis le lanceur ;
    - lancement : import, puis le jeu avec le relais. Ses erreurs, une photo, la scène, les fichiers chargés ; `?vitrine=A-0001` devient `--vitrine=A-0001`.
  - **La manette** (`GodotPlaySession`) : même outil `jouer` que pour le web. Le testeur reçoit des consignes Godot (actions, nœud `studio_test`, vitrines). Les agents reçoivent les commandes Godot dans leur contexte (`<godot>`), et le plan propose l'import et les tests.
  - **« ▶ Essayer »** ouvre le jeu dans sa fenêtre, sur le PC, d'où que vienne la demande.
  - **Chaque copie de chantier** reçoit une copie du cache d'import `.godot` (jamais un lien, l'import y écrit) : elle n'importe que ce que le chantier change.
  - Les consignes d'intégration des visuels parlent des scènes vitrines Godot.
- **Bloc 2, le socle** (`scaffold.ts`), posé par « Créer le projet » quand le moteur est Godot. Il est réglé d'après ce que le Concepteur a décidé (`godot` : rendu, 2D ou 3D, taille de base, langage) :
  - `project.godot` sur la version du PC, avec le rendu, la fenêtre et l'adaptation de l'écran ;
  - une scène de départ 2D, ou 3D avec caméra, soleil et sol, avec son nœud `studio_test` ;
  - un premier test, les dossiers `scenes/ scripts/ assets/ data/ tests/ vitrines/`, `.gitignore` (`.godot/`) et `.gitattributes` (fins de ligne) ;
  - les outils du studio, et une section « Godot dans le studio » ajoutée au CLAUDE.md (version, commandes, tests, Input Map, relais, vitrines, interdits).
  - Le hub importe le projet, lance le premier test, commite (« studio: socle Godot … ») et dit le résultat dans la discussion du projet. C# demandé sans Godot .NET : GDScript.
- **Bloc 3, le Concepteur** :
  - le dossier d'un nouveau jeu a huit sections de plus : contrôles et caméra ; écrans et parcours du joueur ; sauvegarde et progression ; son et musique ; plateformes, affichage et performances ; langues et accessibilité ; architecture du projet ; tests et outils de débogage. Chacune a ce qu'elle doit couvrir, et le dossier passe de 1 500 à 2 500 mots au plus ;
  - le hub calcule les **trous** du dossier (`missingSections`) : une section absente, ou de moins de quelques mots (« Questions encore ouvertes » et « Choix faits pour vous » peuvent dire « aucune ») ;
  - l'écran les montre (« Il manque encore : … » ou « Dossier complet ») ;
  - « Créer le projet » est refusé tant qu'il en reste ;
  - le Concepteur connaît le Godot du PC : version exacte, .NET ou non. Il sait ce que le hub pose lui-même : le premier chantier bâtit la première scène jouable sur le socle, sans le refaire ;
  - une fonctionnalité garde l'ancien dossier.
- **Pas fait** : l'export web (choix de l'utilisateur) ; un atelier sonore (le dossier dit comment s'en passer) ; Godot n'est pas téléchargé par le hub (celui du bureau est trouvé tout seul).
- **Vérifié** :
  - `godot.e2e.ts` avec le vrai Godot 4.6.2. Socle ; tests réussis, puis un échec et un script qui plante, tous deux vus. Lancement : photo, scène, fichiers chargés. Scène vitrine par le relais. Partie jouée : deux clics sur « Compter », l'action maintenue, l'état lu, la remise à zéro, la photo. Une erreur au démarrage fait échouer le lancement ;
  - essai à part des socles 2D et 3D, avec le premier test et le lancement, et en mode téléphone ; la commande `godot` dans Git Bash ;
  - `policy.test.ts` : commandes Godot permises et refusées ;
  - `conception.test.ts` : trous du dossier, refus puis création ; socle Godot, project.godot et CLAUDE.md ; Concepteur sans Godot ;
  - `conception.e2e.ts` remis à jour : il échouait depuis l'ADR-57, à cause d'un message dont le texte avait changé ;
  - 246 tests au vert, et les 37 tests navigateur aussi.

## ADR-74 — Le Concepteur propose la meilleure technologie pour le jeu

- **Contexte** : le Concepteur disait « Godot, recommandé pour un jeu sur PC » d'office. Le directeur créatif veut qu'il propose la meilleure technologie pour chaque jeu.
- **Décision** : une méthode de choix (`TECH_CHOICE`, dans le prompt d'un nouveau jeu) :
  - partir du jeu : 2D ou 3D, genre, plateformes, besoins particuliers ;
  - comparer 2 ou 3 candidates sur des critères fixes : adaptée au genre, plateformes et export, ce que le studio vérifie seul, maîtrise par les agents, performances, installation et licence, intégration des visuels du DA ;
  - ce que le studio sait faire par technologie. Godot et web : tout (tests, lancement vérifié, testeur qui joue, « Essayer »), avec le téléphone pour le web seulement. Autre (Unity, Unreal…) : le code seulement, à ne recommander que si le jeu l'exige ;
  - une candidate nette est choisie et expliquée ; sinon c'est la première question, candidates en options ;
  - la section « Choix techniques » donne la technologie et sa version, le comparatif, les bibliothèques et ce qu'il faut installer.
  - Le contexte Godot ne dit plus « recommandé » : il ne s'applique que si Godot est retenu.
- **Vérifié** : `conception.test.ts` (méthode présente, plus de recommandation d'office), 246 tests au vert, typecheck.

## ADR-75 — Le Concepteur a 15 minutes par réponse

- **Contexte** : sur « Néon Saloon » (3D, 34 chantiers, dossier de 12 500 caractères), le Concepteur s'est arrêté deux fois de suite : « Claude Code n'a pas répondu en 480 s ». Une fois le dossier prêt, il réécrit à chaque tour le dossier et toutes les consignes en entier. Le tour précédent avait déjà pris 7 minutes, et le dossier plus long de l'ADR-73 alourdit chaque tour.
- **Décision** : le niveau « concept » a 900 s, comme l'artisan 3D, au lieu de 480 s.
- **Vérifié** : typecheck, `conception.test.ts`. La conversation garde son dossier : il suffit de renvoyer le dernier message après le redémarrage du hub.

## ADR-76 — Les .uid de Godot ne bloquent plus la fusion

- **Contexte** : sur Néon Saloon, T-0001 a été fait, testé par le hub et validé par le testeur, mais sa fusion a échoué avec « Conflit de fusion sur : ? ». L'import de Godot fait à la pose du socle avait écrit `scripts/main.gd.uid` et `tests/test_demarrage.gd.uid` dans le projet, sans qu'ils soient enregistrés. Le chantier avait créé les siens, avec d'autres identifiants, et Git refuse d'écraser un fichier non suivi.
- **Décision** :
  - le socle enregistre les `.uid` que l'import a écrits avec le reste ;
  - avant une fusion, un fichier non suivi que la branche ajoute est remplacé par celui de la branche s'il est régénéré par Godot (`.uid`, `.import`) ;
  - un autre fichier non suivi donne un refus clair qui le nomme, sans rien toucher, au lieu de « Conflit sur : ? ».
- **Vérifié** : `tasks.test.ts` (un .uid local cède la place, un brouillon à vous bloque avec son nom), 247 tests au vert, typecheck.
- **Constaté au passage** : premier vrai chantier Godot réussi. Le développeur a travaillé, les tests du jeu (6) et le lancement ont été vérifiés par le hub, et le testeur a joué au vrai jeu (7 actions, 2 photos).

## ADR-77 — Godot n'importe plus studio/, la file s'arrête après un échec, un chantier en échec se relance

- **Contexte** : sur Néon Saloon, T-0002 puis T-0003 ont échoué avec « Modifications interdites détectées : studio/art/choix/m2-1.png.import… ». Le développeur n'avait rien fait de mal. Le DA avait ajouté ses images (moodboard, choix) dans studio/art. Godot importe toute image du projet et écrit un `.import` à côté, ici dans studio/, zone interdite aux agents. La file a continué malgré l'échec : T-0003, puis T-0004, sont partis sans le travail de T-0002, alors qu'ils s'appuient dessus. T-0003 a même refait de son côté une partie de T-0002. Enfin, un chantier en échec ne pouvait pas être relancé : seul un brouillon se lançait.
- **Décision** :
  - avant de créer la copie d'un chantier, le hub pose et enregistre `studio/.gdignore` dans un jeu Godot : Godot ignore ce dossier ;
  - avant d'enregistrer le travail, les `.import` et `.uid` laissés par Godot dans studio/ sont effacés : ce n'est ni du travail, ni une faute ;
  - un chantier de la file qui échoue arrête la file. Ceux qui attendaient redeviennent des brouillons prêts, et la discussion le dit (« ⏸ La file s'arrête là… ») ;
  - `launch` accepte un chantier en échec ou arrêté. Il le remet à zéro (copie et branche effacées) et il repart sur la version actuelle du jeu. Le directeur le sait (`[[LANCER: …]]`).
- **Vérifié** : `autonomy.test.ts` couvre l'échec et ce qui suit. La file s'arrête, le .gdignore est enregistré et le `.import` effacé sans faute. Le chantier en échec et le suivant, relancés, sont fusionnés. 248 tests au vert, typecheck.
- **Complément (27/10)** : le bouton manquait à l'écran : un chantier en échec ne proposait que « Demander un nouveau plan ». Pilotage montre maintenant les chantiers « En échec », chacun avec « ↻ Relancer », et « ↻ Relancer les N dans l'ordre » : le premier part, les suivants attendent leur tour dans la file. La fiche d'un chantier en échec ou arrêté propose « ↻ Relancer ce chantier de zéro ».

## ADR-78 — Le DA reçoit des compétences ; premières skills Godot et visuels venues du catalogue public

- **Contexte** : le directeur créatif veut des skills de développeur Godot, de rendu, de polish, d'équilibrage et de tower defense, puis pour la 3D et les visuels. Le catalogue public (skills.sh, via find-skills) en propose beaucoup. Mais le DA ne recevait aucune compétence : seuls le directeur, le Concepteur, le développeur et le testeur y avaient droit (ADR-29).
- **Décision** :
  - « art_director » rejoint les agents des compétences. Celles qu'on lui donne s'ajoutent aux consignes de sa discussion, comme pour le Concepteur (9 000 caractères au plus). La page « Compétences » a une pastille « DA ».
  - Six skills lues puis adaptées, enregistrées comme « ajoutées par vous » et actives. Chacune commence par une note du studio : Godot 4.6.2 (le texte vise 4.7), StudioTest et pas GUT, les règles du projet d'abord. Les renvois à des fichiers absents sont retirés, et les annexes utiles sont incluses dans les 12 000 caractères.
    - Pour le développeur : godot-gdscript (wshobson/agents, MIT), godot-rendu-3d, godot-shaders, game-feel-godot (gamedev-skills/awesome-gamedev-agent-skills, Apache-2.0).
    - tower-defense, pour le Concepteur et le développeur, sur Néon Saloon seulement.
    - direction-artistique-assets (create-game-assets), pour le DA.
  - Écartées :
    - balance-check : elle lance des commandes et dépend d'un autre cadre.
    - Les skills Blender, qui exigent un serveur MCP Blender.
    - Les skills Meshy ou de génération d'images liées à un service, et threejs-3d-generator, sans licence.
    - Les skills peu installées qui contiennent des scripts.
    - Le test headless, qui utilise GUT.
- **Vérifié** : un test (art.test.ts) montre qu'une compétence donnée au DA arrive dans ses consignes. 249 tests au vert, typecheck.

## ADR-79 — Le squelette Tripo contrôlé et refait avant les animations, ce qu'en dit le guide threejs-3d-generator

- **Contexte** : le directeur créatif veut que la chaîne 3D s'inspire du guide Tripo de majidmanzarpour/threejs-game-skills (`threejs-3d-generator`, `references/api-notes.md`). Ce guide n'a pas de licence : il est lu et comparé, pas recopié. Il décrit l'API v2 de juin 2026, alors que le studio parle à l'API v3.
- **Vérifié avant de changer** :
  - Le guide dit que `animate_in_place` croise les membres, et qu'un squelette v1.0 en GLB fait rentrer bras et jambes dans le torse.
  - Mesure dans Blender 4.5 sur le Héron (A-0005) et le Titan (A-0002) de Survivor Destiny, tous deux en v1.0, GLB et sur place : position des pieds et des mains à 11 à 15 instants de chaque animation. Aucun pied ni aucune main ne passe de l'autre côté du corps, dans aucune animation. Le validateur ne voyait rien qui se détache.
  - Ces deux réglages ne changent donc pas. Rien ne prouve le défaut chez nous, et en changer un repaierait des animations sans preuve.
- **Décision** :
  - **Contrôle du squelette avant de payer les animations** (`#rig`, `glbJoints`, `rigProblem`). Le fichier du squelette est lu (noms des os de son premier `skin`). Un bipède à moins de 12 os est refusé, comme le fait un côté à moins de 3 os ou deux côtés qui diffèrent de plus de 2. Des noms sans côté (une version inconnue) passent.
  - **Jusqu'à 3 essais** du squelette, une commande nouvelle à chaque fois. L'essai fait partie de l'empreinte du carnet (ADR-70), et une reprise retrouve les essais déjà payés. Un squelette raté chez Tripo est lui aussi refait. Après 3 ratés, l'erreur dit quoi changer à l'image.
  - « riggable » faux, ou 3 ratés : le message donne la recette d'une image qui reçoit un squelette (corps entier, pose en A ou en T, membres écartés, rien de soudé).
  - Plus de crédits (code 2010) : « Plus assez de crédits chez Tripo », au lieu de « Tripo refuse la clé ».
  - **Consignes du DA** :
    - un personnage à animer a le corps entier, les membres séparés, rien de long qui les soude ;
    - décrire le corps plutôt qu'une liste d'interdits (sinon on obtient une armure vide, sans tête) ;
    - une autre forme n'a que son déplacement, une créature volante n'a aucune animation ;
    - une armure dure, un robot ou une carapace ratent plus souvent le squelette.
  - Le validateur d'images vérifie aussi le corps entier et les membres non soudés.
- **Vérifié** :
  - Deux tests dans `model3d.test.ts` : squelette incomplet refait puis animé, trois ratés qui arrêtent sans payer d'animation, contrôle des noms.
  - Les vrais .glb du Héron, du Titan (41 os) et du Grouillot (22 os) passent le contrôle.
  - 251 tests au vert, typecheck.
- **Plus tard, si un modèle le montre** : animations sans `animate_in_place` (racine retirée dans Blender) et squelette v1.0 en FBX. Un essai réel coûterait environ 100 crédits (le squelette du Héron n'est plus gardé chez Tripo).

## ADR-80 — Jamais « simple » pour ce qui se voit de près ; l'arme vue à la première personne a un vrai budget

- **Contexte** : le 27/10, sur Néon Saloon, le directeur créatif trouve la texture de la carabine A-0004 « grossière ». Le modèle Tripo est intégré, mais sa surface est bosselée et ses couleurs bavent. Le DA conclut que la méthode est en cause et fait refaire l'arme en « simple » : l'artisan l'assemble à la main dans Blender. Il obtient des tiges et des blocs, refusés deux fois par le validateur (« trop primitive »). Le directeur créatif : « bien pire qu'avant ».
- **Cause** : le budget, pas Tripo. 3000 triangles et des textures de 1024 pour une arme qui remplit l'écran en vue à la première personne écrasent les formes, d'où une surface molle et des couleurs qui bavent. Le mode « simple » ne sait faire que des boîtes et des cylindres.
- **Décision** :
  - Consigne du DA : jamais « simple » pour l'arme du joueur, un personnage, un ennemi ou un objet héros. Un modèle Tripo « mou » se reprend par Tripo, avec plus de triangles et une image plus nette. Budget de l'arme en vue à la première personne : 8000 à 15000 triangles.
  - `closeUp` (model3d.ts) : un modèle à squelette, ou à 8000 triangles et plus, prend la géométrie détaillée de Tripo et des textures de 2048.
  - La fiche d'A-0004 est revenue au modèle Tripo intégré (a-0004-3d-3.glb, celui du jeu), commit 23ab8ef du jeu. Les versions faites main restent dans models/ sans servir.
- **Vérifié** : 251 tests au vert, typecheck. Le jeu n'avait jamais reçu la version faite main : l'arme du jeu est identique à a-0004-3d-3.glb (même empreinte).

## ADR-81 — Audit du 27/10 : le moteur d'un projet créé vide, des tests sans faux échec, une documentation à jour

- **Contexte** : audit du projet à la demande du directeur créatif. Trois défauts, sans conséquence sur les jeux :
  - Néon Saloon (Godot) et Bordée (web) étaient enregistrés avec le moteur « unknown » : « Créer le projet » enregistre le dossier vide, avant que le socle existe. Le hub reconnaissait Godot à la volée (`isGodot`), mais l'affichage et le journal disaient « unknown » ;
  - la suite échouait parfois sur un EPERM de Windows en effaçant le dossier temporaire d'un test (un processus enfant le tenait encore) ;
  - le README et la feuille de route s'arrêtaient à la phase 2 (14/10), alors que tout le reste n'était que dans ce fichier.
- **Décision** :
  - le registre reconnaît le moteur d'un projet « unknown » à chaque lecture (`#withEngine`) et le note dès qu'il est trouvé ;
  - le nettoyage des tests réessaie plus longtemps, puis laisse le dossier temporaire en cas d'EPERM ou d'EBUSY : ce n'est pas un échec du test ;
  - README réécrit (équipe, lancement, variables, dossiers), feuille de route à jour : phase 3 reportée, phase 4 en partie remplacée par l'atelier, phase 5 faite, **phase 6** ouverte avec les dix idées de l'audit.
- **Vérifié** : `projects.test.ts` (un projet vide puis son socle Godot : « godot » en lecture et dans la liste), typecheck.

## ADR-82 — Un plafond par visuel : le DA s'arrête et explique au lieu de boucler

- **Contexte** : idée n°1 de la phase 6. A-0013 a été refusé 5 fois de suite pour ~12 $ (ADR-66), et la fenêtre de 5 h a été vidée en 2 h (ADR-67). Rien n'arrêtait un visuel qui ne converge pas : chaque « Refaire » repartait de zéro, sans mémoire de ce qu'il avait déjà coûté.
- **Décision** :
  - **un compte par visuel** (`art/budget.ts`, table `art_spend`) : les appels de modèles faits pour lui (validateur, artisan, planche, en équivalent API comme partout dans le hub) et les crédits Tripo (modèle, animations). Il est tenu d'une fabrication à l'autre. Les appels sont comptés à un seul endroit : l'orchestrateur du DA est enrobé, et la fabrication d'un visuel tourne dans son contexte (`AsyncLocalStorage`). La réponse du DA dans sa discussion n'est pas comptée sur un visuel ;
  - **plafond** : 6 $ et 250 crédits Tripo par défaut (`STUDIO_ART_ASSET_USD`, `STUDIO_ART_ASSET_CREDITS`) ;
  - **arrivé au plafond**, la fabrication ne lance ni nouveau tour d'images ni nouvelle passe d'atelier. Le DA dit dans sa discussion ce qui a été dépensé et ce qui bloquait au dernier essai (le dernier avis du validateur, sans nouvel appel), et propose « Valider quand même », de changer l'image ou la forme, ou de relever le plafond. Le journal note `art.budget_reached` ;
  - vos clics « Générer », « Fabriquer / Refaire la 3D », « Reprendre la finition » et « Refaire » sont refusés sur un visuel au plafond, avec la marche à suivre ;
  - **« Relever le plafond »** (fiche du visuel, `POST /projects/:slug/art/assets/:id/budget`, session humaine) ajoute un plafond de plus (12 $, puis 18 $…). Journal `art.budget_raised`. Aucun agent ne peut le faire ;
  - la fiche montre « Dépensé : x $ sur y $ · n crédits Tripo sur m », en orange au plafond.
- **Vérifié** : deux tests dans `art.test.ts`. Un décor dont la finition résiste : les pas de l'artisan et le validateur sont comptés, la 2e passe n'a pas lieu, le message cite la dépense et les remarques, « Reprendre la finition » est refusé, puis accepté après « Relever le plafond » ; un canon : les 30 crédits Tripo sont comptés. 41 tests du DA au vert, typecheck.

## ADR-83 — Budget de performance des jeux Godot : le relais mesure, le hub refuse un chantier qui ralentit le jeu

- **Contexte** : idée n°2 de la phase 6. Le hub vérifiait que le jeu se lance sans erreur, jamais qu'il reste fluide. L'ADR-80 fait passer l'arme vue à la première personne à 15 000 triangles et à des textures de 2048 : sans mesure, un chantier qui fait chuter le jeu passe inaperçu jusqu'à ce que vous jouiez.
- **Décision** :
  - **Le relais mesure** (`bridge.gd` v2, commande `perf`). Pendant 3 s, avec la synchronisation verticale coupée pour obtenir la marge réelle et non les 60 images de l'écran, il relève : images par seconde ; temps par image (moyenne, 95 %, pire) ; appels de dessin, triangles et objets par image ; mémoire vidéo et statique ; nombre de nœuds. Les réglages d'écran sont rétablis ensuite.
  - **Quelle scène** : `res://vitrines/perf.tscn` si le jeu l'a (la scène de jeu la plus chargée, tenue à jour par le développeur), sinon la scène de départ. Sur Néon Saloon, c'est aujourd'hui le menu titre : la consigne Godot des agents (`GODOT_RULES`) et la section CLAUDE.md d'un nouveau jeu demandent de créer `vitrines/perf.tscn` dès qu'il y a une partie jouable.
  - **Le budget** (`perfProblems`) : un plancher de 60 images/s (`STUDIO_PERF_MIN_FPS`), et pas plus de 25 % de baisse face à la dernière mesure d'un chantier fusionné. La différence d'appels de dessin, de triangles ou de nœuds (+30 %) est nommée.
  - **Contre le bruit de la machine** : un chantier qui paraît plus lent fait remesurer le jeu actuel **à l'instant** (même machine, même charge). C'est une régression seulement si le jeu actuel fait nettement mieux. Sinon la vérification passe, avec « l'écart venait de la machine » ; si les deux sont sous le plancher, elle dit « déjà le cas avant ce chantier ».
  - **Conséquence** : une régression de performance est une régression comme les autres (ADR-32). Le développeur la corrige tout seul, avec les chiffres et des pistes (objets, lumières, modèles trop détaillés, matériaux non partagés, calcul dans `_process`). Le compte rendu dit « performances ✓ (N images/s) » et le testeur reçoit la mesure.
  - **Les outils du studio suivent le hub** : avant chaque chantier d'un jeu Godot, `addons/studio_bridge` et `addons/studio_tests` sont remis à jour s'ils ont changé, et commités (« outils du studio Godot mis à jour »). Avant, ils n'étaient posés qu'à la création du jeu.
  - Jeux web : pas de mesure (un navigateur sans écran ne dit rien de fiable sur la fluidité).
- **Vérifié** :
  - `autonomy.test.ts` : une mesure de référence ; un chantier à 110 images/s contre 195 pour le jeu remesuré, corrigé par le développeur avec « 195 → 110 images/s (−44 %) ; appels de dessin 200 → 450 », puis fusionné ; un chantier lent sur une machine lente aussi : fusionné, « l'écart venait de la machine ». Un relais v1 remis à jour avant un chantier.
  - `godot.e2e.ts` avec le vrai Godot 4.6.2 : 1 198 images/s sur le socle 2D, 3 593 images mesurées ; `vitrines/perf.tscn` mesurée à la place de la scène de départ.
  - Essai sur une copie de Néon Saloon (relais mis à jour) : menu titre à 1 411 images/s, 135 appels de dessin, 2 827 triangles, 172 Mo de mémoire vidéo.
  - 256 tests au vert, typecheck.

## ADR-84 — Contrôle des vitrines : chaque visuel du jeu rephotographié et comparé à sa photo validée

- **Contexte** : idée n°3 de la phase 6. Le bilan (ADR-71) prouve que le bon fichier est dans le jeu et qu'il est chargé, mais pas qu'il a encore l'air juste. Un chantier qui change l'éclairage, la caméra, une échelle ou un matériau partagé peut défigurer un visuel validé sans que personne le voie avant de jouer.
- **Décision** :
  - **La référence** : la photo de la scène vitrine jugée bonne par le validateur à l'intégration (`ingame`, ADR-49), ou celle que vous avez acceptée (`lookRef`).
  - **Après chaque fusion** (et sur « Comparer aux photos validées » dans le Bilan), le hub relance le jeu sur la scène vitrine de chaque visuel intégré qui a une référence et le photographie. Les visuels que le chantier vient lui-même d'intégrer sont exclus : ils sont jugés à part. Les fusions rapprochées sont **groupées** : au plus un passage automatique toutes les 20 minutes par projet, qui cite tous les chantiers fusionnés depuis.
  - **La comparaison, sans modèle** (`art/visual-diff.ts`) : un petit décodeur PNG sans dépendance. Chaque photo est réduite à une grille de 32 × 18 cases de couleur moyenne ; une case change si une couleur bouge de plus de 12 %. Le grain, l'anticrénelage ou un pixel de décalage disparaissent dans la moyenne. Au-delà de **6 %** de cases changées, l'aspect a changé ; le hub dit aussi où (« au centre à droite »).
  - **Contre les vitrines animées** : un écart fait prendre une seconde photo. Si les deux diffèrent entre elles (plus de 3 %), la vitrine bouge toute seule et la comparaison ne dit rien (« unstable », pas une alerte).
  - **Un aspect changé** : la nouvelle photo est gardée dans `production/<id>-aspect.png` (seulement dans ce cas, pour ne pas alourdir le dépôt). Le Bilan montre « Aspect changé » avec les deux photos, avant puis maintenant. Le DA le dit dans sa discussion. Le journal note `art.look_changed`.
  - **Deux suites** : « Faire réintégrer » (le directeur reçoit les deux photos et la consigne de rendre au visuel son aspect validé sans changer le fichier) ou « Accepter le nouvel aspect » (le changement est voulu : la nouvelle photo devient la référence, `art.look_accepted`). Une nouvelle intégration jugée remet la référence à zéro.
  - Pas de nouvel appel de modèle, et pas d'image ajoutée au dépôt tant que rien ne change.
- **Vérifié** :
  - `art.test.ts`, avec de vraies images PNG : même aspect au grain près après une fusion sans rapport (rien ne bouge) ; aspect changé après T-0005 (Bilan, deux photos, message, commit) ; nouvel aspect accepté puis retrouvé identique ; vitrine animée non signalée. 42 tests du DA au vert.
  - Sur les vraies photos de Survivor Destiny : deux photos d'A-0005 prises à deux fusions d'écart, 1,7 % de cases changées (même aspect) ; A-0008 avant et après la réparation de sa vitrine (T-0096 → T-0097), 99,8 % (changé). Les photos du vrai Godot se lisent aussi.
  - typecheck.

## ADR-86 — Le hub retrouve la forge de la DA, sans revenir au tout-lueur

- **Contexte** : à la demande du directeur créatif (« améliorer le rendu graphique », propositions 1 et 2 retenues). Depuis ADR-68, le hub était sobre mais plat, loin de `DA.png`. Quelques incohérences aussi : le rose du DA (`--c-art`) hors palette, sur la sélection d'un style et les visuels à valider ; un bouton indisponible (cyan à 42 %) passait pour un second style de bouton bleu-vert ; la frise des étapes de la direction passait à la ligne ; Exo 2 et Orbitron étaient livrées sans servir.
- **Décision** (`styles.css`, `studio/studio.css`, CSS seulement) :
  - **couleurs** : ce que vous choisissez est en glace (style retenu, vignette), ce qui vous attend en braise (question du DA, visuel à valider, puce « à valider »), le validé en vert. `--c-art` devient une braise claire (`#ff8a4c`). Un bouton indisponible est gris (`grayscale`), sauf les vignettes de style, qui gardent leurs couleurs ;
  - **la forge** : fond avec la glace en haut à droite, la braise en bas, très atténuées, et un grain fin (SVG en ligne, aucun fichier). Le liseré glace → braise revient sous l'onglet actif, sur la barre du menu et sous la bannière de l'accueil. La lueur reste réservée à l'élément actif ;
  - **lettres** : Exo 2 pour les titres (h1 à h3), Orbitron pour les rubriques en capitales (menu, sur-titres, titres de colonnes). Le texte courant et les boutons restent en Segoe. Orbitron rend mal les parenthèses en petit : elle ne sert pas aux libellés des messages ;
  - la frise des étapes de la direction tient sur une ligne (étape en cours en glace).
- **Non retenu** : les messages « estompés » des captures étaient l'animation d'apparition saisie en cours, pas un défaut. « Directeur : fake » au bas du menu vient des tests (en vrai : « Claude (direct) »).
- **Vérifié** : captures avant/après de `studio`, `art`, `art-vision` et `pilotage` examinées ; suite navigateur relancée (37 tests).
- **Numéro** : d'abord écrit ADR-83 puis ADR-85 : deux numéros pris en même temps par d'autres chantiers ; renuméroté.
- **Complément, chantier 3 (« donner plus de vie »)** :
  - **image clé d'un jeu** (`studio/KeyImage.tsx`) : la dernière capture d'un chantier fusionné ou en relecture, à défaut le style retenu par la DA, à défaut l'initiale. Elle sert de vignette dans l'en-tête du projet (liseré glace → braise) et de fond fondu à droite de cet en-tête, et de couverture aux tuiles de l'accueil qui n'ont pas de capture. Relue chaque minute et à chaque changement d'onglet. L'en-tête passe en `z-index: 10` pour que le menu d'autonomie reste devant ;
  - **la forge chauffe** : un agent au travail (bandeau de l'en-tête) et une tuile de projet occupée ont un liseré glace → braise qui tourne, avec une pulsation de braise pour l'agent ;
  - **survols** : visuels du DA et vignettes de style se soulèvent ; la tuile « Concevoir » passe à la braise de la DA (l'ancien orange `#FB923C` disparaît) ;
  - **états vides habités** (discussion vide, DA vide, aucun projet) : la caverne de la bannière en fond très sombre et le N qui respire ;
  - **panneau de la DA** : générateur, Flux Kontext et atelier 3D ont un titre, une étiquette (« À installer », « 2 étapes »), une phrase et l'action ; l'explication longue passe dans « En savoir plus ». La clé Tripo reste visible ;
  - sur le téléphone, la frise des étapes de la direction défile au lieu de couper les mots ;
  - les animations s'arrêtent avec « réduire les animations » de Windows (règle existante).


## ADR-85 — Vos parties enregistrées, puis rejouées comme tests

- **Contexte** : idée n°4 de la phase 6. Quand vous trouvez un bug ou une règle qui compte en jouant, il fallait le décrire, et rien n'empêchait un chantier suivant de le casser à nouveau. Le testeur joue (ADR-69), mais ses parties ne sont pas les vôtres.
- **Décision** :
  - **Enregistrer** (jeux Godot, relais v3) : « ▶ Essayer » (le jeu ou la version d'un chantier) lance le jeu avec `--studio-record`, 60 images par seconde fixes (`--fixed-fps 60 --max-fps 60`), donc une partie se rejoue à l'identique. Le relais note :
    - le hasard du jeu (`seed()` global, et `set_seed()` du nœud `studio_test` s'il existe) ;
    - chaque entrée, à son image : touches, souris, toucher, manette, actions ;
    - l'état du jeu (`snapshot()` du nœud `studio_test`) toutes les 30 images, et à la fin.
    - Le fichier va dans les données du hub (`recordings/<projet>/`), gardé 7 jours ; une partie sans action est oubliée. Avant « Essayer », le jeu reçoit les outils du studio à jour (ADR-83).
  - **Rejouer** (`--studio-replay`) : hors de l'écran, à la taille de l'enregistrement, aussi vite que possible. Les entrées d'une image sont injectées la frame d'avant, car Godot les livre au début de l'image suivante, comme pendant l'enregistrement. L'état est comparé aux mêmes images. Le relais rend `STUDIO_REPLAY: {ok, mismatches…}` puis quitte. Les erreurs de script pendant la partie la font échouer.
  - **Garder comme test** (panneau Chantiers, « Vos parties » → « En faire un test », nom et ce qu'elle vérifie) : la partie est rejouée **deux fois** sur la version actuelle du jeu. Si elle diverge (hasard sans graine, temps réel…), elle ferait un test qui échoue au hasard : elle est refusée, avec ce qui a divergé. Sinon elle est commitée dans `studio/replays/<nom>.jsonl`, zone du hub que les agents lisent sans pouvoir l'écrire. Une partie sans état à comparer (pas de `snapshot()`) ne peut pas devenir un test. « retirer » l'enlève.
  - **À chaque chantier**, les vérifications du hub (ADR-32) rejouent les parties gardées dans la copie. Une partie qui diverge dans la copie mais pas dans le jeu actuel est une régression : le développeur corrige, avec l'instant, l'état attendu, l'état obtenu, et ce que vous vérifiiez. Le compte rendu dit « vos parties rejouées ✓ ».
  - **Correctif Git trouvé au passage** (`GitCli.commitPaths`) : un fichier nommé seul, nouveau, dans un dossier nouveau, n'était pas ajouté quand la liste portait l'exclusion des `*.tmp` (Git 2.53 : « ?? studio/replays/ » restait non suivi). Les fichiers nommés sont maintenant ajoutés une seconde fois, sans exclusion.
- **Limites** : jeux Godot seulement ; un jeu qui tire son hasard d'un `RandomNumberGenerator` à part, sans `set_seed`, ou qui dépend de l'heure, ne se rejoue pas à l'identique. C'est alors dit au moment de garder la partie.
- **Vérifié** :
  - `replays.test.ts` (5 tests) : chemin d'enregistrement Godot seulement, lecture d'une partie, refus d'une partie qui diverge, partie gardée et commitée puis retirée, partie sans état refusée, vérification qui dit la divergence en clair.
  - `autonomy.test.ts` : une partie qui diverge dans la copie et pas dans le jeu fait corriger le chantier, puis il est fusionné.
  - `godot.e2e.ts` avec le vrai Godot 4.6.2, deux fois : partie enregistrée par le relais (clics, touche maintenue), rejouée à l'identique ; le carré ralenti (300 → 200), la même partie diverge.
  - Essais préalables : 3 enregistrements sur 3 rejoués à l'identique avec des touches. Avec l'outil du testeur pour une action de l'Input Map (`Input.action_press`, état posé sans événement), le rejeu avait 1 image d'écart : ce n'est pas le cas d'une vraie partie, faite de vrais événements.
  - 263 tests au vert, typecheck.

## ADR-86 — L'équilibreur : des centaines de parties simulées sans écran, des distributions, puis le directeur

- **Contexte** : idée n°5 de la phase 6. L'équilibrage se faisait au ressenti : le testeur joue une partie, vous en jouez quelques-unes. Néon Saloon est un tower defense : vagues, économie et dégâts se règlent sur des centaines de parties, pas sur une.
- **Décision** :
  - **Une simulation** est un fichier `tests/sims/sim_*.gd` du jeu qui « extends StudioSim » (nouvel outil du studio, `addons/studio_tests/studio_sim.gd`) et définit `simulate(graine) -> Dictionary`. Elle joue une partie entière sans écran, avec une stratégie simple, et rend ce qu'elle mesure : nombres, vrai/faux, textes courts. Elle peut appeler la logique du jeu directement (le plus rapide), ou instancier de vraies scènes et les laisser tourner (`add_scene`, `wait_frames`, à 60 images fixes par seconde, aussi vite que possible).
  - **Le lanceur** (`addons/studio_tests/sim.gd`) joue N parties par simulation, une graine par partie (`seed()` global et `rng` de la simulation), et écrit une ligne `STUDIO_SIM:` par simulation. Mêmes graines, mêmes parties.
  - **Le hub** (`godot/sim.ts`, `quality/balance.ts`, table `sim_runs`) en tire des distributions : pour un nombre, moyenne, minimum, maximum, 10e, 50e et 90e centiles, histogramme ; pour vrai/faux, un taux ; pour un texte, les valeurs les plus fréquentes. Il les compare au passage précédent (écart de moyenne de plus de 10 %, de taux de plus de 5 points) et garde la version du jeu mesurée.
  - **Pilotage → Équilibrage** : « Jouer les parties » (50 à 1 000, en arrière-plan), une carte par simulation (gros chiffre, histogramme, fourchette des 9 parties sur 10, écart avec le passage précédent). « Demander des réglages au directeur » envoie les chiffres dans une discussion « Équilibrage », avec votre question : il propose des valeurs précises et prépare le chantier ; vous relancez l'équilibreur pour vérifier.
  - **Les agents écrivent les simulations** : la consigne Godot (`GODOT_RULES`) et la section CLAUDE.md d'un nouveau jeu les décrivent, et le gardien laisse lancer le lanceur des simulations (`-s addons/studio_tests/sim.gd`, `--fixed-fps`, `--runs`, `--seed`, `--only`) comme celui des tests. Un jeu sans simulation reçoit dans l'onglet la phrase à dire au directeur.
  - Aucun modèle ne joue : ce sont des chiffres. Le directeur ne les reçoit que sur votre demande.
- **Vérifié** :
  - `balance.test.ts` : distributions, centiles, histogramme, taux, textes ; comparaison en clair ; deux passages en arrière-plan (le second plafonné à 2 000 parties), version du jeu gardée, chiffres envoyés au directeur avec votre question ; un jeu web refusé ; un passage sans simulation dit pourquoi. `policy.test.ts` : lanceur des simulations permis, autre script ou argument refusés.
  - `godot.e2e.ts` avec le vrai Godot 4.6.2 : 300 parties d'une simulation qui instancie aussi la scène principale, en 0,38 s ; vague atteinte de 4 à 10 ; les mêmes graines redonnent exactement les mêmes chiffres.
  - `pilotage.e2e.ts` : l'onglet Équilibrage, deux passages comparés (capture examinée).
  - 267 tests au vert, typecheck, construction de l'interface.

## ADR-87 — Le banc d'essai des agents : des chantiers de référence refaits à chaque changement de modèle ou de consignes

- **Contexte** : idée n°6 de la phase 6. Les consignes du développeur changent souvent (ADR-26, 41, 77, 83, 85, 86…) et les modèles aussi. Rien ne disait si un changement rendait le développeur meilleur ou pire : on le découvrait sur le chantier suivant, au prix d'un échec réel.
- **Décision** :
  - **Une référence** est un chantier déjà fusionné, choisi par vous (Pilotage → Banc d'essai, « Ajouter au banc », 8 au plus). Le hub garde sa consigne, le commit d'où il était parti, et son coût et sa durée d'origine.
  - **« Passer le banc »** refait chaque référence, l'une après l'autre, en arrière-plan : une copie jetable du jeu partie du même commit (`.data/bench/<projet>/B-xxxx`, branche `studio/banc-B-xxxx`), le développeur actuel en exécution directe (mêmes consignes, même gardien, même compte rendu), puis les vérifications du hub (tests, lancement, parties rejouées). Ni testeur ni fusion : la copie et sa branche sont effacées, le jeu n'est jamais touché, et aucun chantier n'apparaît dans la liste.
  - **Réussi** veut dire : le développeur a rendu un compte rendu qui n'est pas un échec, il a modifié au moins un fichier, et aucune vérification n'échoue. Pour chaque référence, le tableau montre réussi ou raté, tests et jeu, coût, durée et nombre de fichiers, face à l'origine et au passage précédent, avec un total.
  - **L'empreinte du développeur** est un hachage de l'exécuteur, des modèles du développeur (`STUDIO_MODEL_DEV`, `STUDIO_MODEL_DEV_BIG`) et de ses consignes système pour ce jeu (hors carnet « État du jeu », qui bouge à chaque fusion). Si elle a changé depuis le dernier passage, l'onglet le dit : le banc n'est plus à jour.
  - Seul votre clic passe le banc : chaque passage coûte autant que les chantiers de référence, et l'onglet le rappelle.
  - Au passage, la suite de tests a 30 s par test au lieu de 5 (des tests qui font plusieurs commits Git dépassaient parfois sous Windows quand tout tourne en parallèle).
- **Vérifié** :
  - `bench.test.ts` : un vrai chantier mené jusqu'à la fusion devient une référence. Le premier passage refait la consigne depuis le commit de départ (le fichier du chantier n'y est pas encore), et réussit. Le jeu reste au même commit, sans branche du banc ni copie restante, sans chantier ajouté. Un changement de modèle change l'empreinte ; le passage suivant échoue sur les tests et le dit. Un développeur qui s'arrête est dit avec sa raison, et la copie est quand même effacée.
  - `pilotage.e2e.ts` : l'onglet Banc d'essai, deux passages comparés, banc pas à jour (capture examinée).
  - 268 tests au vert, typecheck, construction de l'interface.

## ADR-88 — La passe « game feel » à la demande : la sensation change, les règles non, et c'est vérifié

- **Contexte** : idée n°7 de la phase 6. Le polish (« juice ») arrivait au hasard des chantiers, ou pas du tout, et un effet ajouté en passant pouvait changer une règle (un ralenti qui touche la logique, un recul qui déplace le joueur). Le studio a désormais de quoi prouver qu'une règle n'a pas bougé : parties gardées (ADR-85) et simulations (ADR-86).
- **Décision** :
  - Pilotage → Production, sous les chantiers : « ✦ Passe game feel… ». Vous dites quels moments (vide : les actions principales du joueur) et l'intensité (discrète, marquée, généreuse). Un clic crée la discussion « Game feel : … » et lance le chantier en exécution directe ; si le projet est occupé, il attend son tour dans la file. Refusé en « Je valide tout » : la passe se demande alors au directeur.
  - La consigne (`quality/feel.ts`, `feelGoal`) :
    - repérer chaque moment et ce qui le signale aujourd'hui ;
    - 2 à 4 retours par moment, pris dans un catalogue : arrêt sur image, tremblement à « trauma » qui décroît, flash, écrasement-étirement, éclats, recul, zoom, courbes adoucies, chiffres qui volent, point d'accroche pour un son (le directeur sonore viendra) ;
    - toutes les valeurs dans un seul fichier de réglages (`res://scripts/feel.gd` en autoload « Feel », ou `src/feel.ts`), un interrupteur par effet, une intensité globale, et un réglage « mouvements réduits » ;
    - interdit de toucher une règle, une valeur de jeu, l'ordre des événements, la physique ou le hasard ; l'arrêt sur image ne ralentit que l'affichage (pas d'`Engine.time_scale` sur le jeu) ;
    - la preuve : tests du jeu, parties gardées rejouées à l'identique (si le jeu en a), simulations aux chiffres identiques avant et après (si le jeu en a), et pas de chute d'images par seconde ;
    - un compte rendu « moment → retours → réglages », pour doser ensuite dans la discussion.
  - Le développeur dispose déjà de la compétence game-feel-godot (ADR-78) ; la consigne lui dit de la consulter.
- **Vérifié** : `feel.test.ts` (la consigne pour Godot et pour le web, sous les 4 000 caractères ; refus en « Je valide tout » et sans session humaine ; premier chantier lancé et suivi dans sa discussion, second en file derrière lui, journal). `pilotage.e2e.ts` : le formulaire (capture examinée). Suite complète au vert, typecheck, construction.

## ADR-89 — Le journal de bord : les fusions en images, semaine par semaine, et le récit du directeur sur demande

- **Contexte** : idée n°8 de la phase 6. Le studio produit vite (près de 190 chantiers fusionnés en deux semaines sur trois jeux), mais rien ne montrait le jeu changer. Il fallait ouvrir les chantiers un par un. Chaque chantier a pourtant sa capture du jeu prise par le hub (ADR-33), ses vérifications et son coût.
- **Décision** :
  - Pilotage → Journal : une page par semaine (du lundi au dimanche, heure locale), avec précédente et suivante parmi les semaines où le jeu a bougé.
    - Les chiffres de la semaine : fusions, visuels intégrés, chantiers en échec, coût, passages de l'équilibreur et du banc d'essai, parties gardées comme tests.
    - Chaque fusion, dans l'ordre : sa capture, son titre, le compte rendu simple du développeur, les vérifications du hub en une ligne, son coût. Chaque visuel intégré, avec son image et le chantier qui l'a intégré.
    - Un GIF du jeu au fil de la semaine, une image par fusion (la dernière tenue 3 s), dès qu'il y a deux captures.
  - Le GIF est fait par le hub, sans dépendance (`journal/gif.ts`) : captures décodées par le décodeur PNG de l'ADR-84, ramenées à 640 × 360, palette fixe de 252 couleurs avec un tramage léger, compression LZW. Il est gardé en cache dans `.data/logbook/` et refait quand une fusion s'ajoute.
  - Tout cela sans modèle, à partir du journal du hub. « Raconter la semaine » demande au directeur 5 à 8 lignes : ce qui a changé pour le joueur, ce qui a coûté ou résisté, une suggestion. Il n'a que les faits fournis. Le récit est gardé (table `logbook_weeks`).
- **Vérifié** :
  - `logbook.test.ts` : la semaine commence le lundi. Le GIF est relu par ffmpeg image par image, avec les bonnes couleurs. Deux vrais chantiers fusionnés apparaissent avec leur capture, leurs vérifications et leur coût ; le GIF est fait, puis resservi depuis le cache. Le récit est refusé sans session humaine ; sinon il est demandé avec les faits et gardé.
  - Un GIF fait des huit dernières captures réelles de Bordée (272 Ko en 0,3 s) est relu par ffmpeg ; une image extraite a été examinée.
  - `pilotage.e2e.ts` : l'onglet Journal avec une fusion, un visuel et le récit (capture examinée).
  - 273 tests au vert, typecheck, construction de l'interface.
