# Mission Control for Claude Code

[English](./README.md) · **Français**

Dashboard web **100 % local** de supervision des sessions Claude Code, en quasi
temps réel, avec une esthétique HUD sci-fi. Il lit les fichiers que Claude Code
écrit dans `~/.claude/`, agrège tokens et coûts, et conserve un historique long
terme indépendant de la purge des transcripts.

> Projet communautaire, non affilié à Anthropic ni approuvé par Anthropic. « Claude » et « Claude Code » sont des marques d'Anthropic.

Le serveur écoute uniquement sur `127.0.0.1` et n'expose **aucune
authentification** — voir [Sécurité](#sécurité).

- [Prérequis](#prérequis)
- [Installation](#installation)
- [Démarrage & cycle de vie](#démarrage--cycle-de-vie)
- [Alias shell](#alias-shell)
- [Guide fonctionnel](#guide-fonctionnel)
- [Sources de données](#sources-de-données)
- [Configuration](#configuration)
- [API REST & WebSocket](#api-rest--websocket)
- [Exploitation](#exploitation)
- [Sécurité](#sécurité)
- [Dépannage](#dépannage)
- [Tests & qualité](#tests--qualité)
- [Architecture](#architecture)
- [Distribution](#distribution)
- [Contribuer](#contribuer)
- [Licence](#licence)

## Prérequis

| Prérequis                | Détail                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node.js ≥ 22.12**      | `node -v`. Testé en CI sur Node 22.12 et 26.                                                                                                              |
| **Yarn 4**               | Fourni par corepack : `npm install -g corepack` (Node ≥ 25 ne l'embarque plus) puis `corepack enable`. Pas de `npm install` (Yarn PnP).                   |
| **Réseau**               | Nécessaire à la première installation (téléchargement des dépendances) ; l'app fonctionne ensuite hors ligne.                                             |
| **Toolchain C++**        | Pour `better-sqlite3` si aucun binaire pré-compilé n'existe pour la plateforme : `sudo apt install build-essential python3`.                              |
| **Claude Code**          | Installé et utilisé au moins une fois : sans `~/.claude/projects/` ni `~/.claude/sessions/`, l'app démarre mais n'affiche rien.                           |
| **Plannotator** _(opt.)_ | Recommandé : ajoute la visualisation des UI Plannotator actives. Voir [Plannotator](#plannotator-optionnel).                                              |

## Installation

### Depuis le dépôt

```bash
git clone https://github.com/Tibeno88/mission-control-for-claude-code.git
cd mission-control-for-claude-code
npm install -g corepack   # Node ≥ 25 n'embarque plus corepack
corepack enable
yarn install
```

### Depuis une release GitHub

Chaque version est publiée sur la [page des releases](https://github.com/Tibeno88/mission-control-for-claude-code/releases) sous forme de zip. Il contient les sources, pas les dépendances : l'installation est identique au clone, sans l'étape `git clone`.

```bash
unzip mission-control-for-claude-code-<version>.zip
cd mission-control-for-claude-code-<version>
npm install -g corepack   # Node ≥ 25 n'embarque plus corepack
corepack enable
yarn install
yarn build
yarn start        # http://127.0.0.1:4517
```

Vérifiez au préalable l'intégrité de l'archive avec la somme sha256 publiée avec la release :

```bash
sha256sum mission-control-for-claude-code-<version>.zip
```

## Démarrage & cycle de vie

### Mode développement

```bash
yarn dev
```

Lance deux processus en parallèle (via `concurrently`) :

- l'**API** sur `http://127.0.0.1:4517` (serveur Hono + WebSocket) ;
- **Vite** sur `http://localhost:5173`, qui proxifie `/api` et `/ws` vers l'API.

C'est l'URL Vite (`:5173`) qu'il faut ouvrir en développement (rechargement à
chaud de l'UI).

### Mode production locale

```bash
yarn build        # compile l'UI (Vite) puis le serveur (tsc)
yarn start        # sert l'API ET l'UI buildée sur http://127.0.0.1:4517
```

En production, l'UI compilée (`web/dist`) est servie directement par le serveur,
avec repli SPA sur `index.html`. Une seule URL, un seul processus.

> ⚠️ **Yarn PnP** : lancez toujours le serveur via `yarn start` (ou
> `yarn node server/dist/server.js`). Un `node server/dist/server.js` nu échoue
> avec `ERR_MODULE_NOT_FOUND` car il ne charge pas le runtime PnP.

### Arrêt

`Ctrl+C` sur le processus, ou `cmc-stop` si vous utilisez les alias. Le serveur
intercepte `SIGINT`/`SIGTERM` et ferme proprement watchers, WebSocket et base
SQLite.

## Alias shell

Le dépôt fournit un pré-script prêt à l'emploi, `scripts/cmc-aliases.sh`,
compatible bash et zsh. Il se localise tout seul (y compris à travers un lien
symbolique), il est sourçable plusieurs fois sans effet de bord, et `cmc-help`
liste tout ce qu'il expose.

Deux façons de l'installer, au choix :

```bash
# 1) source direct — dans ~/.zshrc, ~/.bashrc ou votre fichier d'alias
source /chemin/vers/mission-control-for-claude-code/scripts/cmc-aliases.sh

# 2) lien symbolique — chargé automatiquement par oh-my-zsh
#    (oh-my-zsh source tout *.zsh de custom/, d'où l'extension du lien)
ln -s /chemin/vers/mission-control-for-claude-code/scripts/cmc-aliases.sh \
      "${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/cmc-aliases.zsh"
```

La seconde voie est préférable si vous mettez le dépôt à jour : les alias suivent
le code automatiquement.

| Alias         | Effet                                                                 |
| ------------- | --------------------------------------------------------------------- |
| `cmc-start`   | Démarre API + UI (mode dev) en tâche de fond, log dans `logs/app.log` |
| `cmc-stop`    | Arrête tous les processus du workspace                                |
| `cmc-restart` | `cmc-stop` puis `cmc-start`                                           |
| `cmc-status`  | Santé de l'API, compteurs de la flotte, coût du jour                  |
| `cmc-logs`    | `tail -f` du log applicatif                                           |
| `cmc-open`    | Ouvre l'UI : Vite (`:5173`) si elle répond, sinon `:4517`             |
| `cmc-build`   | `yarn build`                                                          |
| `cmc-test`    | `yarn test`                                                           |
| `cmc-backup`  | Sauvegarde/archivage manuel one-shot                                  |
| `cmc-package` | Produit le zip distribuable dans `dist-pkg/`                          |
| `cmc-update`  | `git pull` (si dépôt git) puis install + build                        |
| `cmc-cd`      | Se place dans le dossier du projet                                    |
| `cmc-help`    | Affiche cette liste                                                   |

Variables reconnues : `CMC_DIR` (racine, déduite automatiquement), `CMC_LOG_DIR`
(défaut `$CMC_DIR/logs`), `CMC_URL` / `CMC_PORT` pour l'**API** (défaut
`http://127.0.0.1:4517`), `CMC_DEV_URL` / `CMC_DEV_PORT` pour l'**UI Vite** en
mode développement (défaut `http://localhost:5173`).

## Guide fonctionnel

L'UI a quatre onglets, **LIVE**, **TASKS**, **DASHBOARD** et **CONFIG**, commutables depuis l'en-tête.

### En-tête (commun)

- **Compteurs `RUN` / `WAIT` / `IDLE`** : nombre de sessions par statut. Le
  compteur `WAIT` passe en alerte dès qu'une session attend une saisie.
- **Indicateur Plannotator** : nombre d'UI Plannotator actives (survol pour la
  liste et les liens).
- **Horloge** et **uplink** : `UPLINK ONLINE` quand le WebSocket est connecté,
  `UPLINK LOST` sinon (l'UI tente une reconnexion).
- **Cloche de notifications** : état de l'autorisation navigateur
  (`granted` / `denied` / `default`) ; masquée si le navigateur ne supporte pas
  les notifications.

### Onglet LIVE

**Grille de flotte** (`FleetGrid` / `SessionCard`) — une carte par session :

- **statut** : `busy` (en cours), `waiting` (attend une saisie, avec le motif
  `waitingFor`), `idle`, `ended`, `missing` (le registre live a disparu alors que
  le transcript existe encore) ;
- projet, `cwd`, **branche git**, modèles utilisés, nombre de prompts, tokens,
  coût estimé ;
- **badge sous-agents** : nombre de sous-agents (`Task`/`Agent`) lancés dans la
  session et part du coût qui leur est imputable ;
- **bouton de retrait** sur les sessions `missing` : retire la carte de la
  grille, **en mémoire serveur uniquement** — aucun fichier n'est supprimé sur
  disque, et un redémarrage du serveur la fait réapparaître ;
- clic sur une carte → panneau de détail.

**Panneau de détail** (`SessionDetail`) :

- fil d'activité récent (prompts, réponses, appels d'outils, résultats, messages
  système) ;
- ventilation **par sous-agent** : type d'agent attribué, extrait du prompt de la
  tâche, modèles, tokens, coût, première et dernière activité ;
- UI Plannotator rattachées à la session, avec lien direct.

**Notifications** : quand une session passe à `waiting`, l'UI envoie une
notification navigateur (titre « Session en attente », corps = motif d'attente)
et affiche un badge `[n WAITING]` dans le titre de l'onglet. L'autorisation est
demandée à la première transition, pas au chargement. Si elle a été refusée, la
cloche est barrée : il faut débloquer les notifications dans les réglages du
navigateur pour ce site.

### Onglet TASKS

Tableau Kanban de sessions Claude Code **headless** (`claude -p`), lancées en
arrière-plan par le serveur. Colonnes `TODO`, `IN PROGRESS`, `WAITING`, `DONE`,
plus un état `ARCHIVED` masqué par défaut (case « afficher archivées », bouton
`RESTORE`).

- Formulaire : titre, prompt, répertoire de travail (chemin absolu existant),
  modèle optionnel, mode de permissions (`manual`, `acceptEdits`, `plan` ;
  `bypassPermissions` est volontairement refusé).
- `START` lance `claude -p --output-format json … -- <prompt>` ; quand le process
  se termine, la tuile passe en `WAITING` avec la dernière réponse. On répond
  dans la tuile (`Ctrl+Entrée`) : le serveur relance `claude --resume <session_id>`
  avec ce message. `MARK DONE` clôt la tâche.
- Outils refusés (`permission_denials` du JSON de sortie) : listés dans la tuile ;
  `AUTORISER + RELANCER` les ajoute à `allowedTools` (`PATCH`) puis envoie « continue »
  (`--resume` avec la liste mise à jour). Portée : cette tâche uniquement.
- Process en erreur ou sortie illisible : la tuile reste en `WAITING` avec
  l'erreur affichée (`RELANCER` si aucune session n'a encore été créée).
  Au redémarrage du serveur, les tâches `IN PROGRESS` (process perdu) passent en
  `WAITING` avec l'erreur « interrompue par redémarrage du serveur ».
- Les tâches sont persistées dans la table SQLite `tasks`. Binaire `claude`
  résolu via le `PATH`.
- Sécurité : ces routes exécutent `claude`. La règle `Host`/`Origin` locaux
  s'applique à toute l'API et au WebSocket ; les mutations exigent en plus
  `Content-Type: application/json`. Entrées validées (cwd, mode, modèle, tailles, id).

### Onglet DASHBOARD

Deux sections. **Temps réel** (`MetricsBar`), calculée depuis les transcripts en cours de scan :

| Panneau                          | Contenu                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `01 CORE · COÛT`                 | Jauge du coût du jour rapporté à la moyenne journalière sur 7 jours (écart en %), coût 7 j, sessions |
| `02 FLUX TOKENS · AUJOURD'HUI`   | Tokens I/O du jour, répartition IN / OUT / CACHE READ / CACHE WRITE, taux de cache hit      |
| `03 TÉLÉMÉTRIE · COÛT / HEURE`   | Barres horaires sur 24 h, pic et heure courante ; survol = détail coût et tokens de l'heure |
| `04 MODÈLES · SCAN`              | Coût par modèle sur la fenêtre de scan, tokens de sortie, part du total                     |
| `05 PROJETS · SCAN`              | Top 5 des projets par coût sur la fenêtre de scan, sessions, part du total                  |

**Historique archivé** (`HistoryPanels`), calculé depuis les snapshots de
sauvegarde : sélecteur de période (`AUJOURD'HUI`, `7 JOURS`, `30 JOURS`,
`TOUT`) et filtre par compte, qui pilotent les panneaux 06 à 09.

| Panneau               | Contenu                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `06 TOTAUX · PÉRIODE` | Coût total, sessions, tokens I/O et répartition IN / OUT / CACHE, taux de cache hit             |
| `07 COÛT / JOUR`      | Barres journalières (jours sans activité affichés à 0) ; survol = coût et tokens du jour        |
| `08 PAR COMPTE`       | Coût par compte (pastille à la couleur du compte), sessions, part du total                      |
| `09 PROJETS · PÉRIODE`| Top 6 des projets par coût, sessions, part du total                                             |
| `10 COÛT / REQUÊTE`   | Requêtes, coût moyen et tokens de sortie moyens par modèle ; granularité propre JOUR / SEMAINE / MOIS (30 j / 12 sem. / 12 mois), indépendante du sélecteur de période |

### Onglet CONFIG

Paramétrage uniquement — aucune métrique de consommation (voir DASHBOARD).

- **Run de sauvegarde** : bouton de déclenchement immédiat, avec suivi en direct
  (`running` / `done` / `error`) poussé par WebSocket.
- **Comptes** : création/suppression de comptes (libellé, email, organisation,
  couleur).
- **Mapping projet → compte** : rattachement **manuel** de chaque `project_slug`
  à un compte ; il n'y a aucune attribution automatique. C'est ce mapping qui
  alimente la ventilation des coûts par compte.
- **Configuration du scheduler** : activation, expression cron, rétention en
  jours. Persistée en base, appliquée sans redémarrage.
- **Navigateur d'archives** par projet (tous les projets archivés) : chemin, taille brute → gzip, sha256,
  date d'archivage. Le téléchargement du `.jsonl.gz` depuis l'UI n'est pas encore
  disponible.

## Sources de données

| Source                                 | Usage                                                                 |
| -------------------------------------- | --------------------------------------------------------------------- |
| `~/.claude/sessions/<pid>.json`        | Registre live des sessions (statut `busy`/`waiting`/`idle`, PID, cwd) |
| `~/.claude/projects/<slug>/*.jsonl`    | Transcripts : usage tokens par tour, modèle, activité                 |
| `<slug>/<sessionId>/subagents/*.jsonl` | Transcripts des sous-agents (`Task`), agrégés par session             |
| `~/.plannotator/sessions/<pid>.json`   | Registre des UI Plannotator actives (optionnel)                       |
| `$CMC_DATA_DIR/cmc.db`                 | SQLite local : runs, snapshots de sessions, archives, comptes, config |
| `$CMC_DATA_DIR/archives/`              | Transcripts archivés (gzip, dédupliqués par sha256)                   |

Les transcripts sont lus en **tail incrémental** (offsets conservés en mémoire) :
après le scan initial, un fichier n'est jamais re-parsé intégralement. Les
répertoires sont surveillés par `chokidar`, avec un poll de secours toutes les
3 s pour détecter les registres périmés (processus tué). Un répertoire absent ou
illisible est journalisé en avertissement et n'interrompt pas le serveur.

Le pricing des modèles est embarqué (source
[LiteLLM](https://github.com/BerriAI/litellm)) et rafraîchi au démarrage si le
réseau est disponible ; sinon la table embarquée est utilisée.

### Plannotator (optionnel)

Plannotator fournit une UI d'annotation de plans et de revue de code. S'il est
installé, Mission Control affiche les UI actives : compteur dans l'en-tête,
panneau et lien direct sur la carte de la session concernée. L'attribution à une
session Claude n'est faite que lorsqu'elle est **certaine** (filiation de PID) ;
sinon l'UI reste comptée mais non rattachée. Une tâche `in_progress` dont le
processus `claude` possède une UI Plannotator affiche un lien « PLANNOTATOR »
(champ dérivé `plannotatorUrl` du snapshot WS, jamais persisté).

Sans Plannotator, tout fonctionne normalement : le compteur reste à zéro et
`/api/plannotator` renvoie une liste vide. Si son répertoire de données n'est pas
`~/.plannotator`, déclarez-le via `CMC_PLANNOTATOR_DIR` (ou la variable
`PLANNOTATOR_DATA_DIR` de Plannotator lui-même, reconnue en repli).

#### Éviter la coupure de session

Un `plannotator annotate` lancé par l'outil Bash de Claude passe en arrière-plan
après 120 s. Le harness le tue à 10 min (« background time limit »). L'assistant
termine souvent son tour sans attendre : l'annotation n'est jamais lue.

**Option D : hook de plan (recommandé).** Le hook ne passe pas par Bash, donc le
plafond de 10 min ne s'applique pas. Le champ `timeout` d'un hook est en
**secondes** (défaut 600 pour `command`). Le matcher filtre sur le nom d'outil ;
`ExitPlanMode` est un nom d'outil valide. Exemple (`~/.claude/settings.json`) :

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [{ "type": "command", "command": "plannotator", "timeout": 345600 }]
      }
    ]
  }
}
```

Non vérifié dans la doc Claude Code : que `PermissionRequest` se déclenche pour
`ExitPlanMode` (sinon utiliser `PreToolUse`, qui le liste explicitement), et la
commande exacte de hook de Plannotator (voir sa documentation). Contrôlez avec
`/hooks` ou `claude --debug`.

**Option E : lancement détaché + attente active.** Pour `/plannotator-annotate` :

```bash
setsid nohup plannotator annotate plan.md > /tmp/pn.out 2>&1 &
```

Puis attendez la sortie avec `Monitor` (ou une boucle `until grep`). Le tour ne
doit pas finir avant le résultat. Gardez des commandes simples (pas de `;` ni
`&&`) et pré-autorisez `Bash(plannotator:*)` et `Bash(setsid:*)`. `Monitor`
expire au plus après 30 min (plafond de l'outil) : relancez-le à chaque expiration.
Ce plafond vient de la description de l'outil, non de la doc des hooks.

### Schéma SQLite

`$CMC_DATA_DIR/cmc.db` est la source ouvrable par un outil externe (DB Browser
for SQLite, DuckDB, un script Python…) pour du recalcul ou des statistiques que
l'UI ne couvre pas. Une ligne par table :

| Table                 | Granularité / clé                                                                                          | Rôle                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_events`      | 1 ligne = 1 requête LLM. Unique `(session_id, agent_id, dedupe_key)`                                       | **Table de faits.** Tokens, cache, coût _et_ taux appliqués au moment de l'appel, par requête. Base de toutes les moyennes par période. **Non liée à `backup_runs`** : survit à une purge des runs/archives, par construction. `account_id` figé à l'écriture (un remappage projet→compte ultérieur ne réécrit pas l'historique). |
| `request_rollups`     | 1 ligne = mois × modèle × projet (`project_slug` NULL = tous projets). Clé `(bucket, model, project_slug)` | Compaction d'une période purgée depuis `request_events` : `requests` est conservé comme dénominateur, donc les moyennes restent exactes après compaction. Vide tant que la purge est désactivée (réglage actuel : rétention infinie).                                                                                             |
| `purge_watermark`     | 1 ligne fixe (`id = 1`)                                                                                    | Marque la date en-deçà de laquelle `request_events` peut être incomplet (compacté dans `request_rollups`). Absente = aucune purge n'a encore eu lieu, `request_events` est intégral.                                                                                                                                              |
| `session_snapshots`   | 1 ligne par run de backup × session                                                                        | Photo cumulée d'une session à l'instant d'un run. Sert les vues par session/projet/compte de l'onglet CONFIG. `rate_*`/`pricing_source` renseignés uniquement quand la session n'a utilisé qu'un seul modèle (sinon `pricing_source = "mixed"`, taux à NULL — pas de taux moyen fabriqué).                                       |
| `archives`            | 1 ligne par fichier `.jsonl` archivé, unique par `sha256`                                                  | Index des transcripts gzippés (`archives/`) : chemin d'origine, chemin d'archive, tailles, date. Dédoublonne par contenu.                                                                                                                                                                                                         |
| `backup_runs`         | 1 ligne par run de backup (manuel ou planifié)                                                             | Journal d'exécution : volumétrie, durée, erreur éventuelle.                                                                                                                                                                                                                                                                       |
| `accounts`            | 1 ligne par compte déclaré                                                                                 | Comptes Claude saisis manuellement (libellé, email, organisation, couleur).                                                                                                                                                                                                                                                       |
| `project_account_map` | 1 ligne par projet mappé, clé `project_slug`                                                               | Rattachement projet → compte, saisi à la main dans l'onglet CONFIG.                                                                                                                                                                                                                                                              |
| `backup_config`       | Clé/valeur                                                                                                 | Configuration du backup : activation, cron, rétention (jours, `0` = infinie), répertoire.                                                                                                                                                                                                                                         |

**Requête prête à l'emploi** — coût moyen et tokens de sortie moyens par
requête, par modèle, sur les 30 derniers jours (résultat identique à ce que
sert `/api/metrics/periods`) :

```sql
SELECT
  strftime('%Y-%m-%d', ts, 'localtime') AS jour,
  model,
  COUNT(*)                              AS requetes,
  SUM(cost_usd) / COUNT(*)              AS cout_moyen_usd,
  SUM(output_tokens) / COUNT(*)         AS tokens_out_moyen
FROM request_events
WHERE ts >= datetime('now', '-30 days')
GROUP BY jour, model
ORDER BY jour, model;
```

Pour une période purgée (antérieure à `purge_watermark.purged_before`), la même
moyenne se recalcule au grain mois depuis `request_rollups` :
`SUM(cost_usd) / SUM(requests)` et `SUM(output_tokens) / SUM(requests)`.

## Configuration

Tout se configure par variables d'environnement, à passer au serveur.

| Variable              | Défaut                      | Description                                                                    |
| --------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| `CMC_PORT`            | `4517`                      | Port du serveur (toujours bindé sur `127.0.0.1`). Entier positif obligatoire.  |
| `CMC_CLAUDE_DIR`      | `~/.claude`                 | Racine des données Claude Code (`projects/` et `sessions/` en dérivent).       |
| `CMC_SCAN_DAYS`       | `7`                         | Fenêtre de scan des transcripts, en jours. Entier positif obligatoire.         |
| `CMC_DATA_DIR`        | `~/.claude-mission-control` | Répertoire de données CMC (`cmc.db` + `archives/`).                            |
| `CMC_PLANNOTATOR_DIR` | `~/.plannotator`            | Répertoire de données Plannotator. Repli sur `PLANNOTATOR_DATA_DIR`. `~` géré. |

Une valeur non entière ou négative pour `CMC_PORT` / `CMC_SCAN_DAYS` fait échouer
le démarrage avec un message explicite, plutôt que de retomber silencieusement
sur le défaut.

Exemple :

```bash
CMC_PORT=4600 CMC_SCAN_DAYS=30 CMC_DATA_DIR=~/backups/cmc yarn start
```

**Constantes non configurables** (dans `server/src/config.ts`), utiles pour
interpréter la latence de l'UI :

| Constante             | Valeur    | Rôle                                          |
| --------------------- | --------- | --------------------------------------------- |
| `registryPollMs`      | 3 000 ms  | Poll de secours des registres de sessions     |
| `broadcastDebounceMs` | 500 ms    | Regroupement des diffusions WebSocket         |
| Heartbeat WS          | 10 000 ms | Rafraîchit les compteurs relatifs côté client |

**Réglages persistés en base** (table `backup_config`, modifiables depuis
l'onglet CONFIG) : `enabled` (défaut `false`), `cron` (défaut `0 * * * *`, soit
toutes les heures), `retentionDays` (défaut `0` = rétention infinie),
`backupDir`.

## API REST & WebSocket

Toutes les routes sont servies sur `http://127.0.0.1:$CMC_PORT`.

Toutes les routes `/api/*` (GET comme mutations) et le WebSocket `/ws` exigent un
`Host` local (`127.0.0.1` ou `localhost`, port quelconque). Si un `Origin` est présent,
il doit être local et identique au `Host`. Sinon : `403` avec `{ "error": "forbidden host" }`
ou `{ "error": "forbidden origin" }` (handshake refusé pour `/ws`). Les clients sans
`Origin` (curl, alias `cmc-*`) fonctionnent tant qu'ils visent `127.0.0.1` ou `localhost`.

### Supervision live

| Méthode | Route                        | Réponse                                                            |
| ------- | ---------------------------- | ------------------------------------------------------------------ |
| `GET`   | `/api/health`                | `{ ok: true }`                                                     |
| `GET`   | `/api/snapshot`              | Flotte + métriques + Plannotator en un appel (ce que pousse le WS) |
| `GET`   | `/api/fleet`                 | Sessions uniquement                                                |
| `GET`   | `/api/metrics`               | Métriques globales (jour, 7 j, par projet, par modèle, timeline)   |
| `GET`   | `/api/sessions/:id/activity` | Activité récente. `?limit=` entre 1 et 300 (défaut 80)             |
| `POST`  | `/api/sessions/:id/dismiss`  | Retire une session non live de la grille. `409` si elle est live   |
| `GET`   | `/api/plannotator`           | UI Plannotator actives, avec attribution de session                |

Les identifiants de session sont validés (`[0-9a-fA-F-]{8,64}`) ; une valeur
invalide renvoie `400`.

### Sauvegarde & historique

| Méthode  | Route                  | Rôle                                                                                                                                                                         |
| -------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/backup/run`      | Déclenche un run manuel                                                                                                                                                      |
| `GET`    | `/api/backup/runs`     | Liste des runs                                                                                                                                                               |
| `GET`    | `/api/backup/history`  | Historique agrégé (`?period=today\|7d\|30d\|all`)                                                                                                                            |
| `GET`    | `/api/metrics/periods` | Coût moyen et tokens de sortie moyens par requête, par modèle (`?bucket=day\|week\|month&from=&to=&model=&project=`) — coût **estimé**, voir [Schéma SQLite](#schéma-sqlite) |
| `GET`    | `/api/backup/config`   | Configuration du scheduler                                                                                                                                                   |
| `PUT`    | `/api/backup/config`   | Met à jour activation / cron / rétention                                                                                                                                     |
| `GET`    | `/api/accounts`        | Liste des comptes                                                                                                                                                            |
| `POST`   | `/api/accounts`        | Crée un compte                                                                                                                                                               |
| `DELETE` | `/api/accounts/:id`    | Supprime un compte                                                                                                                                                           |
| `GET`    | `/api/project-map`     | Mapping projet → compte                                                                                                                                                      |
| `PUT`    | `/api/project-map`     | Met à jour le mapping                                                                                                                                                        |
| `GET`    | `/api/archives`        | Métadonnées des archives                                                                                                                                                     |

### Tâches (Kanban)

| Méthode | Route                    | Rôle                                                                        |
| ------- | ------------------------ | --------------------------------------------------------------------------- |
| `GET`   | `/api/tasks`             | Liste des tâches                                                            |
| `POST`  | `/api/tasks`             | Crée une tâche `todo` (`title`, `prompt`, `cwd`, `model?`, `permissionMode`, `allowedTools?` : liste `--allowedTools`, absent = tous) |
| `POST`  | `/api/tasks/:id/start`   | Lance la tâche. `409` si déjà en cours ou déjà démarrée                      |
| `POST`  | `/api/tasks/:id/reply`   | `{ message }` : reprend la session. `409` si la tâche n'est pas `waiting`    |
| `PATCH` | `/api/tasks/:id`         | `title`, `prompt`, `allowedTools` (même validation qu'à la création), `status` ∈ `todo` (restauration), `done`, `archived` |

Mutations : en plus de la règle `Host`/`Origin` générale ci-dessus, `Content-Type: application/json`
est obligatoire (`415` sinon).

### WebSocket

Canal unique sur `/ws`. Le serveur envoie un snapshot complet à la connexion,
puis à chaque changement (débounce 500 ms) et toutes les 10 s :

| Message         | Contenu                                                         |
| --------------- | --------------------------------------------------------------- |
| `snapshot`      | `{ fleet, metrics, plannotator, tasks, generatedAt }`           |
| `backup_status` | `{ status: running\|done\|error, run?, message?, generatedAt }` |

## Exploitation

### Sauvegarde manuelle

Depuis l'UI (bouton de l'onglet CONFIG) ou en ligne de commande, sans démarrer
le serveur HTTP :

```bash
yarn backup
```

La commande charge la configuration, ouvre `cmc.db`, scanne les transcripts de la
fenêtre `CMC_SCAN_DAYS`, exécute un run `manual` et imprime un résumé (run id,
sessions, fichiers archivés, taille brute → gzip, durée, erreur éventuelle).
**Code de sortie : `0` en succès, `1` si le run porte une erreur ou si la
commande échoue** — utilisable dans un cron externe.

### Sauvegarde planifiée

Scheduler interne basé sur `node-cron`, activable depuis l'onglet CONFIG
(expression cron + rétention). La configuration est persistée en base et
rechargée au démarrage.

### Rétention

`retentionDays = 0` signifie **rétention infinie** (aucune purge). Au-delà, les
archives plus anciennes que le seuil sont supprimées (lignes en base + fichiers
`.gz`), puis les `session_snapshots` et `backup_runs` orphelins sont purgés. Les
suppressions de fichiers sont confinées à `backupDir` : un chemin extérieur n'est
jamais touché.

### Déduplication

Un contenu déjà archivé (même sha256) n'est jamais réarchivé. La contrainte
d'unicité est portée par la colonne `archives.sha256`.

### Inspection de la base

```bash
sqlite3 ~/.claude-mission-control/cmc.db '.tables'
sqlite3 ~/.claude-mission-control/cmc.db \
  'SELECT id, mode, sessions_count, files_archived, error FROM backup_runs ORDER BY id DESC LIMIT 5;'
```

Tables : `backup_runs`, `session_snapshots`, `archives`, `accounts`,
`project_account_map`, `backup_config`. La base est en mode WAL.

### Logs

Le serveur écrit sur la sortie standard. Avec `cmc-start`, tout est redirigé vers
`logs/app.log` (`cmc-logs` pour le suivre). Sinon, redirigez vous-même la sortie
du processus.

## Sécurité

- Le serveur est bindé sur `127.0.0.1` et **n'a aucune authentification**. Ne
  l'exposez pas sur un réseau, ne le placez pas derrière un reverse proxy
  accessible : quiconque atteint le port lit tous vos transcripts.
- Les données lues (prompts, réponses, chemins de projets) sont potentiellement
  confidentielles. `CMC_DATA_DIR` (base + archives) reste strictement local et
  n'est jamais inclus dans un zip de distribution.
- Les URL fournies par Plannotator sont filtrées : seuls les schémas `http:` et
  `https:` sont rendus côté client.
- L'app est en **lecture seule** sur `~/.claude/` : elle n'écrit jamais dans les
  données de Claude Code. Le retrait d'une session de la grille est un état en
  mémoire, pas une suppression.
- Toutes les routes `/api/*` et `/ws` rejettent un `Host` ou un `Origin` non local.
  Cela bloque le DNS rebinding (une page web lisant l'API via un domaine rebindé) et le
  cross-site WebSocket hijacking (une page ouverte dans le même navigateur lisant le
  snapshot live, les WebSockets échappant au CORS). Ce n'est pas une authentification :
  n'exposez toujours pas le port.
- Signaler une vulnérabilité : voir [SECURITY.md](./SECURITY.md) (signalement privé, jamais d'issue publique).

## Dépannage

| Symptôme                                  | Cause probable                                                               | Vérification / correction                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `ERR_MODULE_NOT_FOUND` au lancement       | `node` lancé sans le runtime Yarn PnP                                        | Utiliser `yarn start` (ou `yarn node server/dist/server.js`)                            |
| `yarn: command not found`                 | Corepack non activé                                                          | `npm install -g corepack`, puis `corepack enable`, puis `yarn -v` (doit afficher `4.x`) |
| `EADDRINUSE` sur 4517                     | Une instance tourne déjà, ou le port est pris                                | `cmc-status`, `ss -tlnp \| grep 4517`, ou changer `CMC_PORT`                            |
| `UPLINK LOST` dans l'en-tête              | Serveur arrêté, ou UI ouverte sur le mauvais port                            | En dev, ouvrir `:5173` (pas `:4517`) ; vérifier `cmc-status`                            |
| Aucune session affichée                   | Mauvais `CMC_CLAUDE_DIR`, ou fenêtre de scan trop courte                     | `ls ~/.claude/projects` ; augmenter `CMC_SCAN_DAYS`                                     |
| Notifications absentes                    | Autorisation refusée pour le site                                            | Cloche barrée = `denied` : débloquer dans les réglages du navigateur                    |
| Échec d'installation de `better-sqlite3`  | Pas de binaire pré-compilé pour la plateforme                                | `sudo apt install build-essential python3` puis `yarn install`                          |
| Compteur Plannotator toujours à zéro      | Plannotator absent, ou répertoire de données non standard                    | Optionnel par nature ; sinon définir `CMC_PLANNOTATOR_DIR`                              |
| Coûts qui semblent faux                   | Table de pricing non rafraîchie (hors ligne au démarrage)                    | Les logs indiquent `[pricing] refreshed N claude models` ; sinon table locale           |
| `403 forbidden host` / `forbidden origin` | Accès via un autre nom d'hôte que `127.0.0.1`/`localhost` (alias, IP, proxy) | Ouvrir `http://127.0.0.1:4517` (ou `:5173` en dev)                                      |

## Tests & qualité

```bash
yarn test         # vitest : parsing JSONL, pricing, agrégation, backup, plannotator
yarn typecheck    # tsc --noEmit sur les deux workspaces
```

## Architecture

```
server/                       Node + TypeScript + Hono
  src/
    server.ts                 API REST, WebSocket, service de fichiers statiques
    config.ts                 chargement des variables d'environnement
    sessions.ts               registre live (~/.claude/sessions)
    transcripts.ts            tail incrémental des transcripts + sous-agents
    metrics.ts                agrégation flotte et métriques globales
    pricing.ts                table de pricing (embarquée + refresh LiteLLM)
    plannotator.ts            registre des UI Plannotator + attribution par PID
    proc.ts                   lecture /proc, filiation de PID
    local-guard.ts            garde Host/Origin locale (API REST + WebSocket)
    tasks/                    onglet TASKS : API, runner claude -p, persistance
    backup/                   db, service, scheduler, archivage, rétention, CLI, API
  test/                       vitest

web/                          React 19 + Vite
  src/
    App.tsx                   composition des vues LIVE / DASHBOARD / CONFIG
    components/               Header, MetricsBar, HistoryPanels, HudPanel, CostBars,
                              FleetGrid, SessionCard, SessionDetail,
                              PlannotatorPanel, backup/ (vue CONFIG)
    lib/                      useSnapshot (WS), useBackup, useNotifications, format
    styles/                   tokens, global, hud, metrics, backup

scripts/
  package.sh                  production du zip distribuable
  cmc-aliases.sh              alias shell cmc-*
```

## Distribution

Chaque version publiée est attachée à une [release GitHub](https://github.com/Tibeno88/mission-control-for-claude-code/releases), avec sa somme sha256. Pour produire le zip localement :

```bash
yarn package                        # dist-pkg/mission-control-for-claude-code-<version>.zip
bash scripts/package.sh --worktree  # inclut aussi les modifications non committées
```

Le zip est construit à partir de git : rien de non suivi ni d'ignoré ne peut y
entrer. Le script retire en plus le contenu interne (`BACKLOG.md`, `docs/`,
`.claude/`, `.github/`, `package-lock.json`, tout `*.local.*`), génère un
`INSTALL.md`, puis **vérifie le contenu réel de l'archive** et la supprime si un
motif interdit apparaît. Il affiche enfin la taille et le sha256 à transmettre
avec le fichier.

Contenu : sources `server/` et `web/`, manifestes, `yarn.lock`, artefacts Yarn
PnP, `scripts/`, `README.md`, `README.fr.md`, `LICENSE`, `SECURITY.md`,
`CONTRIBUTING.md`, `INSTALL.md`. Ni dépendances, ni build, ni données.

## Contribuer

Les contributions sont bienvenues : voir [CONTRIBUTING.md](./CONTRIBUTING.md). Les évolutions prévues et les bugs sont suivis dans les [issues GitHub](https://github.com/Tibeno88/mission-control-for-claude-code/issues).

## Licence

[MIT](./LICENSE). La table de pricing embarquée provient de [LiteLLM](https://github.com/BerriAI/litellm) (licence MIT).
