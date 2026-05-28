#!/usr/bin/env python3
"""Insert agent README banners when banner.png exists."""

from __future__ import annotations

import re
import sys
from pathlib import Path


DISPLAY_NAMES = {
    "granola": "Granola Prospect Agent",
    "hn-monitor": "HN Monitor",
    "linear": "Linear Implementer",
    "repo-hygiene": "Repo Hygiene",
    "review": "PR Reviewer",
    "spotify-releases": "Spotify Releases",
    "vendor-monitor": "Vendor Monitor",
}


def has_agent_shape(path: Path) -> bool:
    return (path / "persona.ts").is_file() and (path / "agent.ts").is_file()


def image_block(folder: str) -> str:
    name = DISPLAY_NAMES.get(folder, folder.replace("-", " ").title())
    return f'<img src="./banner.png" alt="{name}">\n'


def update_readme(agent_dir: Path) -> bool:
    banner = agent_dir / "banner.png"
    readme = agent_dir / "README.md"
    if not banner.is_file() or not readme.is_file():
        return False

    text = readme.read_text()
    block = image_block(agent_dir.name)
    if text.startswith(block + "\n") or text.startswith(block):
        return False

    old_wrapped_card = re.compile(
        r'\A<p align="center">\n'
        r'  <img src="\./card\.png" alt="[^"]+" width="\d+">\n'
        r"</p>\n+"
    )
    old_banner_or_card = re.compile(
        r'\A<img src="\./(?:banner|card)\.png" alt="[^"]+">\n+'
    )

    new_text, count = old_wrapped_card.subn(block + "\n", text, count=1)
    if count == 0:
        new_text, count = old_banner_or_card.subn(block + "\n", text, count=1)
    if count > 0:
        readme.write_text(new_text)
        return True

    lines = text.splitlines()
    insert_at = 0
    while insert_at < len(lines) and lines[insert_at].strip() == "":
        insert_at += 1

    new_lines = lines[:insert_at] + block.splitlines() + [""] + lines[insert_at:]
    readme.write_text("\n".join(new_lines).rstrip() + "\n")
    return True


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    changed = []
    for child in sorted(root.iterdir()):
        if child.is_dir() and has_agent_shape(child) and update_readme(child):
            changed.append(str(child.relative_to(root) / "README.md"))

    for path in changed:
        print(f"updated {path}")
    if not changed:
        print("no README updates needed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
