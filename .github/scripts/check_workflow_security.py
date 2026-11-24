"""Check action pins and the isolated contributor control plane."""

from pathlib import Path
import re

HARDEN_RUNNER = "step-security/harden-runner@aebdcf6156ab6691adf63218240e476564a1ed4c"
POLICIES = {
    "pr-assignment.yml": ({"contents": "read", "issues": "read", "pull-requests": "write"},
                          "enforce_pr_assignments", "enforce_pr_assignments"),
    "approve-pr-ci.yml": ({"contents": "read", "issues": "read", "pull-requests": "read", "actions": "write"},
                         "enforce_pr_assignments,approve_pr_ci", "approve_pr_ci"),
    "auto-merge-prs.yml": ({"contents": "write", "pull-requests": "write", "issues": "write", "actions": "read", "checks": "read"},
                         "enforce_pr_assignments,check_pr_description,auto_merge_prs", "auto_merge_prs"),
}


def validate(name, text, bootstrap):
    actions = re.findall(r"uses:\s*([^\s#]+)", text)
    if any(not re.fullmatch(r"[A-Za-z0-9_./-]+@[0-9a-f]{40}", action) for action in actions):
        raise ValueError("Actions must use full commit SHAs")
    if "write-all" in text:
        raise ValueError("Unbounded workflow permissions")
    if name not in POLICIES:
        if "pull_request_target" in text or "workflow_run" in text:
            raise ValueError("Unexpected privileged workflow")
        return
    permissions, modules, entrypoint = POLICIES[name]
    if actions != [HARDEN_RUNNER]:
        raise ValueError("Policy workflows may only use the pinned network isolation action")
    block = re.search(r"(?m)^permissions:\n((?:  [^\n]+\n)+)", text)
    if not block or dict(re.findall(r"^  ([\w-]+): (read|write)\s*$", block[1], re.MULTILINE)) != permissions:
        raise ValueError("Policy permissions differ from the required scope")
    if len(re.findall(r"(?m)^\s*permissions:", text)) != 1:
        raise ValueError("Policy jobs cannot override permissions")
    expressions = re.findall(r"\$\{\{(.*?)\}\}", text)
    for expression in expressions:
        if ("secrets." in expression and not (name == "auto-merge-prs.yml" and expression.strip() == "secrets.MIERKHAT_ISSUE_COMPLETION_TOKEN")) or ("github.event." in expression and expression.strip() != "github.event.repository.default_branch"):
            raise ValueError("Untrusted event interpolation or secret in privileged workflow")
    for expected in (
        "POLICY_SHA: ${{ github.workflow_sha }}",
        "POLICY_REF: ${{ github.workflow_sha }}",
        "POLICY_MODULES: " + modules,
        "POLICY_ENTRYPOINT: " + entrypoint,
        "egress-policy: block",
        "allowed-endpoints: api.github.com:443",
    ):
        if expected not in text:
            raise ValueError("Missing immutable policy or network boundary")
    if len(re.findall(r"(?m)^\s*run:", text)) != 1:
        raise ValueError("Policy workflows must have one trusted bootstrap")
    shell = "          python3 -B - <<'PY'\n" + "".join(
        "          " + line + "\n" if line else "\n" for line in bootstrap.splitlines()
    ) + "          PY\n"
    if text.split("        run: |\n", 1)[-1] != shell:
        raise ValueError("Policy bootstrap differs from the reviewed source")


def main():
    root = Path(__file__).resolve().parents[1]
    bootstrap = (root / "scripts/policy_bootstrap.py").read_text()
    for path in (root / "workflows").glob("*.y*ml"):
        validate(path.name, path.read_text(), bootstrap)
    print("PASS: pinned workflows and immutable, isolated contributor policies")


if __name__ == "__main__":
    main()
