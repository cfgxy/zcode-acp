#!/usr/bin/env python3
"""Patch the zcode CLI bundle so the TUI /model list renders readable entries.

zcode 0.16.9 defect: formatModelList (BXa) renders `${s.id}`/`${s.alias}`/`${s.name}`,
but app.listModels() returns registry-shaped entries `{ref: {providerId, modelId},
label, providerLabel, ...}` — `s.id` is always undefined and every list line prints
"undefined". This patch adds a ref-aware fallback for the id and falls back to
`label` for the display name.

Re-apply after every zcode desktop/CLI update (the update rewrites the bundle).
The original bundle is backed up next to the target on first patch.
"""

from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

TARGET = Path.home() / ".zcode/server/agents/glm/zcode.cjs"

OLD = (
    'let o=t.map(s=>{let a=s.alias?`${s.alias}: `:"",'
    "l=s.name&&s.name!==s.id?` (${s.name})`:\"\";"
    'return`- ${a}${s.id}${l}`})'
)
NEW = (
    "let o=t.map(s=>{let d=s.id??(s.ref?`${s.ref.providerId}/${s.ref.modelId}`:void 0),"
    'a=s.alias?`${s.alias}: `:"",'
    "l=s.name&&s.name!==d?` (${s.name})`:s.label&&s.label!==d?` (${s.label})`:\"\";"
    'return`- ${a}${d}${l}`})'
)


def main() -> int:
    if not TARGET.exists():
        print(f"target not found: {TARGET}", file=sys.stderr)
        return 1
    src = TARGET.read_text(encoding="utf-8")
    if NEW in src:
        print("already patched — nothing to do")
        return 0
    if src.count(OLD) != 1:
        print(f"patch site not found (occurrences={src.count(OLD)}) — bundle layout changed, "
              "re-derive the patch from formatModelList (search 'No selectable models are configured.')",
              file=sys.stderr)
        return 1
    backup = TARGET.with_suffix(".cjs.bak-modellist-" + time.strftime("%Y%m%d-%H%M%S"))
    shutil.copy2(TARGET, backup)
    TARGET.write_text(src.replace(OLD, NEW), encoding="utf-8")
    print(f"patched {TARGET}")
    print(f"backup: {backup}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
