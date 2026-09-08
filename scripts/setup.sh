#!/usr/bin/env bash
# Contributor setup for a fresh clone. Idempotent; safe to re-run.
#   scripts/setup.sh            bun install, symlink the skill, print a hint
#   scripts/setup.sh --no-skill skip the ~/.claude/skills/flock symlink step
#   scripts/setup.sh --link     install a dev launcher at the install slot (FLOCK_INSTALL_DIR, else
#                               $FLOCK_HOME/bin, else ~/.flock/bin) so a bare `flock` runs this
#                               checkout's source; a real binary already there is set aside
#   scripts/setup.sh --unlink   remove the launcher and restore the binary it set aside
#
# By default this symlinks ~/.claude/skills/flock -> this checkout's skills/flock, so edits
# to the skill are live everywhere (a contributor's live-editing setup; `flock setup` does the
# equivalent for an installed binary by copying the file instead). An existing real file or
# directory there (e.g. a prod-installed copy) is moved aside to ~/.claude/skills/flock.bak
# first, replacing any older .bak.
#
# This never puts a dev build on PATH by default: run the CLI from source as
# `bun run flock <verb>`. The only global `flock` is the installed binary from
# scripts/install.sh, unless you opt in with --link, which writes a two-line POSIX sh launcher
# over the same install slot the installer uses. Dev then wins over prod everywhere without a
# PATH-ordering game: the installer and auto-update both recognise the marker comment on line 2
# and refuse to overwrite the launcher, and --unlink puts the release binary back.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
NO_SKILL=0
LINK=0
UNLINK=0
for a in "$@"; do
  case "$a" in
    --no-skill) NO_SKILL=1;;
    --link) LINK=1;;
    --unlink) UNLINK=1;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

step "bun"
if ! command -v bun >/dev/null; then
  echo "bun is required: curl -fsSL https://bun.sh/install | bash"; exit 1
fi
bun --version

step "dependencies"
bun install

if [ "$NO_SKILL" = 0 ]; then
  step "claude skill (~/.claude/skills/flock -> $ROOT/skills/flock)"
  mkdir -p "$HOME/.claude/skills"
  DEST="$HOME/.claude/skills/flock"
  if [ -L "$DEST" ] && [ "$(readlink -f "$DEST" 2>/dev/null)" = "$(readlink -f "$ROOT/skills/flock" 2>/dev/null)" ]; then
    echo "already linked to this checkout"
  else
    if [ -e "$DEST" ] || [ -L "$DEST" ]; then
      rm -rf "$HOME/.claude/skills/flock.bak"
      mv "$DEST" "$HOME/.claude/skills/flock.bak"
      echo "moved existing $DEST to $HOME/.claude/skills/flock.bak"
    fi
    ln -sfn "$ROOT/skills/flock" "$DEST"
    ls -l "$DEST"
  fi
fi

INSTALL_DIR="${FLOCK_INSTALL_DIR:-${FLOCK_HOME:-$HOME/.flock}/bin}"
SLOT="$INSTALL_DIR/flock"
BAK="$INSTALL_DIR/flock.bin.bak"

# Line 2 of the launcher is a marker the installer and the auto-updater both look for:
#   # flock-dev-launcher: <absolute checkout path>
# `head -c` first so this never reads a 60 MB binary, and `tr -d` so a NUL byte in one does not
# make the command substitution complain.
launcher_target() { # launcher_target FILE -> the checkout path on stdout, or nothing
  [ -f "$1" ] || return 1
  local line
  line=$(head -c 512 "$1" 2>/dev/null | tr -d '\000' | sed -n '2p') || return 1
  case "$line" in
    "# flock-dev-launcher: "*) printf '%s\n' "${line#\# flock-dev-launcher: }";;
    *) return 1;;
  esac
}

if [ "$LINK" = 1 ]; then
  step "global flock (dev launcher at $SLOT)"
  mkdir -p "$INSTALL_DIR"
  if PREV=$(launcher_target "$SLOT"); then
    if [ "$PREV" = "$ROOT" ]; then
      echo "replacing this checkout's launcher"
    else
      echo "replacing the launcher for $PREV"
    fi
  elif [ -e "$SLOT" ] || [ -L "$SLOT" ]; then
    rm -f "$BAK"
    mv "$SLOT" "$BAK"
    echo "moved the existing $SLOT aside to $BAK"
  fi
  # Written to a temp name in the same directory and moved into place, so a `flock` running from
  # the slot is never a half-written file. No `cd`: the CLI resolves the board from the caller's
  # working directory, so the launcher must leave it alone.
  cat > "$SLOT.new" <<EOF
#!/bin/sh
# flock-dev-launcher: $ROOT
# Written by scripts/setup.sh --link. Runs this checkout's CLI from source — the same thing
# \`bun run flock\` does — in the caller's working directory. scripts/setup.sh --unlink removes it.
exec bun "$ROOT/packages/cli/src/main.ts" "\$@"
EOF
  chmod +x "$SLOT.new"
  mv -f "$SLOT.new" "$SLOT"
  echo "flock -> $ROOT/packages/cli/src/main.ts (via $SLOT)"
  if [ -e "$BAK" ]; then echo "the release binary is parked at $BAK; --unlink restores it"; fi
  case ":${PATH:-}:" in
    *":$INSTALL_DIR:"*) ;;
    *) echo "note: $INSTALL_DIR is not on your PATH — export PATH=\"$INSTALL_DIR:\$PATH\"";;
  esac
elif [ "$UNLINK" = 1 ]; then
  step "global flock (removing the dev launcher at $SLOT)"
  if PREV=$(launcher_target "$SLOT"); then
    rm -f "$SLOT"
    if [ "$PREV" = "$ROOT" ]; then echo "removed this checkout's launcher"; else echo "removed the launcher for $PREV"; fi
    if [ -e "$BAK" ]; then
      mv -f "$BAK" "$SLOT"
      echo "restored the release binary from $BAK"
    fi
  elif [ -e "$SLOT" ] || [ -L "$SLOT" ]; then
    echo "$SLOT is not a dev launcher; left alone"
  else
    echo "no launcher at $SLOT"
    if [ -e "$BAK" ]; then
      mv -f "$BAK" "$SLOT"
      echo "restored the release binary from $BAK"
    fi
  fi
fi

step "global database"
bun run flock boards >/dev/null 2>&1 || true
echo "$HOME/.flock/flock.db"

step "done"
echo "Run flock from source: bun run flock <verb>, e.g. bun run flock up"
