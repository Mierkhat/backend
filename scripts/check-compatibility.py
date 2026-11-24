#!/usr/bin/env python3
"""Check immutable sibling revisions, deployment pins, ABI and SDK provenance."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse
from email.utils import parsedate_to_datetime

ROOT = Path(__file__).resolve().parents[1]


def check(condition, message):
    if not condition:
        raise ValueError(message)


class PublicRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        target = urlparse(url)
        if request.has_header("Authorization") and (
            target.scheme != "https" or target.hostname != "api.github.com"
        ):
            raise ValueError("Authenticated GitHub API redirect rejected")
        return super().redirect_request(request, fp, code, message, headers, url)


def fetch_bytes(url):
    headers = {"Accept": "application/vnd.github+json"}
    target = urlparse(url)
    token = os.environ.get("GITHUB_TOKEN")
    if token and target.scheme == "https" and target.hostname == "api.github.com":
        headers["Authorization"] = "Bearer " + token
    opener = urllib.request.build_opener(PublicRedirects())
    deadline = time.monotonic() + 120
    for attempt in range(3):
        delay = 2 ** attempt
        try:
            with opener.open(urllib.request.Request(url, headers=headers), timeout=30) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            rate_limited = error.code == 429 or (
                error.code == 403 and error.headers.get("X-RateLimit-Remaining") == "0"
            )
            retryable = rate_limited or error.code in (408, 500, 502, 503, 504)
            if not retryable:
                raise
            retry_after = error.headers.get("Retry-After")
            reset = error.headers.get("X-RateLimit-Reset") if rate_limited else None
            try:
                if retry_after:
                    try:
                        delay = max(delay, float(retry_after))
                    except ValueError:
                        delay = max(delay, parsedate_to_datetime(retry_after).timestamp() - time.time())
                elif reset:
                    delay = max(delay, float(reset) - time.time() + 1)
            except (ValueError, TypeError, OverflowError):
                pass
            finally:
                error.close()
        except (urllib.error.URLError, TimeoutError):
            pass
        if attempt == 2 or time.monotonic() + delay + 30 > deadline:
            raise RuntimeError("Pinned compatibility read unavailable within retry budget")
        time.sleep(delay)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--siblings", type=Path, help="Local independent repositories for offline checks")
    args = parser.parse_args()
    pins = json.loads((ROOT / ".github/compatibility.json").read_text())
    facet = pins["facet"]
    for name in ("frontend", "backend", "contracts"):
        check(re.fullmatch(r"[0-9a-f]{40}", pins[name]) is not None, "Sibling revisions must be immutable SHAs")

    def read(name, path):
        check(name in ("frontend", "backend", "contracts"), "Unexpected repository")
        if name == facet:
            return (ROOT / path).read_bytes()
        if args.siblings:
            return subprocess.check_output(["git", "show", f"{pins[name]}:{path}"], cwd=args.siblings / name)
        url = f"https://raw.githubusercontent.com/Mierkhat/{name}/{pins[name]}/{path}"
        return fetch_bytes(url)

    def document(name, path):
        return json.loads(read(name, path))

    frontend = document("frontend", "src/deployments.json")
    backend = document("backend", "sdk/deployments/index.json")
    check(frontend == backend, "Frontend and backend deployment registries differ")
    check(all(not b["enabled"] or b["environment"] == "testnet" for b in backend), "Only testnet profiles may be enabled")
    check(len({(b["environment"], b["epoch"]) for b in backend}) == len(backend), "Duplicate deployment epochs")
    guard = document("contracts", "evidence/testnet-fixture.json")["bundle"]["guardWasmHash"]
    migrations = document("contracts", "evidence/testnet-migration-routes.json")["bundles"]
    approved = {guard, *(b["guardWasmHash"] for b in migrations)}
    check(all(b["guardWasmHash"] in approved for b in backend if b["enabled"]), "Unverified contract executable in deployment registry")
    for migration in migrations:
        candidate = next((b for b in backend if b["epoch"] == migration["epoch"]), None)
        check(candidate is not None and all(candidate[k] == migration[k] for k in ("environment", "networkPassphrase", "guard", "guardWasmHash", "profileHash", "profile", "migration")), "Migration contract identity differs from proof")

    manifest = document("frontend", ".vendor/manifest.json")
    archive = manifest["archive"]
    check(re.fullmatch(r"mierkhat-sdk-[0-9A-Za-z.-]+\.tgz", archive) is not None, "Invalid SDK archive path")
    check(manifest["source_repository"] == "https://github.com/Mierkhat/backend", "Unexpected SDK source")
    packed = read("frontend", ".vendor/" + archive)
    check(hashlib.sha256(packed).hexdigest() == manifest["sha256"], "SDK archive checksum mismatch")
    package = document("frontend", "package.json")
    embed = document("frontend", "embed/package.json")
    check(package["dependencies"]["@mierkhat/sdk"] == "file:.vendor/" + archive, "App SDK reference differs")
    check(embed["dependencies"]["@mierkhat/sdk"] == "file:../.vendor/" + archive, "Embed SDK reference differs")
    with tarfile.open(fileobj=io.BytesIO(packed)) as tar:
        check(all(m.name.startswith("package/") and ".." not in Path(m.name).parts and not m.issym() and not m.islnk() for m in tar), "Unsafe SDK archive member")
        def packed_json(path):
            return json.load(tar.extractfile("package/" + path))
        check(packed_json("deployments/index.json") == backend, "Packed SDK deployment registry differs")
        for spec in ("spec.json", "migration-spec.json"):
            check(packed_json("dist/generated/" + spec) == document("backend", "sdk/src/generated/" + spec), "Packed SDK ABI differs from backend: " + spec)

    # The packed source tree is deliberately versioned; dependency-only fixes do not rebuild it.
    if args.siblings:
        sdk_tree = subprocess.check_output(["git", "rev-parse", pins["backend"] + ":sdk"], cwd=args.siblings / "backend", text=True).strip()
    else:
        url = "https://api.github.com/repos/Mierkhat/backend/git/trees/" + pins["backend"]
        tree = json.loads(fetch_bytes(url))["tree"]
        sdk_tree = next(t["sha"] for t in tree if t["path"] == "sdk" and t["type"] == "tree")
    check(sdk_tree == manifest["source_sdk_tree"], "SDK source tree differs; repack and update provenance before release")
    print("PASS: immutable sibling revisions, testnet pins, contract evidence, SDK checksum/source tree and both ABIs")


if __name__ == "__main__":
    main()
