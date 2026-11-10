#!/usr/bin/env python3
"""Add lowercase aliases for mixed-case StarCraft sprite files on Linux hosts."""

import os
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"Usage: {sys.argv[0]} <bw_sprite_data directory>")

    root = Path(sys.argv[1]).resolve()
    if not root.is_dir():
        raise SystemExit(f"Sprite directory does not exist: {root}")

    created = 0
    for source in root.rglob("*"):
        if source.is_symlink() or not source.is_file():
            continue

        relative = source.relative_to(root)
        target = root.joinpath(*(part.lower() for part in relative.parts))
        if target == source or target.exists() or target.is_symlink():
            continue

        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(os.path.relpath(source, target.parent))
        created += 1

    print(f"Created {created} lowercase sprite aliases in {root}")


if __name__ == "__main__":
    main()
