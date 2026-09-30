#!/usr/bin/env bash
# usage: run-mut2.sh <label> <relative-src-file> <python-snippet mutating variable s> <vitest -t filter> [test-file]
set -u
REPO=/mnt/data/Codes/offcial/zcode-acp
rel="$2"; FILE="$REPO/$rel"
label="$1"; snippet="$3"; filter="$4"; tfile="${5:-tests/zserver-hardening.test.ts}"
BACKUP="/tmp/mut-work/$(echo "$rel" | tr '/' '_').orig"
cp "$FILE" "$BACKUP"
restore() { cp "$BACKUP" "$FILE"; }
trap restore EXIT
python3 - "$FILE" <<PY
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
before = s
$snippet
if s == before:
    print("NOT APPLIED"); sys.exit(3)
open(p, "w", encoding="utf-8").write(s)
print("APPLIED")
PY
rc=$?
if [ $rc -ne 0 ]; then echo "[$label] mutation not applied (rc=$rc)"; exit 3; fi
cd "$REPO"
out=$(npx vitest run "$tfile" -t "$filter" 2>&1)
vrc=$?
echo "$out" | grep -E "^ +[✓×]|FAIL|Tests |AssertionError|expected|Unhandled" | head -10
if [ $vrc -ne 0 ]; then echo "[$label] => KILLED (vitest exit $vrc)"; else echo "[$label] => SURVIVED"; fi
