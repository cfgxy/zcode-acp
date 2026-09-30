#!/bin/bash
# For each survivor mutant: run ONLY the killer file and report which killer tests go RED.
cd /tmp/audit-mut-7a5b47d170e6
for m in "$@"; do
  node tools/run-mutant.mjs "$m" --tag "-KILLER" --tests "tests/zserver-mutation-killers.test.ts" 2>&1 | sed -e 's/leaked=.*md5=/md5=/' | cut -c1-230
done
