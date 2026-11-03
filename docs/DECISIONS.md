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

## ADR-90 — L'export local des jeux Godot : un .exe autonome dans build/, essayé par le hub, jamais envoyé

- **Contexte** : idée n°9 de la phase 6. Pour jouer à un jeu du studio hors de l'éditeur, ou le donner à quelqu'un, il fallait ouvrir Godot, créer un réglage d'export et télécharger les modèles d'export (1,25 Go pour toutes les plateformes). Vous avez choisi un export local seulement : pas de butler ni d'itch.io, rien n'est envoyé.
- **Décision** :
  - **Les modèles d'export** : « Installer les modèles d'export », sur votre clic, pour la version de Godot du PC. L'archive officielle est un zip. Le hub lit son sommaire à la fin du fichier, puis ne télécharge par plages HTTP que les cinq fichiers Windows (exécutables release et debug, leurs consoles, `version.txt`). Cela fait 70 Mo au lieu de 1,25 Go, soit 3 s ici. Ils sont rangés là où Godot les cherche (`%APPDATA%/Godot/export_templates/4.6.2.stable/`), donc l'éditeur en profite aussi. Le dossier n'est rempli qu'à la fin : une interruption ne laisse rien à moitié installé.
  - **« Exporter le jeu (.exe) »** (Pilotage → Production, jeux Godot) :
    - le hub ajoute s'il manque un réglage « Windows Desktop » à `export_presets.cfg`, sans toucher aux autres : jeu embarqué dans l'exécutable, `studio/`, `tests/` et `build/` exclus ;
    - il ajoute `/build/` au `.gitignore` et commite ces deux fichiers ;
    - il exporte la version actuelle du jeu dans `build/<date-heure>/<Nom>.exe` ;
    - il ne garde que les 5 derniers exports ;
    - « Ouvrir le dossier » montre l'exécutable dans l'explorateur.
  - **L'essai de l'exécutable** : le hub lance le .exe obtenu, sans fenêtre, pendant 240 images. Il doit finir sans erreur et avec le code 0. Un jeu qui s'exporte mais plante au démarrage est signalé (pastille rouge et raison).
- **Vérifié** :
  - `export.test.ts` : modèles lus dans un zip par plages (le modèle Linux jamais demandé), rangés au bon endroit. Réglage ajouté à côté d'un réglage Web existant, une seule fois ; `build/` ignoré par Git. Installation puis six exports : 5 gardés, réglage commité, jeu propre. Erreur d'export dite. Refusé pour un jeu web et sans session humaine.
  - Pour de vrai : modèles Windows de Godot 4.6.2 installés depuis l'archive officielle (tailles conformes au sommaire). Néon Saloon (clone) exporté en 17 s, 108 Mo, et son essai passe.
  - `godot.e2e.ts` : un jeu qui écrit une erreur au démarrage est exporté, mais l'essai voit l'erreur. Réparé, il démarre sans erreur.
  - 276 tests au vert, typecheck, construction.

## ADR-91 — Le directeur sonore : des sons proposés, écoutés, choisis, branchés par un chantier, vérifiés après la fusion

- **Contexte** : idée n°10 de la phase 6. Les jeux du studio n'avaient pas de son, ou des sons synthétisés à la volée. Vous avez choisi ElevenLabs, avec votre clé. Les visuels ont déjà leur chaîne (le DA, des essais, votre choix, l'intégration par un chantier, le bilan) ; le son suit le même chemin, sans les boucles automatiques : chaque essai coûte des crédits ElevenLabs.
- **Décision** :
  - **Pilotage → Son**.
    - Sans clé : un champ masqué pour la coller. Elle est vérifiée auprès d'ElevenLabs (`/v1/user/subscription`), puis gardée dans `.data/elevenlabs/key.json`, ou lue dans `STUDIO_ELEVENLABS_KEY`. Elle n'est écrite ni dans le jeu ni dans le journal.
    - Avec la clé : les crédits utilisés sur le total, et la date de remise à zéro.
  - **Proposer** : « Demander des sons ». Le directeur sonore lit la bible et l'état du jeu, plus les sons déjà prévus. Il propose au plus 12 sons, chacun avec :
    - un nom en français et un genre : effet, interface, ambiance ou musique ;
    - le moment où le joueur l'entend ;
    - une description pour le générateur, en anglais ;
    - une durée, et s'il tourne en boucle.

    Vous pouvez retoucher la description avant de générer. La liste est versionnée dans le jeu (`studio/sound/sounds.json`).
  - **Écouter** : « Générer deux essais », sur votre clic seulement. Les effets passent par `/v1/sound-generation` (durée, boucle, influence du texte 0,5), la musique par `/v1/music` (instrumentale, 10 s à 5 min).
    - Une génération à la fois, pour savoir ce que chaque essai a coûté : les crédits sont lus avant et après.
    - Les essais restent dans les données du hub. Le jeu ne reçoit que le son choisi.
  - **Choisir puis intégrer** : « Intégrer les sons » copie les sons choisis dans le jeu (`assets/audio/<genre>/` pour Godot, `public/audio/<genre>/` pour le web), les commite, puis lance un chantier « S-0001, S-0002 : brancher… ». Sa consigne :
    - un seul point d'entrée, l'autoload `Sound` ou `src/sound.ts` ;
    - des lecteurs réutilisés, des bus « SFX » et « Musique », et les volumes dans un fichier ;
    - musique et ambiances en boucle, avec un fondu ;
    - une légère variation de hauteur pour les sons fréquents ;
    - les points d'accroche laissés par la passe game feel (ADR-88) ;
    - aucune règle du jeu touchée.
  - **Vérifier** : après la fusion de ce chantier, le hub cherche dans les scripts et les scènes du jeu (hors `studio/`, outils du hub et exports) si chaque son est appelé. S'il l'est, il est « dans le jeu, joué ». Sinon, il est « copié, jamais joué », comme un visuel intégré que le jeu ne charge pas (ADR-71). Un son dans ce cas repart dans un nouveau chantier au prochain « Intégrer », sans être recopié.
- **Vérifié** :
  - `sound.test.ts` (ElevenLabs simulé) :
    - une clé mal formée est refusée ; une clé refusée par ElevenLabs n'est pas gardée ; une clé acceptée l'est ;
    - les crédits sont lus ;
    - l'adresse, l'en-tête `xi-api-key` et le corps exacts des appels effet et musique sont vérifiés ; une limite atteinte est dite ;
    - parcours complet : liste proposée à partir de la bible, retouche, rien sans clé, essais et leurs crédits, essai introuvable refusé, aucun essai dans le jeu, intégration par un vrai chantier fusionné ;
    - le son branché est « joué », la musique oubliée est « jamais jouée », puis rebranchée par un second chantier ;
    - la clé n'apparaît ni dans le jeu ni dans le journal.
  - `pilotage.e2e.ts` : onglet Son sans clé, trois sons à des étapes différentes (capture examinée).
  - 278 tests au vert, typecheck, construction de l'interface.
  - Pas encore essayé avec le vrai service : il faut votre clé ElevenLabs. À la première génération, vérifier qu'un essai s'écoute et que le coût en crédits correspond à votre compte.


## ADR-92 — Mesurer ce que coûte chaque passage, et un essai Caveman réversible pour le Développeur

- **Contexte** : le directeur créatif a entendu parler de Caveman (caveman.so) pour « surveiller sa consommation de jetons ». Pour surveiller, le hub fait déjà mieux : il lit les chiffres réels de Claude Code (jetons, fenêtres 5 h et 7 jours, coût en équivalent API, par agent et par visuel). Caveman sert à consommer moins : un skill qui raccourcit les réponses (peu utile ici, et nuisible aux messages que vous lisez) et un relais local (`caveman-proxy`) qui compresse ce que l'agent relit. Il manquait au hub les jetons de chaque passage d'un chantier, pour juger un tel outil sur pièces. Consigne : aucune régression, la partie développement donne satisfaction.
- **Essais réels du 27/10/2026** (Haiku, abonnement, relais sur un port de test) :
  - l'abonnement passe par le relais : seule l'adresse change (`ANTHROPIC_BASE_URL`), aucun identifiant, la connexion claude.ai reste celle utilisée ; le cache d'Anthropic reste chaud (un préfixe écrit via le relais est relu en direct) ;
  - en mode « compress » **sans** outil de relecture, le relais transmet tout à l'identique (empreintes égales) : avec un abonnement, il ne compresse que si l'agent a l'outil MCP `caveman_retrieve` ;
  - avec l'outil : sur des sorties de commandes (git log, npm ls, tests), rien n'est compressé, Claude Code ayant déjà rangé les grosses sorties dans un fichier ; sur des lectures de fichiers, quand le contexte grossit, le relais a retiré 14 600 jetons (−22 à −38 % par requête) **en remplaçant des corps de fonctions d'un fichier de code par « caveman: body elided »**. Le modèle a cru le fichier altéré, l'a revérifié à la main : 7 tours au lieu de 6, plus de jetons au total, mais 20 % de moins en équivalent API (moins d'écriture de cache). Avec une consigne qui explique les marques, une autre lecture est restée exacte (rien n'a été abrégé cette fois-là).
- **Décision** :
  - **mesure, toujours** (migration : `runs.route`, `runs.tokens_json`) : chaque passage du Développeur et du Testeur garde ses jetons réels et son chemin. Qualité → « Jetons du Développeur par chantier » : médianes par chantier fusionné (jetons, jetons hors relecture du cache, coût), exécutions et vérifications par chantier, passages échoués, par chemin. C'est la référence, avec ou sans Caveman ;
  - **essai Caveman, éteint par défaut** (`executor/caveman.ts`, `STUDIO_CAVEMAN=off|record|compress`) : éteint, l'exécuteur n'est même pas enveloppé, rien ne change. Allumé, seul le Développeur (plan et exécution) d'une part des chantiers (`STUDIO_CAVEMAN_SHARE`, 0,5 par défaut, tirage fixe par chantier) passe par le relais ; le Testeur, le Jeu express et les mods restent en direct ;
  - le hub lance lui-même `caveman-proxy` sur un port à lui (8797, pas le 8787 de `caveman claude`), avec son propre dossier (`.data/caveman`), et l'arrête à sa fermeture. Un relais déjà là dans un autre mode n'est pas utilisé ;
  - **jamais bloquant** : relais absent ou muet → passage en direct, signalé dans le chantier ; relais tombé en cours de route (erreur de connexion) → le passage est refait en direct ; toute autre erreur reste celle du chantier et compte pour le relais ;
  - en mode « compress », le Développeur reçoit l'outil `mcp__caveman__caveman_retrieve` (permis par le Gardien en plan et exécution, refusé au Testeur ; les autres outils de Caveman sont refusés) et une consigne : un passage marqué « caveman: body elided » ou `<<ccr:…>>` se relit avec cet outil avant d'être cité ou modifié ;
  - installation faite : `npm i -g @caveman-ai/cli` puis `caveman setup --install` (programmes dans `~/.caveman/bin`, empreintes vérifiées). **Pas** `caveman setup --yes`, qui réécrirait `~/.claude/settings.json`, `~/.claude.json` et la configuration d'Hermes (vérifié inchangés).
- **Recommandation** : rester éteint, ou passer en `record` quelques jours pour vérifier la tuyauterie sans effet. `compress` seulement en connaissance de cause : le gain attendu est modeste et le risque est précisément sur la lecture du code par le Développeur. À juger après une dizaine de chantiers fusionnés de chaque côté, sur les jetons hors cache, les reprises et l'avis du Testeur.
- **Non retenu** : le skill Caveman (réponses télégraphiques) pour les agents dont vous lisez les messages ; Caveman Cloud (passerelle hébergée : un identifiant de passerelle ferait passer Claude Code à la facturation au jeton, et elle ne prend pas les abonnements) ; le choix automatique du modèle (compte requis, le hub choisit déjà par agent).
- **Note** : une autre session a inclus ces fichiers, en cours d'écriture, dans ses commits 768eb37 (ADR-90) et 29002f2 (ADR-91) ; ce numéro, d'abord ADR-88 puis ADR-90, a été pris deux fois entre-temps.
- **Vérifié** : `caveman.test.ts` (13 tests : réglages, tirage, coupures, détour et repli, Gardien, mesure en base et comparaison), suite complète, typecheck.


## ADR-93 — Refonte « Obsidienne » : une finition premium, sans rien déplacer

- **Contexte** : demande du directeur créatif, « une vraie refonte polish et premium, qui claque, mais qui reste ergonomique et très optimale ». Après ADR-86 (forge de la DA), l'interface restait plate : des boîtes au même niveau, des boutons en aplat, un vert vif hors palette sur « Essayer », un bouton flottant « à vous » en cyan alors que ce qui vous attend est en braise, un menu latéral long et uniforme.
- **Décision** (CSS surtout : `styles.css`, bloc final de `studio/studio.css` ; une seule classe ajoutée, `side-create`, dans `Sidebar.tsx`) :
  - **matière** : toutes les surfaces de premier niveau (cartes, panneaux, tuiles, chiffres, moniteur) partagent une plaque d'obsidienne : un dégradé de lumière à peine perceptible, un liseré clair en haut, une ombre longue. Une plaque posée dans une plaque reste plate : une seule profondeur à la fois. Nouveaux jetons : `--plate`, `--hairline`, `--lift`, `--elev-1`, `--elev-2`, `--ease` ;
  - **boutons** : le principal en glace polie (dégradé, reflet, liseré cyan, ombre colorée), hauteur minimale de 36 px ; les secondaires et les puces en verre fumé qui s'allument en cyan au survol. « Essayer cette version » et le bouton flottant « à vous » passent à la braise (ce qui vous attend), le vert reste au validé ;
  - **menu** : plus dense ; filet vertical glace → braise ; le jeu actif bien marqué ; les raccourcis « Créer » plus petits et plus discrets que la navigation ; le compteur d'utilisation dans une petite plaque ;
  - **en-tête de projet et onglets** : titre en Exo 2 avec un dégradé clair, moniteur plus lisible (chiffres alignés, jauges fines), onglet actif avec un fond glace léger, onglets segmentés (Pilotage, panneau DA) en relief ;
  - **accueil** : « Bonjour » plus grand, tuiles de jeux sur une grille fine avec une aube glace et braise, initiale en dégradé ; au survol, une arête glace → braise s'allume et la tuile se soulève. Titres de section précédés d'un trait glace → braise ;
  - **chaque écran** : une aube glace et braise très légère en haut de la zone de contenu ; un fondu de 0,28 s au changement de page seulement (jamais sur un panneau qui se rafraîchit pendant la lecture) ;
  - **ergonomie** : rien n'a changé de place ni de nom ; anneau de focus net ; chiffres alignés dans les tableaux et les jauges ; barres de défilement fines ; animations coupées par « réduire les animations » de Windows (règle existante).
- **Non retenu** : verre flou (lourd et moins lisible), une nouvelle police (Segoe reste pour lire), un réagencement des pages (le confort d'usage passe avant l'effet).
- **Vérifié** : captures avant et après (accueil, Pilotage, projet, chantier à relire, Direction artistique, téléphone) examinées ; typecheck ; suites unitaire et navigateur relancées.


## ADR-94 — Refonte « Atelier » : un outil pro haut de gamme, du mouvement précis, une palette de commandes

- **Contexte** : ADR-93 n'était qu'une finition ; le directeur créatif attendait « plus gros, avec des animations, quelque chose de premium ». Ses choix : une vraie refonte de l'accueil, du menu et de l'en-tête de projet, avec les mêmes fonctions ; une ambiance d'outil pro haut de gamme (Linear, Raycast, Vercel : sobre, ultra fluide, micro-animations précises) ; un interrupteur « animations réduites » dans l'interface.
- **Décision** :
  - **`studio/refonte.css`**, chargé en dernier : il redéfinit les jetons (nuit plus neutre `#08090d`, surfaces `#0f1117`, filets à 6 % de blanc, rayons 10 à 12 px, courbe `--ease` en sortie rapide), une seule famille de lettres (Segoe, titres serrés ; Exo 2 et Orbitron ne servent plus), des boutons plats et nets avec un retour à la pression (0,97). Glace = ce que vous choisissez, braise = ce qui vous attend, vert = fait : inchangé ;
  - **menu** : marque compacte (N et « Nidavellir · Studio de jeux »), champ « Rechercher… Ctrl K », « En direct » remonté sous Pilotage, entrées de 30 px. **Un repère unique glisse** d'une entrée active à l'autre (`useGlider`) ;
  - **en-tête de projet** : une barre d'une ligne, « Studio / Nom du jeu » à gauche, l'équipe au travail en pastilles compactes, l'autonomie et « Concevoir » à droite ; le moniteur en fine barre dessous. **Le soulignement de l'onglet actif glisse** d'un onglet à l'autre ; les onglets segmentés (Pilotage, panneau de la DA, Conception) ont un fond qui glisse (`installAutoGliders`, sans toucher à leur code) ;
  - **accueil** : un en-tête court (date, salutation, état de l'équipe), les quatre façons de créer en raccourcis compacts juste dessous, puis deux colonnes : « Pour vous » et « Vos projets » à gauche, « Ce qui vient de se passer » à droite, qui reste visible au défilement. Mêmes liens, mêmes textes ;
  - **mouvement** : chaque page arrive par un fondu qui monte de 6 px ; les listes (tuiles, raccourcis, cartes « pour vous », fil d'activité, chiffres de Qualité, galerie) arrivent en cascade, 35 ms d'écart ; un halo suit la souris sur les cartes, avec une arête qui s'allume du côté du curseur (glace, braise pour ce qui vous attend) ; les messages glissent et se posent ; les jauges avancent en douceur. Rien ne bouge pendant que vous lisez un panneau qui se rafraîchit ;
  - **palette de commandes** (`CommandPalette.tsx`) : Ctrl+K (ou « / ») partout ; recherche sans accents ; aller à une page, ouvrir un jeu sur sa discussion, ses chantiers, sa bible ou sa direction artistique, créer, couper les animations. Flèches, Entrée, Échap. Aucune action nouvelle, seulement des chemins plus courts ;
  - **animations réduites** : interrupteur en bas du menu (et dans la palette), gardé sur ce poste (`localStorage`). Par défaut, il suit « réduire les animations » de Windows. Réduites : plus aucune animation, transition ni halo.
  - Téléphone : même matière, disposition existante gardée (barre d'onglets, menu replié).
- **Non retenu** : une bibliothèque d'animation (tout tient en CSS et en un petit fichier `motion.tsx`) ; les effets spectaculaires d'un lanceur de jeu (grandes images, particules) ; des transitions entre pages qui retardent l'affichage.
- **Vérifié** : `studio.e2e.ts` étendu (Ctrl+K, « qualite » sans accent, Entrée mène à Qualité ; l'interrupteur pose `data-motion="reduced"` puis se garde) ; captures examinées (accueil, palette, projet, Pilotage, chantier, téléphone) ; typecheck ; suites unitaire et navigateur.


## ADR-95 — L'Atelier de démontage, troisième passe : des démontages vérifiés, les données publiques, et le dossier de feature

- **Contexte** : audit demandé par le directeur créatif, qui veut « pousser la décompilation jusqu'au bout, au point d'extraire une feature et de l'insérer dans un jeu », avec un but précis : recréer le mode Swarm de League of Legends (été 2024, retiré depuis). L'audit des trois vrais démontages a montré :
  - **Slay the Spire 2** marqué « Démonté » sans son code C# (51 scripts GDScript, aucun `.cs`) : GDRE Tools en « code seulement » ignore `sts2.dll` ;
  - **Mycopunk** marqué « Démonté » avec trois fichiers génériques : le jeu est mal installé (`Mycopunk_Data` vide), AssetRipper n'a rien lu, et le hub prenait « dossier non vide » pour un succès ;
  - **League of Legends** classé « moteur non reconnu, aucune protection » : Riot Vanguard s'installe dans `C:\Program Files\Riot Vanguard`, jamais dans le dossier du jeu ;
  - une fiche en prose ne suffit pas pour transplanter une feature : aucune donnée chiffrée réutilisable, aucun critère vérifiable.
- **Décision** :
  - **Démontages vérifiés** : un démontage sans code est un échec expliqué (`recoveryProblem` : jeu C# sans `.cs`, Unity sans code, Godot sans script ni scène), et l'Archéologue n'est pas lancé. La détection signale un jeu Unity mal installé (`incomplete`) et refuse de le démonter. Les jeux Riot sont reconnus protégés (exécutables Riot, ou dossier « Riot Games »). Au démarrage, les jeux pas encore démontés sont réexaminés : un LoL déjà ajouté passe « protégé ».
  - **ILSpy** (catalogue fermé, sur votre clic) : `ilspycmd` 9.1, installé par `dotnet tool install` dans `.data/tools/ilspy` (la 10+ exige un SDK plus récent). Il décompile l'assemblage dans `jeu/csharp/` quand le démontage n'a sorti aucun `.cs`. Un jeu Godot C# demande désormais GDRE Tools **et** ILSpy. Essai réel : 3 425 fichiers C# lisibles sortis de `sts2.dll` en 43 s, contre 0 avant.
  - **Données publiques** (`reverse/public-data.ts`, `lol-tables.ts`) : certains jeux sont pilotés par leurs données, que la communauté (CommunityDragon) convertit en JSON et archive version par version. Pour eux, on ne décompile rien, et on ne touche ni au jeu installé ni à son anti-triche : « Importer » télécharge une version archivée. Première source : **League of Legends — Swarm** (`map33`, personnages `strawberry_*`, textes français du mode). Le hub range les nombres en tables courtes (`tables/` : vagues, déroulé, personnages, sorts, améliorations, expérience, progression) et écrit la carte. L'Archéologue est prévenu : pas de code, et la logique fine (déclencheurs, IA des boss) tourne sur les serveurs de Riot ; elle se déduit, ou devient une zone d'ombre. Un jeu protégé dont les données sont publiques propose ce bouton. Essai réel (14.15) : 59 fichiers en 2 s, 1 967 enregistrements, 64 vagues, un déroulé de 21 étapes (vague 1 à 0 s pendant 42 s, vague 2 à 42 s…), 57 personnages, 518 sorts, 105 améliorations, 99 niveaux d'expérience.
  - **Dossier de feature** : à côté des questions, « Dossier de feature » demande à l'Archéologue les règles numérotées et sourcées, les données, les dépendances, les zones d'ombre, et un bloc JSON final (fichiers de données, 5 à 15 scénarios chiffrés). Le hub vérifie ce bloc : des **données seulement** (jamais de code, rien hors du démontage, 5 Mo et 10 fichiers au plus) ; ce qui est écarté est affiché. « Envoyer le dossier au projet » range `fiche.md`, `scenarios.json` et `donnees/` dans `studio/references/<feature>/` du jeu (commit du hub), puis ouvre une discussion avec le directeur : règles à garder, adapter ou laisser ; chantiers dans l'ordre des dépendances ; chaque chantier reprend mot pour mot, dans ses critères d'acceptation, les scénarios qu'il couvre, pour que le testeur les vérifie. Le développeur lit `studio/references/` (lecture seule) et peut en copier une donnée dans le jeu (`cp`, comme les visuels de la DA).
  - **Correctif Git** : `commitPaths` ne commitait rien quand on lui donnait un dossier nouveau dans un dépôt existant (l'exclusion des `*.tmp` faisait sauter les nouveaux fichiers). Les nouveaux fichiers d'un dossier, listés par Git, sont maintenant ajoutés un par un.
- **Cadre** : inchangé (ADR-40). Usage personnel ; on reprend les règles et les nombres, jamais le code d'origine ni les images, sons ou modèles de l'éditeur (la DA du studio les refait). Aucun accès au binaire ni au processus d'un jeu protégé.
- **Non retenu pour l'instant** : Cpp2IL ou Il2CppDumper avec Ghidra pour les jeux IL2CPP (Megabonk, Vampire Survivors, Windblown), FModel pour Unreal (Witchfire), un outil de requête sur les données pour l'Archéologue. À reprendre après Swarm.
- **Vérifié** : `reverse.test.ts` (Vanguard hors dossier, jeu mal installé, démontage vide en échec, ILSpy quand le C# manque, import Swarm et tables, dossier de feature trié puis rangé et commité dans le projet, copie permise par le gardien) ; essais réels d'ILSpy sur `sts2.dll` et de l'import Swarm 14.15 depuis CommunityDragon ; typecheck ; suites unitaire et navigateur.

## ADR-96 — Le code des fonctions des jeux Unity IL2CPP : Cpp2IL, annoté par le hub

- **Contexte** : sur un jeu Unity IL2CPP (Megabonk, Vampire Survivors, Windblown), AssetRipper ne rend que la structure du code : classes, champs, méthodes **vides**. Les règles (formules, conditions, nombres) restaient invisibles, et l'Archéologue devait les deviner à partir des noms et des données. Essais réels sur les trois jeux (métadonnées IL2CPP 29, 31 et 39, Unity 6 compris) :
  - Cpp2IL en `dll_il_recovery` puis ILSpy : toutes les méthodes sortent en `throw null`, inutilisable ;
  - Ghidra (avec Il2CppDumper) demande Java 21, absent du PC, et un projet de plusieurs Go par jeu ;
  - Cpp2IL en `isil` rend le code de chaque fonction dans un pseudo-assembleur où les appels sont déjà nommés (`Call PlayerStats.GetStat`), mais les champs restent des décalages (`[rbx+72]`) et les constantes des adresses (`[0x18262EC80]`) ;
  - Cpp2IL en `diffable-cs` avec `attributeinjector` donne la structure avec le décalage de chaque champ (`//Field offset: 0x48`).
- **Décision** :
  - **Cpp2IL** entre au catalogue fermé (sur votre clic, dans `.data/tools/cpp2il/`) : le programme Windows de la dernière préversion publiée sur GitHub (seules les préversions lisent les Unity récents). Un jeu IL2CPP demande AssetRipper **et** Cpp2IL.
  - **Deux passages** (`dumpIl2cpp`) : `isil` (le code) puis `diffable-cs` (les décalages), dans `cpp2il-brut/`, supprimé ensuite (des centaines de Mo).
  - **Annotation par le hub, sans IA** (`reverse/il2cpp-functions.ts`) dans `jeu/fonctions/<assemblage>/<chemin>/<Classe>.txt` :
    - les champs de l'objet retrouvent leur nom (`[rbx+72 «rb»]`), champs hérités des classes du jeu compris ; le registre qui porte `this` est suivi en ligne droite (rcx, ses copies, effacé quand on y écrit ou après un appel s'il est volatil). Rien pour un paramètre ni pour une méthode statique ;
    - les constantes sont lues dans les sections en lecture seule de `GameAssembly.dll` (`[0x… «15»]`), seulement si la valeur est plausible ;
    - les valeurs d'énumération passées à un appel sont nommées (`«EStat.JumpHeight»` pour 26) ;
    - le désassemblage brut est retiré (moitié du volume, illisible) ; le moteur et les bibliothèques du commerce (Unity, System, DOTween, Rewired, Photon, Coherence, PlayFab, Steamworks…) sont écartés : seul le code du jeu reste ;
    - un `LISEZMOI.md` explique comment lire l'ISIL ; la carte du jeu (`carte.md`) a une section « Code des fonctions ».
  - **Dans le démontage** : un démontage complet enchaîne AssetRipper puis Cpp2IL. Un échec de Cpp2IL n'annule pas le démontage (souvent une demi-heure) : il est noté au journal. **« Récupérer le code des fonctions »** (mode `fonctions`) fait Cpp2IL seul sur un jeu déjà démonté, en quelques minutes ; en cas d'échec le jeu reste « Démonté », avec l'erreur affichée. À la fin, l'Archéologue écrit la fiche « Le code des fonctions : les vraies règles », qui reprend sa vue d'ensemble écrite sur des squelettes.
  - **Consignes de l'Archéologue** : où est le code, comment chercher (Glob sur la classe, Grep sur « Méthode : »), citer fichier, méthode et numéro d'instruction, rester prudent sur les noms de champs déduits.
- **Cadre** : inchangé (ADR-40). Rien n'est écrit dans le dossier du jeu ; Cpp2IL lit `GameAssembly.dll` et les métadonnées, ne lance pas le jeu. Les jeux protégés restent refusés.
- **Limites connues** : l'ISIL reste un pseudo-assembleur, moins lisible que du C# ; le suivi de `this` est une approximation (sauts ignorés) ; les génériques partagés et les méthodes très inlinées peuvent manquer de noms. Non retenu : Ghidra (Java 21, poids), une décompilation en C# par IA (coût, invérifiable).
- **Vérifié** : `reverse.test.ts` (sorties Cpp2IL au vrai format : champs de `this` nommés, rien pour une méthode statique, énumération nommée, moteur écarté, brut supprimé ; Cpp2IL obligatoire, échec non bloquant, « Récupérer le code des fonctions » sans refaire AssetRipper, erreur affichée). Essais réels : installation depuis GitHub (2022.1.0-pre-release.21) ; **Megabonk** : 82 s de Cpp2IL, 9 141 fonctions, 18 392 champs nommés, 3 015 constantes lues, 476 énumérations nommées ; **Windblown** (Unity 6, Photon Quantum) : 26 343 fonctions dans `Bosco`, `quantum.code`, `WindblownPlatformsRuntime`, `Assembly-CSharp`.

## ADR-97 — Une bibliothèque de compétences qui se tient seule : procédures apprises, import d'Hermes, lecture à la demande

- **Contexte** : le directeur créatif trouve la gestion des skills d'Hermes (son assistant) plus efficace que celle du studio et veut en faire profiter les agents des jeux, avec le moins d'actions possible. Les agents du studio ne voient pas la bibliothèque d'Hermes (mode verrouillé, ADR-29). Il leur manquait quatre choses : écrire eux-mêmes des procédures, ne lire que ce qui sert, joindre des annexes, savoir ce qui sert vraiment.
- **Décision** :
  - **Procédures apprises** : quand un chantier est fusionné après des difficultés (corrections demandées, refus du testeur, passage en échec, écarts au plan, au moins deux refus du gardien), un curateur lit le chantier, les rapports, les avis du testeur et les refus. Il écrit une procédure réutilisable (« À utiliser quand… », étapes, pièges, vérification) ou corrige une procédure apprise existante. Elle est active tout de suite, pour ce jeu ou pour tous. Pas de difficulté : aucun appel. Le curateur ne touche jamais aux compétences du hub, aux vôtres ni à celles d'Hermes. Au plus 40 procédures apprises par projet.
  - **Import d'Hermes** : le hub relit `%LOCALAPPDATA%\hermes\skills` (`STUDIO_HERMES_SKILLS` change le dossier ou le vide) 2 minutes après le démarrage, puis toutes les 6 heures. Les skills nouvelles ou modifiées sont triées en un appel (par 80) : seules celles qui aident un agent à faire un meilleur jeu sont gardées. Chacune est adaptée (outils d'Hermes retirés, méthode gardée, en français), puis activée avec ses annexes utiles. Une skill modifiée dans Hermes est réadaptée, sauf si vous l'avez retouchée dans le studio. Une skill supprimée par vous n'est jamais réimportée. Lecture seule : le hub n'écrit rien chez Hermes.
  - **Lecture à la demande** pour le directeur, le Concepteur et le DA : les leçons du projet restent dans leurs consignes. Les autres compétences arrivent en index (nom, « quand », chemin du fichier). Le hub les écrit dans un cache à empreinte (`.data/skill-cache/<empreinte>`, partagé, jamais réécrit, nettoyé après 2 jours) que l'appel reçoit en `--add-dir`, avec l'outil Read seulement. Fin de la limite des 9 000 caractères pour la bibliothèque.
  - **Annexes** (references/, templates/, scripts/, assets/, examples/) : texte seulement, 12 fichiers et 150 ko au plus. Elles sont écrites à côté du SKILL.md dans le plugin du Développeur et du Testeur, dont le dossier devient lisible par le gardien (et seulement lui, pas le reste du run).
  - **Usage** : chaque compétence proposée et ouverte est comptée (outil Skill vu par le gardien ; lecture d'un SKILL.md du cache relevée dans le flux de Claude Code). Une procédure apprise proposée 80 fois sans jamais être ouverte est mise en sommeil.
  - **Retour arrière** : la version précédente de chaque compétence est gardée (curateur, import, vos retouches, leçons), « ↶ Version précédente » la remet d'un clic, et on peut refaire.
  - **Page Compétences** : chiffres (apprises, reprises d'Hermes, ouvertures, leçons), « Ce que le hub a fait tout seul », filtres par origine, origine et usage sur chaque carte, annexes lisibles, bouton « Relire Hermes maintenant ». Les nouveautés apparaissent aussi dans le fil de l'accueil.
  - `STUDIO_SKILLS_AUTO=0` éteint l'apprentissage et l'import.
- **Correctif** : la route d'enregistrement refusait « art_director » (400). La pastille DA de la page ne marchait donc pas, alors que le DA reçoit des compétences depuis l'ADR-78.
- **Vérifié** :
  - `skills.test.ts` : procédure créée après un chantier difficile, puis retouchée, remise, comptée et mise en sommeil ; aucun appel sans difficulté ; import d'Hermes trié et adapté avec annexes, sans appel quand rien ne change, réadapté s'il change, vos retouches et suppressions respectées ; index du directeur et lecture comptée ; arguments de Claude Code ; lecture des en-têtes YAML.
  - `http.test.ts` (DA, détail, retour arrière, état) ; `art.test.ts` (index du DA).
  - Essai réel avec Claude Code (haiku, `--restricted --safe-mode`) : l'agent a ouvert la bonne compétence puis son annexe et cité la valeur exacte, sans ouvrir l'autre. Une lecture hors du dossier des compétences a été refusée.
  - Vérifié aussi : en mode conversation, l'outil Skill aurait exposé les skills intégrées de Claude Code (dataviz, deep-research…) et `--safe-mode` coupe les skills des plugins. D'où Read sur un dossier, plutôt que le plugin.

## ADR-98 — L'équipe se consulte : un agent demande l'avis d'un collègue pendant qu'il vous répond

- **Contexte** : le directeur créatif veut se passer d'Hermes pour créer ses jeux : « tout doit être embarqué dans l'application ». Il trouvait incohérent de réfléchir à la DA à la fois avec Hermes et avec le Directeur artistique. Le modèle est le même. La différence venait de la façon dont le hub faisait travailler ses agents : ils ne se parlaient pas. Le Concepteur transmettait au DA (ADR-59), mais à sens unique, et le directeur créatif faisait seul le lien entre les agents.
- **Décision** :
  - **Outil `consulter`** pour le directeur, le Concepteur (conceptions et Atelier d'idées) et le DA. Ils peuvent consulter : le directeur (état du jeu, chantiers, décisions), le Concepteur (dossier de conception), le DA (bible visuelle, visuels), le directeur sonore (sons) et le Testeur (derniers rapports de vérification, parties jouées). Le collègue répond avec son propre contexte (`team/briefings.ts`) et la mémoire du studio, en une seule réponse, sans pouvoir consulter à son tour. Il ne décide rien et ne lance rien. Au plus 3 consultations par réponse, jamais soi-même.
  - **Servi par le hub, en MCP** : un petit serveur MCP local (`POST /api/agent/team`, JSON-RPC, réponses JSON simples, sans flux) que Claude Code joint par `--mcp-config`. Chaque tour d'agent reçoit un jeton aléatoire à usage unique, qui donne accès seulement à ses outils et disparaît à la fin du tour (45 min au plus). L'agent consulte au milieu de sa réflexion et continue avec la réponse : pas de second appel, et cela marche aussi pour les sorties structurées du Concepteur.
  - **Isolement gardé** : `--safe-mode` coupe aussi les serveurs MCP passés en ligne de commande (vérifié le 28/10/2026). Avec des outils d'équipe, il est remplacé par `--setting-sources ""`. Restent `--restricted`, `--strict-mcp-config` (seul le serveur du hub), la liste fermée `--tools` (ni Skill, ni terminal) et `--allowedTools` limité aux outils `mcp__studio__…` du tour. Sans outil d'équipe, les arguments ne changent pas.
  - **Files** : le collègue consulté passe par sa propre file (`lane: "team"`, 2 places), puisque celui qui le consulte occupe déjà une place dans la sienne : jamais d'interblocage. `MCP_TOOL_TIMEOUT` est porté à 15 min, et un appel qui peut consulter a 10 min de plus.
  - **Tout est montré** : chaque consultation est gardée (table `consultations`, journal `team.consulted`). Elle est ajoutée sous le message de l'agent, sous la forme d'un encart replié « Le Directeur a consulté le Directeur artistique » qui contient la question et la réponse. L'encart apparaît dans la discussion du projet, chez le Concepteur et chez le DA. Au tour suivant, l'agent relit l'échange résumé en une ligne, pas le JSON. Les consultations en cours apparaissent dans « En direct ». La page « Mémoire et équipe » liste les derniers échanges.
  - `STUDIO_TEAM=0` éteint l'équipe : les agents retrouvent leur fonctionnement d'avant.
- **Non retenu** : une balise `[[CONSULTER]]` suivie d'un second appel. Elle doublait le coût et la durée des tours du Concepteur, qui prennent déjà plusieurs minutes. La « réunion » à plusieurs agents viendra si le besoin se confirme.
- **Vérifié** :
  - `team.test.ts` : arguments de Claude Code avec et sans outils ; jeton refusé, outils du tour seulement, jeton oublié à la fin ; le directeur consulte le DA, qui répond avec sa bible dans sa file ; encart et relecture résumée ; 3 consultations au plus, jamais soi-même ; le Concepteur d'un nouveau jeu consulte le DA sans projet ; le DA consulte le Concepteur ; route MCP (401, 202, 405).
  - **Essais réels avec Claude Code** (haiku), avec le vrai `DirectClaudeOrchestrator` : un directeur a consulté le DA, qui a répondu d'après sa bible (16 s en tout). Puis une sortie structurée (comme le Concepteur) a consulté le DA et rendu son JSON avec la palette retenue (17 s).

## ADR-99 — La mémoire du studio : ce que vous avez appris à l'équipe, pour tous vos jeux

- **Contexte** : Hermes retient d'une session à l'autre les goûts et les refus du directeur créatif. Les agents du hub, eux, repartaient de zéro sur chaque projet : seules les leçons d'un projet (ADR-29) passaient d'un tour à l'autre.
- **Décision** :
  - Une **mémoire du studio** (table `studio_memory`) : des phrases courtes (400 caractères), valables pour tous les jeux. Elle est placée en tête des consignes du directeur, du Concepteur, du DA, du directeur sonore, du Développeur et du Testeur. Une décision validée du jeu prime sur elle.
  - **Les agents proposent, vous seul décidez** : avec l'outil `retenir`, un agent propose un souvenir quand vous exprimez une préférence durable (goût, refus, règle). Le souvenir s'affiche sous son message avec « Garder » et « Non », et une notification vous prévient. Rien n'entre sans votre clic. Un doublon est ignoré. Un souvenir refusé n'est plus proposé. Au plus 30 souvenirs en attente.
  - **Page « Mémoire et équipe »** (`#/memoire`, menu Studio) : souvenirs à décider, mémoire gardée (ajouter, modifier, oublier), derniers échanges de l'équipe.
- **Vérifié** : `team.test.ts` (rien n'entre sans vous, doublon ignoré, souvenir gardé lu par le directeur, refusé non reproposé, mémoire donnée au Développeur et au Testeur, API). Essai réel : le directeur a proposé de lui-même « Il déteste les rendus photoréalistes ; il veut un rendu stylisé dans tous ses jeux ».

## ADR-100 — L'Atelier d'idées : avant les projets, vos idées et vos inspirations

- **Contexte** : le hub commençait au projet. Le directeur créatif allait noter ses idées et inspirations ailleurs : un coffre Obsidian avait été proposé puis retiré, car il faisait une deuxième source hors de l'application.
- **Décision** :
  - **Atelier d'idées** (`#/idees`, menu Créer) : une idée (titre, texte libre) et ses inspirations (lien et/ou quelques mots).
  - **« Enrichir avec le Concepteur »** : en arrière-plan, il lit l'idée et ses inspirations (WebFetch), cherche des œuvres proches (WebSearch, adresses vérifiées) et rend un pitch, le fil commun, des pistes de jeu, les questions qui décideront de la forme du jeu, des références et les idées proches de l'atelier (numéros vérifiés par le hub). Il peut consulter ses collègues et proposer un souvenir.
  - **« En faire un projet »** : l'idée, ses inspirations et ce qu'en a tiré le Concepteur ouvrent une conception de nouveau jeu (ADR-28). L'idée passe « Devenue un projet » et garde le lien vers sa conception.
  - Une idée se met de côté, se remet dans l'atelier ou se supprime.
- **Vérifié** : `team.test.ts` (noter, ajouter une inspiration et refuser un lien qui n'est pas http(s), enrichir avec une idée liée inconnue écartée, en faire un projet avec le texte compilé dans le premier message du Concepteur, refus d'un second passage).

## ADR-101 — Des agents qui vérifient avant d'affirmer : la lecture du jeu en conversation

- **Contexte** : en conversation, le directeur, le Concepteur et le DA n'avaient qu'un résumé du code (liste de fichiers, CLAUDE.md) et 16 étapes au plus. Ils affirmaient des choses sur le jeu sans pouvoir les vérifier.
- **Décision** :
  - Outils **`lire_fichier`** (400 lignes numérotées à la fois), **`lister`** et **`chercher`** (texte ou expression régulière, 80 résultats), en lecture seule, dans le dossier du jeu. Ils sont donnés au directeur, au DA et au Concepteur d'une fonctionnalité.
  - **Le hub filtre lui-même** (`team/game-reader.ts`) : rien hors du jeu (liens suivis compris) ; jamais `.git`, `node_modules`, `.godot`, `build`… ; jamais les fichiers sensibles (`.env*`, clés, `credentials`, `secrets`…), même demandés par leur nom. Les fichiers binaires sont refusés et les réponses bornées.
  - Une réponse avec des outils d'équipe a 40 étapes au lieu de 16.
- **Vérifié** : `team.test.ts` (lecture, liste, recherche ; refus de `.env`, de `.git` et de `../`). Essai réel : le directeur a lu `SPEED = 7.5` dans `scripts/player.gd`, puis a vu sa lecture de `.env` refusée et l'a dit sans chercher à la contourner.


## ADR-102 — Des compétences qui se nourrissent et se vérifient seules : besoins, catalogue public, quarantaine, essais automatiques

- **Contexte** : le directeur créatif veut une bibliothèque de compétences « au maximum automatisée ». Elle doit se créer et se nourrir seule, aller chercher sur des dépôts publics, et vérifier toute seule ce qui aide vraiment, sans rien lui demander. Il a levé la règle de l'ADR-29 (« le hub ne télécharge jamais rien seul ») pour une liste fixe de sources, avec relecture, quarantaine et essai obligatoires. Il a accepté un budget de 3 essais de banc par semaine.
- **Décision** : un laboratoire (`skills/lab.ts`) fait **une action au plus toutes les 20 minutes**, dans cet ordre :
  1. Essai des compétences en quarantaine.
  2. Recherche pour les besoins ouverts.
  3. Chaque semaine : catalogue public relu, besoins repérés par jeu actif.
  4. Essai des compétences apprises ou importées jamais essayées.
  5. Chaque semaine : mesure continue, puis ménage.
  - **Besoins** :
    - Le Développeur et le Testeur reçoivent une consigne : une compétence qui leur a manqué s'écrit dans `open_issues` en commençant par « Compétence manquante : ».
    - Chaque semaine, un curateur repère au plus 4 sujets manquants par jeu actif (moteur, état du jeu, leçons, chantiers récents, corrections).
    - Les doublons sont ignorés.
  - **Catalogue public** (`skills/public-catalog.ts`) :
    - **Liste fixe** : anthropics/skills, wshobson/agents, gamedev-skills/awesome-gamedev-agent-skills, Donchitos/Claude-Code-Game-Studios, et obra/superpowers limité à 4 skills (ADR-108). `STUDIO_SKILL_SOURCES` la remplace.
    - **Lecture** anonyme via l'API GitHub (2 appels par dépôt) et raw.githubusercontent, relue chaque semaine.
    - **Licences libres seulement** (MIT, Apache-2.0, BSD, ISC, CC0, CC-BY-4.0, Unlicense), lues sur le dépôt ou dans le LICENSE du dossier de la skill.
    - **Texte seulement** : les `scripts/` ne sont jamais repris, rien n'est exécuté.
  - **Éclaireur**, pour une skill du catalogue choisie pour un besoin :
    1. Filtre sans IA (texte invisible, « ignore previous instructions », curl/wget vers une adresse, secrets, longs blocs encodés, contournement des permissions).
    2. Relecture de sécurité par un appel séparé, qui refuse au moindre doute.
    3. Adaptation au studio (en français, outils du studio, source et licence citées).
    4. **Quarantaine** : aucun agent ne la reçoit.
    Si rien ne convient dans le catalogue, le curateur **écrit** la compétence pour ce jeu, et elle part en quarantaine elle aussi.
  - **Essais** (`skill_trials`) :
    - **Sur le banc**, pour une compétence du Développeur ou du Testeur : le chantier fusionné le plus proche (mots communs) est refait depuis son point de départ, une fois avec la compétence forcée, une fois sans (`benchRun` reçoit `skills: { include | exclude }`). Elle gagne si elle réussit là où l'autre rate, ou si les deux réussissent sans qu'elle coûte ou dure 30 % de plus. Elle perd si elle rate là où l'autre réussit.
    - **En aveugle**, pour le directeur, le Concepteur et le DA : une demande réaliste est écrite, deux réponses sont faites (avec et sans la compétence), puis un juge les compare sans savoir laquelle est laquelle. L'ordre ne dépend que de l'identifiant de la compétence.
    - **Budget** : au plus 3 essais de banc par semaine (`STUDIO_SKILL_TRIALS`), seulement si aucun chantier ne tourne et si l'abonnement est sous 50 % sur 5 h et sous 70 % sur la semaine. Les essais en aveugle (4 appels courts) sont plafonnés à 10 par semaine.
    - **Verdict** : en quarantaine, « réussi » active et « raté » écarte ; deux égalités écartent aussi, faute de preuve. Une compétence déjà active (apprise, reprise d'Hermes) n'est retirée que sur un échec.
  - **Motifs** : tous les 5 chantiers fusionnés d'un jeu, un curateur lit les derniers chantiers réussis et ce que le Testeur a vérifié ou trouvé en jouant. Il en tire au plus 2 procédures ou listes de vérification (actives, essayées ensuite).
  - **Mesure continue** (`skill_tasks`) : pour chaque chantier, le hub retient les compétences proposées et celles ouvertes. Chaque semaine, si une compétence apprise, importée ou publique fait au moins 30 points de « premier coup » de moins quand elle est ouverte (6 chantiers au moins de chaque côté), elle est retirée. Les vôtres et celles du hub ne sont jamais touchées.
  - **Ménage** hebdomadaire des procédures apprises (6 au moins) : fusion des doublons dans la meilleure, retrait des fausses ou périmées, versions précédentes gardées.
  - **Page Compétences** : chiffre « En essai » (essais de la semaine), fil des essais, imports, refus et retraits, liste des besoins repérés, badges « Catalogue », « En essai », « Écartée », résultat du dernier essai sur chaque carte, filtres « Catalogue », « En essai », « Écartées ».
- **Non retenu** :
  - La découverte automatique de nouveaux dépôts (recherche GitHub) : la liste reste fixe.
  - Tout essai pendant qu'un chantier tourne.
  - Toucher aux compétences ajoutées par vous ou fournies par le hub.
  - La mise en quarantaine des procédures apprises de vos propres chantiers : elles restent actives tout de suite et sont essayées ensuite.
- **Sécurité** : une compétence externe reste un texte que les agents suivront. Les garde-fous sont la liste fixe, la licence, l'absence de scripts, le filtre, la relecture séparée, la quarantaine et l'essai, et le gardien du Développeur reste inchangé. Le risque est réduit, pas nul.
- **Vérifié** :
  - `skill-lab.test.ts` : besoin signalé puis catalogue (licence GPL écartée, scripts jamais repris, quarantaine) ; skill malveillante refusée sans relecture ; essai de banc avec et sans (plugin forcé et retiré, activation) ; budget de 3 par semaine ; essai en aveugle ; compétence écrite quand rien ne convient ; motifs après 5 fusions ; rien quand c'est éteint ; règles de comparaison, licences, signaux suspects.
  - Essai réel : 78 skills lues dans gamedev-skills en 4 s, toutes sous licence libre. `godot-shaders` récupérée avec son annexe ; Claude a accepté sa relecture et refusé une skill piégée (lire `.env` puis le coller dans le README). L'adaptation est en français avec la ligne « Source ».

## ADR-103 — Une chaîne de production en béton : rien ne se perd d'une passe à l'autre, moins d'actions perdues, moins d'interventions

- **Contexte** : audit du 28/10/2026, sur les vraies données du hub (14 au 27/10 : 3 jeux, 202 chantiers, 186 fusionnés, 463 passages) et l'historique Git des jeux.
  - Un bug caché : les numéros de passage (`RUN-xxxx`) étaient comptés par jeu. 129 numéros existaient dans deux jeux, avec le même dossier de travail, et le hub retrouve un passage en cours par son seul numéro. Deux jeux au travail en même temps avec le même numéro, et le premier développeur voyait tous ses outils refusés. Ce n'était jamais arrivé (aucun passage simultané), mais cela interdisait tout parallélisme. Rien ne plafonnait non plus le nombre de passages simultanés.
  - Une correction automatique repartait sans savoir ce que la passe précédente avait fait, avec au plus 8 des points du testeur. Le testeur revérifiait sans se souvenir de ce qu'il avait relevé. Résultat : 12 corrections sur 34 échouaient encore.
  - En atelier, les critères du testeur étaient génériques (« La consigne est réalisée ») ; 17 % des critères restaient « non vérifiables ». Le diff montré au testeur était coupé à 60 000 caractères, sans dire ce qui manquait.
  - 602 refus du gardien, souvent sur des commandes sans danger : le `$` d'une expression régulière (`grep -v "^$"`), le `cat > /dev/null <<'EOF'` vide que Claude Code met devant ses commandes, et la lecture des sorties longues que Claude Code range lui-même dans `%TEMP%\claude\…` (l'agent ne pouvait pas lire le résultat de ses propres tests). L'agent retentait des variantes.
  - Des fusions bloquées par `studio/art/assets.json`, écrit par le hub sans être enregistré : on vous demandait un commit. Une autre affichait « Conflit de fusion sur : ? ».
  - Testeur sur Haiku : 1 min 15, 0,015 $ par vérification, 3 régressions rattrapées par le hub seulement.
- **Décision** :
  - **Numéros de passage uniques dans tout le hub** (`nextGlobalId`, compteur `*`, toujours au-dessus de tous ceux déjà donnés). Les anciens passages restent lisibles tels quels.
  - **Réservoir d'agents** (`executor/agent-pool.ts`) : au plus `STUDIO_MAX_AGENTS` développeurs et testeurs au travail en même temps, tous jeux confondus (3 par défaut). La place n'est tenue que pendant que Claude Code tourne, puis rendue avant les vérifications du hub et le testeur : un développeur n'attend jamais la place de son propre testeur. Un passage arrêté pendant l'attente renonce. « En direct » dit quand un passage attend une place.
  - **Rien ne se perd d'une passe à l'autre** :
    - la correction reçoit `<ta_passe_precedente>` (fichiers déjà modifiés dans la copie, son rapport, ce qu'elle avait laissé en suspens) et les retours du plus ancien au plus récent, le dernier étant à traiter ; elle doit dire point par point ce qu'elle a corrigé ;
    - tous les points du testeur passent, sans coupe ;
    - la revérification reçoit `<verification_precedente>` : chaque point relevé est revérifié d'abord, avec une preuve nouvelle, puis le reste, pour repérer ce que la correction aurait cassé.
  - **Le testeur juge la consigne, pas des critères génériques** : en atelier, il la découpe en exigences vérifiables (comportement, valeur chiffrée, visuel, texte, cas limite), une vérification par exigence ; une exigence non réalisée est un échec, pas une note. Il reçoit la liste complète des fichiers modifiés. Le diff est donné fichier par fichier dans la limite ; ce qui n'y tient pas est nommé, avec la commande `git diff <base> -- <fichier>` pour le lire.
  - **Dernière correction automatique sur le modèle des gros chantiers**, au lieu de refaire la même passe une troisième fois. C'est dit dans la discussion, et ce n'est pas fait pour un chantier déjà « (gros) ».
  - **Testeur conseillé : Sonnet** au lieu de Haiku. Il relit, joue et juge chaque exigence, pour quelques centimes par chantier. `STUDIO_MODEL_QA` et le réglage du studio priment toujours.
  - **Gardien** :
    - un `$` entre guillemets passe s'il n'est suivi de rien qui en fasse une variable ou une substitution (`$HOME`, `$?`, `$(…)`, `${…}`, `$[…]` restent refusés) ;
    - le heredoc VIDE vers `/dev/null` placé en tête de commande est ignoré (un heredoc non vide reste refusé), et `>> /dev/null` vaut `> /dev/null` ;
    - le dossier des sorties longues de Claude Code pour CETTE copie (`%TEMP%\claude\<chemin de la copie>`) est lisible, jamais modifiable, celui d'une autre copie non ;
    - au deuxième refus pour la même raison, l'agent est prié de changer d'approche plutôt que de tenter une variante.
  - **Fusion sans usine à gaz** :
    - si les seules modifications non enregistrées du jeu sont dans `studio/` (la zone du hub), le hub les enregistre avant la fusion (« studio: état du studio enregistré avant la fusion de T-xxxx »), journalisé `studio.saved`. Un fichier à vous bloque toujours la fusion : il n'est jamais enregistré à votre place ;
    - quand Git refuse une fusion sans fichier en conflit, sa raison est rendue telle quelle au lieu de « ? ».
- **Non retenu (pour l'instant)** :
  - plusieurs développeurs sur le même jeu en parallèle : dans 41 % (Survivor), 54 % (Bordée) et 76 % (Néon Saloon) des cas, deux chantiers qui se suivent touchent les mêmes lignes. Il faudra d'abord un « chef de chantier » qui prédit les fichiers touchés, et une fusion en file avec reprise. Le réservoir et les numéros uniques en sont le socle ;
  - laisser la file avancer quand un chantier attend votre avis : les suivants s'appuient souvent sur lui (même raison que l'ADR-77) ;
  - remplacer Fable par Opus pour les chantiers « (gros) » : les données (7,61 $ contre 1,13 $, même taux de reprise de 20 %) le suggèrent, mais ce choix vous revient (« Le studio en direct ») et se mesure d'abord sur le banc d'essai (ADR-87).
- **Vérifié** : `pipeline.test.ts` (12 tests) :
  - numéros uniques entre jeux et au-dessus des compteurs par jeu ;
  - réservoir : attente, place rendue une seule fois, renoncement à l'arrêt, chantier complet avec une seule place ;
  - gardien : `$` permis et refusés, heredoc vide ou non, sorties temporaires de la copie et d'une autre copie, deuxième refus identique ;
  - prompts de correction et de revérification, exigences de la consigne, diff trop long ;
  - boucle de trois passes : la passe précédente transmise, dix points sur dix transmis, dernière passe sur le modèle des gros chantiers ;
  - fusion : `studio/` enregistré par le hub, un fichier à vous qui bloque toujours.

## ADR-105 — Compétences externes durcies : réservées au Développeur et au Testeur, et plus d'autorisation automatique après usage

- **Contexte** : après l'ADR-102, le danger estimé était de 3 sur 10. Deux risques ressortaient :
  - une compétence externe piégée qui ferait ouvrir une adresse web par un agent qui a le web (DA, Concepteur), ce qui peut faire fuir des informations du jeu ;
  - en atelier, une consigne piégée qui entre dans le code du jeu, parce que les actions hors plan y sont autorisées automatiquement et la fusion se fait seule.
  Le directeur créatif a demandé ces deux durcissements.
- **Décision** :
  - **Réservées au Développeur et au Testeur** (`EXTERNAL_AGENTS`), qui travaillent dans une copie, sans réseau, sous le gardien :
    - une compétence du catalogue public n'est jamais donnée au directeur, au Concepteur ni au DA (`forAgent`, et l'index lu à la demande) ;
    - la route d'enregistrement retire ces agents, et leurs pastilles sont grisées sur la page ;
    - l'éclaireur refuse une skill qui ne servirait qu'à eux, et le tri du catalogue est prévenu.
  - **Plus d'autorisation automatique après une compétence externe** :
    - dès qu'un passage du Développeur ou du Testeur ouvre une compétence du catalogue (outil `Skill` vu par le gardien), ce qui sort du plan n'est plus autorisé d'office en atelier : la demande vous parvient comme une escalade ordinaire (notification) ;
    - sans réponse au bout de 15 minutes, c'est un refus, et l'agent continue sans cette action ;
    - le journal note `escalation.external_skill` ;
    - le banc d'essai garde l'autorisation automatique : sa copie est jetée et rien n'y est jamais fusionné ;
    - les compétences apprises, celles d'Hermes, les vôtres et celles du hub ne changent rien.
- **Effet estimé** : danger d'environ 3 sur 10 ramené à environ 2 sur 10. Le risque restant est une consigne piégée qui reste DANS le plan validé ou dans le travail du Testeur. Git permet toujours de revenir en arrière.
- **Vérifié** : `skill-lab.test.ts`. Le directeur et le DA ne reçoivent pas la compétence externe ; l'enregistrement retire les agents interdits ; une skill destinée au seul DA est refusée. En atelier, l'écriture hors plan après une compétence externe est soumise à votre accord, puis refusée faute de réponse, alors que le chantier suivant, sans compétence externe, est autorisé automatiquement comme avant.


## ADR-104 — Le chef de chantier : plusieurs développeurs sur le même jeu, une fusion en file, une réconciliation quand deux chantiers se croisent

- **Contexte** : un seul chantier avançait à la fois par jeu (ADR-31). L'audit du 28/10 comptait 315 heures-chantier d'attente derrière un chantier en cours. Mais lancer simplement plusieurs développeurs sur le même jeu aurait été une erreur : dans 41 % (Survivor), 54 % (Bordée) et 76 % (Néon Saloon) des cas, deux chantiers consécutifs modifient les mêmes lignes (calcul `git merge-tree` sur l'historique réel). Le socle de l'ADR-103 (numéros de passage uniques, réservoir d'agents) rendait le parallélisme possible ; il fallait encore décider QUOI paralléliser, et fusionner sans risque.
- **Décision** :
  - **Le chef de chantier** (`executor/foreman.ts`) : un appel structuré, sans outil, sur le modèle de l'archiviste. Il reçoit la consigne, les autres chantiers en cours ou en file, la liste des fichiers du jeu et CLAUDE.md. Il rend une **fiche** rangée sur le chantier (`Task.scope`) : fichiers probablement touchés (les chemins cités dans la consigne y sont toujours ajoutés ; rien de `studio/`), chantiers dont il dépend, s'il sait où le chantier agit, et une phrase pour vous. En panne, la fiche est « incertaine » : le chantier attend son tour, comme avant.
  - **L'ordonnanceur** (`TaskService`), seulement en atelier et avec `parallel` > 1 :
    - jeu libre : le premier chantier part tout de suite, sans fiche ni appel, comme avant. La fiche n'est demandée que s'il y a déjà un chantier en cours ou en file ;
    - un chantier de la file part s'il est compatible avec tous ceux qui occupent le jeu ET avec ceux qui le précèdent dans la file. Il ne double jamais un chantier dont il dépend ou avec lequel il partage un fichier ;
    - compatibles = deux fiches sûres, aucune dépendance, aucun fichier commun. Un dossier « src/ui/ » couvre ses fichiers, et les fichiers qu'un chantier en cours a réellement déjà touchés comptent aussi ;
    - au plus `parallel` chantiers par jeu (`STUDIO_PARALLEL`, 2 par défaut au lancement du hub ; 1 dans les tests et sans réglage). Le réservoir d'agents (3) borne l'ensemble ;
    - une seule décision d'ordonnancement à la fois par jeu. Un chantier « à relire » occupe toujours une place et ses fichiers ; les autres avancent ;
    - l'échec d'un chantier retire toujours la file (ADR-77).
  - **Le développeur connaît son périmètre** : un bloc `<travail_en_parallele>` lui donne les fichiers prévus et ceux que les autres chantiers en cours ont en main. Il doit rester dans son périmètre ou dire tout écart.
  - **Fusion en file** : avant de fusionner un chantier, le hub fusionne la version actuelle du jeu dans SA copie (`integrate`), une fusion à la fois par jeu :
    - rien n'a bougé : fusion directe ;
    - fusion propre : les vérifications du hub (tests, lancement, performance, parties gardées) sont refaites sur l'ensemble. Une régression renvoie au développeur, sans fusion ;
    - conflit : la fusion reste en cours dans la copie avec ses marqueurs, et le développeur fait une **passe de réconciliation** (garder les deux intentions, retirer tous les marqueurs). Le testeur revérifie ensuite. Le hub refuse d'enregistrer s'il reste un marqueur `<<<<<<<` ou `>>>>>>>` : le chantier échoue et se relance de zéro sur la version actuelle, et votre jeu ne reçoit jamais de marqueur ;
    - le point de départ du chantier devient la version intégrée : son diff, le gardien des zones interdites et le testeur ne voient que son propre travail.
  - **Votre « fusionne »** passe par la même réunion.
  - **Git** : les fusions dans un jeu passent par la même file que les enregistrements du hub dans ce dépôt (bug réel trouvé par les tests : deux fusions simultanées, « index.lock »).
  - **Ce que vous voyez** :
    - dans la discussion, une phrase par décision : « ⇉ T-0012 démarre en même temps que T-0011 : aucun fichier en commun (…) » ou « ⏳ T-0012 attend T-0011 : ils touchent tous deux src/main.ts » ;
    - au lancement : « en file : le chef de chantier regarde s'il peut avancer en même temps que… » ;
    - au moniteur : « T-0011 +1 » et la liste des chantiers en même temps.
  - Le directeur est prévenu que deux chantiers bien délimités (une ligne « Où : ») peuvent avancer ensemble.
- **Non retenu** :
  - un éclaireur Claude Code qui lit le code (1 à 2 minutes et environ 10 fois le coût par chantier, pour une prévision déjà bonne) ;
  - rejouer d'office un chantier en conflit au lieu de le réconcilier (une passe complète au lieu de quelques minutes, et le travail vérifié perdu) ;
  - laisser la file doubler un chantier qui attend votre avis sans regarder ses fichiers ;
  - le parallélisme hors atelier.
- **Vérifié** :
  - `parallel.test.ts` (8 tests, trois passages d'affilée sans échec) :
    - compatibilité (fichiers, dossiers, casse, dépendance, incertitude, fichiers réellement touchés) ;
    - chemins de la consigne ;
    - deux chantiers réellement simultanés (le premier attend que le second ait commencé), puis réunis et fusionnés ;
    - un même fichier : attente annoncée, puis départ de la version qui contient le premier ;
    - chef de chantier en panne : attente ;
    - prévision ratée : réconciliation avec marqueurs, puis fusion des deux intentions ;
    - marqueur oublié : échec, jeu intact ;
    - sans réglage, jamais appelé ;
  - la suite complète passe (le seul échec vu, `sound.test.ts`, dépasse son délai sous charge et passe seul) ;
  - **essais réels** (Sonnet, chantiers fusionnés de Bordée et de Survivor, prévision comparée aux fichiers réellement touchés) :
    - les fichiers réels sont presque tous prévus (8/8, 5/7, 4/4, 26/26, 5/5, 4/4 sur Survivor) ;
    - Bordée (refonte du HUD en chantiers enchaînés) : tout reste à la suite, à raison ;
    - Survivor : en parallèle la seule paire réellement indépendante, en attente les paires qui partagent `view3d.ts` ou qui dépendent l'une de l'autre ;
    - un premier essai montrait un chef de chantier jamais « sûr » (aucun parallélisme). La consigne précise maintenant que le croisement est jugé par le hub, et seulement là où le chantier agit par lui ;
    - environ 0,05 $ et 6 secondes par fiche.


## ADR-106 — La Forge : l'équipe de chaque jeu en voxels, à ses postes

- **Contexte** : avec plusieurs développeurs sur un même jeu (ADR-104), le directeur créatif veut voir l'équipe travailler d'un coup d'œil, par poste, avec les chantiers en cours et tout ce qu'il faut savoir. Il a demandé une vue « simulée », en style voxel, sur le thème de Nidavellir (la forge des nains).
- **Décision** :
  - un onglet **La Forge** dans chaque jeu (`#/p/<jeu>/forge`, aussi dans Ctrl K et sur la tuile du projet). C'est une salle de nains en diorama isométrique (three.js, chargé seulement à l'ouverture de l'onglet) ;
  - tout est construit en code avec des cubes, sans fichier graphique (`apps/web/src/studio/forge/`) :
    - la salle du conseil (Directeur, Concepteur), le scriptorium (Archiviste) et l'atelier d'art et de son (DA) ;
    - le foyer, où se reposent ceux qui n'ont rien à faire ;
    - **un établi par chantier simultané** (réglage `STUDIO_PARALLEL`), le banc d'essai (Testeur) et le trésor (la version du jeu) ;
    - la porte (Gardien), la file des caisses et le tableau du chef de chantier ; devant, votre table ;
  - les personnages suivent les **vrais états** :
    - la vue Studio, déjà interrogée, donne ce que fait chaque agent sur ce jeu ;
    - la nouvelle route en lecture seule `GET /api/human/projects/:slug/forge` (`studio/forge.ts`) donne les établis (chantier, étape, passage en cours, dernière action, fiche du chef de chantier), la file avec **la raison de chaque attente** (calculée par `conflictBetween` d'ADR-104), les demandes du Gardien, les fusions du jour et le réservoir d'agents ;
  - la mise en scène suit ces états, sans montrer la réflexion des agents :
    - au travail : le développeur frappe l'enclume (étincelles), lit sa consigne pendant le plan et les contrôles du hub, le testeur se penche sur le banc ;
    - quand on vous attend : un « ! » couleur braise, la lanterne de la porte en braise si le Gardien bloque une action, une caisse qui rougeoie sur l'établi d'un chantier qui attend votre mot ;
    - au repos : le nain va au foyer (hydromel le jour, il dort la nuit) ;
    - une fusion nouvelle envoie un wagonnet du banc d'essai au trésor ;
  - un clic sur un nain, un établi, la file, votre table ou le trésor ouvre une fiche à droite : chantier (lien), étape, durée, dernières actions du passage (rafraîchies toutes les 3 s), fiche du chef de chantier, raison de l'attente. On tourne la vue à la souris, on zoome à la molette, « Recentrer » revient à la vue de départ ;
  - **cycle jour / nuit** sur l'heure réelle : ciel aux fenêtres, soleil puis lune, lumière ambiante, torches plus vives la nuit. Le bouton « Cycle accéléré » fait passer une journée en 36 secondes ;
  - **aperçu sur l'accueil** : la Forge du jeu le plus occupé, en petit (sans ombres, 30 images par seconde), avec des puces pour changer de jeu. Un clic l'ouvre ;
  - **Démo** : une minute de studio imaginaire en boucle, annoncée par un bandeau, pour voir la Forge s'animer quand l'équipe se repose ;
  - l'interrupteur des animations fige la scène : les personnages vont directement à leur poste, sans particules, et l'image n'est redessinée qu'à chaque changement. Le rendu est aussi en pause quand l'onglet est caché ou la scène hors de l'écran.
- **Non retenu** :
  - des modèles 3D ou des sprites dessinés (des fichiers à maintenir, alors que les cubes en code restent cohérents avec la charte) ;
  - des étiquettes en texte 3D (moins lisibles que des étiquettes HTML aux polices du studio) ;
  - un vrai calcul de chemins : deux allées et deux couloirs suffisent pour une salle fixe ;
  - montrer la pensée des agents en direct : la fiche donne les dernières actions réelles du passage, ce qui est plus honnête.
- **Vérifié** :
  - `forge.test.ts` (2 chantiers sur le même fichier, avec 2 établis) : au repos, puis un établi occupé (étape, passage, fiche), le second chantier en file avec « attend T-0001 : ils touchent tous deux src/grille.ts », enfin les deux fusions comptées et la forge vide ;
  - `npm run typecheck`, `npm run build` (three.js dans un fichier à part, environ 130 Ko compressés, chargé seulement par la Forge) et la suite complète ;
  - hub de test réel : captures de la Forge au repos, en démo de jour, en démo de nuit (Gardien qui bloque, nains endormis), d'une fiche de développeur, de la file avec sa raison, avec les animations réduites, et de l'aperçu sur l'accueil.
- **Complément (finition « forge premium »)** : le directeur créatif trouvait que la première version ressemblait à « une taverne pas finie ». Il signalait aussi deux défauts : les développeurs n'atteignaient pas leur établi, et le wagonnet partait de nulle part.
  - **Décor** :
    - basalte sombre, liserés et chapiteaux de bronze, piliers, bande de runes cyan au pied des murs, chaînes ;
    - au centre, une grande forge (creuset et hotte de bronze) remplace le feu de camp ;
    - une rigole de métal en fusion part du creuset et passe devant les postes ; on la franchit sur des grilles ;
    - chaque poste a son fourneau, son soufflet, son enclume, un billot pour la caisse du chantier, un bac de trempe et un râtelier ;
    - un trône pour vous, et un trésor sous une arche ;
  - **Rendu** :
    - halo (bloom) sur ce qui est plus clair que le blanc (métal en fusion, feux, runes, étincelles), sans courbe de tons qui les pâlirait ;
    - braises qui montent de la forge et de la rigole ;
    - métal et runes qui respirent ;
    - l'aperçu de l'accueil reste sans halo ni ombres ;
  - **Développeurs coincés** : quand le nombre d'établis changeait, `layoutBenches` créait un nouvel objet poste à chaque rafraîchissement (toutes les 2,5 s). Les nains recevaient alors un nouveau trajet qui repartait de leur ancien point d'arrivée, d'où les allers-retours près des fours. Les postes sont maintenant des objets stables dont seules les coordonnées changent, et un nain ne reçoit un nouveau trajet que si sa destination change vraiment ou si les postes ont bougé. L'arrivée se fait par la droite de l'enclume ;
  - **Wagonnet** : il attend, vide, au butoir devant le banc d'essai. À une fusion, il est chargé, roule jusqu'au trésor (le coffre s'ouvre, l'or jaillit), puis revient à vide ;
  - au repos, les nains se chauffent les mains à la grande forge au lieu de boire.
  - **Vérifié** : typecheck et build ; dans le hub de test, une séquence chronométrée de la démo (le wagonnet chargé au départ, à mi-chemin, au trésor coffre ouvert, puis revenu ; les développeurs à leur enclume), plus des captures de jour, de nuit et de l'accueil.

## ADR-107 — Le plan de production : un objectif, tous les métiers enchaînés

- **Contexte** : le directeur créatif a demandé si un « orchestrateur » serait utile. Le hub en a déjà un pour le code : le Directeur, le pilote automatique, les séances autonomes et le chef de chantier (ADR-104). Mais une fonctionnalité qui touche plusieurs métiers (« un boss avec son look et son rugissement ») le faisait passer lui-même d'une page à l'autre : Directeur artistique, puis directeur sonore, puis discussion pour le code. Hermes comme orchestrateur reste écarté (ADR-18) : il coûterait une clé API pour refaire ce que le hub fait déjà. Sa demande : « aucune perte, aucune régression, pas de baisse de qualité ».
- **Décision** :
  - **Le plan de production** (`apps/hub/src/production/`). En atelier, le Directeur termine sa réponse par un bloc `[[PRODUCTION]] … [[/PRODUCTION]]` quand une demande touche le code ET des visuels ou des sons, sans demander une vraie conception (celle-là reste au Concepteur). La règle et l'état des plans lui sont donnés dans `<plans_de_production>` ; le Concepteur ne les voit pas.
  - **Préparation** : une sortie structurée (schéma zod) du Directeur « en mode plan ». Elle reçoit la demande, la fin de la discussion, l'état du jeu, CLAUDE.md, la liste des fichiers, les visuels et les sons existants, la mémoire du studio. Elle rend un titre, l'objectif, 3 à 8 critères d'acceptation vérifiables, les visuels manquants, les sons utiles et 1 à 6 chantiers au format habituel (Objectif / À faire / Où / Contraintes / Vérification / Hors périmètre), chacun relié à ses visuels et à ses sons. Le plan s'affiche dans la discussion, sous forme de carte (`§PRODUCTION§`). **Rien ne part sans votre clic « Valider le plan »**. Une nouvelle proposition dans la même discussion remplace celle qui n'était pas validée.
  - **Aucun circuit nouveau, donc aucune perte de qualité** : le plan passe par les circuits existants, sans les modifier.
    - Les visuels passent par `art.brief`, comme une conception (ADR-59) : la file du Directeur artistique, vos validations, le provisoire posé par les chantiers, l'intégration automatique après la fusion du chantier qui pose la place (ADR-60, 62), le contrôle dans le jeu.
    - Les chantiers passent par la file habituelle : chef de chantier, testeur, corrections automatiques, fusion. Leur consigne est celle du plan, mot pour mot, suivie du chemin du dossier du plan, du bloc « Visuels confiés au Directeur artistique, pas encore faits » au format des conceptions, et d'une demande de points d'accroche nommés pour les sons à venir.
    - Les sons : le directeur sonore propose ceux du plan (`sound.proposeFor`). Vous générez les essais (crédits ElevenLabs, toujours sur votre clic) et choisissez. Quand tous les chantiers du plan sont fusionnés, le hub branche les sons choisis par un chantier (`sound.integrateFor`, dans la discussion du plan), puis vérifie après la fusion qu'ils sont bien joués (ADR-91).
    - Le dossier du plan est écrit dans le jeu (`studio/production/p-xxxx-….md`) et commité. Chaque agent le lit, et le Directeur artistique en reçoit une copie.
  - **La vérification d'ensemble**, nouveauté du plan pour la qualité : quand chantiers, sons et visuels sont terminés, un dernier chantier reçoit l'objectif, les critères et tout ce qui a été produit (chantiers, fichiers des visuels validés avec l'avis du validateur dans le jeu, chemins des sons). Il vérifie chaque critère sur le jeu, écrit ou complète des tests automatisés qui les couvrent, et corrige seulement les défauts d'assemblage : provisoire resté en place, son jamais joué, branchement manquant. Il ne change ni règle ni visuel validé, et rend un compte rendu critère par critère. Le testeur le vérifie comme tout chantier. Sa fusion termine le plan, avec un bilan dans la discussion.
  - **Le pilote du plan est du code, pas un agent** : il ne résume rien et ne décide rien. Il lit l'état réel (statut des chantiers, `assets.json`, `sounds.json`) à chaque changement de chantier ou de son, plus un passage de sécurité toutes les 2 minutes. Une évaluation à la fois par jeu, pour ne jamais lancer deux fois la même étape. Un visuel intégré n'est compté qu'une fois regardé dans le jeu par le validateur, quand le hub fait ce contrôle (au plus 10 minutes d'attente).
  - **Pause, jamais de saut** : une étape en échec, arrêtée ou abandonnée met le plan en pause, avec une phrase dans la discussion et une notification. Il repart seul quand vous relancez le chantier. « Continuer sans » (onglet Plans) laisse de côté une étape en échec ou qui vous attend, ou les sons. La vérification d'ensemble ne se saute pas. « Abandonner » arrête le plan sans rien défaire.
  - **Vos choix, regroupés** : « À vous de jouer » et les notifications annoncent un plan à valider, des sons à écouter ou un plan en pause. Les choix de visuels y étaient déjà. L'onglet **Plans** du projet montre une ligne par métier (Code, Visuels, Sons, Vérification), l'avancement, les critères, vos gestes, et les essais de sons à écouter sur place.
  - **Séance autonome** (proposition 2) : un plan proposé pendant une séance part sans attendre votre validation, puisque vous avez délégué. La séance suit ses chantiers comme les siens, et son bilan dit où en est chaque plan et ce qui vous attend.
  - **Aucune régression** : sans bloc `[[PRODUCTION]]`, les consignes du directeur sont exactement les mêmes (le champ n'existe pas). Le seul changement visible est la règle dans le contexte du directeur. `STUDIO_PRODUCTION=0` éteint tout : aucun service, aucune règle, bloc ignoré. Le directeur sonore garde ses gestes : `propose` et `integrate` passent par les mêmes fonctions internes.
- **Non retenu** :
  - Hermes, ou un agent orchestrateur qui résumerait l'état entre deux métiers : plus cher, et chaque résumé est une occasion de perdre de l'information ;
  - attendre les visuels validés avant de lancer le code : vos choix bloqueraient les développeurs, alors que le circuit provisoire puis intégration est déjà éprouvé ;
  - générer les essais de sons sans vous, à cause des crédits ElevenLabs ;
  - transformer les conceptions du Concepteur en plans : leur comportement reste identique, à reconsidérer plus tard.
- **Vérifié** : `production.test.ts` (8 tests) :
  - lecture du bloc ;
  - le parcours complet : plan préparé avec la demande, la discussion et le jeu ; rien lancé avant le clic ; dossier commité ; visuel chez le Directeur artistique ; sons proposés ; consignes complètes ; chantiers fusionnés ; essai choisi puis branchement automatique dans la discussion du plan ; vérification d'ensemble avec tout ce qui a été produit ; plan terminé ;
  - pause dite une seule fois, puis reprise après relance ;
  - remplacement d'une proposition et abandon ;
  - séance autonome : départ sans validation, chantiers suivis, bilan ;
  - sans clé ElevenLabs : « Continuer sans les sons » d'un coup, et le plan finit sans eux ;
  - préparation impossible ;
  - désactivation complète ;
  - typecheck et build ;
  - la suite complète ;
  - **essai réel** sur un hub de test (vrai Claude, petit tower defense) :
    - à « un boss à la vague 10 avec son look et un rugissement », le Directeur a proposé de lui-même un plan de production ;
    - le plan, préparé en environ 30 s pour 0,05 $, comptait 8 critères chiffrés, 3 chantiers bien découpés (PV des tours, apparition du boss, frappe de zone), 2 visuels et 3 sons reliés aux bons chantiers ;
    - au clic, le dossier a été écrit dans le jeu, les visuels sont entrés dans la file du Directeur artistique, le vrai directeur sonore a proposé les 3 sons, le premier chantier a démarré, et le chef de chantier a mis les suivants en attente pour de bonnes raisons (« s'appuie sur T-0001 ») ;
    - plan et chantiers arrêtés ensuite, pour ne pas consommer le quota ;
    - corrections faites après l'essai : la note du plan ne cite plus de clés internes (c1, v1), le lien « Suivre » était illisible, « Continuer sans les sons » a été ajouté.

## ADR-108 — Superpowers (obra/superpowers) dans le catalogue public, limité à ses méthodes de travail

- **Contexte** : Superpowers (licence MIT) est une méthode de développement complète pour agents, découpée en une quinzaine de skills. Le directeur créatif a demandé d'en profiter pour les agents du hub. Une partie fait doublon avec le hub ou contredit son pipeline : questions avant de construire (le Concepteur), plans (le directeur et le chef de chantier), branches git et fusion (les copies isolées et la fusion du hub), sous-agents (les équipes et l'`AgentPool`).
- **Décision** :
  - `obra/superpowers` rejoint `DEFAULT_SOURCES`, avec une liste fermée de skills lues (`SOURCE_SKILLS`) : `systematic-debugging`, `verification-before-completion`, `test-driven-development`, `receiving-code-review`. Les autres skills du dépôt ne sont jamais lues.
  - Elles suivent le circuit de l'ADR-102 et de l'ADR-105, sans exception : licence, texte seul, filtre, relecture de sécurité, adaptation, quarantaine puis essai, et Développeur et Testeur seulement. Elles n'arrivent que si un besoin signalé ou repéré leur correspond.
  - Une source ajoutée à la liste est lue au tour suivant du laboratoire, sans attendre la relecture hebdomadaire (`catalog_sources` dans `skill_lab`).
- **Non retenu** : installer Superpowers comme plugin de Claude Code ou d'Hermes. Les agents du hub ignorent les réglages et les plugins personnels (`--setting-sources ""`), et le plugin imposerait son déroulé (branches, commits, plans) à chaque session.
- **Vérifié** : `skill-lab.test.ts`. Seules les 4 skills retenues sont lues dans Superpowers, et les autres dépôts restent lus en entier. Le catalogue n'est pas relu dans la semaine, sauf quand la liste des sources change. Sur le vrai GitHub, les 4 skills sont lues sous licence MIT et passent le filtre sans IA.

## ADR-109 — Pipeline 3D, première étape : une planche fidèle ou rien, des couleurs propres, un vrai studio photo

- **Contexte** : audit de la pipeline 3D (DeepSeek, relu par Claude, 28/10/2026). Les modèles ressemblent peu aux concepts validés, varient d'un asset à l'autre, et leurs photos sont pauvres. Causes vérifiées dans le code :
  - la planche de Tripo trahit parfois l'image (le Héron A-0005 : le long canon tube devient un pistolet vert, une queue apparaît), et une planche refusée après retouche servait quand même à construire la 3D ;
  - la voie « planche » n'envoyait pas la texture v3.5 qui retire l'éclairage peint : ombres cuites, couleurs sales ;
  - les consignes du validateur dataient de l'ADR-49 (« Blender repeint, la couleur ne compte pas ») alors que, depuis l'ADR-54, Blender ne repeint plus : des couleurs fausses passaient ;
  - les photos : un seul soleil fixe, fond gris uni, 640 px. Le dos et les personnages sombres sortaient en taches noires, et le validateur jugeait sur de petites images.
- **Décision** :
  - La texture v3.5 (`delight`, `texture_alignment: original_image`) sur les deux voies, la planche comme l'image seule (`model3d.ts`).
  - Le validateur de la planche juge d'abord la FIDÉLITÉ à l'image : il relève les traits qui définissent le sujet et les vérifie sur la vue de face. Une planche refusée, et qui n'a plus de retouche possible, est écartée : la 3D est tirée de l'image seule, fidèle de face (`#reviewViews`, `VIEWS_SYSTEM`).
  - Les consignes du validateur de l'image de référence et du DA suivent l'ADR-54 : la forme ET les grandes couleurs comptent, un rendu étranger au style des assets validés bloque.
  - Le studio photo de Blender (`studio()` dans `workshop.py`) : trois lumières douces qui suivent la caméra (principale, débouchage, contre-jour), un fond en dégradé vu de la seule caméra, l'ambiance neutre, AgX, 1024 px. Même lumière pour chaque asset et chaque angle.
- **Non retenu** :
  - Une graine Tripo fixe par asset. Elle ne rend identique qu'une même image : on ne refait la 3D que pour obtenir autre chose, et la cohérence entre assets ne vient pas de la graine.
  - Remplacer la vue de face de la planche par l'image de référence. Tripo demande quatre vues sous la même lumière, et l'image de face diffère des vues dessinées par Tripo.
- **Vérifié** : `model3d.test.ts` (réglages v3.5 sur la planche ; planche écartée → image seule) et `art.test.ts` (le Héron : planche retouchée toujours infidèle, écartée, et le modèle n'emporte pas ses vues). Le studio a été rendu sous Blender 4.5.14 sur les vraies scènes A-0002, A-0005 et A-0016 : de 3 à 9 s par série. Les dos et le personnage noir sont lisibles, et le contre-jour détache la silhouette du fond.
- **Suite prévue** : un générateur d'images récent à références multiples, à la place de Flux.1-dev ; une planche dessinée par nous depuis le concept ; une feuille de style 3D par jeu ; un score de ressemblance ; le jugement final dans Godot ; puis la pipeline des cinématiques.

## ADR-110 — Google Gemini (Nano Banana) dessine les visuels et la planche, Flux en relais

- **Contexte** : suite de l'ADR-109 (« un générateur d'images récent à références multiples, à la place de Flux.1-dev ; une planche dessinée par nous depuis le concept »). Flux.1-dev (2024) ne prend qu'une image en entrée et ignore le style des assets déjà validés ; la planche de Tripo trahit parfois l'image de référence. Les modèles d'images de Google prennent jusqu'à 6 à 14 images jointes et gardent un personnage d'une vue à l'autre.
- **Décision** :
  - Un fournisseur Google (`google-images.ts`), par l'API REST `generateContent` (`responseModalities: ["IMAGE"]`, `imageConfig.imageSize`, images jointes en `inlineData`, clé dans l'en-tête `x-goog-api-key`). Modèles et prix dans des constantes, changeables par `STUDIO_GEMINI_DRAFT_MODEL` et `STUDIO_GEMINI_FINAL_MODEL`, d'après la page officielle (28/10/2026) :
    - `gemini-nano-banana-2.1` (Nano Banana 2.1 : 0,0336 $ en 1K, 0,0504 $ en 2K) : croquis, essais, vignettes, duels, vues de côté de la planche ;
    - `gemini-3-pro-image` (Nano Banana Pro : 0,134 $) : seulement les retouches qui mènent à l'image finale (la retouche du meilleur essai demandée par le validateur, une vue de la planche à refaire).
  - Le générateur des visuels (`RoutedImageGen`) envoie à Google les demandes du Directeur artistique (`tier` donné). Sans clé : le générateur local, à l'identique et sans un mot. Plafond atteint ou erreur : le générateur local aussi, avec une ligne dans le fil (« Google indisponible : … → générateur local. »). Les sprites du studio de modding (réduits au pixel près) restent au générateur local.
  - Cohérence de style : un concept d'asset (croquis, essais) reçoit en références les images de la bible (`![…](…)` dans `bible.md`, deux au plus) et les 2 à 3 assets validés les plus récents du jeu, même type d'abord. Aucune référence tant que rien n'est validé.
  - La planche par Google : la vue de face EST l'image de référence validée (déjà de face, fond uni, pose en A d'après les consignes du DA) ; gauche, dos et droite sont dessinées en 2K par Nano Banana 2.1, chacune avec la face et les vues déjà faites en références, sous une consigne stricte (même personnage, même pose, mêmes couleurs, même éclairage neutre, fond uni). Même validateur (`#reviewViews`) ; une vue à retoucher est refaite par Nano Banana Pro, seule. Les quatre vues sont téléversées chez Tripo (`/v3/files`) et passées en jetons à `multiview-to-model` (format `[{front: jeton}, …]`, que la doc de Tripo accepte). Google en panne ou sans clé : la planche de Tripo, inchangée. Une planche de Google jugée infidèle est écartée comme celle de Tripo (ADR-109).
  - La clé : saisie dans l'onglet Visuels (« Clé Google (Gemini) », masquée, lien vers aistudio.google.com/apikey), vérifiée par la liste des modèles (gratuite), gardée dans `.data/tools/google/key.json`. Le navigateur ne reçoit que « configurée », la dépense et le plafond. Les messages d'erreur de Google sont expurgés de la clé.
  - Le coût : estimé par image rendue (seules les images rendues sont facturées), suivi par mois dans `.data/tools/google/usage.json`, plafond de 10 $ par mois (`STUDIO_GOOGLE_MONTHLY_USD`, réglable dans l'onglet Visuels, gardé dans `settings.json`). Chaque fabrication dit au fil « Images Google : 3 × Nano Banana 2.1 · ≈ 0,15 $. », et le coût compte dans le plafond du visuel (ADR-82).
- **Non retenu** :
  - L'API « Interactions » que la page de Google met désormais en avant : `generateContent` reste documentée sans dépréciation, et c'est le format le plus répandu.
  - Nano Banana Pro pour tous les essais : 4 fois le prix, pour des essais que le validateur départage de toute façon.
  - Gemini 3.1 Flash Image (Nano Banana 2) : plus cher que Nano Banana 2.1 (0,067 $ en 1K) pour le même usage.
  - Remplacer Flux : il reste le relais gratuit, hors ligne, et le seul à savoir réduire un sprite au pixel près.
  - L'ADR-109 écartait la face remplacée par l'image de référence, parce que Tripo dessinait les autres vues sous une autre lumière. Ici, les autres vues sont dessinées DEPUIS la face, sous sa lumière : la raison ne tient plus.
- **Vérifié** : `google-images.test.ts`, avec un faux `fetch` (aucun appel réel). La requête Gemini (modèle, images jointes, format, clé seulement dans l'en-tête), Pro pour une retouche et 2.1 pour le reste, le repli local sans clé (identique, sans ligne), sur erreur (raison dite, clé expurgée), sur image bloquée et au plafond (aucun appel). L'usage est compté, le plafond réglé. La planche de Google va jusqu'à `multiview-to-model` avec quatre jetons, une seule vue est retouchée par Pro, Google en panne donne la planche de Tripo, une planche infidèle donne l'image seule. Les références de style sont absentes puis jointes (bible et asset validé). `http.test.ts` : la clé n'est jamais renvoyée par l'API du hub ni gardée dans sa base.
- **Corrigé après essai réel (le Héron, A-0005, ≈ 0,92 $ d'essais)** : Nano Banana 2.1 refusait environ deux vues de la planche sur trois (`PROHIBITED_CONTENT`, un personnage armé), toujours en 2K ou avec un format imposé, parfois en 1K. Nano Banana Pro a rendu les trois vues du premier coup, fidèles : le canon tube, la queue et la teinte sont gardés, là où Tripo dessinait un pistolet vert. La planche passe donc à Pro, en 1K sans format (≈ 0,40 $, Tripo ne la facture plus). La consigne est formulée en « plateau tournant », et `generate` redemande jusqu'à quatre fois une image bloquée : seule l'image rendue est comptée.
- **À essayer en vrai** : avec une vraie clé, un croquis, un essai et une planche. Il faut regarder si 2K est bien honoré (des développeurs signalent l'inverse sur certains chemins), quel type d'image arrive (PNG ou JPEG, l'extension suit le contenu), et si les vues de côté gardent la pose.

## ADR-111 — La Forge remplace « En direct »

- **Contexte** : la Forge (ADR-106) montrait l'équipe en voxels dans un onglet de chaque jeu, à côté d'un panneau fixe de 330 px qui rétrécissait la scène ; « En direct » (organigramme, moniteur global, fil) faisait doublon avec elle.
- **Décision** :
  - « En direct » disparaît (menu, barre de titre, palette, barre du téléphone, `Live.tsx`, `OrgChart.tsx`). À sa place, une page globale **La Forge** (`#/forge`, `#/forge/<jeu>`, `ForgePage.tsx`). Les anciens liens (`#/direct`, `#/p/<jeu>/forge`) y mènent. L'onglet « La Forge » quitte la page du jeu.
  - Par défaut, la page montre le jeu qui tourne (le plus d'activité de l'équipe, `useBusiestProject`, partagé avec l'aperçu de l'accueil), sinon un jeu à l'arrêt. Des puces changent de jeu. Le bouton « Démo » reste toujours disponible.
  - La scène prend toute la largeur et toute la hauteur de la zone de travail. Le panneau (équipe, établis, file, trésor) glisse par-dessus, à droite, avec le bouton « L'équipe » ou au clic sur un nain ou un atelier. Sans WebGL, il reste ouvert.
  - Les modèles des agents (ADR-37, ADR-41) se règlent dans leur fiche de la Forge. Le fil complet de l'accueil se déplie avec « Tout voir ».
  - Les étiquettes restent discrètes : un mot pâle, sans cadre ; un point cyan pour un nain au travail ; rien au repos. Au survol ou à la sélection, une fiche nette apparaît (nom, et activité ou rôle). Ce qui vous attend reste en braise.
- **Non retenu** : garder le moniteur global de « En direct ». Celui du projet (en-tête) reste, et la Forge montre déjà la file et la pause de quota.
- **Vérifié** : `studio.e2e.ts` (menu, ancien lien, équipe et modèles dans la fiche, jeu qui tourne choisi par défaut, retour au repos) et `production.e2e.ts`.

## ADR-112 — « Refaire la 3D » sur un asset déjà dans le jeu

- **Contexte** : tous les modèles 3D existants sont déjà intégrés, et le hub masquait « Refaire la 3D » dès qu'un asset était branché (le serveur le refusait aussi). Impossible donc de profiter de la planche fidèle (ADR-109, ADR-110) sur un modèle existant, comme le Héron (survivor_destiny, A-0005).
- **Décision** : le bouton apparaît aussi sur un asset intégré, en secondaire, et demande confirmation (crédits Tripo et images Google). Tripo repart de zéro, même si le squelette pouvait être gardé (`fresh`, conservé dans la tâche s'il y a un redémarrage). Le modèle suit le parcours habituel (planche, atelier, validateur). Une fois validé, il part en intégration avec la consigne « modèle refait de zéro : remplace l'ancien fichier, vérifie l'échelle, l'orientation et les animations ». L'ancien modèle reste dans le jeu jusque-là. Pendant une intégration en cours : refusé.
- **Vérifié** : `art.test.ts` (refus pendant l'intégration ; dans le jeu, Tripo rappelé, nouvelle intégration avec la consigne de remplacement, pas celle d'une retouche).

## ADR-113 — Vue projet refondue autour de « À vous » et du Récap

- **Contexte** : la vue d'un jeu avait six onglets (Discussion, Décisions, Le jeu, Chantiers, Plans, Direction artistique), un bandeau moniteur et une bande d'équipe toujours visibles, et un panneau droit différent selon l'autonomie (questions du directeur, panneau Atelier, fiches à trier). Les décisions qui attendent le directeur créatif étaient dispersées : demande du Gardien dans l'onglet Chantiers, chantier à relire dans la discussion, croquis chez le DA, plan dans Plans, propositions dans Décisions. La maquette cliquable du 29/10/2026 (« on garde tout ») fait foi. Le chantier est découpé en trois parties : 1, ossature, en-tête et boîte « À vous » ; 2, le Récap et la photo « en jeu » ; 3, discussions triées, comptes rendus en carte, Art & son, Le jeu en clair et passe de cohérence.
- **Décision (partie 1)** :
  - **Quatre onglets** : Discussion · Récap · Le jeu · Art & son (soulignement cyan qui glisse). Les anciennes adresses restent valides et s'ouvrent sous l'onglet qui les contient : `#/p/<jeu>/tasks` et `/tasks/<id>` sous Récap, `/plans` sous Récap (lien « Plans de production »), `/decisions` sous Le jeu (lien « Toutes les décisions »), `/art` et `/son` sous Art & son. Nouvelle adresse `#/p/<jeu>/recap`, qui montre pour l'instant la liste des chantiers (la partie 2 la remplacera par le vrai Récap). Sur téléphone, ces quatre onglets (et le menu) passent dans la barre du bas.
  - **En-tête** : vignette et nom du jeu, une seule pastille « L'équipe travaille · n » / « Équipe au repos » (ou « File en pause » à la pause de quota). Un clic ouvre qui fait quoi sur ce jeu, puis la machine : c'est le moniteur existant (`MonitorBar`, ADR-64 : file, processeur, carte graphique, jetons, jauge 5 h), réutilisé tel quel. Le bandeau moniteur, la bande d'équipe et la pastille moniteur du téléphone disparaissent de la vue projet (ils n'étaient montés nulle part ailleurs). À droite : Ctrl K (masqué dans l'application de bureau, qui l'a dans sa barre de titre), l'autonomie, « Lancer le jeu » et « Concevoir » en cyan.
  - **La boîte « À vous »** : la colonne droite de la Discussion, la même dans les quatre modes d'autonomie. Le hub la calcule (`apps/hub/src/studio/inbox.ts`, route `GET /api/human/projects/:slug/inbox`) : une liste typée, triée par urgence, de tout ce qui attend une décision sur ce jeu — demande du Gardien (avec l'échéance réelle du refus automatique, `escalationTimeoutMs`, 15 min par défaut), chantier à relire (résumé, avis du Testeur, capture), plan de chantier à valider (« Je valide tout »), proposition du directeur (la carte de choix existante, ★ conseillé), attente du DA (question, croquis à choisir, image ou 3D à décider, rendu à valider), plan de production à valider ou en pause, son à écouter, questions du Concepteur sur ce jeu, chantier en échec de la semaine. `studioSnapshot` (« À vous de jouer ») lit la même liste : les deux ne divergent plus, et leurs liens mènent là où la décision se prend (la discussion du jeu, ou le fil du chantier).
  - Chaque carte se tranche sur place avec les routes humaines existantes (autoriser / refuser, fusionner / demander une correction, choisir une option, garder un croquis, valider / refaire un visuel, valider un plan, garder un essai de son, répondre au Concepteur, relancer). Gardien en premier, en braise, avec un compte à rebours. Décision prise : la carte s'efface, un message confirme ; « Annuler » n'apparaît que si le hub sait défaire (« Plus tard » sur un visuel, qui le met de côté). État vide : « Rien ne vous attend ». Dessous : « En cours » (chantiers en travail et file, étape sur 5, rang dans la file, visuels attendus, « Lancer ce chantier » pour un brouillon) et « Récemment fusionné » (3 lignes, lien vers le Récap). Ce que montraient les anciens panneaux reste dessous : lecture des documents, vos parties enregistrées, « Ajouté récemment à la bible », et en repli « Ce que le directeur a noté » (les fiches à trier, ouvert d'office en « Je valide tout » quand il y en a).
  - Le bouton flottant « À vous de jouer » reste hors projet ; dans un jeu, il ne parle que des autres jeux. Sur téléphone, la Discussion s'ouvre sur « À vous · n » quand une décision attend (segments À vous / Conversation / Fils).
  - Le tiroir du menu, sur téléphone, est rétabli en position fixe : une règle récente de `refonte.css` le remettait dans la page et laissait un vide au-dessus de l'en-tête.
- **Décision (partie 2 : le Récap et la photo « en jeu »)** :
  - **Le Récap des chantiers** (`#/p/<jeu>/recap`) remplace la liste des chantiers. Le hub le calcule à partir des données existantes, sans nouvelle table ni appel à un modèle (`apps/hub/src/studio/recap.ts`, route `GET /api/human/projects/:slug/recap?period=week|lastweek|30d`) : les lignes de « Qualité » (coût, temps d'agents, corrections, chantiers repris), le dernier rapport du développeur (`summary_simple`, `summary`, `how_to_test`), le dernier avis du Testeur (`verdict`, `summary_simple`, ce qu'il a joué), le fil d'origine, la capture, et les visuels intégrés (journal `art.asset_integrated` de la période, confirmés par `assets.json`). Six chiffres sur la période : fusionnés, échecs et abandons, coût total, temps d'agents, réussis du premier coup (fusionnés sans correction et jamais repris, sur les fusionnés), visuels intégrés. Sans période demandée : cette semaine si l'équipe y a travaillé, sinon la semaine dernière. Un chantier se range à la date de sa fusion, sinon de sa dernière activité ; un brouillon jamais lancé est dans la liste mais pas dans les chiffres (comme « Qualité »).
  - **À l'écran** : en-tête chiffré (les chiffres défilent jusqu'à leur valeur, coupés avec les animations réduites), sélecteur de période dont le fond glisse, filtres Tous / Fusionnés / Échecs et abandons / En cours avec leurs nombres, puis une grille de cartes par semaine (capture, titre, « Ce qui change dans le jeu », avis du Testeur, coût, durée, correction). La braise ne marque que ce qui vous attend (à relire, plan à valider, Gardien). Une carte ouvre un panneau latéral (rendu dans `<body>`, au-dessus de tout ; ↑ ↓ et Échap) : la capture, le résumé, l'avis complet du Testeur et ce qu'il a joué, comment tester, les détails techniques repliés, le fil d'origine, et les actions selon le statut (fusionné : lancer le jeu, demander une retouche au directeur dans le fil d'origine ; à relire : fusionner, essayer cette version, demander une correction ; échec : relancer, abandonner ; plan refusé : nouveau plan ; brouillon : lancer). « Tout le détail » ouvre la page complète du chantier.
  - **La page détail** `#/p/<jeu>/tasks/<id>` garde tout (plan, Gardien, journal en direct, résultat, changements, fusion, abandon, avis), restylée dans la vue projet, avec « ← Récap des chantiers » et le chantier précédent / suivant à la place de l'ancienne liste. `#/p/<jeu>/tasks` ouvre le Récap sur « En cours » ; « Plans de production » reste dans la barre sous l'onglet. L'explication « Comment avancent les chantiers » (selon l'autonomie) est repliée sous le Récap, ouverte quand il n'y a encore aucun chantier. La palette (Ctrl K) propose « Chantiers en cours ».
  - **« Raconter la semaine »** réutilise le journal de bord (ADR-89) : même route, même récit gardé (`logbook_weeks`), même GIF en tête ; le directeur n'écrit que si le récit n'existe pas encore ou sur « Raconter à nouveau ».
  - **La photo « en jeu » du Testeur.** Les captures de chantier montraient toutes le menu d'accueil : c'est la vérification « le jeu se lance » du hub. Le Testeur, qui joue déjà avec l'outil `jouer` (ADR-69), prend désormais en plus, avant de fermer la partie, UNE photo avec `change=true`, là où le changement se voit (consigne ajoutée à ses règles de jeu ; rien ne change pour le développeur ni sans manette). Le hub la copie à un emplacement connu, `.data/shots/<jeu>/<T-xxxx>-en-jeu.jpg` ; elle passe même au-delà des 15 photos. La capture d'un chantier (`pickTaskShot`, route `…/tasks/:id/screenshot`, Récap, « À vous », journal de bord, comptes rendus de la discussion qui l'affichent par cette route) est choisie ainsi : la photo en jeu si elle date de la dernière vérification (le hub reprend sa capture de lancement juste avant chaque passage du Testeur, donc une photo en jeu plus ancienne montrerait une version d'avant la correction) ; sinon la capture du lancement ; sinon la dernière photo prise en jouant. Le type d'image suit le contenu (le relais Godot écrit du PNG ou du JPEG). Cela vaut pour les jeux web (navigateur invisible) et Godot (relais du studio), qui passent par le même outil. Le GIF du journal de bord garde les captures du lancement (même cadrage d'une fusion à l'autre, et son décodeur ne lit que le PNG) ; le jugement des visuels dans le jeu par le DA (ADR-48) garde aussi la capture du lancement.
- **Décision (partie 3 : discussions triées, comptes rendus, Art & son, Le jeu)** :
  - **D'où vient un fil.** Une discussion garde désormais qui l'a ouverte : colonne `threads.origin` (nouvelle migration), passée à `createThread` par chaque service — `human` (route humaine, défaut), `art` (intégrer ou retoucher un visuel), `sound` (brancher des sons), `feel` (passe game feel), `balance` (équilibrage), `conception`, `express`, `reverse`, `mod`. La liste des fils (`listThreads`) renvoie `origin` et `automatic` : vrai pour `art`, `sound`, `feel`, `balance` (`AUTOMATIC_THREAD_ORIGINS`, contrats). Les fils d'avant la colonne (`origin` vide) sont reconnus à leur titre, en repli seulement (« Intégrer A-… : », « Retoucher A-… dans le jeu », « Sons : », « Game feel : », « Équilibrage »).
  - **La liste des fils**, comme la maquette : « Chercher un fil… » (filtre les deux groupes), « + Nouvelle discussion », « Vos discussions », puis « Automatiques » replié (ouvert quand vous y êtes ou que la recherche y trouve ; replié, il compte ce qui y est nouveau). Les fils du Concepteur restent dans les vôtres, marqués « · Concepteur ». En ouvrant un jeu sans fil précisé, on arrive sur **votre** dernier fil actif, pas sur une intégration plus récente ; le bandeau « Du nouveau dans… » ne parle que de vos fils. Sur téléphone, la liste vit sous « Fils » et la conversation garde l'écran.
  - **La conversation** : en-tête du fil (titre, « Automatique », date, « Toutes les décisions » hors autonomie), messages du directeur avec avatar et heure, les vôtres en bulle, séparateurs de jour ; compositeur « Joindre une capture », mots rapides « go / fusionne / plus simple ? » en Atelier (posés dans le brouillon, rien ne part sans « Envoyer »). Le texte des messages ne change pas (le directeur relit le même historique, l'extraction aussi) : seul l'affichage le lit (`apps/web/src/studio/projet/Messages.tsx`). Le **compte rendu de fin de chantier** (`#reviewReport`, « ✓/⚠ Chantier T-… terminé ») devient une carte : statut (« Fusionné dans le jeu », ou en braise « Prêt à essayer », « Attend votre avis », « Fusion bloquée »), avis du Testeur en pastille (« Validé », « Validé, remarques », « Problèmes relevés »), « Ce qui a changé » en trois lignes, la capture (la photo « en jeu » de la partie 2, par la route de capture, avec « Montrer un défaut »), « ▶ Lancer le jeu » (ou « Essayer cette version » avant fusion), « Voir le chantier », la consigne de fin en ligne discrète et tout le reste du texte (avis complet, ce qu'il a joué, contrôles, écarts, « Pour essayer », coût) sous « Détails techniques ». La consigne `§CONSIGNE§` devient une carte « Proposition de chantier » (titre, objectif, consigne complète repliée) ; les lignes « → / ⏳ / ⇉ / ↻ Chantier T-… » une ligne discrète qui mène au chantier, sans avatar quand le message n'est que cela.
  - **Art & son** (`#/p/<jeu>/art`) : la galerie d'abord (vignettes : image, statut — vert dans le jeu, braise ce qui vous attend, glace en route —, nom ; « Valider / Refaire » ou « Faire intégrer » sur place), filtres Tous / Intégrés / À valider / En cours / Écartés ; un clic ouvre la fiche complète d'un visuel dans un panneau (étapes, rendus, 3D, verdicts, prompts, dépôt d'un rendu, toutes ses actions : rien n'est retiré). Le **son** (le directeur sonore, ADR-91) est sous la galerie ; il reste dans Pilotage → Son et `#/p/<jeu>/son` mène ici. « Parler au Directeur artistique » ouvre sa discussion dans un panneau latéral, avec ses onglets Direction et Moodboard (le bouton passe en braise quand sa question attend votre réponse) ; `#/p/<jeu>/art/da` l'ouvre directement (lien « Répondre au Directeur artistique » d'« À vous »). La roue crantée ouvre les **réglages techniques** : générateur local (et Flux Kontext), clé Google, Blender et Tripo, avec leurs installations ; une ligne discrète dit ce qui manque. Le panneau se ferme à Échap ; sur téléphone, il prend l'écran.
  - **Le jeu** : en tête « La bible, en clair » (image clé, nom, la vision notée, quelques chiffres), puis « Décidé seul par le directeur » avec « Revenir dessus » hors « Je valide tout » (même composant, restylé en glace), puis deux colonnes : **État du jeu** en rubriques et sujets repliables (titres en clair : « Ce qui existe dans le jeu », « Règles déjà actées », « Ce qui reste à faire ou à vérifier » ; noms de fichiers, réglages et coordonnées en petit et atténués, interrupteur « Termes techniques ») et **Réalisé récemment**, une frise des chantiers fusionnés avec le compte rendu en clair du Développeur (`summary_simple`, lu par le Récap) et non plus la consigne technique ; puis la bible par thèmes, avec le lien « Toutes les décisions ».
- **Non retenu** : une deuxième liste côté navigateur (les cartes appellent les routes existantes, rien n'est recalculé) ; un « Annuler » simulé en retardant l'action (une décision prise doit l'être tout de suite : le Gardien n'attend pas) ; garder les onglets Plans et Décisions pour le seul mode « Je valide tout » (la boîte est la même partout) ; garder le moniteur toujours visible (il reste à un clic, et la pause de quota se voit sur la pastille). Partie 2 : une table ou un service de récapitulatif à part (les lignes de « Qualité », les rapports et le journal suffisent) ; un deuxième circuit de récit hebdomadaire (le journal de bord sert) ; demander la photo en jeu au développeur ou la faire prendre par le hub au hasard (seul le Testeur sait où le changement se voit) ; un « Revenir en arrière » dans le panneau (le hub ne sait pas annuler une fusion : la page détail rappelle le « git revert ») ; remplacer la capture du lancement (elle reste la vérification « le jeu se lance » et le repli). Partie 3 : reconnaître les fils automatiques à leur seul titre (un titre se renomme ; il ne sert qu'aux fils d'avant la colonne `origin`) ; réécrire le compte rendu côté hub en données structurées (le directeur et l'extraction relisent ce texte, et les anciens messages doivent s'afficher aussi : l'interface le lit tel quel) ; garder la discussion du DA en colonne permanente (la galerie d'abord, comme la maquette ; elle reste à un clic et se signale quand elle vous attend) ; retirer le son de Pilotage (il y reste : rien ne se perd) ; le « Revenir dessus » de la maquette qui rouvre la discussion avec un texte (le bouton garde le geste réel du hub : retirer la décision de la bible, avec confirmation).
- **Vérifié** : `inbox.test.ts` (401 sans session, projet vide, chaque type présent avec ses données et le tri, accord avec `studioSnapshot`, échec trop ancien écarté) ; e2e `workshop.e2e.ts` (parcours « À vous » : Gardien tranché sur place, chantier fusionné depuis la boîte, choix du directeur, téléphone, état vide), `studio`, `tasks`, `browser`, `pilotage`, `production`, `art`, `art-vision`, `phone`, `conception` adaptés aux nouveaux emplacements. Partie 2 : `recap.test.ts` (401 sans session, période inconnue refusée, projet vide, chiffres de la semaine et de la semaine dernière, premier coup, visuels intégrés confirmés par le manifeste, semaines et ordre, détail d'une carte, récit déjà écrit, bornes des périodes, familles de statuts) ; `playtest.test.ts` (photo `change=true` gardée à part et au-delà de la limite, choix de la capture : en jeu, lancement, photo de partie, photo en jeu périmée après une nouvelle vérification, type PNG ou JPEG ; la consigne n'est donnée qu'au Testeur) ; e2e `recap.e2e.ts` (chiffres, photo en jeu servie en JPEG, filtres, période, ancienne adresse `/tasks`, panneau de détail, suivant, échec à relancer, « Tout le détail », « Raconter la semaine », téléphone) et les e2e de la partie 1 rejoués. Partie 3 : `conversation.test.ts` (origine de chaque fil, fil automatique d'après l'origine, repli sur le titre pour les fils d'avant la colonne, fil à vous au titre trompeur non rangé) ; `art.test.ts` (l'intégration d'un visuel ouvre un fil d'origine « art », automatique) ; e2e `workshop.e2e.ts` (« Proposition de chantier » et sa consigne repliée, ligne de lancement qui mène au chantier, compte rendu en carte fusionnée et validée avec son texte complet sous « Détails techniques », « Automatiques » replié qui compte ses nouveautés, recherche dans les fils, arrivée sur votre fil plutôt que sur une intégration plus récente, Le jeu : état en rubriques, jargon atténué puis visible, « Réalisé récemment » d'après le compte rendu en clair) ; `recap.e2e.ts` (compte rendu avec la photo en jeu, « Validé, remarques », détails repliés, ligne de lancement sans avatar, téléphone) ; `art.e2e.ts` et `art-vision.e2e.ts` (page vide, panneau du DA et ses onglets, galerie, détail d'un visuel avec dépôt de rendu et verdict, réglages derrière la roue crantée avec l'atelier 3D, `/art/da` sur téléphone) ; `pilotage.e2e.ts` (le son dans Art & son, l'ancienne adresse `/son`). Suite e2e complète : 17 fichiers, 45 tests passés.

## ADR-114 — Facettes nettes pour le style low-poly : fini les arêtes baveuses

- **Contexte** : les modèles low-poly de neon-saloon (le chien A-0002, la Brute A-0003) sortaient « baveux » alors que l'aperçu de Tripo montrait des facettes nettes. Mesuré dans le .glb livré de la Brute : 3 117 faces sur 3 121 portaient des normales lissées. Tripo livre son low-poly réglé pour paraître lisse (faces lissées, normales personnalisées), et l'atelier le gardait tel quel : les facettes fondent l'une dans l'autre et la peinture de Tripo, qui ne suit pas les arêtes, déborde d'une face sur l'autre (les « bavures bleu nuit » que le validateur relevait sur le chien). Faute d'outil, l'artisan de la Brute a repeint le corps à la main, par zones de hauteur, contre la consigne : la moitié du corps a viré au vert lumineux (version 3 refusée par le validateur).
- **Décision** : un style « à facettes » (`Model3DSpec.facettes`), posé par la directive (`[[MODELE3D: … | facettes]]`) ou d'office quand la fiche dit « low-poly » ou « facettes ». Blender rend alors chaque face plate, arête franche, dès la préparation, et le réapplique à l'export après la réduction au budget. Sur une scène gardée (« Reprendre la finition », animations changées), les facettes sont posées si l'artisan n'a rien choisi : les assets existants en profitent sans crédit Tripo. L'artisan reçoit deux outils : `facettes(False)` revient au lissé (visage organique) ; `aplats_facettes()` donne une couleur unie de la palette à chaque facette, choisie par vote au cœur de la facette (jamais sur ses bords) puis nettoyée par ses voisines. Ce second outil est réservé aux grandes zones de couleur (bête, rocher, carrosserie) : il efface les détails plus fins qu'une facette, comme les veines de la Brute. La consigne de l'artisan le dit.
- **Complété après essai réel (texture)** : les facettes nettes ont mis à nu la peinture de Tripo. Elle est peinte sur son modèle détaillé puis reportée sur le low-poly : des taches floues qui chevauchent les facettes, du grain, des dégradés. La Brute livrée était pire encore, parce que l'artisan l'avait repeinte par zones. `nettoyer_texture()` reprend chaque facette dans la texture même, sans toucher aux UV. Une facette d'une seule couleur (écart Oklab sous 0,05) devient un aplat ; une facette qui porte un détail garde ses deux ou trois couleurs, avec une frontière franche et sans pixel isolé ; une couleur proche de la palette s'y aligne. La préparation l'applique d'office au style à facettes, et une scène gardée le reçoit une fois. Essayé sur le chien et la Brute : veines, rivets, yeux et crête gardés, grain et bavures partis (environ 10 s). La consigne de l'artisan interdit désormais de repeindre par zones : `teinter` sert seulement à changer une couleur précise, avec une tolérance basse. Écarté : regrouper les facettes en zones de couleur à travers le modèle (algorithme de Felzenszwalb sur les facettes), qui a perdu l'armure de la Brute et semé des triangles.
- **Non retenu** : les aplats par facette pour tous. Essayés sur la Brute, ses veines deviennent des triangles verts épars. Les fiches sans « low-poly » ne changent pas.
- **Vérifié** : `art.test.ts` (facettes à la préparation et à l'export d'une fiche low-poly, posées sur une scène gardée, absentes sinon ; directive « facettes »). Dans Blender 4.5, sur des copies des scènes du chien et de la Brute : export à 0 face lissée sur 1 999 (contre 3 117 sur 3 121 dans le .glb actuel), forme et budget intacts ; `aplats_facettes` sur le chien : 2 404 facettes en 6 couleurs de la palette, sans traînée.

## ADR-115 — Planche 4 vues selon l’orientation de l’image de référence (réservé, en cours)

## ADR-116 — Garde-fous de l’atelier Blender : une passe qui casse est annulée, la meilleure passe est gardée (réservé, en cours)

## ADR-117 — Le développeur voit la vitrine de l’asset qu’il intègre (réservé, en cours)

## ADR-118 — Jolt Physics pour les nouveaux jeux Godot 3D

- **Contexte** : Godot 4.6 annonce Jolt comme moteur physique 3D par défaut, mais seulement pour les projets créés par son gestionnaire de projets, qui écrit le réglage dans project.godot. Le hub écrit son project.godot lui-même (ADR-73) sans ce réglage : la valeur reste `DEFAULT`, c'est-à-dire l'ancien moteur. Mesuré dans Godot 4.6.2 : un projet du hub crée des `GodotBody3D` ; avec `3d/physics_engine="Jolt Physics"`, les avertissements viennent de `modules/jolt_physics`. neon-saloon tourne donc sur GodotPhysics3D.
- **Décision** : le socle d'un jeu **3D** ajoute `[physics] 3d/physics_engine="Jolt Physics"` (`JOLT_SECTION` dans `apps/hub/src/godot/scaffold.ts`) et la section Godot du CLAUDE.md le dit au développeur (ne pas revenir en arrière ; biais et amortissement d'un PinJoint3D ignorés par Jolt). Un jeu 2D ne change pas.
- **Non retenu** : basculer les jeux existants (neon-saloon) d'office : collisions et articulations se comportent autrement, ce serait un chantier à part, vérifié par le Testeur. Embarquer la bibliothèque Jolt elle-même : elle est déjà dans Godot.
- **Vérifié** : `scaffold-jolt.test.ts` (3D : section et consigne présentes ; 2D : absentes), `conception.test.ts`, `projects.test.ts`, typecheck. project.godot produit par `projectGodot(DEFAULT_SETUP)` ouvert dans Godot 4.6.2 : les joints passent par Jolt.

## ADR-119 — Les registres du jeu ne bloquent plus le parallèle : fusion clé par clé

- **Contexte** : le chef de chantier (ADR-104) ne lance deux chantiers ensemble que si leurs fiches ne partagent aucun fichier. Sur neon-saloon, 20 chantiers sur 25 restaient bloqués sur les mêmes « registres » (`data/balance.json`, `data/sounds.json`, `data/translations.csv`, `docs/visuels_en_attente.md`), où chacun n'ajoute que ses clés. Retirer la règle seule ne suffit pas : mesuré, Git produit un conflit sur les 4 fichiers, car les deux branches insèrent au même endroit.
- **Décision** : `apps/hub/src/executor/registres.ts` définit les registres (`data/**.json`, `data/**.csv`, `docs/visuels_en_attente.md`) et leur fusion à trois versions : JSON récursif, CSV par première colonne, carnet markdown par `git merge-file --union`. `conflictBetween` ne les compte plus. Quand une fusion s'arrête sur des conflits (`integrate()` et `#merge()`), `resoudreRegistres` les résout s'ils sont TOUS des registres fusionnables, commite et journalise `task.registers_merged`. Sinon rien n'est touché : marqueurs et réconciliation dans la copie d'un chantier, annulation et même refus dans le dépôt du joueur. Une même clé modifiée différemment des deux côtés n'est jamais tranchée. Dans `#merge()`, tout se passe sous `VcsPort.exclusive` : une écriture du hub glissée entre la fusion et sa résolution échouerait, et une autre fusion pourrait annuler celle en cours. Le développeur reçoit la consigne d'ajouter ses clés sans toucher à celles des autres, et les registres ne figurent plus parmi les fichiers « tenus ». Inactif avec `parallel: 1`.
- **Non retenu** : pilote de fusion Git (`.gitattributes`), à installer dans chaque dépôt et chaque copie, et invisible du journal. Union ligne à ligne des JSON : elle produit des objets invalides. Dernier écrit gagne : perte silencieuse.
- **Vérifié** : `registres.test.ts` (29 tests : fusions pures ; deux chantiers simultanés sur `data/balance.json` et `data/translations.csv` fusionnés sans 3e passe, avec les clés des deux ; fusion directe dans le dépôt du joueur ; même refus qu'avant sur un désaccord ; fichier de code commun toujours bloquant ; désaccord de clé réconcilié avec marqueurs), `parallel.test.ts`, `tasks.test.ts`, `sound.test.ts`, `bench.test.ts`, typecheck. Seconde passe, après essai sur une vraie fusion de neon-saloon (444 lignes changées pour 5 ajoutées) : le JSON n'est plus réécrit, un petit analyseur garde le texte source de chaque nœud (`6.0` reste `6.0`, seules les clés ajoutées apparaissent au diff) ; le carnet garde une ligne vide avant un titre. Limites : deux littéraux de même valeur mais d'écriture différente (`6.0` et `6`) comptent comme différents ; le CSV suppose la virgule comme séparateur.

## ADR-120 — Un démontage n'est réussi que si le projet se recompile et démarre

- **Contexte** : l'Atelier (ADR-40) savait extraire, pas rejouer. Mesuré : le démontage par défaut de Slay the Spire 2 rendait 51 fichiers `.gd` en 12 s, aucune scène, aucun `.cs` — et la fiche affichait « Démonté ». Sa fiche ne prouvait rien : `recoveryProblem` comptait des fichiers sans jamais ouvrir, compiler ni lancer le projet, alors que le hub avait déjà de quoi le faire (`godot/run.ts` `--import`, `godot/export.ts` `--export-release`). GDRE rend pourtant un vrai projet (27 055 fichiers, 978 `.tscn`, 3 405 `.cs`) qui se compile (`dotnet build` : 0 erreur, 4 s) — mais rien ne le vérifiait dans le hub.
- **Décision** : `apps/hub/src/reverse/playable.ts` mesure le projet récupéré — il lit ce qu'il exige (`requirements` : version, C#, assemblage, scène principale, `.csproj`), choisit le Godot qui convient (`pickEditor` : la version exacte, en .NET s'il y a du C#), puis importe, compile (`dotnet build`) et lance sans fenêtre (`--quit-after 240`). Le verdict est **playable / partiel / echec / outil** ; « partiel » couvre le projet qui tourne avec des réserves (aucune scène principale déclarée, erreurs non fatales). Seul le **lancement** décide : les erreurs de l'import viennent du contexte éditeur (plugins d'export, extensions) et ne disent rien du jeu, et le bruit de sortie de Godot (« RID allocations … leaked at exit », « resources still in use at exit ») ne compte pas. Godot sort souvent 0 en n'ayant rien affiché : les erreurs fatales (scène illisible, classe introuvable, `error CS`) sont donc triées à part (`FATAL`). `apps/hub/src/reverse/rebuild.ts` recrée ce qui manque, jusqu'à trois tours mesure → réparation → remesure : une classe C# avec le **bon parent** déduit de la scène qui l'utilise, une scène vide, une ressource générique, une image d'un pixel, un WAV silencieux, et les bibliothèques natives (FMOD, Sentry) recopiées du jeu installé quand le paquet ne les contient pas. Rien n'est présenté comme l'original (`note` par fichier, `lancement.md`). Un fichier présent et non vide n'est jamais écrasé. Le hub installe lui-même le Godot que le projet réclame (`installGodot`, versions officielles GitHub, archive ouverte par le `tar` de Windows — celui de Git Bash prend `C:` pour un hôte distant) et le retrouve dans ses propres dossiers (`godotEditors`, descente sans filtre de nom). Le rapport est rangé dans `lancement.md` / `lancement.json` et en base (`dissections.launch_json`) ; l'interface l'affiche dans « Le projet se lance-t-il ? », avec le bouton d'installation de l'éditeur manquant et « Revérifier » (`POST /reverse/:id/relaunch`, `/reverse/:id/editor`). Au démarrage, une fiche « Démonté » dont le dossier ne contient aucun code repasse en échec expliqué.
- **Non retenu** : rouvrir le projet avec un Godot plus récent que celui du jeu (il convertit le format, ce qui s'éloigne de l'original) — il reste proposé, mais annoncé. Compter les erreurs d'import comme des échecs : le plugin FMOD de STS2 échoue à l'import et le jeu tourne parfaitement. Croire le code de sortie : Godot rend 0 sur une scène illisible. Écrire dans le dossier du jeu : tout se passe dans la copie démontée.
- **Vérifié** : `playable.test.ts` (20 tests : lecture des exigences, choix de l'éditeur, trois formes d'erreur « fichier réclamé », reconstitution avec le bon parent, ressources/images/sons, bibliothèque native recopiée, fichier non vide jamais écrasé, deux tours menant à « playable », « partiel » sans scène principale, arrêt après un tour sur erreur fatale, rapport lisible) et deux tests de service (`reverse.test.ts` : « outil manquant » puis installation de 4.5.1 et lancement « playable » après reconstruction ; Unity refusé), typecheck, suite complète (452 tests). Bout en bout sur le vrai Slay the Spire 2 démonté (2,8 Go) : le hub installe Godot 4.5.1 .NET (120 Mo), compile le C# (0 erreur), lance le jeu — **playable en 54 s**, 0 erreur au lancement, 3 erreurs d'éditeur à l'import (plugin FMOD), aucun fichier recréé. Les six scripts que GDRE laisse vides (0,17 %) ne bloquent pas le démarrage : ils ne sont pas chargés par la scène de départ.

## ADR-121 — La demande du directeur créatif, mot pour mot, prime sur la consigne

- **Contexte** : sur Néon Saloon, quatre chantiers sur le viseur (T-0070, T-0072, T-0074, T-0075) ont fusionné avec un mauvais rendu. Le Directeur avait reformulé la plainte en consigne en y glissant de mauvaises solutions (arme semi-transparente, viseur surélevé de 5 cm sans support), et le Testeur vérifiait cette consigne, pas la demande humaine.
- **Décision** : `Task.request` (optionnel, absent par défaut) garde le texte de ses messages depuis la dernière consigne partie avant son dernier message, ce dernier au moins, 4000 caractères au plus (`humanRequest`, `conversation-service.ts`), joint à tous les chantiers de la réponse. Un chantier qui « reprend » d'autres chantiers fusionnés hérite de leur `request`, chaîne complète et sans doublon, la plus ancienne d'abord, 12 000 caractères au plus (`chainRequests`, les plus anciennes tombent faute de place) ; un chantier relancé après un arrêt du hub la garde. Le bloc `demande_du_directeur_creatif` va au Développeur (plan, exécution, atelier) et au Testeur : ces mots priment sur la consigne, et le Testeur fait au moins une vérification par plainte ou attente, avec `source: "demande"`. Comme un message peut donner plusieurs chantiers, chacun ne répond que de la part qui le concerne.
- **Non retenu** : donner le dernier message humain à un tour demandé par le hub (séance autonome) : personne n'a parlé pour ce chantier, et le rendre responsable du message qui a ouvert la séance bloquerait des fusions sans rapport. Faire résumer la demande par un agent : c'est précisément le défaut à corriger. Les chantiers du Concepteur, des plans de production, des visuels et des sons n'ont pas de `request` : ils ne naissent pas directement de ses mots dans le fil.
- **Vérifié** : `qualite-rendu.test.ts` (bornes du fil, chaîne, 4000 et 12 000 caractères, deux chantiers de bout en bout par « reprend », présence dans les deux prompts, propriété absente sans demande). Limite : une correction demandée par `[[CORRIGER]]` passe encore par la reformulation du Directeur et n'ajoute rien à `request`.

## ADR-122 — Les poses de contrôle : le hub photographie lui-même le vrai jeu

- **Contexte** : aucun agent n'avait vu la visée à 100 % dans le vrai jeu : le Testeur plafonnait à 0,8 en jouant, les captures venaient d'une vitrine, et la capture du hub montre l'écran de départ.
- **Décision** : convention de jeu : le nœud du groupe `studio_test`, présent dès la scène de départ, peut exposer `poses() -> Array` de `{ "nom", "description" }` et `pose(nom) -> String` ("" si tout va bien). Le relais (`bridge.gd`, VERSION 4, propagé par `refreshGodotTools`, ADR-83) ajoute l'étape `{"do":"pose","name":…}` (5 images d'attente pour que le rendu suive) et `poses` dans l'état. L'outil jouer reçoit l'étape (`PlayStep`, `gate.mjs`) et la liste. `CheckService.run` : si le lancement n'a pas échoué et que le jeu déclare des poses, `RealChecker.poses` ouvre une seule instance neuve (la mesure de performance a pu changer la scène de celle du lancement), fait pose puis photo, 8 poses au plus, 120 s au total hors démarrage du jeu. Les chemins vont au Testeur dans `photos_des_poses` (lecture obligatoire de celles qui concernent le chantier) et au compte rendu : ligne `§POSE§`, route `/tasks/:id/poses/:nom`, 3 images au plus, celles que le Testeur cite d'abord. Une pose ratée est notée, jamais une régression. Le Développeur d'un jeu Godot doit ajouter ou tenir à jour la pose quand le chantier touche à ce qu'on voit ; le socle des nouveaux jeux le dit aussi.
- **Non retenu** : photographier dans l'instance du lancement : la mesure de performance dépendrait alors des poses. Une instance par pose : trop lent. Ouvrir une instance pour découvrir les poses : l'état du lancement les donne déjà, un jeu sans poses ne coûte rien de plus. **Jeu web** : l'étape `pose` et la liste existent dans la manette (`__STUDIO_TEST__.poses()` / `.pose(nom)`), mais pas les photos automatiques : il faudrait relancer un serveur et un navigateur à chaque chantier rien que pour savoir si le jeu a des poses.
- **Vérifié** : `qualite-rendu.test.ts` (schéma, liste, nettoyage de la déclaration, bloc du Testeur, compte rendu, pose ratée sans régression, nom hors rapport refusé, jeu sans poses inchangé). Essai ponctuel dans le vrai Godot, sur un petit projet temporaire : poses lues au lancement, photo écrite, pose ratée rapportée avec son message, étape `pose` jouée par la manette. Pas encore essayé sur Néon Saloon, qui n'a pas encore de poses : un prochain chantier visuel devra les ajouter.

## ADR-123 — Mesurer le défaut, pas la propriété

- **Contexte** : les tests des chantiers du viseur relisaient l'alpha d'un matériau ou la position d'un marqueur, c'est-à-dire la valeur que le chantier venait de poser. Ils passaient alors que le rendu restait mauvais.
- **Décision** : règle dans le prompt du Développeur et dans celui du Testeur : une plainte sur le rendu ou le ressenti devient un test PERMANENT qui mesure le défaut tel que le joueur le voit (écart en mètres entre deux pièces, point d'impact et point visé à 20 m pendant le tir et en marchant, objet présent dans un rectangle d'écran, opacité finale rendue). Le Testeur classe en échec un test qui ne fait que relire la valeur posée. Ces tests tournent ensuite à chaque fusion par les vérifications du hub (ADR-32).
- **Non retenu** : détecter ces tests par analyse du code : fragile, et le Testeur lit déjà le diff.
- **Vérifié** : `qualite-rendu.test.ts` (présence de la règle dans les deux prompts). Son effet réel dépend des agents et reste à constater sur de vrais chantiers.

## ADR-124 — « Validé avec remarques » ne fusionne plus quand la remarque touche le rendu ou la demande

- **Contexte** : le Testeur avait rendu `pass_with_notes` avec « le viseur paraît décollé de l'arme » et « visée complète non vue », et `#afterVerify` fusionnait tout verdict différent de `fail`. Le directeur créatif garde l'automatisation complète : il faut remplacer son œil, pas lui ajouter une validation.
- **Décision** : `checks[]` reçoit `kind` (`rendu`, `regle`, `technique`) et `source` (`demande`, `consigne`, `plan`), optionnels. `quality/verdict.ts` porte la règle en fonctions pures : `blockingChecks` retient un point qui n'est pas `pass` et qui est de rendu ou vient de la demande (`not_verifiable` compte), `verdictBlocks`, `effectiveVerdict`, `pointsToFix`. `#afterVerify` traite un tel verdict comme un échec : même boucle (`VERIFY_ROUNDS`, modèle plus fort au dernier tour, puis « attend votre avis »), retour au Développeur avec les points non prouvés, message explicite dans la discussion. `#reviewReport` les montre en ✗. Le Testeur revérifie ces points d'abord. Sont alignés : inbox, Récap, onglet Qualité, décompte des refus des compétences et du laboratoire. Le « fusionne » du directeur créatif reste souverain.
- **Non retenu** : bloquer sur toute remarque : une note technique doit continuer à fusionner. Chercher des mots-clés dans le texte des remarques : fragile. Rendre `kind` obligatoire : anciennes données et faux orchestrateurs casseraient. Un point sans `kind` ni `source` ne bloque donc pas : la règle tient à ce que le Testeur les renseigne, et rien ne l'y contraint.
- **Vérifié** : `qualite-rendu.test.ts` (table de cas ; correction puis fusion une fois prouvé ; trois tentatives puis « attend votre avis » avec ✗ ; note technique qui fusionne), `autonomy.test.ts`, `inbox.test.ts`, `recap.test.ts`, `skills.test.ts`, `skill-lab.test.ts`.

## ADR-125 — Contre-expertise automatique de la consigne du Directeur

- **Contexte** : les mauvaises solutions de T-0070 à T-0075 étaient dans la consigne dès le départ ; tout le reste de la chaîne travaillait ensuite à les réaliser.
- **Décision** : `autonomy/brief-review.ts` : avant de créer un chantier issu de `directives.requests` (atelier, séance autonome, ou `implement` hors atelier), un relecteur compare la demande et la consigne. Un seul appel `structured`, sans outils, 150 s au plus, dans la file `team` (il n'attend pas le Directeur et ne le bloque pas, voir ADR-98), avec le modèle de conception : un relecteur faible laisserait passer les rustines. Schéma `{ ok, objections (≤5), consigne_corrigee? }`. `ok` : lancement inchangé. `ko` : la consigne corrigée part si elle est fournie, sinon l'originale avec « Points du relecteur à respecter » (4000 caractères au plus, le corps est raccourci). Une seule passe, jamais de boucle. Erreur, délai ou réponse illisible : la consigne d'origine part. Visible par une carte repliée (la marque `§CONSULTATION§` d'ADR-98, sans changement d'interface) et journalisé (`brief.reviewed`, `brief.review_failed`). Option `review` de `createHub`, éteinte par défaut, allumée dans `main.ts`, `STUDIO_RELECTEUR=0` la coupe. Sans demande (tour de séance autonome), il juge la consigne seule.
- **Non retenu** : relire les chantiers du Concepteur ou des plans de production : ils sont déjà passés par leur propre conception. Lui donner accès au code : plus lent et plus cher ; il compare deux textes. Bloquer en cas de doute : le directeur créatif veut l'automatisation complète.
- **Vérifié** : `qualite-rendu.test.ts` (éteint par défaut sans aucun appel ; ok ; corrigée ; points ajoutés ; erreur ; délai ; réponse illisible ; file et délai propres ; plafond de 4000 caractères). Pas encore essayé avec le vrai modèle : sa sévérité réelle et son coût par chantier restent à observer.

## ADR-126 — Le hub dit quel outil convient, et n'abandonne plus pour un fichier abîmé

- **Contexte** : chaque outil du catalogue ne lit qu'une famille de fichiers — Godot ne comprend pas Unity, ILSpy ne lit pas du code compilé, Ghidra ne rend pas un projet. Le hub savait lequel installer, mais ne disait jamais **pourquoi** celui-là, et ne proposait aucun outil pour Unreal ou un moteur maison, où seul le binaire est lisible. Deux manques mesurés : le clic « Projet complet » s'arrêtait sur « Checksum failed for res://banks/desktop/act1_a1.bank … MD5 checksum failed, not proceeding » en laissant l'utilisateur sans rien, et Ghidra, absent, était le seul recours possible pour ces moteurs.
- **Décision** : `detect.ts` porte un **plan d'outils par moteur** (ADR-126) — chaque étape dit son rôle (`obligatoire`, `conseillé`, `dernier recours`) et sa raison en une phrase ; l'Atelier l'affiche dans « Quel outil, et pourquoi », avec un bouton d'installation pour chaque outil manquant. Le plan **informe** : seul `needs()` décide de ce qui bloque un lancement, pour qu'un outil facultatif ne puisse pas empêcher de démonter. Ghidra entre au catalogue pour ce qui n'a pas de projet à récupérer (Unreal, moteur maison, bibliothèques natives d'un IL2CPP) : le hub installe l'archive officielle **et le JDK 25** qu'elle réclame (le PC n'a que Java 8 et Ghidra refuse de démarrer en dessous), via Temurin, dans ses propres données. Rien n'est préinstallé : un outil ne descend que si le plan de ce jeu-là le demande. Côté GDRE, un fichier dont la somme de contrôle ne correspond plus (mise à jour Steam, mod, copie abîmée) ne condamne plus le démontage : le hub relance une fois avec `--ignore-checksum-errors`, nomme les fichiers concernés dans le journal, et ne réessaie **pas** pour une autre panne. Si même sans sommes de contrôle GDRE échoue, le message demande de vérifier les fichiers du jeu dans Steam. Les archives passent toutes par le `tar` de Windows (bsdtar) : celui de Git Bash prend `C:` pour un hôte distant.
- **Non retenu** : préinstaller le catalogue entier (des centaines de Mo pour des outils que le jeu n'utilise pas). Faire de Ghidra le premier outil de l'IL2CPP : Cpp2IL lit la même chose, sans Java, et rend en plus des noms de classes — Ghidra reste le dernier recours. Ignorer les sommes de contrôle dès le premier passage : on perdrait le seul signal qui distingue un paquet abîmé d'un paquet sain. Lancer `analyzeHeadless.bat` par `spawn` : Node refuse un `.bat` (EINVAL) et, sans entrée standard fermée, Ghidra ouvre une invite qui attend indéfiniment — il faut `cmd.exe` et `stdin: ignore`.
- **Vérifié** : `reverse-tools.test.ts` (3 tests sur la reprise GDRE : second passage avec l'option, aucun second passage sur une autre panne, message final qui renvoie vers Steam), les 36 tests de l'ADR-120 toujours verts, typecheck et build. Bout en bout : Ghidra 12.2 + Temurin 25 installés par le hub en 6 s (l'archive était déjà là), puis `analyzeHeadless -import C:/Windows/System32/notepad.exe -noanalysis` → code 0, « REPORT: Import succeeded », 31 s. GDRE relancé pour de vrai sur Slay the Spire 2 après l'erreur `act1_a1.bank` : 15 658 fichiers en 1 min 38 s, et l'option `--ignore-checksum-errors` acceptée en mode récupération (code 0).

## ADR-127 — « Jouer » et « Ouvrir dans Godot » sur un démontage qui se lance

- **Contexte** : l'Atelier recompile et lance sans fenêtre le projet récupéré d'un jeu Godot (ADR-120), mais quand le verdict était « Se lance », le directeur n'avait aucun bouton pour ouvrir ce projet lui-même. L'Archéologue répondait « c'est faisable » sans moyen d'agir.
- **Décision** : quand le verdict est `playable`, le bloc « Le projet se lance-t-il ? » montre deux boutons de plus : **Jouer** (lance le jeu recompilé en fenêtre, `--path <jeu>`) et **Ouvrir dans Godot** (`--path <jeu> -e`). « Revérifier le lancement » passe en secondaire. Le hub reprend l'éditeur exact choisi par `pickEditor` (même version, Mono si le jeu a du C#) et le lance **détaché** (`spawn` `detached`, `unref`) : la fenêtre survit à un redémarrage du hub, et le hub n'attend pas qu'elle se ferme. Route `POST /reverse/:id/open { how: "editor" | "play" }`, session humaine obligatoire, refusée si le lancement n'a pas été vérifié, si un travail tourne sur ce démontage ou si l'éditeur n'est plus installé. Tout se passe sur la copie démontée, jamais sur le jeu installé. Journal : `dissection.opened`.
- **Vérifié** : `reverse.test.ts` (refus avant vérification, puis bons arguments, bon éditeur et bon dossier pour les deux boutons), typecheck. Lancement détaché réel testé avec une application fenêtrée : elle survit à la fin du processus parent.

## ADR-128 — Le hub lance lui-même les tests de bout en bout ; le Développeur ne lance que les siens

- **Contexte** : sur le jeu web « bordee », un chantier prend environ 48 min en moyenne. Dans les passes longues du Développeur (25 à 60 min), 15 à 52 min partent à relancer la suite Playwright complète (`npx playwright test`, 4 à 10 lancements par passe), parce que le CLAUDE.md du jeu dit « avant de terminer : npm run test:e2e doit passer ». Le hub, lui, ne lançait que `npm test` : la suite de bout en bout n'était jamais vérifiée de façon fiable, et le Testeur écrivait souvent « je n'ai pas relancé l'e2e ».
- **Décision** : `quality/checks.ts` : `CheckerPort.e2e?(cwd)`, appelée par `CheckService.run` après les parties rejouées. `RealChecker.e2e` rend `none` pour un jeu Godot, sans script `test:e2e` ou sans `node_modules` ; sinon il lance `npm run test:e2e` (commande fixe, `CI=1`, `FORCE_COLOR=0`), avec `E2E_PORT` = un port TCP libre choisi par le hub (deux chantiers en parallèle ne se disputent plus le serveur de dev) et, si le script appelle Playwright, `-- --retries=1` (un test instable rejoué une fois n'est pas un échec du chantier). Délai propre de 15 min (`e2eTimeoutMs`), arbre de processus tué à l'expiration ; même lanceur que `npm test`, factorisé. Un échec est refait sur le jeu actuel : seul un échec nouveau est une régression, renvoyée au Développeur (« Tests de bout en bout (npm run test:e2e) » dans `checksForTester`, `describeChecks`, `regressionFeedback`). Les clés `e2e` n'apparaissent dans le rapport et dans `check.done` que si la suite a vraiment tourné : les rapports des autres jeux restent identiques. Côté prompts (`executor/prompts.ts`), `ProjectContext.e2e` (jeu non Godot avec un script `test:e2e`, rempli par `TaskService`) ajoute au Développeur `E2E_RULE` : ne jamais lancer la suite complète, même si le CLAUDE.md du jeu le demande ; seulement les fichiers e2e qui concernent son changement, une fois son code prêt, sans `--repeat-each`. Le Testeur lit que la suite a été lancée par le hub et ne la relance pas en entier.
- **Complément** : le résultat de la suite sur le jeu actuel (pour distinguer « cassé par ce chantier » de « déjà cassé ») est gardé par commit (`git rev-parse HEAD`) : mesurée sur Bordée, la suite prend 9 min sous charge, et un test déjà cassé la ferait relancer après chaque passe. Deux chantiers simultanés partagent le même lancement ; une expiration ou un `none` n'est pas gardé. Essai réel sur Bordée (`b588e0a`) : 50 tests passés, 1 échec (« sillage de torpille », aussi au rejeu), 9,1 min.
- **Non retenu** : faire confiance au Développeur pour lancer moins la suite — la règle « la suite complète une fois à la fin » existait déjà et n'était pas suivie. Supprimer la suite e2e : elle attrape de vrais défauts.
- **Vérifié** : `chantiers-courts.test.ts` (faux vérificateur sans `e2e` : aucune clé `e2e` dans le rapport ni le journal ; suite qui passe ; suite « none » invisible ; échec dans la copie et succès sur le jeu actuel → régression citée au Développeur ; échec des deux côtés → pas de régression ; `RealChecker.e2e` réel sur un dossier temporaire : `none`, `pass`, `fail`, et `E2E_PORT` bien transmis ; `E2E_RULE` seulement avec `e2e`), fichiers voisins (`pipeline`, `qualite-rendu`, `parallel`, `tasks`, `playtest`) et typecheck. Le gain de temps réel sur « bordee » reste à mesurer.

## ADR-129 — Le Développeur se relit comme le Testeur, et tout jeu web peut déclarer des poses de contrôle

- **Contexte** : sur « bordee », plus de la moitié des chantiers sont renvoyés par le Testeur, souvent pour (a) un point de la consigne oublié (« retirer .tmp-avant/ », « jouer deux parties de recette »), (b) un rendu que le Testeur n'arrive pas à atteindre en jouant (zone d'Hydrophone, étincelles du Radoub : il faudrait que la bonne carte soit en main), (c) un nouveau test lourd qui dépasse le délai par défaut de 5 s sous charge. La manette savait déjà mettre un jeu web dans une pose (`window.__STUDIO_TEST__.pose(name)`, `poses()`, ADR-122), mais seul le prompt d'un jeu Godot en parlait.
- **Décision** : `executor/prompts.ts` : `SELF_CHECK_RULE`, pour tous les jeux, dans les deux prompts d'exécution du Développeur : relire la consigne et la demande ligne par ligne comme le Testeur (une vérification par exigence), faire chaque point ou dire dans `deviations` pourquoi c'est impossible, ne laisser aucun fichier temporaire, donner un délai explicite large à un nouveau test lourd. `WEB_POSE_RULE`, pour les jeux non Godot : quand un rendu ne se voit que dans une situation difficile à atteindre, ajouter `poses()` et `pose(nom)` à `window.__STUDIO_TEST__` (seulement avec `?studioTest=1`), en gardant les poses existantes. `developerRules(godot)` met `POSE_RULE` (inchangée) ou `WEB_POSE_RULE`, puis `SELF_CHECK_RULE`. `quality/playtest.ts` gérait déjà les poses web : rien n'y change.
- **Non retenu** : une validation humaine par chantier — refusée par le directeur créatif : la mesure remplace l'œil.
- **Vérifié** : `chantiers-courts.test.ts` (`SELF_CHECK_RULE` dans les deux prompts pour tout jeu ; `WEB_POSE_RULE` seulement hors Godot, `POSE_RULE` seulement pour Godot). Dans `qualite-rendu.test.ts`, l'assertion « pas de poses pour un jeu web » (ADR-122) devient « pas de poses du nœud studio_test pour un jeu web ». La baisse réelle des renvois reste à mesurer.

## ADR-130 — Nidavellir n'écrase plus le PC : priorité basse, reprise échelonnée, un seul gros contrôle à la fois

- **Contexte** : à l'ouverture de Nidavellir, le PC du directeur (Ryzen 5 5600X, 6 cœurs) se mettait à ramer, Hermes plantait, le Pilotage ne s'affichait pas. Au démarrage, le hub relançait d'un coup les files de tous les jeux (jusqu'à 2 chantiers par jeu et 3 agents au travail en tout, ADR-103, chacun avec ses tests, son navigateur caché, parfois Godot), au même niveau de priorité que Windows et la fenêtre. Le journal de Windows montrait aussi 6 arrêts brutaux en 30 jours (4 écrans bleus 0x1A MEMORY_MANAGEMENT, 2 coupures nettes), dont certains 5 à 12 min après une ouverture du hub : une cause matérielle (RAM/XMP, alimentation) que le pic de charge révèle. Ce point-là se règle sur le PC, pas dans le hub.
- **Décision** :
  - `main.ts` : le hub se met en priorité « inférieure à la normale » (`os.setPriority(0, PRIORITY_BELOW_NORMAL)`) ; sous Windows, ses enfants en héritent (agents, npm, navigateurs, Godot). `STUDIO_PRIORITY=normal` l'éteint.
  - `main.ts` : les files reprennent 90 s après le démarrage, puis un jeu par minute (`TaskService.queuedProjects()`, `resumeQueues(project)`). `STUDIO_RESUME_DELAY_S` règle le délai (0 = tout de suite). Le Directeur artistique reprend tout de suite : `ArtService.resume()` relance tous les travaux enregistrés et doublerait un travail commencé pendant l'attente.
  - `CheckService.run` : un seul contrôle du hub à la fois pour tout le studio (tests, lancement, parties rejouées, bout en bout, photos de contrôle d'un chantier passent d'un bloc) ; les autres attendent leur tour dans l'ordre, et un contrôle qui plante rend son tour. `STUDIO_HEAVY` (option `heavyChecks`) en autorise davantage.
- **Non retenu** : baisser `STUDIO_PARALLEL` — on perdrait le travail des agents en parallèle, qui coûte peu en processeur (ils attendent surtout Claude) ; seuls les contrôles sont lourds. Mettre les seuls enfants en priorité basse — une vingtaine d'endroits lancent des processus, l'héritage par le hub les couvre tous.
- **Vérifié** : `chantiers-courts.test.ts` (trois contrôles simultanés passent un par un, dans l'ordre, jamais deux en même temps ; un contrôle qui plante rend son tour). Héritage de la priorité vérifié sous Windows : un processus Node en priorité basse lance cmd, puis ping, et tous ont la priorité 6 (normale = 8). Typecheck.
