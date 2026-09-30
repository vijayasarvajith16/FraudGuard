"""Create .env for docker compose from .env.example, generating every secret.

    python tools/init_env.py            (or: make env)

Keys that are empty or set to `change-me` in the example get random values: 64 hex chars for
secrets and tokens, 32 URL-safe chars for passwords. Everything else is copied as-is. An existing
.env is never overwritten, so this is safe to run at any time.
"""

from __future__ import annotations

import argparse
import re
import secrets
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PLACEHOLDER = "change-me"
# Empty values that are meant to stay empty (optional settings).
OPTIONAL_EMPTY = {"MLFLOW_TRACKING_USERNAME", "MLFLOW_TRACKING_PASSWORD"}
LINE = re.compile(r"^(?P<key>[A-Z][A-Z0-9_]*)=(?P<value>.*)$")


def generate(key: str) -> str:
    if "PASSWORD" in key or key.endswith("_PASS"):
        return secrets.token_urlsafe(24)
    return secrets.token_hex(32)


def render(example: str) -> tuple[str, list[str]]:
    """Return the .env text and the keys that were generated."""
    out, generated = [], []
    for line in example.splitlines():
        m = LINE.match(line)
        if m and m["key"] not in OPTIONAL_EMPTY and m["value"].strip() in ("", PLACEHOLDER):
            line = f"{m['key']}={generate(m['key'])}"
            generated.append(m["key"])
        out.append(line)
    return "\n".join(out) + "\n", generated


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--example", type=Path, default=REPO_ROOT / ".env.example")
    p.add_argument("--out", type=Path, default=REPO_ROOT / ".env")
    args = p.parse_args(argv)
    if args.out.exists():
        print(f"{args.out} already exists; leaving it unchanged.")
        return 0
    text, generated = render(args.example.read_text(encoding="utf-8"))
    args.out.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {args.out} with generated values for: {', '.join(generated)}")
    print("Review the host ports in it if another local project already uses the defaults.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
