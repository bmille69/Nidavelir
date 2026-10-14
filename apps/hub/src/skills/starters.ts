/**
 * Compétences de départ (ADR-29), proposées désactivées : vous les activez une à une
 * et la page « Qualité » dit si elles aident.
 */
export const STARTERS: { name: string; description: string; agents: string[]; body: string }[] = [
  {
    name: "game-feel",
    description: "Sensation de jeu : rendre une action agréable (impact, retour visuel et sonore, lisibilité). À utiliser pour tout ce que le joueur fait ou subit.",
    agents: ["director", "concepteur", "developer"],
    body: `# Game feel (sensation de jeu)

Une action est agréable quand le jeu y RÉPOND clairement. Pour toute action du joueur ou ce qu'il subit :

1. **Anticipation** : un petit signe avant (élan, lueur, son) quand l'action est lente ou dangereuse.
2. **Impact** : au contact, plusieurs retours ensemble, brefs (50 à 150 ms) : arrêt sur image très court (« hit stop », 30 à 80 ms), flash blanc de la cible, secousse de caméra légère et orientée, particules, son marqué.
3. **Conséquence** : recul de la cible, chiffre ou jauge qui bouge, état visible (brûlé, ralenti…).
4. **Lisibilité d'abord** : dans une foule, le joueur doit distinguer SES coups, les dangers et les récompenses (forme et couleur différentes, pas seulement la couleur). Les effets ne cachent jamais un danger.
5. **Doser** : plus l'action est rare ou forte, plus le retour est fort. Les actions répétées toutes les secondes restent discrètes.
6. **Réglable** : chaque valeur (durées, intensités) dans un seul endroit, facile à ajuster ; prévoir un mode « effets réduits » (accessibilité, performance).

Vérifier en jouant : couper le son et regarder, puis fermer les yeux et écouter. Chaque action doit rester compréhensible.`,
  },
  {
    name: "testeur-joueur",
    description: "Checklist du testeur : vérifier ce qu'un joueur remarquerait, au-delà des tests automatiques. À utiliser pour toute vérification d'un chantier.",
    agents: ["qa"],
    body: `# Tester comme un joueur

Les tests automatiques prouvent que le code fait ce qu'on croit. Vérifie AUSSI, en lisant le code et le diff :

1. **La consigne est-elle réellement remplie** pour le joueur (pas seulement « le code existe ») ? Cite l'endroit précis.
2. **Cas limites** : début et fin de partie, pause, mort pendant l'action, deux actions en même temps, valeurs à zéro ou au maximum, fenêtre redimensionnée.
3. **Performance** : rien de coûteux ajouté dans une boucle par image (allocation, recherche, création d'objets) ; un plafond existe pour tout ce qui peut s'accumuler.
4. **Régressions** : ce qui partageait le code modifié marche-t-il encore ? Les tests du projet passent-ils ?
5. **Lisibilité** : un nouvel effet ou écran gêne-t-il la lecture d'un danger ?
6. **Textes** : aux bons endroits (fichiers de traduction s'il y en a), sans faute.

Classe chaque point : bloquant (le joueur le verra vite), à surveiller, ou détail. Pas de faux échec : une limite de l'environnement de test n'est pas un défaut du jeu.`,
  },
  {
    name: "perf-web-3d",
    description: "Performance d'un jeu web en 3D (three.js, Vite) : budgets par image, allocations, nombre d'objets. À utiliser pour le rendu, les effets et les foules.",
    agents: ["developer"],
    body: `# Performance d'un jeu web 3D

Budget : 16 ms par image à 60 i/s, sur une machine modeste.

- **Zéro allocation par image** dans les boucles chaudes : réutiliser vecteurs, tableaux, objets (pools).
- **Instanciation** pour tout ce qui est nombreux (ennemis, projectiles, particules) : un seul appel de dessin par type.
- **Plafonds** explicites (effets simultanés, projectiles, décalques) avec recyclage du plus ancien.
- **Pas de lumière dynamique par objet** ; préférer l'émissif et le bloom.
- **Textures et géométries partagées** ; libérer (dispose) ce qui n'est plus utilisé.
- **Mesurer avant d'optimiser** : un mode de mesure (temps par image, nombre d'appels de dessin) vaut mieux qu'une supposition.
- **Mode « effets réduits »** qui coupe le plus coûteux (ombres, post-traitement, particules secondaires).`,
  },
];
