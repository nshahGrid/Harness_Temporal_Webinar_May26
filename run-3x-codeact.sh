#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
OUT_DIR="artifacts/harness-runs/systematic-3x-$(date +%Y%m%d)"
mkdir -p "$OUT_DIR"

echo "Running 3 CodeAct harness tests to check scaffold validation consistency"
echo "Output directory: $OUT_DIR"
echo ""

for i in 1 2 3; do
  RUN_ID="codeact-systematic-$i"
  RUN_DIR="$OUT_DIR/$RUN_ID"
  mkdir -p "$RUN_DIR"
  echo "=== Run $i/3 starting at $(date) ==="
  npx tsx src/cli/harness-demo.ts \
    --agent codeact \
    --run-id "$RUN_ID" \
    --out "$RUN_DIR" \
    --json > "$RUN_DIR/result.json" 2>&1
  EXIT_CODE=$?
  echo "=== Run $i/3 finished at $(date), exit=$EXIT_CODE ==="
  echo ""
done

echo "All 3 runs complete. Results in $OUT_DIR"
echo ""

# Quick summary: check each run for scaffold fallback usage
echo "=== Quick scaffold validation summary ==="
for i in 1 2 3; do
  RUN_DIR="$OUT_DIR/codeact-systematic-$i"
  if [ -f "$RUN_DIR/result.json" ]; then
    FALLBACK=$(grep -c "scaffold_generation_fallback\|scaffold_source=fallback" "$RUN_DIR/result.json" 2>/dev/null || true)
    REPAIR_SUCCESS=$(grep -c "scaffold_repair_success" "$RUN_DIR/result.json" 2>/dev/null || true)
    REJECTED=$(grep -c "llm_output_rejected" "$RUN_DIR/result.json" 2>/dev/null || true)
    if [ "$FALLBACK" -gt 0 ]; then
      echo "Run $i: FALLBACK used (Pi scaffold failed validation, $REJECTED rejection(s))"
    elif [ "$REPAIR_SUCCESS" -gt 0 ]; then
      echo "Run $i: REPAIR succeeded (Pi scaffold failed initially, fixed on repair)"
    else
      echo "Run $i: FIRST ATTEMPT passed (Pi scaffold valid on first try)"
    fi
  else
    echo "Run $i: NO RESULT FILE"
  fi
done
