# Contrats entre agents

Ce document définit **qui fait quoi**, **avec quels outils** et **dans quels formats**. Les formats seront implémentés comme schémas Zod dans `packages/contracts/`. Ils sont utilisés à la fois pour valider les sorties des LLM (`--json-schema` pour Claude Code, `output_schema` pour Hermes) et pour typer l'API et le frontend.

Principe : **un agent produit des objets, le hub décide de leur statut.** Un objet invalide au regard du schéma est rejeté ; l'agent reçoit l'erreur et peut corriger, deux tentatives au maximum.

---

## 1. Enveloppe commune

Tout objet produit par un agent ou par vous partage ces champs :

```ts
type Envelope = {
  id: string                 // attribué par le hub, jamais par l'agent
  project: string            // slug du projet ; le hub refuse tout autre projet que celui de la session
  kind: "proposal" | "question" | "objection" | "decision" | "task" | "plan"
      | "execution_report" | "verification_report" | "item"
  status: string             // valeurs propres à chaque kind (cf. VISION_ENGINE §1.3)
  author: { kind: "human" } | { kind: "agent", role: Role, run: string }
  source: { kind: "message" | "item" | "run" | "file" | "human", ref: string, quote?: string }
  authorized_by: string[]    // décisions/specs qui l'autorisent (obligatoire pour task/plan)
  vision_rev: number         // révision du canon utilisée
  links: { rel: LinkRel, to: string }[]
  created_at: string         // ISO 8601, horodaté par le hub
}
type Role = "director" | "game_designer" | "architect" | "developer" | "qa"
```

Les champs `id`, `author`, `created_at` et `vision_rev` sont **remplis par le hub** à partir du contexte de la session MCP. Un agent ne peut ni usurper un autre rôle, ni antidater, ni écrire dans un autre projet.

---

## 2. Rôles et responsabilités

| Rôle | Responsable de | N'a pas le droit de |
|---|---|---|
| **Directeur** | Comprendre vos demandes, conduire la conversation, extraire et trier, formuler les propositions, décider s'il faut un spécialiste, synthétiser leurs avis, présenter les arbitrages | Valider quoi que ce soit, exécuter du code, écrire des fichiers |
| **Game designer** | Cohérence ludique : mécaniques, boucles, progression, équilibrage, respect des piliers ; rédaction des specs de gameplay | Modifier le canon, toucher au code, trancher les contraintes techniques |
| **Architecte technique** | Faisabilité, choix techniques dans le moteur, structure du code, performance, dépendances ; specs techniques ; contrainte `C-` quand c'est nécessaire | Modifier le canon, exécuter des modifications |
| **Développeur** | Plans d'implémentation détaillés, puis exécution **du plan validé** dans le worktree de la tâche | Sortir du périmètre du plan sans nouvelle validation, toucher `studio/`, fusionner sa branche |
| **QA** | Vérifier un plan (couverture, hypothèses cachées, risques), puis le résultat (tests, conformité aux décisions, régressions) ; rapport de vérification | Corriger lui-même, valider la fusion |
| **Vous** | Valider, refuser, abandonner ; approuver plans et escalades ; fusionner | — |

Un même LLM peut jouer plusieurs rôles. Le rôle est une **configuration de session** (invite système, outils visibles, format de sortie), pas un processus permanent.

---

## 3. Outils MCP du hub, par rôle

| Outil | Directeur | Designer | Architecte | Dév. (plan) | Dév. (exécution) | QA |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `get_context_pack(scope)` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `search_items(query, filters)` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `get_item(id)` / `get_history(id)` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `capture_item(candidate)` | ✔ | | | | | |
| `triage_item(id, action)` | ✔ | | | | | |
| `submit_proposal(p)` ¹ | ✔ | ✔ | ✔ | | | |
| `raise_question(q)` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `raise_objection(o)` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `report_conflict(k)` | ✔ | ✔ | ✔ | ✔ | | ✔ |
| `consult(role, mandate)` ² | ✔ | | | | | |
| `create_task(t)` ¹ | ✔ | | | | | |
| `submit_plan(plan)` | | | | ✔ | | |
| `submit_execution_report(r)` | | | | | ✔ | |
| `submit_verification(v)` | | | | | | ✔ |
| `permission_gate(request)` ³ | | | | | ✔ | |

¹ Masqué en mode exploration. ² Seulement avec l'adaptateur DirectClaude ; avec Hermes, la délégation native est utilisée, mais le résultat doit passer par un outil `submit_*`. ³ Appelé par Claude Code lui-même via `--permission-prompt-tool`, et non par le modèle.

**Absents par construction** : `validate`, `approve`, `merge`, `edit_canon`, `set_status(validated)`, `grant_permission`. Ces actions n'existent que dans l'API HTTP humaine (voir SECURITY.md §4).

Lecture des fichiers du jeu : en phase de plan, le développeur, l'architecte et le QA ont accès, **en lecture seule**, aux outils Read, Grep et Glob de Claude Code dans le dépôt du jeu. Le directeur et le designer n'en ont pas besoin dans le MVP.

---

## 4. Formats

### 4.1 Proposition (`P-`)

```ts
type Proposal = Envelope & {
  kind: "proposal"
  status: "submitted" | "validated" | "rejected" | "returned" | "deferred" | "withdrawn"
  title: string                          // ≤ 100 caractères
  statement: string                      // ce qui serait décidé, formulé comme une règle
  options?: { key: string, label: string, statement: string, tradeoffs: string }[]
  recommended_option?: string
  rationale: string
  based_on: string[]                     // items sources (I-, H-, Q-, M-…), avec citations dans source
  assumptions: string[]                  // H- sur lesquelles elle repose
  supersedes: string[]                   // décisions remplacées (vide si nouvelle)
  creates_or_updates: { type: ItemType, title: string, statement: string, domain: string[] }[]
  conflicts: string[]                    // K- connus
  impacts: { item: string, effect: "invalidates" | "requires_change" | "compatible" }[]
  open_questions: string[]               // Q- laissées ouvertes
  specialist_reviews: { role: Role, verdict: "agree" | "agree_with_reserves" | "object", note: string, objection?: string }[]
}
```

### 4.2 Question (`Q-`)

```ts
type Question = Envelope & {
  kind: "question"
  status: "open" | "answered" | "deferred"
  addressed_to: "human" | Role
  question: string
  why_it_matters: string                 // ce qui est bloqué sans réponse
  blocking: string[]                     // ids bloqués (propositions, tâches)
  suggested_answers?: string[]           // pour répondre en un clic
  answer?: { text: string, by: "human" | Role, decision?: string }
}
```

### 4.3 Objection (`O-`)

```ts
type Objection = Envelope & {
  kind: "objection"
  status: "open" | "resolved" | "dismissed"
  target: string                         // P-, S-, T- ou plan contesté (jamais une modification directe)
  severity: "blocking" | "major" | "minor"
  argument: string
  evidence: { kind: "item" | "file" | "run", ref: string, excerpt?: string }[]
  alternative?: string
  resolution?: { by: "human", outcome: "accepted" | "overridden", note?: string, decision?: string }
}
```

### 4.4 Décision (`D-`)

Elle est **créée uniquement par le hub**, quand vous validez une proposition, ou directement depuis l'UI si vous dictez une décision.

```ts
type Decision = Envelope & {
  kind: "decision"
  status: "validated" | "superseded" | "abandoned"
  title: string
  statement: string
  chosen_option?: string
  rationale: string
  from_proposal?: string
  supersedes: string[]
  superseded_by?: string
  domain: string[]
  approval: string                       // A- : enregistrement de votre validation (SECURITY §4)
  human_edits?: string                   // diff si vous avez reformulé avant de valider
}
```

### 4.5 Tâche (`T-`)

```ts
type Task = Envelope & {
  kind: "task"
  status: "draft" | "planning" | "plan_review" | "approved" | "running"
        | "awaiting_escalation" | "review" | "merged" | "changes_requested"
        | "rejected" | "cancelled" | "abandoned" | "failed" | "blocked"
  title: string
  goal: string                           // résultat attendu, vérifiable
  authorized_by: string[]                // ≥ 1 D- ou S- (obligatoire)
  acceptance_criteria: string[]
  scope: {
    repo: string                         // projet ; résolu par le hub vers un chemin
    write_paths: string[]                // globs relatifs au dépôt, ex. "scenes/player/**"
    read_paths?: string[]                // défaut : tout le dépôt sauf secrets
    forbidden_paths: string[]            // toujours inclut "studio/**", ".git/**", ".env*"
  }
  assignee: Role
}
```

### 4.6 Plan d'exécution

Il est produit par le développeur, en lecture seule. **Votre validation porte sur le hash de ce document** : tout changement du plan rend la validation caduque.

```ts
type Plan = Envelope & {
  kind: "plan"
  task: string
  status: "submitted" | "approved" | "rejected" | "superseded"
  summary: string
  steps: { n: number, description: string, files: string[] }[]
  files_to_create: string[]
  files_to_modify: string[]
  files_to_delete: string[]              // toute suppression est une opération sensible
  commands: { cmd: string, purpose: string }[]   // ex. tests Godot headless
  new_dependencies: { name: string, version: string, why: string }[]  // sensible
  risks: string[]
  assumptions: string[]
  verification: string[]                 // comment le QA vérifiera
  estimated_turns: number
  hash: string                           // calculé par le hub
}
```

Le hub dérive de ce plan la **politique d'exécution** : la liste blanche des chemins en écriture (= `files_to_create` ∪ `files_to_modify`, bornée par `scope.write_paths`), la liste blanche des commandes (`commands`) et la liste des opérations sensibles pré-approuvées. Tout ce qui sort de cette politique déclenche une **escalade** (SECURITY.md §3).

### 4.7 Rapport d'exécution

```ts
type ExecutionReport = Envelope & {
  kind: "execution_report"
  task: string
  plan: string
  run: string
  outcome: "completed" | "partial" | "failed" | "aborted"
  summary: string
  deviations: { step: number, what: string, why: string }[]   // tout écart doit être déclaré
  files_changed: { path: string, change: "added" | "modified" | "deleted" }[]  // contrôlé par le hub contre git diff
  commands_run: { cmd: string, exit_code: number }[]
  open_issues: string[]
  questions: string[]                    // Q- créées pendant le run
}
```

Le hub **ne fait pas confiance** à `files_changed` : il le compare au `git diff` réel du worktree, et toute divergence est signalée dans l'UI.

### 4.8 Rapport de vérification (QA)

```ts
type VerificationReport = Envelope & {
  kind: "verification_report"
  target: { kind: "plan" | "execution", id: string }
  verdict: "pass" | "pass_with_notes" | "fail"
  checks: {
    criterion: string                    // un critère d'acceptation, ou une décision liée
    result: "pass" | "fail" | "not_verifiable"
    evidence: string                     // sortie de test, extrait de diff, référence
  }[]
  decision_compliance: { decision: string, respected: boolean, note?: string }[]
  hidden_assumptions: string[]           // hypothèses non déclarées repérées
  regressions: string[]
  recommendation: "merge" | "request_changes" | "abandon"
}
```

---

## 5. Protocoles d'échange

**Consultation d'un spécialiste.** Le directeur appelle `consult(role, mandate)` avec DirectClaude, ou `delegate_task` avec Hermes et un `output_schema` égal au schéma attendu. Le mandat contient l'identifiant de la proposition et la question précise. Le spécialiste reçoit un context pack restreint au domaine. Le résultat est soit `{verdict, note}`, soit une objection ; il est rattaché à `specialist_reviews`.

**Règle de non-modification.** Un agent qui pense qu'une décision validée est mauvaise produit une `Objection` sur elle, ou une `Proposal` avec `supersedes`. Toute tentative d'écriture directe est impossible : aucun outil, et `studio/**` est interdit à l'exécuteur.

**Désaccord entre agents.** Le directeur ne tranche pas un désaccord de fond entre spécialistes. Il le présente comme une proposition à options, avec les positions de chacun.

**Travail sur un canon périmé.** Si la `vision_rev` d'un plan ou d'une proposition est inférieure à la révision courante et que des items de ses domaines ont changé, le hub bloque la validation et demande une remise à jour.
