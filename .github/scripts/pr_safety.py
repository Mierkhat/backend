"""Inspect PR Git objects without checking out or executing contributor files."""

import argparse
from difflib import SequenceMatcher
import json
import os
from pathlib import PurePosixPath
import re
import subprocess
import sys
from urllib.request import HTTPRedirectHandler, Request, build_opener


SHA = re.compile(r"[0-9a-f]{40}")
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
HORIZONTAL_GAP = re.compile(r"(?<=\S)[ \t]+(?=\S)")
INVISIBLE = re.compile(r"[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]")
CONFIG_EXECUTION = re.compile(
    r"['\"](?:node:)?(?:child_process|net|tls|https?|dgram)['\"]"
    r"|\b(?:exec(?:File)?(?:Sync)?|spawn(?:Sync)?|fetch|eval|Function)\s*\("
)
HOOKS = frozenset({"preinstall", "install", "postinstall", "prepare", "preprepare",
                   "postprepare", "prepublish", "dependencies", "pnpm:devPreinstall"})
MAX_BLOB = 2 * 1024 * 1024
MAX_FILES = 500
CONTEXT = "PR safety"


def git(*args):
    result = subprocess.run(["git", "--no-replace-objects", *args], capture_output=True,
                            check=False, timeout=90)
    if result.returncode:
        raise ValueError(f"Git {args[0]} failed; no safety decision was made")
    return result.stdout


def scripts(text):
    if text is None:
        return {}
    package = json.loads(text)
    hooks = package.get("scripts", {}) if isinstance(package, dict) else None
    if not isinstance(hooks, dict):
        raise ValueError("Invalid package scripts")
    return hooks


def findings(path, before, after, mode="100644", new=False):
    name = PurePosixPath(path).name.lower()
    vscode = ".vscode" in PurePosixPath(path.lower()).parts
    eslint = name.startswith(("eslint.config.", ".eslintrc"))
    if name in {"init", ".envrc"} or (new and mode == "100755" and "." not in name):
        yield 1, "new extensionless executable or changed automatic environment script"
    if name == "package.json":
        try:
            previous, current = scripts(before), scripts(after)
        except ValueError:
            yield 1, "package manifest is not valid JSON with a scripts object"
        else:
            for hook in sorted(HOOKS & current.keys()):
                if current[hook] != previous.get(hook):
                    yield 1, f"new or changed package lifecycle hook: {hook}"
    if after is None:
        if eslint or vscode or name == "package.json":
            yield 1, "execution-sensitive configuration is not UTF-8 text"
        return
    old_lines = before.split("\n") if before is not None else []
    new_lines = after.split("\n")
    for kind, _, _, first, last in SequenceMatcher(None, old_lines, new_lines).get_opcodes():
        if kind not in {"insert", "replace"}:
            continue
        for index in range(first, last):
            line = new_lines[index]
            if INVISIBLE.search(line) or any(len(gap[0].expandtabs(8)) >= 32
                                             for gap in HORIZONTAL_GAP.finditer(line)):
                yield index + 1, "potentially concealed content (wide whitespace or invisible control)"
            if vscode and re.search(r'"folderOpen"|"terminal\.integrated\.profiles\.', line):
                yield index + 1, "editor auto-run or executable terminal profile"
            if eslint and CONFIG_EXECUTION.search(line):
                yield index + 1, "process, network, or dynamic execution in ESLint configuration"


def blob(revision):
    if revision == "0" * 40:
        return None
    if int(git("cat-file", "-s", revision)) > MAX_BLOB:
        raise ValueError("Changed blob exceeds the PR safety limit (2 MiB)")
    data = git("cat-file", "blob", revision)
    if b"\0" in data:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def scan(base, head):
    git("cat-file", "-e", f"{base}^{{commit}}")
    git("cat-file", "-e", f"{head}^{{commit}}")
    ancestor = git("merge-base", base, head).decode("ascii").strip()
    raw = git("diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff",
              "--no-textconv", "--diff-filter=AMT", ancestor, head, "--")
    fields = raw.split(b"\0")[:-1]
    if len(fields) % 2 or len(fields) > MAX_FILES * 2:
        raise ValueError("Invalid or oversized PR diff (limit: 500 changed files)")
    rejected = False
    for metadata, path_bytes in zip(fields[::2], fields[1::2], strict=True):
        old_mode, mode, previous, current, change = metadata.decode("ascii").split()
        path = os.fsdecode(path_bytes)
        display = json.dumps(path, ensure_ascii=True)
        if mode not in {"100644", "100755"}:
            print(f"{display}:1: new or changed symlink, submodule, or special Git entry")
            rejected = True
            continue
        before = blob(previous) if old_mode in {":100644", ":100755"} else None
        after = blob(current)
        executable_added = mode == "100755" and old_mode != ":100755"
        for line, reason in findings(path, before, after, mode, change == "A" or executable_added):
            print(f"{display}:{line}: {reason}")
            rejected = True
    if not rejected:
        print(f"PR safety passed: {len(fields) // 2} added or modified paths inspected")
    return not rejected


def verified_head(repository, number, expected):
    git("fetch", "--no-tags", "--no-recurse-submodules", "--no-auto-maintenance",
        f"https://github.com/{repository}.git", f"refs/pull/{number}/head")
    if git("rev-parse", "--verify", "FETCH_HEAD^{commit}").decode("ascii").strip() != expected:
        raise ValueError("PR head moved during scan; the updated PR must be scanned separately")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Authenticated API redirect refused")


def api(repository, path, data=None):
    request = Request(f"https://api.github.com/repos/{repository}/{path}",
                      data=json.dumps(data).encode() if data is not None else None,
                      headers={"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
                               "Accept": "application/vnd.github+json",
                               "Content-Type": "application/json",
                               "User-Agent": "mierkhat-pr-safety"})
    with build_opener(NoRedirect()).open(request, timeout=20) as response:
        return json.load(response)


def report(repository, number, base, head, success, run_id):
    pr = api(repository, f"pulls/{number}")
    if (pr["state"] != "open" or pr["base"]["ref"] != "dev"
            or pr["base"]["repo"]["full_name"].lower() != repository.lower()
            or pr["base"]["sha"] != base or pr["head"]["sha"] != head):
        raise ValueError("PR head or target changed; refusing to report a stale status")
    api(repository, f"statuses/{head}", {
        "context": CONTEXT, "state": "success" if success else "failure",
        "description": f"Scanned against {base}" if success else f"Scan failed against {base}",
        "target_url": f"https://github.com/{repository}/actions/runs/{run_id}",
    })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("scan", "report"))
    parser.add_argument("--outcome", choices=("success", "failure", "cancelled", "skipped"))
    args = parser.parse_args()
    repository, number = os.environ["GITHUB_REPOSITORY"], os.environ["PR_NUMBER"]
    base, head = os.environ["PR_BASE"], os.environ["PR_HEAD"]
    if (not REPOSITORY.fullmatch(repository) or not re.fullmatch(r"[1-9][0-9]*", number)
            or not SHA.fullmatch(base) or not SHA.fullmatch(head)):
        raise ValueError("Invalid PR scan identity")
    if args.operation == "scan":
        verified_head(repository, number, head)
        return 0 if scan(base, head) else 1
    run_id = os.environ["GITHUB_RUN_ID"]
    if not args.outcome or not re.fullmatch(r"[1-9][0-9]*", run_id):
        raise ValueError("Invalid scan outcome or run identity")
    report(repository, number, base, head, args.outcome == "success", run_id)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        sys.exit(f"PR safety could not complete: {error}")
