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

| Source                              | Usage                                                                 |
| ----------------------------------- | --------------------------------------------------------------------- |
| `~/.claude/sessions/*.json`         | Registre live des sessions (statut `busy`/`waiting`/`idle`, PID, cwd) |
| `~/.claude/projects/<slug>/*.jsonl` | Transcripts : usage tokens par tour, modèle, activité                 |

Les fichiers sont lus en **tail incrémental** (offsets persistés en mémoire),
jamais re-parsés intégralement après le scan initial.

Le pricing des modèles est embarqué (source [LiteLLM](https://github.com/BerriAI/litellm))
et rafraîchi au démarrage si le réseau est disponible.

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

| Variable         | Défaut      | Description                             |
| ---------------- | ----------- | --------------------------------------- |
| `CMC_PORT`       | `4517`      | Port du serveur (bindé sur 127.0.0.1)   |
| `CMC_CLAUDE_DIR` | `~/.claude` | Racine des données Claude Code          |
| `CMC_SCAN_DAYS`  | `7`         | Fenêtre de scan des transcripts (jours) |

## Tests

```bash
npm test           # vitest (parsing JSONL, pricing, agrégation)
```

## Architecture

```
server/  Node + TypeScript + Hono — watchers (chokidar), agrégation, REST + WS
web/     React + Vite — HUD (FleetGrid, MetricsBar, SessionDetail)
```
