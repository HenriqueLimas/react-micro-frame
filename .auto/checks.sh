#!/bin/bash
set -euo pipefail
npm run check >/tmp/react-micro-frame-autoresearch-check.log 2>&1 || {
  tail -80 /tmp/react-micro-frame-autoresearch-check.log
  exit 1
}
npm run format:check >/tmp/react-micro-frame-autoresearch-format.log 2>&1 || {
  tail -80 /tmp/react-micro-frame-autoresearch-format.log
  exit 1
}
