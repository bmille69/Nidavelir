# Moteur de vision

Le moteur de vision transforme une conversation libre en **éléments structurés, reliés et versionnés**, en séparant strictement ce qui est **pensé** de ce qui est **décidé**. C'est le cœur du studio : tous les agents travaillent à partir de lui.

---

## 1. Concepts

### 1.1 L'item, unité de base

Tout ce que le studio retient est un **item** : un fichier Markdown avec un en-tête YAML, stocké dans `<jeu>/studio/items/`. Il est indexé dans SQLite.

```markdown
---
id: D-0007
project: ombres-du-nord
type: decision
status: validated
title: Le joueur ne peut sauvegarder qu'aux feux de camp
domain: [gameplay, progression]
tier: canon                 # canon | working
source:
  kind: message             # message | item | run | file | human
  ref: conv-12/msg-48
  quote: "j'aimerais que la sauvegarde soit rare, genre aux feux, comme dans Dark Souls"
authored_by: { kind: agent, role: director, run: RUN-0031 }
validated_by: { kind: human, at: 2026-10-20T14:02:11Z, approval: A-0019 }
supersedes: [D-0003]
links:
  - { rel: derived_from, to: P-0011 }
  - { rel: refines, to: V-0001 }
  - { rel: constrains, to: M-0004 }
vision_rev: 41
created_at: 2026-10-20T13:55:02Z
updated_at: 2026-10-20T14:02:11Z
---
## Énoncé
La sauvegarde manuelle n'existe pas. Le jeu sauvegarde uniquement quand le joueur se repose à un feu de camp.

## Justification
Renforcer la tension (pilier V-0001 « chaque pas compte »).

## Conséquences connues
- M-0004 (mort) doit renvoyer au dernier feu.
- Nécessite un système de checkpoint (impact technique, voir T-0022).
```

**Règle d'or : le corps et le statut d'un item `validated` ne peuvent changer que par une nouvelle décision qui le remplace (`supersedes`).** On ne réécrit jamais l'histoire.

*Précision d'implémentation (étape 1 de la phase 1)* : l'énoncé est stocké dans l'en-tête YAML (`statement`), avec la justification et les options (`proposal`, `decision`). **L'en-tête fait foi.** Le corps Markdown est un rendu lisible, régénéré à chaque écriture. On évite ainsi d'avoir à interpréter du texte libre pour reconstruire l'index.

### 1.2 Types d'items

| Préfixe | Type | Rôle | Niveau possible |
|---|---|---|---|
| `V-` | `vision` | Pitch, piliers, expérience visée | canon |
| `G-` | `goal` | Objectif ou priorité, avec un rang | canon / working |
| `M-` | `mechanic` | Mécanique ou règle de jeu | canon / working |
| `C-` | `constraint` | Contrainte technique, artistique, de temps ou de plateforme | canon / working |
| `R-` | `reference` | Inspiration ou préférence (« comme X », « je n'aime pas Y ») | working, ou canon s'il est validé comme préférence |
| `I-` | `idea` | Idée brute captée | working |
| `H-` | `hypothesis` | Supposition non confirmée, la vôtre ou celle d'un agent | working |
| `Q-` | `question` | Question ouverte, ou demande de clarification d'un agent | working |
| `O-` | `objection` | Désaccord argumenté d'un agent sur un item | working |
| `P-` | `proposal` | Proposition formelle soumise à validation | working |
| `D-` | `decision` | Décision validée par vous | canon |
| `S-` | `spec` | Spécification détaillée qui implémente des décisions | canon une fois validée |
| `K-` | `conflict` | Contradiction détectée entre deux items ou plus | working |

Les **tâches** (`T-`), **runs** d'agents (`RUN-`), **validations** (`A-`) et **rapports** (`VR-`) sont des objets opérationnels : ils vivent dans SQLite et pointent vers les items, sans être des items de vision.

Un mécanisme, une contrainte ou un objectif peut exister en `working` (brouillon discuté) puis passer en `canon` **uniquement via une décision**. En pratique, la validation d'une proposition crée ou met à jour les items concernés et les marque `canon`, avec `validated_by`.

### 1.3 Statuts

```
                    ┌──────────── discarded
                    │
captured ──▶ triaged ──▶ proposed ──▶ validated ──▶ superseded
   (agent)    (vous ou      (P- soumise)   (vous seul)    (par une nouvelle D-)
              directeur)        │               │
                                └──▶ rejected   └──▶ abandoned (vous seul)
```

| Statut | Signification | Qui peut y faire passer un item |
|---|---|---|
| `captured` | Extrait automatiquement d'une conversation, non vérifié | Agent (outil MCP `capture_item`) |
| `triaged` | Retenu comme pertinent, mais pas encore proposé | Vous, ou le directeur (pour regrouper ou fusionner) |
| `discarded` | Écarté au tri | Vous, ou le directeur avec trace (réversible) |
| `proposed` | Inclus dans une proposition soumise | Agent (outil `submit_proposal`) |
| `rejected` | Proposition refusée (avec votre motif) | **Vous seul** |
| `validated` | Décision officielle, canon | **Vous seul** (action UI) |
| `superseded` | Remplacé par une décision plus récente | Automatique, quand vous validez la décision qui le remplace |
| `abandoned` | Décision retirée sans remplacement | **Vous seul** |

Statuts spécifiques : `question` → `open | answered | deferred` ; `hypothesis` → `open | confirmed | refuted` (une confirmation produit une décision) ; `objection` et `conflict` → `open | resolved | dismissed` (une résolution référence la décision qui tranche).

### 1.4 Liens

| Relation | Exemple |
|---|---|
| `derived_from` | D-0007 vient de P-0011, qui vient de I-0032 |
| `refines` | M-0004 précise V-0001 |
| `depends_on` | S-0003 dépend de D-0007 |
| `constrains` | C-0002 (« 60 fps sur Steam Deck ») contraint M-0010 |
| `implements` | T-0022 implémente S-0003 |
| `supersedes` | D-0012 remplace D-0007 |
| `conflicts_with` | K-0002 relie M-0010 et C-0002 |
| `answers` / `challenges` | D-0009 répond à Q-0005 ; O-0003 conteste P-0011 |

Le graphe est stocké dans SQLite (table `links`) et répliqué dans les en-têtes des fichiers, qui restent la source de vérité.

### 1.5 Révision de vision

Chaque validation incrémente un compteur `vision_rev` par projet et produit un commit Git. Tout ce que produit un agent (proposition, plan, rapport) mentionne la `vision_rev` sur laquelle il s'appuie. Si le canon a changé depuis, le hub marque le travail **à revoir** au lieu de le laisser s'appliquer en silence.

---

## 2. Les deux modes de conversation

Le mode est un attribut **du fil de conversation**, visible et commutable dans l'interface. Le défaut est l'exploration.

### 2.1 Mode exploration (par défaut)

But : vous laisser penser à voix haute.

- Le directeur répond naturellement : il reformule, rebondit et pose **au plus une ou deux questions** par tour, pour ne pas transformer la discussion en interrogatoire.
- **En parallèle**, le hub lance une extraction (voir §3) qui crée des items `captured` : idées, hypothèses, références, questions, éventuellement contraintes et mécaniques en brouillon.
- Les items capturés apparaissent dans un panneau latéral discret (« Ce que j'ai noté »). Vous pouvez les ignorer.
- **Garantie système** : en mode exploration, les outils MCP `submit_proposal` et `create_task` ne sont pas exposés au directeur. Il ne peut physiquement rien proposer de formel.

### 2.2 Mode décision

But : figer ce qui doit l'être.

Vous l'activez explicitement (« passons en décision », bouton, ou « formalise ça »). Le directeur peut le suggérer, mais il ne bascule pas lui-même.

1. Le directeur rassemble les items `captured` ou `triaged` pertinents et le canon concerné.
2. Il produit une ou plusieurs **propositions** (`P-`, format dans AGENT_CONTRACTS.md). Chacune comporte :
   - un énoncé clair et court, plus des options s'il y a un vrai choix ;
   - les items sources (avec citations), les hypothèses sur lesquelles elle repose, et les questions qu'elle laisse ouvertes ;
   - les **conflits détectés** avec le canon, et les **impacts** (items et tâches touchés) ;
   - si nécessaire, l'avis des spécialistes concernés (voir §5).
3. Les propositions arrivent dans l'Inbox. Pour chacune, vous pouvez **valider** (éventuellement en choisissant une option ou en modifiant le texte), **refuser** (avec un motif facultatif), **renvoyer en discussion** ou **reporter**.
4. À la validation, le hub et non l'agent : crée `D-xxxx`, passe les items liés en `canon`, marque les items remplacés `superseded`, résout les conflits liés, régénère `BRIEF.md`, commite, incrémente `vision_rev`, puis lance l'analyse d'impact.

---

## 3. Pipeline d'extraction

```
message ──▶ ① extraction (LLM, schéma JSON strict)
        ──▶ ② rapprochement avec l'existant (FTS5 + filtres par type et domaine)
        ──▶ ③ vérification de cohérence avec le canon (LLM, sur un lot restreint)
        ──▶ ④ écriture : items captured, conflits K-, liens proposés
        ──▶ ⑤ Inbox
```

1. **Extraction.** Entrée : le message, les trois à cinq messages précédents et la liste des items ouverts du fil. Sortie validée par schéma : une liste de `{type, title, statement, quote, confidence, domain[]}`. La citation exacte (`quote`) est obligatoire : elle garantit qu'un item est rattaché à **ce que vous avez réellement dit**. Les reformulations de l'agent restent distinctes de vos paroles.
2. **Rapprochement.** Pour chaque candidat, une recherche plein texte et par domaine trouve les items proches. Le LLM indique « nouveau », « doublon de X » (fusion avec ajout de la source) ou « précise X » (lien `refines`). Aucune base vectorielle n'est nécessaire : le volume d'un projet solo, quelques centaines à quelques milliers d'items, s'y prête parfaitement.
3. **Cohérence.** Chaque candidat est comparé uniquement au **canon du même domaine** et aux contraintes globales, pour garder un coût borné. En cas de contradiction, le hub crée un conflit `K-` avec une explication courte et les deux citations.
4. **Seuils.** En dessous d'une confiance de 0,5, l'élément n'est pas créé ; il devient au besoin une question de clarification. Les hypothèses formulées par un agent sont toujours marquées `authored_by: agent`, pour ne jamais être confondues avec vos intentions.

Le coût est maîtrisé ainsi : l'extraction utilise un modèle rapide et ne s'exécute qu'au tour suivant ou après dix secondes d'inactivité, jamais à chaque frappe.

---

## 4. Ce que les agents reçoivent : le « context pack »

Aucun agent ne lit librement toute la vision : le hub assemble pour chaque appel un **paquet de contexte** déterministe.

| Section | Contenu | Toujours inclus |
|---|---|---|
| En-tête | Projet, rôle, mode, `vision_rev` | oui |
| Vision | Items `V-` et `G-` canon (piliers, priorités) | oui |
| Canon pertinent | Décisions, mécaniques et contraintes `canon` des domaines de la tâche, plus leurs dépendances directes | oui |
| En cours | Propositions, conflits et questions ouverts dans ces domaines | oui |
| Brouillons | Items `working` récents du fil, **étiquetés comme non validés** | en mode exploration et décision |
| Mandat | La tâche et la décision qui l'autorise (`authorized_by`) | pour les tâches |

`BRIEF.md` est la version fichier lisible de ce paquet pour Claude Code. Il est régénéré à chaque validation et en lecture seule pour les agents.

Chaque section est **balisée** (`<canon>`, `<working>`, `<untrusted_content>`), afin que le modèle distingue la règle du brouillon, et le brouillon d'une donnée externe (voir SECURITY.md).

---

## 5. Agents, désaccords et sollicitation des spécialistes

### 5.1 Un seul agent par défaut

Le directeur traite seul tout ce qui ne nécessite pas d'expertise particulière : conversation, extraction, propositions simples. Il sollicite un spécialiste **seulement** selon des règles explicites, configurables par projet :

| Déclencheur | Spécialiste |
|---|---|
| La proposition touche une mécanique ou l'équilibrage, en domaine `gameplay` | game designer |
| La proposition ou la tâche touche une contrainte `C-` technique, l'architecture, la performance ou une dépendance | architecte |
| Une tâche d'implémentation est à planifier | développeur |
| Un plan est à vérifier, ou une exécution est terminée | QA |
| Vous demandez explicitement un avis | celui que vous nommez |

La consultation est **ponctuelle**, avec un mandat et un format de sortie imposé : il n'y a pas d'agent permanent.

### 5.2 Remontée des désaccords

- Un spécialiste qui n'est pas d'accord ne réécrit rien : il produit une **objection** `O-` (« conteste P-0011 parce que… ; alternative… ; gravité : bloquante | importante | mineure »).
- Les objections bloquantes figurent en tête de la proposition dans l'Inbox. Vous tranchez : passer outre, avec trace, ou amender.
- Un agent qui manque d'information produit une **question** `Q-` adressée à vous, et il n'invente pas : le hub fait vérifier par le QA que les plans ne reposent pas sur des hypothèses non signalées.
- Un agent ne peut **jamais** modifier un item `validated`. Il ne peut que proposer une décision qui le remplace (`P-` avec `supersedes`). Cette règle est appliquée par le serveur MCP : aucun outil n'écrit dans un item canon.

### 5.3 Conséquences d'un changement de vision

Quand une décision `D-new` remplace ou modifie `D-old` :

1. le hub parcourt le graphe à partir de `D-old` sur les relations `depends_on`, `refines`, `constrains` et `implements`, jusqu'à une profondeur de 3 ;
2. tous les items `spec` et `working` atteints passent en `needs_review` ; les tâches non démarrées passent en `blocked:vision_changed` ; les tâches en cours sont signalées sans être interrompues automatiquement ;
3. un **rapport d'impact** apparaît dans l'Inbox : liste des éléments touchés, plus une proposition du directeur pour chacun (« toujours valable », « à adapter », « à abandonner »).

Pour que ce parcours soit fiable, **toute tâche doit référencer au moins une décision ou spécification** (`authorized_by`) : le hub refuse de créer une tâche orpheline.

---

## 6. Interface utilisateur du moteur

- **Conversation** : fil, bascule de mode, panneau « Ce que j'ai noté ».
- **Inbox** : propositions, conflits, objections, questions et rapports d'impact, triés par urgence. Une action par carte : valider, refuser, discuter, reporter.
- **Vision** : canon par domaine, brouillons à part, historique d'une décision (de qui, quand, d'où elle vient, ce qu'elle a remplacé, ce qu'elle affecte).
- **Pourquoi ?** : depuis n'importe quel élément (y compris une tâche ou un commit), la chaîne de décisions qui l'autorise.

## 7. Amorçage depuis un projet existant

À l'import d'un projet (ADR-12), la vision ne part pas de zéro :

1. **Inventaire** : `README.md`, `CLAUDE.md`, `docs/**/*.md` et tout fichier désigné par vous. Le code et les assets ne sont pas lus. Au-delà de 200 Ko de texte, le hub vous demande quoi retenir.
2. **Extraction** : même pipeline qu'au §3, avec `source = {kind: "file", ref: "docs/balance-decisions.md#L12-L20", quote}`. Le contenu est traité comme **non fiable** (balisé `<untrusted_content>`). Un document peut avoir été écrit par un agent : il ne vaut jamais « parole du directeur ».
3. **Classement proposé** : chaque item extrait reçoit une suggestion, par exemple « semble être une décision déjà prise » (vocabulaire du type « décidé », « on garde », ou un fichier nommé `*decisions*`), « mécanique décrite », « contrainte technique », « question ouverte ».
4. **Validation par lot** dans l'Inbox : vous cochez les « décisions existantes » à confirmer. Une seule approbation crée les `D-` correspondantes, avec `source.kind = file`, et un commit. Le reste reste en `captured` ou `triaged`.
5. **Pas de duplication** : les documents d'origine ne sont ni modifiés ni déplacés. Le hub retient leur hash. Si un document change plus tard, le hub propose une ré-extraction des parties modifiées.

## 8. Limites assumées

- L'extraction et la détection de conflits sont faites par un LLM : elles **produisent des faux positifs et des oublis**. C'est acceptable, car rien n'entre dans le canon sans votre validation. L'erreur coûte du tri, pas de la cohérence.
- La détection de conflits ne compare qu'au canon des domaines concernés : une contradiction entre deux domaines éloignés peut passer inaperçue. Une vérification de cohérence globale, lancée à la demande, est prévue en phase 4.
