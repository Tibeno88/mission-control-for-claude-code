#!/usr/bin/env bash
#
# Claude Mission Control — alias shell prêts à l'emploi (bash & zsh).
#
# Deux façons de l'installer, au choix :
#
#   1) source direct, dans ~/.zshrc, ~/.bashrc ou votre fichier d'alias :
#        source /chemin/vers/claude-mission-control/scripts/cmc-aliases.sh
#
#   2) lien symbolique, chargé automatiquement par oh-my-zsh :
#        ln -s /chemin/vers/claude-mission-control/scripts/cmc-aliases.sh \
#              "${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/cmc-aliases.zsh"
#
# `cmc-help` liste les commandes disponibles. Ce fichier est sourçable plusieurs
# fois sans effet de bord, et se localise tout seul — y compris à travers un lien
# symbolique. Pour forcer la racine : export CMC_DIR=/chemin/vers/l/installation.

# --- Résolution de la racine d'installation ---------------------------------
# Sourcé et non exécuté : $0 n'est pas fiable. On prend $BASH_SOURCE en bash et
# %x en zsh, puis on suit les liens symboliques (cas d'installation n°2).
if [ -z "${CMC_DIR:-}" ]; then
  # shellcheck disable=SC2296 # ${(%):-%x} est une expansion zsh
  _cmc_src="${BASH_SOURCE[0]:-${(%):-%x}}"
  if command -v readlink > /dev/null 2>&1; then
    _cmc_resolved="$(readlink -f "$_cmc_src" 2> /dev/null || printf '%s' "$_cmc_src")"
  else
    _cmc_resolved="$_cmc_src"
  fi
  CMC_DIR="$(cd "$(dirname "$_cmc_resolved")/.." && pwd)"
  unset _cmc_src _cmc_resolved
fi

if [ ! -f "$CMC_DIR/package.json" ]; then
  printf 'cmc-aliases: racine introuvable (%s) — aucun alias defini.\n' "$CMC_DIR" >&2
  printf 'cmc-aliases: definissez CMC_DIR vers le dossier de l installation.\n' >&2
  unset CMC_DIR
  return 0 2> /dev/null || exit 0
fi

export CMC_DIR
export CMC_LOG_DIR="${CMC_LOG_DIR:-$CMC_DIR/logs}"
# API (et UI buildée en mode production, via `yarn start`).
export CMC_URL="${CMC_URL:-http://127.0.0.1:${CMC_PORT:-4517}}"
# UI de développement servie par Vite, celle que `cmc-start` (yarn dev) expose.
export CMC_DEV_URL="${CMC_DEV_URL:-http://localhost:${CMC_DEV_PORT:-5173}}"

# --- Cycle de vie -----------------------------------------------------------

# Démarre serveur + UI en tâche de fond, journalisés dans $CMC_LOG_DIR/app.log.
cmc-start() {
  mkdir -p "$CMC_LOG_DIR" || return 1
  if cmc-status > /dev/null 2>&1; then
    printf 'CMC deja demarre (API %s)\n' "$CMC_URL"
    return 0
  fi
  (
    cd "$CMC_DIR" || exit 1
    nohup yarn dev > "$CMC_LOG_DIR/app.log" 2>&1 &
    printf 'CMC demarre (pid %s)\n' "$!"
  )
  printf 'logs : %s\n' "$CMC_LOG_DIR/app.log"
  # yarn dev = Vite sert l'UI, le serveur Hono ne sert que l'API.
  printf 'UI   : %s\n' "$CMC_DEV_URL"
  printf 'API  : %s\n' "$CMC_URL"
}

# Arrête les processus du workspace (concurrently + les deux workspaces yarn).
cmc-stop() {
  pkill -f "concurrently.*@cmc|workspace @cmc" 2> /dev/null
  sleep 0.5
  pkill -9 -f "workspace @cmc" 2> /dev/null
  printf 'CMC arrete\n'
}

cmc-restart() {
  cmc-stop
  cmc-start
}

cmc-logs() {
  if [ ! -f "$CMC_LOG_DIR/app.log" ]; then
    printf 'aucun log : %s\n' "$CMC_LOG_DIR/app.log" >&2
    return 1
  fi
  tail -f "$CMC_LOG_DIR/app.log"
}

# Santé du serveur + compteurs de la flotte (sortie non nulle si injoignable).
cmc-status() {
  command -v curl > /dev/null 2>&1 || {
    printf 'curl requis\n' >&2
    return 1
  }
  curl -fsS --max-time 2 "$CMC_URL/api/health" > /dev/null 2>&1 || {
    printf 'CMC injoignable sur %s\n' "$CMC_URL" >&2
    return 1
  }
  printf 'CMC en ligne sur %s\n' "$CMC_URL"
  curl -fsS --max-time 3 "$CMC_URL/api/snapshot" 2> /dev/null |
    node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", () => {
        try {
          const snap = JSON.parse(raw);
          const fleet = snap.fleet ?? [];
          const count = (status) => fleet.filter((s) => s.status === status).length;
          const cost = (snap.metrics?.today?.costUSD ?? 0).toFixed(2);
          console.log(
            `sessions : ${count("busy")} busy / ${count("waiting")} waiting / ` +
              `${count("idle")} idle (total ${fleet.length})`,
          );
          console.log(`plannotator : ${(snap.plannotator ?? []).length} UI active(s)`);
          console.log(`cout du jour : $${cost}`);
        } catch {
          console.error("reponse /api/snapshot illisible");
        }
      });
    '
}

# Ouvre l'UI : celle de Vite si elle repond (mode dev), sinon celle servie par
# le serveur lui-meme (mode production).
cmc-open() {
  local target="$CMC_URL"
  if command -v curl > /dev/null 2>&1 &&
    curl -fsS --max-time 2 -o /dev/null "$CMC_DEV_URL" 2> /dev/null; then
    target="$CMC_DEV_URL"
  fi
  for opener in xdg-open open wslview; do
    if command -v "$opener" > /dev/null 2>&1; then
      "$opener" "$target" > /dev/null 2>&1 &
      return 0
    fi
  done
  printf 'aucun ouvreur trouve — ouvrez %s manuellement\n' "$target" >&2
  return 1
}

# --- Maintenance ------------------------------------------------------------

cmc-build() { (cd "$CMC_DIR" && yarn build); }
cmc-test() { (cd "$CMC_DIR" && yarn test); }
cmc-backup() { (cd "$CMC_DIR" && yarn backup); }
cmc-package() { (cd "$CMC_DIR" && yarn package); }

# Met à jour l'installation. Sans dépôt git (installation depuis un zip), il n'y
# a rien à tirer : on le dit clairement plutôt que d'échouer obscurément.
cmc-update() {
  (
    cd "$CMC_DIR" || exit 1
    if [ -d .git ]; then
      git pull --ff-only || exit 1
    else
      printf 'installation hors git (zip) : recuperez un nouveau zip pour mettre a jour\n'
    fi
    yarn install && yarn build
  )
}

cmc-cd() { cd "$CMC_DIR" || return 1; }

cmc-help() {
  printf 'Claude Mission Control — alias disponibles (racine : %s)\n\n' "$CMC_DIR"
  printf '  cmc-start     demarre API + UI (mode dev) en tache de fond\n'
  printf '  cmc-stop      arrete tous les processus CMC\n'
  printf '  cmc-restart   stop puis start\n'
  printf '  cmc-status    sante de l API + compteurs de la flotte\n'
  printf '  cmc-logs      suit %s\n' "$CMC_LOG_DIR/app.log"
  printf '  cmc-open      ouvre l UI (%s en dev, sinon %s)\n' "$CMC_DEV_URL" "$CMC_URL"
  printf '  cmc-build     compile serveur + UI\n'
  printf '  cmc-test      lance la suite de tests\n'
  printf '  cmc-backup    sauvegarde/archivage manuel (one-shot)\n'
  printf '  cmc-package   produit le zip distribuable dans dist-pkg/\n'
  printf '  cmc-update    git pull (si dispo) + install + build\n'
  printf '  cmc-cd        va dans le dossier du projet\n'
  printf '  cmc-help      cette aide\n\n'
  printf 'Variables : CMC_DIR, CMC_LOG_DIR, CMC_URL (API), CMC_DEV_URL (UI Vite),\n'
  printf '            CMC_PORT, CMC_DEV_PORT\n'
}
