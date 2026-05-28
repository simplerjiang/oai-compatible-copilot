"""
One-shot rename helper for OAICopilot -> OAICopilot-Kong fork.

Reads files under src/ and assets/, applies a precise list of pattern
replacements, and reports per-file change counts. Intended to be run once
from the extension directory:

    python _kong_rename_20260527.py [--apply]

Without --apply it runs in dry-run mode and only prints planned changes.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TARGET_DIRS = [ROOT / "src", ROOT / "assets"]
EXTS = {".ts", ".js", ".html", ".css", ".json", ".md"}

# Each entry: (description, regex, replacement). Order matters: more specific first.
RULES: list[tuple[str, str, str]] = [
    # Stateful marker MIME -> application/vnd.oaicopilot-kong.*
    ("mime stateful-marker",
     r"application/vnd\.oaicopilot\.",
     "application/vnd.oaicopilot-kong."),

    # Extension id used by versionManager.ts
    ("ext id johnny-zhao.oai-compatible-copilot",
     r"johnny-zhao\.oai-compatible-copilot(?!-kong)",
     "kong-fork.oai-compatible-copilot-kong"),

    # Log directory ~/.copilot/oaicopilot/ -> ~/.copilot/oaicopilot-kong/
    (r'"oaicopilot" log dir literal',
     r'"oaicopilot"(?=,\s*"logs")',
     '"oaicopilot-kong"'),

    # Log filename template `oaicopilot-${dateStr}.log` -> `oaicopilot-kong-${dateStr}.log`
    ("log filename template",
     r"oaicopilot-\$\{dateStr\}\.log",
     "oaicopilot-kong-${dateStr}.log"),

    # Log filename regex /^oaicopilot-(\d{4})...$/
    ("log filename regex literal",
     r"\^oaicopilot-",
     "^oaicopilot-kong-"),
    ("log filename comment",
     r"oaicopilot-YYYYMMDD\.log",
     "oaicopilot-kong-YYYYMMDD.log"),

    # prompt_cache_key prefix `oaicopilot-${parsedModelId.baseId}`
    ("prompt_cache_key prefix",
     r"`oaicopilot-\$\{parsedModelId",
     "`oaicopilot-kong-${parsedModelId"),

    # Config view export filename oaicopilot-config-...
    ("export filename",
     r"oaicopilot-config-",
     "oaicopilot-kong-config-"),

    # Configuration keys / command IDs / context keys / secret keys:
    # `"oaicopilot.<word>"` or template literals starting with oaicopilot.
    # Only match when followed by an identifier char (avoids matching the
    # bare word `oaicopilot` used as a vendor id, log dir literal etc.).
    ('"oaicopilot.<key>" double-quoted',
     r'"oaicopilot\.(?=[A-Za-z_])',
     '"oaicopilot-kong.'),
    ("'oaicopilot.<key>' single-quoted",
     r"'oaicopilot\.(?=[A-Za-z_])",
     "'oaicopilot-kong."),
    ("`oaicopilot.<key>` backticked",
     r"`oaicopilot\.(?=[A-Za-z_$])",
     "`oaicopilot-kong."),

    # Bracket-style code paths e.g. config["oaicopilot.xxx"] caught above.

    # Vendor id used by registerLanguageModelChatProvider — bare "oaicopilot"
    # (no dot, no hyphen), only in the registration call argument.
    ('registerLanguageModelChatProvider vendor id',
     r'(registerLanguageModelChatProvider\(\s*)"oaicopilot"',
     r'\1"oaicopilot-kong"'),

    # Console.error tag `[oaicopilot] ...` keep oaicopilot but add -kong.
    (r"console tag [oaicopilot]",
     r"\[oaicopilot\]",
     "[oaicopilot-kong]"),
    (r"console tag [OAICopilot Logger]",
     r"\[OAICopilot Logger\]",
     "[OAICopilot-Kong Logger]"),

    # EXTENSION_LABEL display string
    (r'EXTENSION_LABEL "OAICopilot"',
     r'(const\s+EXTENSION_LABEL\s*=\s*)"OAICopilot"',
     r'\1"OAICopilot-Kong"'),

    # Webview panel title / id used in configView.ts
    (r'webview id oaicopilot.config',
     r'"oaicopilot\.config"',
     '"oaicopilot-kong.config"'),
    (r'webview title OAICopilot Configuration',
     r'"OAICopilot Configuration"',
     '"OAICopilot-Kong Configuration"'),
    (r'export panel title',
     r'"Export OAICopilot Configuration"',
     '"Export OAICopilot-Kong Configuration"'),
    (r'import panel title',
     r'"Import OAICopilot Configuration"',
     '"Import OAICopilot-Kong Configuration"'),
    (r'test detail OAICopilot suffix',
     r'\(OAICopilot\)',
     '(OAICopilot-Kong)'),

    # User-Agent / clientInfo
    (r"User-Agent string",
     r"`oai-compatible-copilot/\$\{this\.getVersion\(\)\}",
     "`oaicopilot-kong/${this.getVersion()}"),
    (r'clientInfo name',
     r'name: "oai-compatible-copilot"',
     'name: "oai-compatible-copilot-kong"'),
]


def should_rename_file(path: Path) -> bool:
    return path.suffix in EXTS and path.is_file()


def apply_rules(text: str) -> tuple[str, list[tuple[str, int]]]:
    counts: list[tuple[str, int]] = []
    new = text
    for desc, pattern, repl in RULES:
        new2, n = re.subn(pattern, repl, new)
        if n:
            counts.append((desc, n))
            new = new2
    return new, counts


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    grand_total = 0
    for base in TARGET_DIRS:
        if not base.exists():
            continue
        for p in base.rglob("*"):
            if not should_rename_file(p):
                continue
            try:
                original = p.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            new, counts = apply_rules(original)
            if not counts:
                continue
            total = sum(n for _, n in counts)
            grand_total += total
            rel = p.relative_to(ROOT)
            details = ", ".join(f"{d}={n}" for d, n in counts)
            print(f"{'APPLY' if args.apply else 'DRY  '} {rel}: {total} ({details})")
            if args.apply:
                p.write_text(new, encoding="utf-8")
    print(f"-- {grand_total} replacements {'applied' if args.apply else 'planned'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
