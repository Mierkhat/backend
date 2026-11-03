#!/usr/bin/env python3
"""Stage exact reviewed source, verify production, then promote the tested build."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.request
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(args, cwd=ROOT):
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=1200)
    # Provider output can contain private deployment information. Never dump it on failure.
    require(result.returncode == 0, "Command failed: " + " ".join(args[:3]))
    return result.stdout.strip()


def api(path, cwd):
    return json.loads(command(["vercel", "api", path], cwd))


def validate_deployment(data, target, sha):
    require(data.get("projectId") == target["projectId"], "Deployment project mismatch")
    require(data.get("ownerId") == target["orgId"], "Deployment team mismatch")
    require(data.get("target") == "production" and data.get("readyState") == "READY", "Production deployment is not ready")
    require(data.get("meta", {}).get("releaseCommit") == sha, "Deployment commit mismatch")
    host = data.get("url", "")
    url = urlsplit("https://" + host)
    require(url.hostname and url.hostname.endswith(".vercel.app") and not url.username and not url.password and url.netloc == host and not url.path and not url.query and not url.fragment, "Unexpected deployment origin")
    return "https://" + host


def current_commit(repository):
    req = urllib.request.Request("https://api.github.com/repos/" + repository + "/git/ref/heads/main", headers={"Authorization": "Bearer " + os.environ["GITHUB_TOKEN"], "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)["object"]["sha"]


def deployment_output(output):
    # CLI 63 supports structured agent output as well as the classic URL output.
    if output.startswith("{"):
        result = json.loads(output)
        output = result.get("deployment", result).get("url", "")
        if output and not output.startswith("https://"):
            output = "https://" + output
    require(re.fullmatch(r"https://[A-Za-z0-9.-]+\.vercel\.app", output) is not None, "Unexpected deploy command output")
    return output


def stage_source(destination, target):
    paths = command(["git", "ls-files", "-z"]).split("\0")
    require(paths and paths[-1] == "", "Invalid tracked-source inventory")
    for name in paths[:-1]:
        relative = Path(name)
        require(not relative.is_absolute() and ".." not in relative.parts, "Unsafe source path")
        require(not any(p.lower() in {".env", ".git", ".tooling", "node_modules", "data", "tasks.md", "agent.md", "agents.md"} or (p.startswith(".env.") and p != ".env.example") for p in relative.parts), "Private file in tracked deployment inputs")
        source = ROOT / relative
        require(not source.is_symlink() and source.is_file(), "Deployment input must be a regular file")
        expected = subprocess.check_output(["git", "show", "HEAD:" + name], cwd=ROOT)
        require(source.read_bytes() == expected, "Deployment input differs from committed source")
        path = destination / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, path)
    # The backend's documented public example contains no credentials.
    linked = destination / ".vercel"
    linked.mkdir()
    (linked / "project.json").write_text(json.dumps({k: target[k] for k in ("projectId", "orgId", "projectName")}))


def smoke(origin, cwd, facet):
    def get(path, status=200):
        output = command(["vercel", "curl", path, "--deployment", origin, "--", "--silent", "--show-error", "--max-time", "60", "--write-out", "\n%{http_code}"], cwd)
        body, _, actual = output.rpartition("\n")
        require(actual == str(status), "Smoke check failed: " + path + " HTTP " + actual)
        return body
    health = json.loads(get("/v1/health"))
    local = ROOT / ("src/deployments.json" if facet == "frontend" else "sdk/deployments/index.json")
    expected = [b for b in json.loads(local.read_text()) if b["enabled"]]
    require(health == {"status": "ready", "enabledDeployments": len(expected)}, "Database readiness or profile count mismatch")
    require(json.loads(get("/v1/environments")) == expected, "Live deployment registry mismatch")
    schema = json.loads(get("/v1/openapi.json"))
    require(schema["openapi"] == "3.1.0" and "/v1/exit/submit" in schema["paths"], "API contract unavailable")
    get("/v1/internal/run", 401)
    get("/v1/ci-unknown-route", 404)
    if facet == "frontend":
        index = get("/")
        require('id="root"' in index and 'id="root"' in get("/app"), "SPA routing failed")
        assets = re.findall(r'(?:src|href)="(/assets/[^"?]+)"', index)
        require(assets, "Frontend assets are missing")
        for path in assets:
            require("<html" not in get(path)[:100].lower(), "Asset route returned an HTML fallback")
        require("<svg" in get("/favicon.svg"), "Brand asset unavailable")
    print("PASS: staged health, registry, OpenAPI, scheduler authentication, unknown routes" + (", SPA and assets" if facet == "frontend" else ""), flush=True)


def main(local_auth=False):
    target = json.loads((ROOT / ".github/production.json").read_text())
    repository = "Mierkhat/" + target["facet"]
    require(os.environ.get("GITHUB_REPOSITORY") == repository and os.environ.get("GITHUB_REF") == "refs/heads/main", "Only the intended repository main may deploy")
    require(not local_auth or os.environ.get("GITHUB_ACTIONS") != "true", "Local authentication cannot be selected by GitHub Actions")
    require(local_auth or os.environ.get("VERCEL_TOKEN"), "Configure production environment secret VERCEL_TOKEN")
    sha = os.environ["GITHUB_SHA"]
    require(re.fullmatch(r"[0-9a-f]{40}", sha) is not None and command(["git", "rev-parse", "HEAD"]) == sha, "Checkout commit mismatch")
    if current_commit(repository) != sha:
        print("Superseded commit: skipping production deployment.")
        return
    with tempfile.TemporaryDirectory(prefix="mierkhat-release-") as directory:
        stage = Path(directory)
        stage_source(stage, target)
        # Remote builds retain production runtime secrets at Vercel; CI never pulls them.
        output = deployment_output(command(["vercel", "deploy", "--prod", "--skip-domain", "--yes", "--meta", "releaseCommit=" + sha], stage))
        data = api("/v13/deployments/" + urlsplit(output).hostname + "?teamId=" + target["orgId"], stage)
        origin = validate_deployment(data, target, sha)
        print("Staged " + data["id"] + " at " + origin + " from " + sha, flush=True)
        smoke(origin, stage, target["facet"])
        if current_commit(repository) != sha:
            print("Superseded during build: tested deployment retained, promotion skipped.")
            return
        command(["vercel", "promote", origin, "--yes"], stage)
        live = api("/v13/deployments/" + target["productionHost"] + "?teamId=" + target["orgId"], stage)
        validate_deployment(live, target, sha)
        require(live["id"] == data["id"], "Production alias did not resolve to the tested deployment")
        smoke("https://" + target["productionHost"], stage, target["facet"])
        summary = "Production: https://" + target["productionHost"] + "\nCommit: " + sha + "\nDeployment: " + data["id"] + "\nStaged and live smoke checks passed.\n"
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as handle:
                handle.write(summary)
        print(summary)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-auth", action="store_true", help="Use this operator's existing Vercel CLI authentication, outside GitHub Actions")
    main(parser.parse_args().local_auth)
