"""Check immutable lockfiles and known malicious dependencies through OSV."""

import base64
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request

NAME = re.compile(r"(?:@[a-z0-9._-]+/)?[a-z0-9._-]+")
VERSION = re.compile(r"\d+\.\d+\.\d+(?:[-+][\w.-]+)?")


def npm_packages(text):
    packages = set()
    blocks = re.findall(r"(?m)^packages:\n(.*?)(?=^\S|\Z)", text, re.DOTALL)
    if not blocks:
        raise ValueError("pnpm lockfile has no packages section")
    for block in blocks:
        for match in re.finditer(r"(?m)^  ([^\n]+):\n(.*?)(?=^  \S|\Z)", block, re.DOTALL):
            key, record = match[1].strip("'\""), match[2]
            name, separator, version = key.rpartition("@")
            if not separator or not NAME.fullmatch(name):
                raise ValueError("Unsupported locked npm package: " + key)
            integrity = re.search(r"\bintegrity:\s*(sha512-[A-Za-z0-9+/=]+)", record)
            if not integrity or len(base64.b64decode(integrity[1][7:], validate=True)) != 64:
                raise ValueError("Locked npm package requires SHA-512 integrity: " + key)
            if version.startswith("file:") and name.startswith("@mierkhat/"):
                continue
            if not VERSION.fullmatch(version):
                raise ValueError("Locked npm package requires an exact version: " + key)
            packages.add(("npm", name, version))
    if not packages:
        raise ValueError("pnpm lockfile has no registry packages")
    return packages


def cargo_packages(text):
    packages = set()
    for package in tomllib.loads(text)["package"]:
        source = package.get("source", "")
        if source.startswith("registry+"):
            if not re.fullmatch(r"[0-9a-f]{64}", package.get("checksum", "")):
                raise ValueError("Registry crate requires SHA-256 checksum: " + package["name"])
            packages.add(("crates.io", package["name"], package["version"]))
        elif source.startswith("git+"):
            if not re.search(r"#[0-9a-f]{40}$", source):
                raise ValueError("Git crate requires immutable revision: " + package["name"])
        elif source:
            raise ValueError("Unsupported Cargo source: " + source)
    if not packages:
        raise ValueError("Cargo lockfile has no registry packages")
    return packages


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("OSV redirect refused")


def osv(path, body=None):
    payload = json.dumps(body).encode() if body is not None else None
    for attempt in range(3):
        request = urllib.request.Request("https://api.osv.dev/v1/" + path, data=payload,
                                        headers={"Content-Type": "application/json", "User-Agent": "mierkhat-dependency-check"})
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=25) as response:
                return json.load(response)
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError("OSV dependency check unavailable")


def malicious(advisory):
    identifiers = [advisory["id"], *advisory.get("aliases", [])]
    return (any(identifier.startswith("MAL-") for identifier in identifiers)
            or "CWE-506" in json.dumps(advisory.get("database_specific", {}))
            or bool(re.search(r"\bmalware\b|\bmalicious (?:package|dependency|code|crate)\b",
                              advisory.get("summary", ""), re.IGNORECASE)))


def scan(packages, request=osv):
    packages = sorted(packages)
    identifiers = set()
    for start in range(0, len(packages), 100):
        queries = [{"package": {"ecosystem": ecosystem, "name": name}, "version": version}
                   for ecosystem, name, version in packages[start:start + 100]]
        results = request("querybatch", {"queries": queries})["results"]
        if len(results) != len(queries):
            raise ValueError("OSV returned incomplete dependency results")
        for result in results:
            identifiers.update(item["id"] for item in result.get("vulns", []))
    if any(not re.fullmatch(r"[A-Za-z0-9-]+", identifier) for identifier in identifiers):
        raise ValueError("Invalid OSV advisory identifier")
    blocked = {identifier for identifier in identifiers if identifier.startswith("MAL-")}
    other = sorted(identifiers - blocked)
    with ThreadPoolExecutor(max_workers=8) as pool:
        for advisory in pool.map(lambda identifier: request("vulns/" + urllib.parse.quote(identifier, safe="")), other):
            if malicious(advisory):
                blocked.add(advisory["id"])
    if blocked:
        raise ValueError("Known malicious dependencies detected: " + ", ".join(sorted(blocked)))
    return len(packages)


def main():
    root = Path(__file__).resolve().parents[2]
    packages = set()
    if (root / "pnpm-lock.yaml").exists():
        packages |= npm_packages((root / "pnpm-lock.yaml").read_text())
    if (root / "Cargo.lock").exists():
        packages |= cargo_packages((root / "Cargo.lock").read_text())
    if not packages:
        raise ValueError("No supported dependency lockfile found")
    count = scan(packages)
    print(f"PASS: immutable lockfile integrity and known-malware advisory checks for {count} dependencies")


if __name__ == "__main__":
    main()
