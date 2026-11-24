#!/usr/bin/env python3
"""Strict SAST of shipped source, with an enforced export-only parser workaround."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


def validate_barrel(text):
    # Semgrep 1.183.0 cannot parse `export type * as ...`. Only pure local
    # re-exports may be excluded; adding any executable statement fails closed.
    export = r'export (?:type )?\*(?: as [A-Za-z_$][\w$]*)? from "\./(?:generated/)?[A-Za-z0-9_-]+\.js";'
    if not text.strip() or any(not re.fullmatch(export, line.strip()) for line in text.splitlines() if line.strip()):
        raise SystemExit("SDK index parser exception permits only local re-exports")


def verify_rules():
    base = Path(".github/security-rules")
    provenance = json.loads((base / "provenance.json").read_text())
    files = provenance["files"]
    actual = {p.name for p in base.iterdir() if p.name != "provenance.json"}
    if actual != set(files):
        raise SystemExit("Security rule inventory differs from provenance")
    for name, metadata in files.items():
        if hashlib.sha256((base / name).read_bytes()).hexdigest() != metadata["sha256"]:
            raise SystemExit(f"Security rule digest mismatch: {name}")


if __name__ == "__main__":
    verify_rules()
    barrel = Path("sdk/src/index.ts")
    if barrel.exists():
        validate_barrel(barrel.read_text())
    sources = [str(p) for p in map(Path, ("src", "sdk/src", "api", "embed/src", "copy/src", "guard/src", "migration/src")) if p.is_dir()]
    if not sources:
        raise SystemExit("No application sources found")
    command = [str(Path(sys.prefix) / "bin" / "semgrep"), "scan", "--config", ".github/security-rules", "--config", ".github/semgrep-project.yml", "--error", "--strict", "--metrics", "off", "--disable-version-check", *sources]
    subprocess.run(command, check=True)
