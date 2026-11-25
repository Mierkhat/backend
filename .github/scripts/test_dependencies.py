import unittest
from check_dependencies import npm_packages, cargo_packages, scan

INTEGRITY = "sha512-" + "A" * 86 + "=="


class DependencyChecks(unittest.TestCase):
    def test_all_pnpm_documents_are_scanned(self):
        document = "packages:\n  package@1.2.3:\n    resolution: {integrity: " + INTEGRITY + "}\nsnapshots:\n"
        text = document + "---\n" + document.replace("package@", "@scope/second@")
        self.assertEqual(npm_packages(text), {("npm", "package", "1.2.3"), ("npm", "@scope/second", "1.2.3")})

    def test_missing_weak_integrity_and_floating_versions_are_rejected(self):
        for text in ("packages:\n  package@1.2.3:\n    resolution: {}\n",
                     "packages:\n  package@1.2.3:\n    resolution: {integrity: sha1-AAAA}\n",
                     "packages:\n  package@latest:\n    resolution: {integrity: " + INTEGRITY + "}\n"):
            with self.assertRaises(ValueError):
                npm_packages(text)

    def test_cargo_registry_checksums_and_git_revisions_are_required(self):
        prefix = '[[package]]\nname="package"\nversion="1.2.3"\n'
        checksum = 'checksum="' + 'a' * 64 + '"\n'
        text = prefix + 'source="registry+https://github.com/rust-lang/crates.io-index"\n' + checksum
        self.assertEqual(cargo_packages(text), {("crates.io", "package", "1.2.3")})
        with self.assertRaises(ValueError):
            cargo_packages(text.replace(checksum, ""))
        with self.assertRaises(ValueError):
            cargo_packages(text + prefix + 'source="git+https://example.com/repo#main"\n')

    def test_malware_records_and_aliases_block(self):
        for identifier, advisory in [("MAL-2026-1", None),
                                     ("GHSA-example", {"id": "GHSA-example", "aliases": ["MAL-2026-1"]}),
                                     ("RUSTSEC-2026-1", {"id": "RUSTSEC-2026-1", "summary": "Malicious package"})]:
            def request(path, body=None):
                return {"results": [{"vulns": [{"id": identifier}]}]} if path == "querybatch" else advisory
            with self.assertRaisesRegex(ValueError, "malicious"):
                scan({("npm", "package", "1.2.3")}, request)

    def test_missing_results_and_unavailable_service_fail_closed(self):
        for request in (lambda *args: {"results": []}, lambda *args: (_ for _ in ()).throw(OSError("offline"))):
            with self.assertRaises((ValueError, OSError)):
                scan({("npm", "package", "1.2.3")}, request)

    def test_clean_scan_checks_each_exact_package_version(self):
        seen = []
        def request(path, body=None):
            seen.extend(body["queries"])
            return {"results": [{} for _ in body["queries"]]}
        self.assertEqual(scan({("npm", "package", "1.2.3")}, request), 1)
        self.assertEqual(seen[0]["version"], "1.2.3")
