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

NODE_MIN_MAJOR=22
NODESOURCE_MAJOR=22

# Privilege helper: on a root session run directly; otherwise require sudo.
priv_prefix() {
  if [[ "$(id -u)" -eq 0 ]]; then
    echo ""
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    echo "sudo"
  else
    return 1
  fi
}

install_node_via_nvm() {
  echo "==> Installing Node.js ${NODE_MIN_MAJOR} via nvm (installs to your home directory, no sudo required)"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash || return 1
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" || return 1
  nvm install "${NODE_MIN_MAJOR}" || return 1
  nvm use "${NODE_MIN_MAJOR}" || return 1
}

install_node_runtime() {
  local pkg_manager=""
  if command -v apt-get >/dev/null 2>&1; then
    pkg_manager="apt"
  elif command -v dnf >/dev/null 2>&1; then
    pkg_manager="dnf"
  elif command -v yum >/dev/null 2>&1; then
    pkg_manager="yum"
  elif command -v apk >/dev/null 2>&1; then
    pkg_manager="apk"
  fi

  case "$pkg_manager" in
    apt|dnf|yum|apk)
      if prefix="$(priv_prefix)"; then
        case "$pkg_manager" in
          apt)
            echo "==> Installing Node.js ${NODESOURCE_MAJOR} LTS from NodeSource (system-wide)"
            curl -fsSL "https://deb.nodesource.com/setup_${NODESOURCE_MAJOR}.x" | bash - || return 1
            $prefix apt-get install -y nodejs || return 1
            ;;
          dnf|yum)
            echo "==> Installing Node.js ${NODESOURCE_MAJOR} LTS from NodeSource (system-wide)"
            curl -fsSL "https://rpm.nodesource.com/setup_${NODESOURCE_MAJOR}.x" | bash - || return 1
            $prefix "$pkg_manager" install -y nodejs || return 1
            ;;
          apk)
            echo "==> Installing Node.js via apk (system-wide)"
            $prefix apk add --no-cache nodejs npm || return 1
            ;;
        esac
        return 0
      fi
      echo "==> No root privileges available; falling back to nvm (user directory)."
      install_node_via_nvm
      ;;
    *)
      install_node_via_nvm || {
        echo "Could not install Node.js automatically on this system." >&2
        echo "Install Node.js ${NODE_MIN_MAJOR} or later from https://nodejs.org/en/download, then run this command again." >&2
        return 1
      }
      ;;
  esac
}

ensure_node_runtime() {
  if command -v node >/dev/null 2>&1; then
    NODE_VERSION="$(node --version 2>/dev/null || true)"
    NODE_MAJOR="${NODE_VERSION#v}"
    NODE_MAJOR="${NODE_MAJOR%%.*}"
    if [[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge "$NODE_MIN_MAJOR" ]] \
      && command -v npm >/dev/null 2>&1 && npm --version >/dev/null 2>&1; then
      return 0
    fi
    echo "==> Node.js ${NODE_MIN_MAJOR}+ with npm is required; detected ${NODE_VERSION:-no usable installation}." >&2
  else
    echo "==> Node.js was not found on this system." >&2
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to install Node.js automatically. Install curl and Node.js ${NODE_MIN_MAJOR}+, then run this command again." >&2
    return 1
  fi

  install_node_runtime || {
    echo "Automatic Node.js installation failed. Install Node.js ${NODE_MIN_MAJOR}+ manually from https://nodejs.org/en/download and run this command again." >&2
    return 1
  }
  hash -r

  NODE_VERSION="$(node --version 2>/dev/null || true)"
  NODE_MAJOR="${NODE_VERSION#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ || "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ]] \
    || ! command -v npm >/dev/null 2>&1 || ! npm --version >/dev/null 2>&1; then
    echo "Node.js installation did not produce a usable Node.js ${NODE_MIN_MAJOR}+ with npm." >&2
    echo "Install Node.js manually from https://nodejs.org/en/download and run this command again." >&2
    return 1
  fi
}

if ! ensure_node_runtime; then
  exit 1
fi

NODE_VERSION="$(node --version 2>/dev/null || true)"

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
