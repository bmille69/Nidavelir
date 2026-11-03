# Nidavellir en application Windows

L'application (`apps/desktop`, Electron) est une fenêtre autour du hub : elle le lance avec le Node du PC, s'y connecte toute seule et l'arrête proprement en quittant. Le hub reste un vrai serveur sur `127.0.0.1` : le navigateur (`npm start`) et le téléphone (Tailscale) fonctionnent comme avant.

## Installer

```
npm run app:installer
```

Cela fabrique `apps/desktop/dist/Nidavellir-Setup-<version>.exe`. L'installateur pose Nidavellir pour votre compte Windows, avec une icône sur le bureau et dans le menu Démarrer, puis le lance. Sans certificat de signature, Windows SmartScreen demande une confirmation la première fois (« Informations complémentaires », puis « Exécuter quand même »).

L'application installée ne contient que la fenêtre. Le hub reste dans le dépôt d'où l'installateur a été fabriqué, et ce chemin est gravé dedans. Les projets et les données (`.data`) sont donc ceux de ce dépôt. Si le dépôt est déplacé, refaites l'installateur, ou lancez Nidavellir avec `STUDIO_HUB_ROOT`. Node 24 ou plus doit être installé.

## Au quotidien

- À chaque lancement, l'application se met à jour depuis le dépôt : le hub repart de ses sources, les nouvelles bibliothèques sont installées si un `package.json` ou `package-lock.json` a changé (« Installation des nouvelles bibliothèques… », `npm install`), et l'interface est recompilée si ses sources, sa configuration ou les types partagés (`packages/contracts`) ont changé (« Mise à jour de l'interface… »). Sans changement, rien n'est refait. Il n'est donc plus nécessaire de relancer `npm start` après une modification.
- Fermer la fenêtre range Nidavellir près de l'horloge : le studio et ses chantiers continuent. Pour l'arrêter : clic droit sur l'icône, puis « Quitter Nidavellir ».
- Pour prendre les dernières modifications : le bouton « Mettre à jour » en haut à droite de la fenêtre (ou Ctrl K, « Redémarrer et mettre à jour », ou clic droit sur l'icône près de l'horloge). Le hub s'arrête proprement, l'application se relance, met à jour ce qui a changé et rouvre la fenêtre.
- `Ctrl+Alt+N`, depuis n'importe où, affiche ou cache la fenêtre.
- « Lancer avec Windows » (clic droit sur l'icône) démarre Nidavellir à l'ouverture de session, directement rangé près de l'horloge.
- Les notifications Windows signalent un chantier prêt ou en échec, un plan ou une autorisation qui attend, ou le Concepteur qui a besoin de vous. Elles s'affichent quand la fenêtre n'est pas au premier plan.
- Si un hub tourne déjà (lancé avec `npm start`), l'application propose de réessayer après l'avoir fermé.

## Réglages (variables d'environnement)

| Variable | Effet |
|---|---|
| `STUDIO_PORT` ou `--port=` | Port du hub (4317 par défaut) |
| `STUDIO_HUB_ROOT` | Dépôt du hub à lancer |
| `STUDIO_NODE` | Node à utiliser (sinon celui du PATH) |
| `STUDIO_MATERIAL=none` | Coupe l'effet Mica |
| `STUDIO_APP_DATA` | Réglages de l'application ailleurs (copie d'essai isolée) |

Les réglages de la fenêtre et le journal du hub sont dans `%APPDATA%\Nidavellir` (`logs\hub.log`).

## Développement

`npm run app` lance l'application depuis les sources. Elle crée alors un raccourci « Nidavellir (dev) » dans le menu Démarrer, dont Windows a besoin pour afficher le nom et l'icône dans les notifications.
