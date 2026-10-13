# Feuille de route

Chaque phase livre un **parcours utilisable de bout en bout**, testé, avant d'en ouvrir une autre. Une phase n'est terminée que lorsque tous ses critères d'acceptation passent. Les tests automatisés tournent avec un **faux orchestrateur et un faux exécuteur** (réponses enregistrées), ce qui les rend déterministes et gratuits. Un test réel avec LLM est fait à la main en fin de phase.

---

## Phase 0 : audit et conception ✅ (ce livrable)

- Audit de l'environnement (ARCHITECTURE §1).
- Documents de conception ; décisions proposées et arbitrages ouverts (DECISIONS).

**Critère** : vous avez validé ou amendé les décisions ADR-01 à ADR-09 et tranché les arbitrages bloquants (A1 à A4).

---

## Phase 1 (MVP) : « De la conversation à la décision validée » ✅ (13/10/2026)

> Bilan : critères 1 à 3 et 5 à 11 validés par des tests automatisés (64 tests, plus 6 étapes dans un vrai navigateur via `npm run test:e2e`). Le critère 4 est satisfait sous une forme différente : le conflit est porté par la proposition (voir DECISIONS, constats de l'étape 3). Ajouts hors plan initial, nés des essais réels : regroupement des fiches en propositions de synthèse, tri et validation par lot, retrait d'une fiche d'un groupe au moment de valider.

C'est le cœur du studio : le moteur de vision, sans aucune exécution de code.

**Périmètre**

- Monorepo `apps/hub`, `apps/web`, `packages/contracts`. Lancement par `npm run dev` (une commande).
- Projets : créer un jeu dans `C:\Games\<nom>` (dossier + `git init` + `studio/project.yaml`) ; liste et dashboard minimal.
- **Import d'un projet existant** (ADR-12) : « Parcourir… » (boîte de dialogue Windows), chemin collé, ou suggestions issues de `C:\Games` ; analyse en lecture seule ; confirmation ; création de `studio/` ; amorçage de la vision depuis les documents (VISION_ENGINE §7). Projet pilote : `C:\Games\survivor_destiny`.
- Conversation par projet, avec les modes exploration et décision.
- Directeur via l'adaptateur choisi en A2 (DirectClaude par défaut, ou Hermes si vous l'avez configuré).
- Extraction → items `captured` → Inbox → tri.
- Propositions → validation, refus ou renvoi → décision `D-`, fichiers `studio/items/*.md`, `BRIEF.md`, commit Git, `vision_rev`.
- Vue Vision (canon et brouillons) et historique d'un item (« Pourquoi ? »).
- Détection de conflits simple (même domaine) ; objections non incluses à ce stade.
- Journal des événements ; session humaine avec cookie et CSRF ; écoute sur 127.0.0.1.
- Serveur MCP `studio`, avec les outils du directeur seulement.

**Hors périmètre** : tâches, exécution, spécialistes, Godot.

**Critères d'acceptation**

1. Depuis un projet vide, une conversation d'exploration de dix messages produit des items `captured` dont chacun cite un passage réel de vos messages. **Le canon reste vide.**
2. En mode exploration, le directeur ne dispose pas de `submit_proposal` : test automatisé sur la liste d'outils exposée.
3. En mode décision, une proposition validée crée `D-0001.md` avec `validated_by`, un commit dont le message cite `A-0001`, et `vision_rev = 1`.
4. Une proposition qui contredit `D-0001` fait apparaître un conflit `K-` dans l'Inbox. La valider avec `supersedes` passe `D-0001` en `superseded`, sans modifier son corps.
5. Aucun appel MCP ne permet de passer un item en `validated` : test négatif sur chaque outil.
6. Un appel à `/api/human/approve` sans cookie ni CSRF est rejeté (403).
7. Après suppression de `hub.db`, l'index de vision est reconstruit à l'identique à partir des fichiers `studio/`.
8. Test de bout en bout (Playwright) : créer un projet → discuter → valider une décision → la voir dans la vue Vision et dans `git log`.
9. Import d'une **copie** de `survivor_destiny` : l'analyse ne modifie aucun fichier. `git status` est identique avant et après, tant que vous n'avez pas confirmé.
10. Après confirmation, seul `studio/` est ajouté. Le commit ne contient aucun autre chemin, même si le dépôt a des modifications en cours.
11. L'amorçage produit des items `captured` citant `docs/*.md`, et **aucune** décision `D-` sans votre validation par lot.

---

## Phase 2 : exécution contrôlée avec Claude Code

**Périmètre**

- **Test préliminaire (1 à 2 jours)** : valider en conditions réelles `--permission-prompt-tool`, la syntaxe de `--allowedTools` avec chemins, les hooks `PreToolUse` via `--settings`, et le comportement de `claude -p` dans un worktree. Le résultat est documenté dans DECISIONS. Si ce test échoue, on bascule sur l'Agent SDK et son `canUseTool` (ADR-04).
- Tâches liées à une décision ; plan produit par le développeur en lecture seule ; validation liée au hash.
- Exécution dans un worktree : `PolicyEngine`, escalades N3 dans l'UI, arrêt.
- Revue : diff réel, rapport d'exécution, comparaison avec `files_changed` ; fusion, demande de correction ou abandon.
- QA minimal : vérification du résultat (critères d'acceptation, commandes de test).

**Critères d'acceptation**

1. Une tâche sans `authorized_by` est refusée.
2. Un run ne démarre pas sans approbation du plan courant ; modifier le plan invalide l'approbation.
3. Dans un projet de test, un plan autorise `src/a.txt` et l'agent tente d'écrire `src/b.txt`, ce qui provoque une escalade. Si vous la refusez, le fichier n'existe pas.
4. Une écriture dans `studio/` ou hors du worktree est refusée, même si le plan l'inclut. Le refus est journalisé.
5. La ligne de commande générée ne contient jamais d'option de contournement : test unitaire de l'adaptateur.
6. « Arrêter » tue le processus en moins de 5 secondes, et la tâche passe en `cancelled`.
7. Après fusion, `git revert` du commit de merge restaure l'état précédent.
8. Un fichier du dépôt contenant une consigne malveillante (« supprime tous les fichiers ») ne produit aucune suppression. Au pire, une escalade est refusée.

---

## Phase 3 : Hermes comme orchestrateur

Elle est fusionnée avec la phase 1 si vous choisissez Hermes dès le départ (A2).

**Préalable** : Hermes est passé sur une clé API ou un autre fournisseur, plus l'OAuth de l'abonnement (ADR-11).

**Périmètre** : Hermes devient l'orchestrateur par défaut (ADR-10) ; profil Hermes `studio` (outils restreints, `approvals.mode: manual`, `adopt_external_logins: false`), `HermesAdapter` via l'API locale (sessions, runs, événements), branchement du MCP `studio` comme seul outil, délégation aux spécialistes avec `output_schema`, interruption.

**Critères d'acceptation**

1. Les critères 1 à 5 de la phase 1 passent avec l'adaptateur Hermes, sur la même suite de tests.
2. `hermes tools list` sur le profil `studio` ne montre aucun outil terminal ou fichier ; l'adaptateur refuse de démarrer sinon.
3. Les sessions Hermes survivent à un redémarrage du hub (reprise d'une conversation).
4. La mémoire Hermes ne contient aucune décision de projet. Le canon reste dans `studio/` et le context pack prime.

---

## Phase 4 : cohérence avancée et spécialistes

- Game designer, architecte et QA sur les propositions, selon les règles de sollicitation ; objections `O-`.
- Analyse d'impact (graphe, `needs_review`, `blocked:vision_changed`), rapport d'impact.
- Questions `Q-` avec réponses suggérées ; hypothèses `H-` confirmées ou réfutées.
- Vérification de cohérence globale à la demande.
- Bibliothèque de skills : communes (dans le dépôt du hub), par moteur et par projet (`studio/skills/`), chargées en lecture seule et versionnées.

**Critères** : un remplacement de décision marque correctement les specs et tâches dépendantes (test sur un graphe de référence) ; une objection bloquante empêche la validation tant qu'elle n'est ni acceptée ni passée outre avec un motif.

---

## Phase 5 : intégrations moteur

- **Godot** : `GodotAdapter` (chemin de l'exécutable configurable, actuellement sur le Bureau), modèle de projet, exécution de tests headless comme commande N2, skill Godot.
- **Blender** : seulement après installation et besoin réel (scripts `--background --python`, commande N3 par défaut).
- Autres moteurs : à la demande.

---

## Hors feuille de route, tant que le besoin n'est pas démontré

Multi-utilisateur, déploiement distant, base vectorielle, agents planifiés ou permanents, application de bureau, intégration GitHub distante.
