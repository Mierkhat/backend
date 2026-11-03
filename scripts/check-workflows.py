#!/usr/bin/env python3
"""Reject workflow permission and event changes that expose untrusted PR code."""
from pathlib import Path
import re
import yaml

# BaseLoader preserves the YAML 1.1 keyword `on` as a string.
def validate(data, path="workflow"):
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: workflow mapping required")
    events = data.get("on", {})
    if not isinstance(events, dict) or set(events) - {"push", "pull_request", "workflow_dispatch", "schedule"}:
        raise SystemExit(f"{path}: unexpected workflow trigger")
    if data.get("permissions") != {"contents": "read"}:
        raise SystemExit(f"{path}: workflow token must have read-only contents access")
    if re.search(r"\bsecrets\b", yaml.dump({k: v for k, v in data.items() if k != "jobs"})):
        raise SystemExit(f"{path}: workflow-level secret access forbidden")
    required = {"security", "compatibility", "application"}
    jobs = data.get("jobs", {})
    if not required <= set(jobs) or jobs.get("ci", {}).get("needs") != ["security", "compatibility", "application"] or jobs["ci"].get("if") != "always()":
        raise SystemExit(f"{path}: all validation jobs must feed the unconditional CI gate")
    for name, job in data.get("jobs", {}).items():
        if name in required and "if" in job:
            raise SystemExit(f"{path}/{name}: validation cannot be conditionally skipped")
        if "permissions" in job and job["permissions"] != {"contents": "read"}:
            raise SystemExit(f"{path}/{name}: elevated job permissions forbidden")
        if job.get("continue-on-error") not in (None, "false"):
            raise SystemExit(f"{path}/{name}: failures must block CI")
        if "environment" in job and name != "production":
            raise SystemExit(f"{path}/{name}: validation jobs cannot enter a credential environment")
        if name == "production":
            expected = "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')"
            if job.get("if") != expected or job.get("needs") != "ci":
                raise SystemExit(f"{path}: production must follow CI only on trusted main events")
        for step in job.get("steps", []):
            if step.get("continue-on-error") not in (None, "false"):
                raise SystemExit(f"{path}/{name}: step failures must not be suppressed")
            action = step.get("uses")
            if action and not re.fullmatch(r"[A-Za-z0-9_./-]+@[0-9a-f]{40}", action):
                raise SystemExit(f"{path}/{name}: immutable action SHA required")
            if action and action.startswith("actions/checkout@") and step.get("with", {}).get("persist-credentials") != "false":
                raise SystemExit(f"{path}/{name}: checkout must not retain credentials")
        text = yaml.dump(job)
        if name != "production" and re.search(r"\bsecrets\b", text):
            raise SystemExit(f"{path}/{name}: validation must not reference deployment secrets")
if __name__ == "__main__":
    paths = list(Path(".github/workflows").glob("*.y*ml"))
    if not paths:
        raise SystemExit("No workflows found")
    for path in paths:
        validate(yaml.load(path.read_text(), Loader=yaml.BaseLoader), str(path))
    print("PASS: workflow events, permissions, action pins and secret isolation")
