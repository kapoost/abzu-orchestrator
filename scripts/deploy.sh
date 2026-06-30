#!/usr/bin/env bash
# Deploys abzu-governance + abzu-orchestrator + abzu-gui to Fly.io (org: personal).
# Idempotent: safe to re-run. Existing apps are updated; new ones are created.
#
# Secrets never enter argv (piped via stdin to `fly secrets import`).
# Governance token is generated fresh on first run and persisted to
# agents/governance/.gov-token (gitignored).
#
# Required:
#   - fly CLI logged in (`fly auth whoami`)
#   - openssl
#   - agents/seller/.env.local with ADCP_AUTH_TOKEN (so Abzu can auth to purrsonality-seller)

set -euo pipefail

AGENTS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELLER_ENV="${AGENTS_ROOT}/seller/.env.local"
GOV_TOKEN_PATH="${AGENTS_ROOT}/governance/.gov-token"

GOV_APP="abzu-governance"
ABZU_APP="abzu-orchestrator"
GUI_APP="abzu-gui"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
step()   { echo; printf '\033[1;34m=== %s ===\033[0m\n' "$*"; }

require() { command -v "$1" >/dev/null 2>&1 || { red "✗ missing $1"; exit 1; }; }
require fly
require openssl

# --- Preflight --------------------------------------------------------------

step "preflight"
fly auth whoami >/dev/null || { red "✗ not logged in (run: fly auth login)"; exit 1; }
green "  fly: $(fly auth whoami)"

if [ ! -f "$SELLER_ENV" ]; then
  red "✗ Missing $SELLER_ENV"
  echo "  Need ADCP_AUTH_TOKEN (the bearer token purrsonality-seller accepts)."
  exit 1
fi
SELLER_TOKEN=$(grep '^ADCP_AUTH_TOKEN=' "$SELLER_ENV" | head -1 | cut -d= -f2-)
if [ -z "$SELLER_TOKEN" ]; then
  red "✗ ADCP_AUTH_TOKEN not found in $SELLER_ENV"
  exit 1
fi
green "  seller token: loaded ($(echo -n "$SELLER_TOKEN" | wc -c | tr -d ' ') chars)"

# Governance token: reuse existing or generate fresh.
if [ -s "$GOV_TOKEN_PATH" ]; then
  GOV_TOKEN=$(cat "$GOV_TOKEN_PATH")
  green "  gov token:    reused from $GOV_TOKEN_PATH"
else
  GOV_TOKEN=$(openssl rand -hex 32)
  umask 077
  printf '%s\n' "$GOV_TOKEN" > "$GOV_TOKEN_PATH"
  green "  gov token:    generated ($(wc -c < "$GOV_TOKEN_PATH" | tr -d ' ') bytes) → $GOV_TOKEN_PATH"
fi

# --- Helpers ----------------------------------------------------------------

create_app_if_missing() {
  local name=$1
  if fly status --app "$name" >/dev/null 2>&1; then
    yellow "  app $name already exists, skipping create"
  else
    echo "  creating app $name"
    fly apps create "$name" --org personal
  fi
}

set_secrets() {
  local app=$1
  shift
  printf '%s\n' "$@" | fly secrets import --app "$app" --stage
}

# --- 1) governance ----------------------------------------------------------

step "1/3 governance — ${GOV_APP}.fly.dev"
create_app_if_missing "$GOV_APP"
set_secrets "$GOV_APP" \
  "ADCP_AUTH_TOKEN=${GOV_TOKEN}"
(cd "${AGENTS_ROOT}/governance" && fly deploy --app "$GOV_APP" --remote-only --yes)

# --- 2) abzu ----------------------------------------------------------------

step "2/3 abzu — ${ABZU_APP}.fly.dev"
create_app_if_missing "$ABZU_APP"
set_secrets "$ABZU_APP" \
  "SELLER_PURRSONALITY_SELLER_AUTH_TOKEN=${SELLER_TOKEN}" \
  "GOVERNANCE_AUTH_TOKEN=${GOV_TOKEN}"
(cd "${AGENTS_ROOT}/abzu" && fly deploy --app "$ABZU_APP" --remote-only --yes)

# --- 3) gui -----------------------------------------------------------------

step "3/3 gui — ${GUI_APP}.fly.dev"
create_app_if_missing "$GUI_APP"
(cd "${AGENTS_ROOT}/abzu-gui" && fly deploy --app "$GUI_APP" --remote-only --yes)

# --- summary ----------------------------------------------------------------

step "done"
green "  governance:   https://${GOV_APP}.fly.dev"
green "  abzu:         https://${ABZU_APP}.fly.dev"
green "  gui:          https://${GUI_APP}.fly.dev"
echo
echo "Probes:"
echo "  curl https://${ABZU_APP}.fly.dev/healthz"
echo "  curl https://${ABZU_APP}.fly.dev/discovery/agents"
echo "  open https://${GUI_APP}.fly.dev/?role=sam"
echo
echo "Governance bearer token is at: $GOV_TOKEN_PATH (chmod 600, gitignored)"
echo "Needed to call MCP tools on https://${GOV_APP}.fly.dev/mcp directly."
