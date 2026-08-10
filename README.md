# Claude Mission Control

Dashboard web **100 % local** de supervision des sessions Claude Code, en quasi
temps réel, avec une esthétique HUD sci-fi.

## Fonctionnalités (V1 — observabilité)

- **Vue flotte** : sessions `busy` / `waiting input` / `idle` / `ended`, par projet,
  avec dernière activité (prompt, réponse, outil utilisé).
- **Métriques de conso** : tokens (input / output / cache read / cache write),
  coût estimé en USD par session, projet et période (aujourd'hui / 7 jours),
  timeline 24 h.
- **Temps réel** : push WebSocket alimenté par la surveillance de `~/.claude/`.

L'interaction avec les sessions (envoi de prompts, terminal embarqué) est une
évolution V2 — voir [BACKLOG.md](./BACKLOG.md).

## Sources de données

| Source                              | Usage                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `~/.claude/sessions/*.json`         | Registre live des sessions (statut `busy`/`waiting`/`idle`, PID, cwd)    |
| `~/.claude/projects/<slug>/*.jsonl` | Transcripts : usage tokens par tour, modèle, activité                    |
| `$CMC_DATA_DIR/cmc.db`              | SQLite local : runs de sauvegarde, snapshots de sessions, mapping compte |
| `$CMC_DATA_DIR/archives/`           | Transcripts archivés (gzip, dédupliqués par sha256)                      |

Les fichiers sont lus en **tail incrémental** (offsets persistés en mémoire),
jamais re-parsés intégralement après le scan initial.

Le pricing des modèles est embarqué (source [LiteLLM](https://github.com/BerriAI/litellm))
et rafraîchi au démarrage si le réseau est disponible.

## Sauvegarde & archivage (V2)

Claude Mission Control conserve un historique local, indépendant de la purge
des transcripts par Claude Code, dans un répertoire de données dédié :

- **`CMC_DATA_DIR`** (défaut `~/.claude-mission-control/`) contient :
  - `cmc.db` — base SQLite (WAL) : runs de sauvegarde (`backup_runs`),
    snapshots agrégés par session (`session_snapshots`), métadonnées
    d'archives (`archives`), configuration de sauvegarde
    (`backup_config`) et mapping projet → compte (`project_account_map`,
    `accounts`).
  - `archives/` — transcripts `.jsonl` archivés en **gzip**, dédupliqués par
    hash SHA-256 (un même contenu n'est jamais réarchivé), avec rétention
    configurable en jours.

### Déclencher une sauvegarde

Deux modes, tous deux orchestrés par le même `BackupService` :

- **Manuel** :
  - via le bouton de la page **ARCHIVE** de l'UI (déclenche un run immédiat,
    suivi en direct via WebSocket) ;
  - via la CLI one-shot, sans démarrer le serveur HTTP :
    ```bash
    npm run build -w server && npm run backup -w server
    # ou, depuis la racine, build + run en une commande :
    npm run backup
    ```
    La commande charge la config, ouvre `cmc.db`, scanne les transcripts
    récents (`CMC_SCAN_DAYS`), exécute un run `"manual"`, imprime un résumé
    (sessions, fichiers archivés, taille brute → gzip, durée, erreurs
    éventuelles) puis se termine (exit code `0` en succès, `1` en erreur).
- **Planifié** : un scheduler interne basé sur **node-cron**
  (`server/src/backup/scheduler.ts`), activable et configurable (expression
  cron, rétention) directement depuis la page **ARCHIVE** — persisté dans
  `backup_config`.

### Attribution de compte

Chaque projet (`project_slug`) peut être rattaché manuellement à un compte
(employeur, client, etc.) via la table `project_account_map` (édition depuis la
page **ARCHIVE**). Cette attribution alimente la ventilation des coûts par
compte dans l'historique ; il n'y a pas d'attribution automatique.

### Page de supervision ARCHIVE

L'onglet **ARCHIVE** de l'UI (à côté de **LIVE**) affiche : l'état du dernier
run (running / done / error), l'historique des runs, le mapping projet →
compte, la configuration du scheduler et un navigateur d'archives par session
(métadonnées uniquement pour l'instant — voir [BACKLOG.md](./BACKLOG.md)).

## Démarrage

```bash
npm install
npm run dev        # serveur API :4517 + Vite :5173 (http://localhost:5173)
```

Production locale :

```bash
npm run build
npm start          # sert l'UI buildée sur http://127.0.0.1:4517
```

## Configuration (variables d'environnement)

| Variable         | Défaut                      | Description                                        |
| ---------------- | --------------------------- | -------------------------------------------------- |
| `CMC_PORT`       | `4517`                      | Port du serveur (bindé sur 127.0.0.1)              |
| `CMC_CLAUDE_DIR` | `~/.claude`                 | Racine des données Claude Code                     |
| `CMC_SCAN_DAYS`  | `7`                         | Fenêtre de scan des transcripts (jours)            |
| `CMC_DATA_DIR`   | `~/.claude-mission-control` | Répertoire de données CMC (`cmc.db` + `archives/`) |

## Tests

```bash
npm test           # vitest (parsing JSONL, pricing, agrégation)
```

## Architecture

```
server/  Node + TypeScript + Hono — watchers (chokidar), agrégation, REST + WS
web/     React + Vite — HUD (FleetGrid, MetricsBar, SessionDetail)
```
