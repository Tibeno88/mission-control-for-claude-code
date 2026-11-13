#!/usr/bin/env bash
#
# Builds the distributable source zip of Mission Control for Claude Code.
#
# The staging area is always derived from git, so nothing gitignored
# (node_modules/, logs/, .env*, dist/, CMC_DATA_DIR data) can leak into the
# artifact. On top of that, the exclusion list below drops internal-only files:
# the zip is meant for end users, not for contributors.
#
# Usage: scripts/package.sh [--out-dir DIR] [--worktree]
#   --worktree  package the current working tree (tracked + not-ignored files)
#               instead of the committed HEAD. Handy to ship work in progress.
set -euo pipefail

# Paths inside the staged tree that must never ship, and the reason why.
# Matched relative to the archive root.
EXCLUDE_PATHS=(
  "BACKLOG.md"        # internal roadmap notes
  "package-lock.json" # npm leftover, contradicts packageManager: yarn
  ".claude"           # local agent configuration
  "docs"              # internal documentation
  ".github"           # CI/workflows, irrelevant to a zip recipient
)
# Filename globs dropped anywhere in the tree.
EXCLUDE_GLOBS=(
  "*.local.*" # machine-local overrides
  "*.tar.gz"
  "*.zip"
)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/dist-pkg"
SOURCE_MODE="head"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      [[ $# -ge 2 ]] || {
        echo "error: --out-dir requires a value" >&2
        exit 2
      }
      OUT_DIR="$2"
      shift 2
      ;;
    --worktree)
      SOURCE_MODE="worktree"
      shift
      ;;
    -h | --help)
      sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done

for tool in git zip unzip node; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: '$tool' is required" >&2
    exit 1
  }
done

cd "$ROOT"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  {
    echo "error: not a git work tree — packaging requires git archive" >&2
    exit 1
  }

VERSION="$(node -p "require('./package.json').version")"
NAME="mission-control-for-claude-code-$VERSION"
ARCHIVE="$OUT_DIR/$NAME.zip"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/$NAME"
if [[ "$SOURCE_MODE" == "worktree" ]]; then
  echo "==> staging working tree into $STAGE/$NAME"
  # --cached --others --exclude-standard = tracked files plus untracked ones that
  # .gitignore does not exclude. Ignored files still cannot get in.
  git ls-files -z --cached --others --exclude-standard |
    tar --null --files-from=- -cf - | tar -x -C "$STAGE/$NAME"
else
  echo "==> staging HEAD into $STAGE/$NAME"
  if ! git diff --quiet HEAD -- .; then
    echo "warning: uncommitted changes are NOT included — use --worktree to include them" >&2
  fi
  git archive HEAD | tar -x -C "$STAGE/$NAME"
fi

echo "==> dropping internal-only files"
for target in "${EXCLUDE_PATHS[@]}"; do
  if [[ -e "$STAGE/$NAME/$target" ]]; then
    rm -rf "$STAGE/$NAME/$target"
    echo "    - $target"
  fi
done
for glob in "${EXCLUDE_GLOBS[@]}"; do
  while IFS= read -r -d '' found; do
    rm -rf "$found"
    echo "    - ${found#"$STAGE/$NAME/"}"
  done < <(find "$STAGE/$NAME" -name "$glob" -print0)
done

echo "==> writing INSTALL.md"
cat > "$STAGE/$NAME/INSTALL.md" << EOF
# Mission Control for Claude Code — installation

Version $VERSION. Dashboard local de supervision des sessions Claude Code.
La documentation complète (fonctionnalités, configuration, exploitation) est
dans \`README.md\`.

## Prérequis

- **Node.js >= 20** (\`node -v\`)
- **Yarn 4** via corepack : \`corepack enable\`
- Une **connexion réseau** pour la première installation (téléchargement des
  dépendances)
- De quoi compiler un module natif (\`better-sqlite3\`) si aucun binaire
  pré-compilé n'est disponible pour votre plateforme :
  \`sudo apt install build-essential python3\` sur Debian/Ubuntu
- **Claude Code** installé et déjà utilisé au moins une fois (l'app lit
  \`~/.claude/\`)

## Installation

\`\`\`bash
corepack enable          # active Yarn 4 (une seule fois par machine)
yarn install             # installe les dépendances
yarn build               # compile le serveur et l'UI
yarn start               # http://127.0.0.1:4517
\`\`\`

Le serveur écoute uniquement sur \`127.0.0.1\` et n'expose aucune
authentification : ne le publiez pas sur un réseau.

## Alias shell (optionnel)

\`\`\`bash
source "\$(pwd)/scripts/cmc-aliases.sh"   # puis : cmc-help
\`\`\`

Voir la section « Alias shell » du \`README.md\` pour une installation permanente.
EOF

echo "==> zipping"
mkdir -p "$OUT_DIR"
rm -f "$ARCHIVE"
(cd "$STAGE" && zip -q -r -9 "$ARCHIVE" "$NAME")

# Belt and braces: assert on the real archive listing rather than trusting the
# staging steps above. A leak here is a data-disclosure bug, not a build glitch.
echo "==> verifying archive contents"
LISTING="$(unzip -Z1 "$ARCHIVE")"
FORBIDDEN=(
  "*/docs/*" "*.local.*" "*/BACKLOG.md" "*/node_modules/*" "*/.git/*"
  "*/logs/*" "*/.env*" "*/.claude/*" "*/package-lock.json" "*/dist/*"
  "*/cmc.db*" "*/archives/*"
)
failed=0
while IFS= read -r entry; do
  for pattern in "${FORBIDDEN[@]}"; do
    # shellcheck disable=SC2254 # $pattern is a glob on purpose
    case "$entry" in
      $pattern)
        echo "FORBIDDEN ENTRY: $entry (matched '$pattern')" >&2
        failed=1
        ;;
    esac
  done
done <<< "$LISTING"
if [[ $failed -ne 0 ]]; then
  rm -f "$ARCHIVE"
  echo "error: archive rejected and deleted — fix the exclusion list" >&2
  exit 1
fi

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
SHA="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
FILES="$(printf '%s\n' "$LISTING" | wc -l)"

cat << EOF

Artifact : $ARCHIVE
Taille   : $SIZE ($FILES entrées)
sha256   : $SHA

À transmettre au destinataire : le zip et la somme sha256 ci-dessus.
EOF
