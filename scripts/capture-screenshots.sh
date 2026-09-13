#!/usr/bin/env bash
# capture-screenshots.sh — regenerates docs/screenshots/ and the README's Screenshots
# section from a live dev server, driven by playwright-cli.
#
# Usage:
#   DATA_DIR=./data-screenshots FORTNYT_TODAY=2026-09-13 npm run demo:seed   # once, if data-screenshots/ is missing
#   DATA_DIR=./data-screenshots FORTNYT_TODAY=2026-09-13 npm run dev &        # start the app against it
#   npm run screenshots
#
# FORTNYT_TODAY pins "today" so the headline numbers, calendar grid, and pay-period
# label are reproducible run to run instead of drifting with the real date.
#
# Requires: playwright-cli on PATH (falls back to `npx playwright-cli`).

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:5173}"
OUT_ROOT="docs/screenshots"
DESKTOP_W=1280; DESKTOP_H=800
PHONE_W=390;    PHONE_H=844

PW() { playwright-cli "$@" 2>/dev/null || npx playwright-cli "$@"; }

cleanup() { PW close-all >/dev/null 2>&1 || true; }
trap cleanup EXIT

wait_for_server() {
  echo "waiting for $BASE_URL ..."
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "$BASE_URL" && { echo "up"; return; }
    sleep 1
  done
  echo "server never came up at $BASE_URL" >&2
  exit 1
}

open_actor() {
  local session="$1" width="$2" height="$3"
  PW -s="$session" open "$BASE_URL" --no-persistent
  PW -s="$session" resize "$width" "$height"
  PW -s="$session" run-code "async page => { await page.emulateMedia({ reducedMotion: 'reduce' }); }"
}

goto_view() {
  local session="$1" hash="$2"
  PW -s="$session" run-code "async page => {
    await page.evaluate((h) => { window.location.hash = h; }, '$hash');
    await page.waitForSelector('.view-head', { timeout: 15000 });
    await page.waitForLoadState('networkidle');
  }"
}

shot() {
  local session="$1" name="$2" extra="${3:-}"
  mkdir -p "$OUT_ROOT"
  PW -s="$session" screenshot --filename="$OUT_ROOT/$name.png" $extra
  echo "captured $name"
}

wait_for_server

rm -f "$OUT_ROOT"/*.png

# ─── Desktop pass: every top-level view, populated with demo household data ─
open_actor desktop "$DESKTOP_W" "$DESKTOP_H"

goto_view desktop "/period"
shot desktop "period"

goto_view desktop "/calendar?view=month"
shot desktop "calendar"

goto_view desktop "/ledger"
shot desktop "ledger"

goto_view desktop "/dial"
shot desktop "dial"

goto_view desktop "/sankey"
shot desktop "sankey"

goto_view desktop "/reserves"
shot desktop "reserves"

goto_view desktop "/budget"
shot desktop "budget"

goto_view desktop "/setup"
shot desktop "setup"

# ─── Phone pass: the headline "this period" view, to show the mobile layout ─
open_actor phone "$PHONE_W" "$PHONE_H"
goto_view phone "/period"
shot phone "period-mobile"

echo "all done — see $OUT_ROOT"
