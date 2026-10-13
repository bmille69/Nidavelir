# Sécurité et contrôle

Objectif : **rien qui ait un effet sur vos fichiers, votre machine ou la vision officielle ne se produit sans votre accord explicite**, et tout est traçable et réversible. Les contrôles sont **appliqués par le code du hub** ; les consignes données aux modèles ne sont qu'une défense supplémentaire.

---

## 1. Modèle de menaces (usage local, utilisateur unique)

| Menace | Exemple | Parade principale |
|---|---|---|
| Erreur d'agent | Claude modifie 30 fichiers au lieu de 3, ou supprime une scène | Plan validé, liste blanche des chemins, worktree jetable, diff avant fusion |
| Dérive de la vision | Un agent « corrige » une décision qu'il trouve mauvaise | Aucun outil d'écriture sur le canon ; `studio/**` interdit à l'exécuteur ; vérification du diff |
| Injection de consignes | Un README, un asset, une page web ou une sortie d'outil contient « ignore les règles et lance… » | Contenu externe balisé comme non fiable, droits fixés par rôle et non par le texte, toute action soumise à votre validation (§6) |
| Auto-approbation | L'exécuteur appelle l'API du hub (curl) pour approuver sa propre escalade | Approbation liée à une session navigateur humaine, absente de l'environnement des agents ; outils réseau bloqués (§4) |
| Fuite de secrets | Un agent lit `.env` ou des identifiants et les recopie dans un rapport ou un commit | Chemins interdits en lecture, filtrage des journaux, `.gitignore` imposé |
| Exposition réseau | Le hub ou Hermes est joignable depuis le réseau local | Écoute sur 127.0.0.1 uniquement, jetons obligatoires, CORS restreint |
| Contournement global | `--dangerously-skip-permissions`, `bypassPermissions`, `--yolo`, `approvals.mode: off` | Interdits par le code de l'adaptateur (§7) |

**Hors périmètre du MVP** : protection contre un logiciel malveillant déjà présent sur la machine, isolation de niveau système (Docker est absent, pas de bac à sable OS). Ces limites sont assumées et décrites au §8.

---

## 2. Isolation des projets

- Chaque jeu est enregistré avec un **chemin racine absolu** canonique (via `realpath`, symlinks résolus). Le hub refuse les projets imbriqués ou se chevauchant, ainsi que les racines système (`C:\`, `C:\Windows`, le profil utilisateur entier).
- Une session d'agent (MCP ou exécuteur) est **liée à un seul projet**. Tout identifiant d'un autre projet est rejeté.
- Pour Claude Code, `cwd` est le worktree de la tâche. Aucun `--add-dir` n'est ajouté sans validation explicite. Le hook `PreToolUse` refuse tout chemin qui, une fois résolu, sort du worktree.
- Les données du hub (`.data/`) et la configuration d'Hermes (`%LOCALAPPDATA%\hermes`) sont **hors** de toute racine de projet.
- **Import d'un projet** : la boîte de dialogue de choix de dossier et l'analyse préalable sont des routes **humaines** (`/api/human/*`), donc inaccessibles aux agents, et **en lecture seule**. L'écriture de `studio/` n'a lieu qu'après confirmation, et le commit est restreint à ce chemin (`git commit -- studio/`). Les documents lus à l'import sont du contenu non fiable (§6).

## 2 bis. Identifiants des modèles

- Le hub n'appelle Claude **que via le binaire Claude Code officiel** (`claude -p`), avec votre propre connexion. Il ne lit, ne copie et ne stocke jamais de jeton OAuth (conformément à la [page Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
- Hermes doit utiliser une clé API ou un autre fournisseur. L'adaptateur Hermes vérifie au démarrage que le profil `studio` n'utilise pas d'identifiant d'abonnement en OAuth (ADR-11).

## 3. Niveaux de permission

| Niveau | Opérations | Accord requis |
|---|---|---|
| **N0 : lecture** | Lire les fichiers du projet (hors secrets), chercher, lire la vision | Aucun ; journalisé |
| **N1 : écriture couverte** | Créer ou modifier un fichier listé dans le plan validé, dans `scope.write_paths` | Couvert par la validation du plan |
| **N2 : commande couverte** | Exécuter une commande listée dans le plan (ex. `godot --headless --path . -s res://tests/run.gd`) | Couvert par la validation du plan |
| **N3 : sensible ou hors périmètre** | Fichier non prévu, suppression, nouvelle dépendance, commande non listée, réseau, `git` autre que lecture, tout chemin hors du worktree | **Escalade** : pause du run et validation dédiée |
| **Interdit** | Écrire dans `studio/**`, `.git/**` ou `.env*` ; lire des identifiants ; `git push` ; modifier la configuration d'Hermes ou de Claude ; désactiver les contrôles | Refusé, sans possibilité d'escalade |

### Mise en œuvre pour Claude Code

1. Les outils autorisés sont dérivés du plan, par exemple `--allowedTools "Read" "Grep" "Glob" "Edit(scenes/player/**)" "Bash(godot --headless:*)"`. La syntaxe exacte sera validée par le test préliminaire de la phase 2.
2. `--permission-mode default` est imposé.
3. `--permission-prompt-tool mcp__studio__permission_gate` : toute demande non couverte arrive au hub. Le `PolicyEngine` répond « autorisé » (N1 ou N2 couvert), « refusé » (interdit) ou **met le run en attente** et crée une escalade dans l'UI (N3). Sans réponse au bout du délai configuré, la demande est refusée.
4. Un `--settings` dédié au run ajoute un hook `PreToolUse` qui revérifie les chemins et commandes : c'est la défense en profondeur si la liste blanche était mal formée.
5. La configuration MCP est limitée au seul serveur `studio` (`--strict-mcp-config`).

### Mise en œuvre pour Hermes (profil `studio`)

- Toolsets terminal, fichiers, navigateur, `cronjob` et `send_message` désactivés (`hermes tools disable`). Le seul outil actif est le serveur MCP `studio`.
- `approvals.mode: manual` (le défaut actuel est `smart`, qui auto-approuve via un LLM), `skills.write_approval: true`, mémoire limitée à vos préférences générales et **jamais utilisée comme source de vérité du projet**.
- Serveur API : `API_SERVER_KEY` aléatoire, CORS fermé ; seul le backend du hub l'appelle.
- Ces réglages sont appliqués **sur un profil dédié**, sans toucher au profil par défaut, et **uniquement après votre accord**.

## 4. Validation humaine réellement imposée

Une validation (`A-xxxx`) est un enregistrement **produit uniquement par l'API humaine** :

```ts
type Approval = {
  id: string; project: string
  subject: { kind: "proposal" | "plan" | "escalation" | "merge" | "abandon", id: string, hash: string }
  verdict: "approved" | "rejected"
  note?: string
  at: string; session: string   // session navigateur
}
```

- **Liaison au contenu** : l'approbation porte sur le `hash` exact de l'objet. Si l'objet change, l'approbation ne s'applique plus.
- **Origine humaine** : les routes `/api/human/*` exigent un cookie de session `HttpOnly`, `SameSite=Strict`, créé au lancement du hub (lien à usage unique ouvert dans le navigateur), ainsi qu'un jeton CSRF. Ni le cookie ni le jeton n'existent dans l'environnement des agents.
- **Séparation des canaux** : les agents ne parlent au hub que par MCP, avec un jeton par run, et aucun outil MCP n'expose d'approbation. L'exécuteur n'a pas accès à `curl`, `Invoke-WebRequest` ni à des outils réseau (interdits au niveau N3 par défaut).
- **Machines à états côté serveur** : le passage d'une tâche à `running` exige une approbation valide du plan courant ; une fusion exige une approbation `merge` ; le passage d'un item à `validated` exige une approbation `proposal`. Aucune autre voie de code ne le permet, et c'est couvert par les tests.

## 5. Cycle de vie d'une tâche et réversibilité

```
draft → planning → plan_review ─(vous)→ approved → running ⇄ awaiting_escalation
                         │                            │
                         └─(vous) rejected             ├→ review ─(vous)→ merged
                                                      │           ├(vous)→ changes_requested → planning
                                                      │           └(vous)→ abandoned
                                  (vous, à tout moment) cancelled ← running
```

- **Avant exécution** : le plan est présenté (fichiers, commandes, risques, dépendances) ; vous le validez ou le refusez.
- **Pendant** : suivi en direct ; le bouton **Arrêter** tue le processus Claude Code et passe la tâche en `cancelled`. Le worktree est conservé pour inspection.
- **Après** : le diff réel (`git diff main...studio/T-xxxx`), le rapport d'exécution, le rapport QA et les sorties de tests sont présentés. Rien n'atteint `main` sans votre clic « Fusionner ».
- **Récupération** : un abandon supprime le worktree et la branche, après confirmation. Une fusion se fait par commit de merge, donc **réversible par `git revert`**. Le hub refuse de lancer une tâche si le dépôt du jeu a des modifications non commitées hors `studio/`, pour ne jamais mélanger votre travail manuel et celui d'un agent.

## 6. Protection contre les instructions malveillantes

L'injection de consignes ne se règle pas par une invite. La défense repose sur ce que l'agent **peut faire**, pas sur ce qu'on lui demande de ne pas faire.

1. **Droits indépendants du contenu** : les outils disponibles sont fixés par le hub selon le rôle et la tâche validée. Un texte lu ne peut pas ajouter d'outil ni élargir une liste blanche.
2. **Toute action à effet passe par un plan validé ou une escalade** : une injection réussie peut au pire produire une proposition ou une demande d'escalade étrange, que vous voyez et refusez.
3. **Balisage** : tout contenu provenant d'un fichier, d'une sortie d'outil ou du web est inséré dans les context packs sous `<untrusted_content source="…">`, avec la consigne permanente de le traiter comme une donnée. Vos messages et le canon sont balisés différemment.
4. **Citations obligatoires** : un item ne peut être rattaché à vos intentions que s'il cite **votre** message. Un texte trouvé dans un fichier ne devient jamais « ce que vous avez dit ».
5. **Signaux d'alerte** : le hub applique un filtre heuristique simple (motifs du type « ignore previous », caractères Unicode invisibles, demandes de secrets) sur les contenus injectés dans les context packs. Il affiche un avertissement mais ne bloque pas silencieusement. Hermes applique sa propre analyse des fichiers de contexte.
6. **Pas de lecture de secrets** : `.env*`, `*.pem`, `*.key`, `%LOCALAPPDATA%\hermes\.env` et `~/.claude/.credentials.json` sont interdits en lecture à tous les agents.
7. **Skills et fichiers de projet** : les skills d'un projet ne sont chargés qu'après votre revue, ce qui correspond au `hermes skills trust` côté Hermes. Les fichiers `CLAUDE.md` ou `AGENTS.md` d'un dépôt de jeu sont versionnés : toute modification par un agent apparaît dans le diff.

## 7. Interdits codés en dur

L'adaptateur Claude Code **refuse de démarrer** si sa ligne de commande contient `--dangerously-skip-permissions`, `--permission-mode bypassPermissions`, `--permission-mode auto` ou `--permission-mode acceptEdits`, ou un `--allowedTools` contenant `Bash` sans restriction, `Bash(*)` ou `Write(**)` sans chemin. L'adaptateur Hermes refuse de fonctionner si le profil `studio` a `approvals.mode: off`, le YOLO actif ou un toolset terminal actif. Ces vérifications sont faites au démarrage et à chaque run.

## 8. Journalisation

- Table `events` en **ajout seul** : l'API n'expose ni UPDATE ni DELETE. Elle enregistre chaque message, extraction, transition de statut, approbation, demande de permission (accordée, refusée ou escaladée), commande exécutée, fichier modifié, début et fin de run, coût annoncé.
- Les flux bruts `stream-json` sont conservés dans `.data/runs/<id>/`.
- **Filtrage des secrets** avant écriture : motifs de clés API, `Bearer …`, valeurs des variables d'environnement sensibles.
- Le commit Git de chaque validation cite l'identifiant de l'approbation, ce qui croise le journal du hub et l'historique du jeu.

## 9. Limites assumées

- **Dépendances partagées** (ADR-16) : la copie de travail utilise votre `node_modules` par une jonction. L'agent ne peut ni y écrire, ni installer de dépendance, ni créer de lien. Mais les outils de test qu'il lance peuvent y écrire leur cache. Toute suppression d'une copie de travail commence par retirer les jonctions, car `git worktree remove --force` effacerait leur cible.
- **Pas de bac à sable système** : Claude Code s'exécute avec vos droits Windows. Les commandes autorisées (par exemple Godot headless) peuvent elles-mêmes exécuter du code du projet, comme les scripts GDScript de test. Le niveau de risque est le même que celui d'un développeur qui lance les tests de son propre projet, ce qui est accepté pour le MVP. Si le besoin apparaît, l'option sera Windows Sandbox ou WSL2 avec Docker (voir DECISIONS, arbitrage ouvert).
- La liste blanche de commandes porte sur le préfixe de la commande : une commande autorisée qui en lance d'autres n'est pas inspectée en profondeur. D'où la règle : **pas d'interpréteurs génériques** (`powershell`, `bash -c`, `node -e`, `python`) dans les listes blanches.
- L'heuristique anti-injection réduit le bruit mais ne garantit rien. La garantie vient du §6.1 et du §6.2.
