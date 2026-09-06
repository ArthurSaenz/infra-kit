#!/usr/bin/env python3
"""Scaffold a per-feature e2e test folder from the bundled template.

Copies assets/feature-template/ into <dest>/<feature-kebab>/, substituting placeholder
tokens with the feature name in kebab / camelCase / PascalCase / Title Case forms, and
renaming the `__feature-kebab__.*` files accordingly.

Copies a deliberately MINIMAL starter (Page Object + cleanup fixture + smoke + crud specs).
Grow it into the full behavioral-axis layout described in references/conventions.md as the
feature matures.

Usage:
  scaffold_feature.py <feature-kebab> --dest <tests/src/tests dir>

Example:
  scaffold_feature.py coupon-batch \\
    --dest apps/backoffice/tests/src/tests
"""
import argparse
import re
import sys
from pathlib import Path

PLACEHOLDERS = {
    "__feature-kebab__": None,   # filled at runtime: coupon-batch
    "__featureCamel__": None,    # couponBatch
    "__FeaturePascal__": None,   # CouponBatch
    "__Feature Title__": None,   # Coupon Batch
}

TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "assets" / "feature-template"


def to_camel(kebab: str) -> str:
    parts = kebab.split("-")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def to_pascal(kebab: str) -> str:
    return "".join(p.capitalize() for p in kebab.split("-"))


def to_title(kebab: str) -> str:
    return " ".join(p.capitalize() for p in kebab.split("-"))


def substitute(text: str, repl: dict) -> str:
    for token, value in repl.items():
        text = text.replace(token, value)
    return text


def main() -> int:
    parser = argparse.ArgumentParser(description="Scaffold a per-feature e2e test folder.")
    parser.add_argument("feature", help="Feature name in kebab-case (e.g. coupon-batch)")
    parser.add_argument("--dest", required=True, help="Target tests dir (e.g. apps/backoffice/tests/src/tests)")
    args = parser.parse_args()

    if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", args.feature):
        print(f"error: feature name must be kebab-case, got '{args.feature}'", file=sys.stderr)
        return 1

    if not TEMPLATE_DIR.is_dir():
        print(f"error: template dir not found at {TEMPLATE_DIR}", file=sys.stderr)
        return 1

    repl = {
        "__feature-kebab__": args.feature,
        "__featureCamel__": to_camel(args.feature),
        "__FeaturePascal__": to_pascal(args.feature),
        "__Feature Title__": to_title(args.feature),
    }

    if not Path(args.dest).is_dir():
        print(f"error: --dest does not exist (typo?): {args.dest}", file=sys.stderr)
        return 1

    dest_dir = Path(args.dest) / args.feature
    if dest_dir.exists():
        print(f"error: destination already exists: {dest_dir}", file=sys.stderr)
        return 1
    dest_dir.mkdir()

    written = []
    for src in sorted(TEMPLATE_DIR.iterdir()):
        if not src.is_file():
            continue
        out_name = substitute(src.name, repl)
        out_path = dest_dir / out_name
        out_path.write_text(substitute(src.read_text(), repl))
        written.append(out_path)

    print(f"Scaffolded {args.feature} e2e structure at {dest_dir}")
    for path in written:
        print(f"  + {path}")
    print("\nNext: rename action methods/locators to match the real UI, then run the suite filtered to this folder.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
