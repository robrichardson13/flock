#!/bin/sh
# flock installer.
#
#   curl -fsSL https://raw.githubusercontent.com/robrichardson13/flock/main/scripts/install.sh | sh
#
# and, once a flock server is hosting the script itself:
#
#   curl -fsSL https://<your-instance>/install.sh | sh
#
# POSIX sh on purpose: Alpine has no bash, and an agent sandbox is often an Alpine container.
#
# Environment:
#   FLOCK_VERSION       tag to install, e.g. v0.2.0. Unset means the latest release.
#   FLOCK_INSTALL_DIR   destination directory. Default $FLOCK_HOME/bin, or $HOME/.flock/bin —
#                       beside the database flock already owns, so it never needs sudo.
#   FLOCK_RELEASE_BASE  base URL the tarball and checksums are fetched from. Default is the
#                       GitHub Releases download URL for FLOCK_VERSION. Overriding it is how the
#                       installer is tested against a local HTTP server, and how a mirror works.
#   FLOCK_NO_SETUP      set to 1 to skip running `flock setup` after a successful install.
#   FLOCK_FORCE         set to 1 to install over a dev checkout's launcher (see below).
#
# Dev wins over prod: `scripts/setup.sh --link` in a checkout writes a small sh launcher at the
# same destination, marked with `# flock-dev-launcher: <checkout>` on line 2. Finding one here
# means a contributor deliberately pointed the global `flock` at their source tree, so this script
# says so and exits 0 rather than overwriting it. `scripts/setup.sh --unlink` in that checkout, or
# FLOCK_FORCE=1 here, installs the release anyway.
#
# Every failure is one line on stderr and a non-zero exit: agents read exit codes.
set -eu

# Repo slug lives in exactly one place; scripts/build-release.ts and .github/workflows/release.yml
# each carry their own copy of the same value — keep all three in sync if it ever changes.
REPO="robrichardson13/flock"
INSTALL_DIR="${FLOCK_INSTALL_DIR:-${FLOCK_HOME:-$HOME/.flock}/bin}"
VERSION="${FLOCK_VERSION:-latest}"

die() { echo "flock: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---- dev launcher --------------------------------------------------------
# Line 2 of the launcher carries the marker. `head -c` so this never reads a whole 60 MB binary,
# and `tr -d` so a NUL byte in one cannot upset the command substitution.
if [ -f "$INSTALL_DIR/flock" ] && [ "${FLOCK_FORCE:-}" != 1 ]; then
  marker=$(head -c 512 "$INSTALL_DIR/flock" 2>/dev/null | tr -d '\000' | sed -n '2p')
  case "$marker" in
    "# flock-dev-launcher: "*)
      checkout=${marker#\# flock-dev-launcher: }
      echo "flock: dev checkout is linked at $checkout; run scripts/setup.sh --unlink to install the release (or FLOCK_FORCE=1)" >&2
      exit 0
      ;;
  esac
fi

# ---- detect target -------------------------------------------------------
# The asset name is a contract shared with scripts/build-release.ts:
#   flock-bun-<os>-<arch>[-musl].tar.gz
os=$(uname -s)
case "$os" in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  *)      die "unsupported OS: $os" ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64|amd64)  arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *)             die "unsupported architecture: $arch" ;;
esac

# libc detection is the fragile part. The cheap reliable test is that ldd mentions musl —
# busybox ldd on Alpine prints "musl libc (…)" and exits non-zero, hence 2>&1 and the `if`.
# The fallback is the musl loader itself. Do not parse /etc/os-release, and do not use getconf.
libc=""
if [ "$os" = linux ]; then
  if ldd --version 2>&1 | grep -qi musl; then
    libc="-musl"
  else
    for f in /lib/ld-musl-*.so.1; do
      if [ -e "$f" ]; then libc="-musl"; fi
      break
    done
  fi
fi

asset="flock-bun-${os}-${arch}${libc}.tar.gz"

if [ -n "${FLOCK_RELEASE_BASE:-}" ]; then
  base="${FLOCK_RELEASE_BASE%/}"
elif [ "$VERSION" = latest ]; then
  # GitHub documents /releases/latest/download/<asset> as the stable "always newest" link — a
  # redirect, not an API call, so it never touches the unauthenticated rate limit.
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/v${VERSION#v}"
fi

# ---- fetch ---------------------------------------------------------------
have curl || have wget || die "need curl or wget to download flock"

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t flock) || die "could not create a temporary directory"
trap 'rm -rf "$tmp"' EXIT INT TERM

# Downloader errors are swallowed so a failure is exactly one line from die(), not two. Some curl
# builds print their own "curl: (22) …" even under -s, which is noise an agent has to parse past.
# curl -L follows the releases/latest redirect; wget follows redirects by default.
fetch() { # fetch URL DEST
  if have curl; then curl -fsSL "$1" -o "$2" 2>/dev/null
  else wget -qO "$2" "$1" 2>/dev/null; fi
}

echo "flock: downloading $asset ($VERSION)" >&2
fetch "$base/$asset" "$tmp/$asset" \
  || die "could not download $base/$asset — see https://github.com/$REPO/releases"

# ---- verify --------------------------------------------------------------
# The release publishes a combined SHA256SUMS and a per-asset <asset>.sha256; either will do, and
# a local build-release output has only the latter. A minimal image with no hashing tool says so
# plainly rather than failing: refusing to install there would be worse than installing unverified.
sum=""
if have sha256sum; then sum="sha256sum"
elif have shasum; then sum="shasum -a 256"
fi

if [ -n "$sum" ]; then
  want=""
  if fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null; then
    want=$(grep " \*\{0,1\}$asset\$" "$tmp/SHA256SUMS" | awk '{print $1}' | head -n1)
  fi
  if [ -z "$want" ] && fetch "$base/$asset.sha256" "$tmp/$asset.sha256" 2>/dev/null; then
    want=$(awk '{print $1}' "$tmp/$asset.sha256" | head -n1)
  fi
  if [ -n "$want" ]; then
    got=$($sum "$tmp/$asset" | awk '{print $1}')
    [ "$want" = "$got" ] || die "checksum mismatch for $asset (expected $want, got $got)"
  else
    echo "flock: no published checksum for $asset, skipping verification" >&2
  fi
else
  echo "flock: no sha256sum or shasum on this system, skipping verification" >&2
fi

# ---- install -------------------------------------------------------------
tar -xzf "$tmp/$asset" -C "$tmp" || die "could not extract $asset"

bin=$(find "$tmp" -maxdepth 1 -type f -name 'flock-bun-*' ! -name '*.tar.gz' ! -name '*.sha256' | head -n1)
[ -n "$bin" ] || die "archive $asset did not contain a flock binary"

mkdir -p "$INSTALL_DIR" || die "could not create $INSTALL_DIR"
chmod +x "$bin"
# Move onto the final name via a temp name in the same directory, so an upgrade that replaces a
# running binary is atomic rather than a half-written file.
mv -f "$bin" "$INSTALL_DIR/flock.new" || die "could not write to $INSTALL_DIR"
mv -f "$INSTALL_DIR/flock.new" "$INSTALL_DIR/flock" || die "could not install to $INSTALL_DIR/flock"

# Smoke-test what was just installed rather than trusting the copy. The failure this catches for
# real is Alpine: a bun musl binary needs libstdc++/libgcc at runtime and dies with a wall of
# "Error relocating … symbol not found" without them. Reporting that here beats letting the agent's
# next command exit 127 with no explanation.
if ! ver=$("$INSTALL_DIR/flock" --version 2>&1); then
  echo "flock: installed $INSTALL_DIR/flock but it will not run:" >&2
  echo "$ver" | head -n 3 | sed 's/^/  /' >&2
  if [ -n "$libc" ]; then
    echo "  a musl build of flock needs libstdc++ — on Alpine: apk add --no-cache libstdc++" >&2
  fi
  exit 1
fi

# The absolute path, always, on stdout. A piped installer cannot change the caller's PATH, so this
# line is what lets a sandboxed agent run flock immediately instead of making a second round trip.
echo "flock: installed $ver to $INSTALL_DIR/flock"

# ---- PATH advice -----------------------------------------------------------
# `flock setup` (below) now owns PATH: it edits the rc file itself and prints its own fallback
# advice when it can't. Printing this script's own advice too would say "add this by hand" and
# "it was added for you" six lines apart. Print it here only when setup is being skipped, so the
# FLOCK_NO_SETUP=1 path — the one case where nothing else will ever say anything — still does.
if [ "${FLOCK_NO_SETUP:-}" = 1 ]; then
  on_path=1
  case ":${PATH:-}:" in
    *":$INSTALL_DIR:"*) on_path=0 ;;
  esac

  if [ "$on_path" -ne 0 ]; then
    # ${SHELL:-} matters: a container shell often has SHELL unset, and `set -u` would abort here —
    # after a successful install, which is the worst possible place to fall over.
    shell_name="${SHELL:-}"
    shell_name="${shell_name##*/}"
    # macOS Terminal starts bash as a *login* shell, which reads ~/.bash_profile and never
    # ~/.bashrc — pointing a mac user at .bashrc is advice that silently does nothing.
    rc=""
    case "$shell_name" in
      zsh)  rc="$HOME/.zshrc" ;;
      bash) if [ "$os" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
      fish) rc="$HOME/.config/fish/config.fish" ;;
    esac

    echo "flock: $INSTALL_DIR is not on your PATH." >&2
    if [ "$shell_name" = fish ]; then
      echo "  fish_add_path $INSTALL_DIR" >&2
    else
      echo "  export PATH=\"$INSTALL_DIR:\$PATH\"" >&2
    fi
    if [ -n "$rc" ]; then
      echo "  (add that to $rc)" >&2
    fi
    echo "  or run it directly: $INSTALL_DIR/flock" >&2
  fi
fi

# ---- setup -----------------------------------------------------------------
# One command installs everything, not just a binary: writes the Claude Code skill, repairs PATH
# (or prints the fallback advice above when it can't), and starts the daemon. Skippable for a
# fake-release test or a scripted install that wants to defer it.
if [ "${FLOCK_NO_SETUP:-}" != 1 ]; then
  "$INSTALL_DIR/flock" setup
fi
