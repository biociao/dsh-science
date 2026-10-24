#!/usr/bin/env bash
# DSH >= 0.2.0-rc.2: install the preset as a declarative profile bundle.
# Usage: bash scripts/install.sh [copy|link]; DSH_PROFILE defaults to web.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/install-preset.mjs" science "${1:-copy}"
