#!/usr/bin/env bash

set -euo pipefail

PACKAGE_NAME="@originrouter/cli"
RELEASE="${ORIGINROUTER_RELEASE:-latest}"
DRY_RUN=false
SETUP_ARGS=()
LOCK_DIR="${HOME}/.originrouter/install.lock.d"

usage() {
  cat <<'EOF'
Usage: install.sh [--release VERSION] [--yes] [--no-proxy] [--dry-run]

Installs OriginRouter CLI from npm, then completes first-run setup and
installation verification. Node.js 22 or later and npm are required.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      [[ $# -ge 2 ]] || { echo "--release requires a value." >&2; exit 1; }
      RELEASE="$2"
      shift
      ;;
    --yes|--no-proxy|--noproxy)
      SETUP_ARGS+=("$1")
      ;;
    --dry-run)
      DRY_RUN=true
      SETUP_ARGS+=("--dry-run")
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [[ ! "$RELEASE" =~ ^(latest|[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$ ]]; then
  echo "Invalid release: $RELEASE. Expected latest or a semantic version." >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 && -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  echo "Do not run the OriginRouter installer with sudo." >&2
  echo "Run the same installation command as your normal user." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "OriginRouter requires Node.js 22 or later (the Node.js installer includes npm)." >&2
  echo "Install Node.js from https://nodejs.org/en/download and run this command again." >&2
  exit 1
fi

NODE_VERSION="$(node --version 2>/dev/null || true)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ || "$NODE_MAJOR" -lt 22 ]]; then
  echo "OriginRouter requires Node.js 22 or later; detected ${NODE_VERSION:-an unknown version}." >&2
  echo "Update Node.js from https://nodejs.org/en/download and run this command again." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1 || ! npm --version >/dev/null 2>&1; then
  echo "npm is required but is not available." >&2
  echo "Install the current Node.js release from https://nodejs.org/en/download and run this command again." >&2
  exit 1
fi

mkdir -p "$(dirname "$LOCK_DIR")"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "Another OriginRouter installation is running (PID $LOCK_PID)." >&2
    exit 1
  fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR"
fi
echo "$$" >"$LOCK_DIR/pid"
cleanup() { rm -rf "$LOCK_DIR"; }
trap cleanup EXIT INT TERM

EXISTING_COMMAND="$(command -v originrouter 2>/dev/null || true)"
NPM_PREFIX="$(npm prefix --global 2>/dev/null || true)"
EXPECTED_COMMAND="${NPM_PREFIX:+$NPM_PREFIX/bin/originrouter}"
GLOBAL_PACKAGE_ROOT="$(npm root --global 2>/dev/null || true)/@originrouter/cli"
if [[ -L "$GLOBAL_PACKAGE_ROOT" ]]; then
  echo "A repository-linked OriginRouter installation was found at $GLOBAL_PACKAGE_ROOT." >&2
  echo "Run npm unlink --global @originrouter/cli before using the official installer." >&2
  exit 1
fi
if [[ -n "$EXISTING_COMMAND" && ( -z "$EXPECTED_COMMAND" || "$EXISTING_COMMAND" != "$EXPECTED_COMMAND" ) ]]; then
  echo "An OriginRouter command outside the active npm global directory was found:" >&2
  echo "  $EXISTING_COMMAND" >&2
  echo "Resolve the PATH or installation conflict before continuing." >&2
  exit 1
fi
if [[ -n "$EXISTING_COMMAND" ]] && ! npm list --global --depth=0 "$PACKAGE_NAME" >/dev/null 2>&1; then
  echo "An OriginRouter command managed outside the global npm installation was found:" >&2
  echo "  $EXISTING_COMMAND" >&2
  echo "Remove the conflicting repository link or installation before continuing." >&2
  exit 1
fi

PACKAGE_SPEC="${PACKAGE_NAME}@${RELEASE}"
echo "==> Node.js $NODE_VERSION"
echo "==> Installing $PACKAGE_SPEC from npm"
if [[ "$DRY_RUN" == true ]]; then
  echo "Would run: npm install --global $PACKAGE_SPEC"
  if [[ -n "$EXISTING_COMMAND" ]]; then
    "$EXISTING_COMMAND" setup "${SETUP_ARGS[@]}"
  else
    echo "Would run: originrouter setup --dry-run"
  fi
  exit 0
fi

if ! npm install --global "$PACKAGE_SPEC"; then
  echo "OriginRouter CLI installation failed." >&2
  echo "Verify that the npm global directory is writable and that the npm registry is reachable." >&2
  echo "The installer does not use sudo or change npm permissions automatically." >&2
  exit 1
fi

hash -r
CLI="$(command -v originrouter 2>/dev/null || true)"
if [[ -z "$CLI" ]]; then
  [[ -n "$NPM_PREFIX" && -x "$NPM_PREFIX/bin/originrouter" ]] && CLI="$NPM_PREFIX/bin/originrouter"
fi
if [[ -z "$CLI" || ! -x "$CLI" ]]; then
  echo "OriginRouter was installed, but the command could not be found on PATH." >&2
  echo "Add the npm global bin directory to PATH, open a new terminal, and run this installer again." >&2
  exit 1
fi

"$CLI" --version
echo "==> Preparing the OriginRouter runtime"
if [[ -r /dev/tty ]]; then
  "$CLI" setup "${SETUP_ARGS[@]}" </dev/tty
elif [[ " ${SETUP_ARGS[*]} " == *" --yes "* ]]; then
  "$CLI" setup "${SETUP_ARGS[@]}"
else
  echo "Interactive setup requires a terminal. Re-run from a terminal or pass --yes." >&2
  exit 1
fi

echo "==> OriginRouter installation complete"
