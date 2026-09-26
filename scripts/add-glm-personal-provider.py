#!/usr/bin/env python3
"""(Re-)add the GLM Coding Plan personal provider to provider_config.json.

The desktop app provisions this file on every sync/update and silently drops
manually-added entries — after a zcode update, if `/model GLM-…` fails with
"Provider Registry 中不存在 Model" (or the REPL footer shows a non-GLM model),
re-run this script.

The entry registers the personal coding plan (same apiKey as config.json's
builtin provider → same billing) as a backend-registry personal provider with
anthropic-messages @ open.bigmodel.cn. Idempotent: skips when a GLM entry
already exists. Backs up the file before writing.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import time
import uuid
from pathlib import Path

HOME = Path.home()
PROVIDER_CONFIG = HOME / ".zcode/v2/provider_config.json"
ZCODE_CONFIG = HOME / ".zcode/v2/config.json"

MODELS = ["GLM-5.3-Flash", "GLM-5.3"]
BASE_URL = "https://open.bigmodel.cn/api/anthropic"


def plan_api_key() -> str:
    cfg = json.loads(ZCODE_CONFIG.read_text())
    for p in cfg.get("provider", {}).values():
        opts = p.get("options") or {}
        if p.get("enabled") and "bigmodel" in opts.get("baseURL", ""):
            key = opts.get("apiKey")
            if key:
                return key
    raise SystemExit("no enabled bigmodel provider with apiKey in ~/.zcode/v2/config.json")


def main() -> int:
    data = json.loads(PROVIDER_CONFIG.read_text())
    rules = data["config"]["providerConfigRules"]["providerRules"]

    existing = [
        r for r in rules
        if any(m.lower().startswith("glm-") for m in (r.get("config", {}).get("personalModelIds") or []))
    ]
    if existing:
        print(f"GLM personal provider already present: {existing[0].get('providerId')} — nothing to do")
        return 0

    pid = str(uuid.uuid4())
    rules.append({
        "providerId": pid,
        "providerName": "GLM Coding Plan (personal)",
        "config": {
            "group": "standard-personal",
            "access": {"type": "api-key", "apiKey": plan_api_key()},
            "api": {"type": "anthropic-messages", "baseUrl": BASE_URL},
            "personalModelIds": MODELS,
            "modelOrder": MODELS,
        },
    })
    model_rules = data["config"]["modelConfigRules"].setdefault("providerModelRules", [])
    have = {(r.get("providerId"), r.get("modelId")) for r in model_rules}
    for m in MODELS:
        if (pid, m) not in have:
            model_rules.append({
                "modelId": m,
                "config": {"properties": {"contextWindow": 200000}},
                "providerId": pid,
            })

    backup = PROVIDER_CONFIG.with_suffix(".json.bak-" + time.strftime("%Y%m%d-%H%M%S"))
    shutil.copy2(PROVIDER_CONFIG, backup)
    tmp = str(PROVIDER_CONFIG) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.chmod(tmp, 0o600)
    os.replace(tmp, PROVIDER_CONFIG)
    print(f"added GLM personal provider: {pid}")
    print(f"backup: {backup}")
    print("next: restart zcode-acp (or the editor bridge), then /model GLM-5.3-Flash")
    return 0


if __name__ == "__main__":
    sys.exit(main())
