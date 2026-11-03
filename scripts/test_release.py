"""Release trust-boundary and failure tests; no provider calls or credentials."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.sha = "a" * 40
        self.target = json.loads((release.ROOT / ".github/production.json").read_text())
        self.deployment = {
            "id": "dpl_checked", "projectId": self.target["projectId"],
            "ownerId": self.target["orgId"], "target": "production", "readyState": "READY",
            "meta": {"releaseCommit": self.sha}, "url": "checked.vercel.app",
        }
        self.environment = {
            "GITHUB_REPOSITORY": "Mierkhat/" + self.target["facet"],
            "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": self.sha,
            "VERCEL_TOKEN": "test-placeholder",
        }

    def test_rejects_wrong_project_team_commit_and_environment(self):
        for key, value in [("projectId", "prj_other"), ("ownerId", "team_other"), ("target", "preview"), ("readyState", "ERROR"), ("meta", {})]:
            data = {**self.deployment, key: value}
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                release.validate_deployment(data, self.target, self.sha)

    def test_rejects_untrusted_deployment_origins(self):
        for host in ["vercel.app.attacker.example", "checked.vercel.app/path", "attacker@checked.vercel.app", "checked.vercel.app?key=1", "checked.vercel.app#fragment"]:
            with self.subTest(host=host), self.assertRaises(RuntimeError):
                release.validate_deployment({**self.deployment, "url": host}, self.target, self.sha)

    def test_accepts_cli_url_and_json_but_rejects_redirect_targets(self):
        origin = "https://checked.vercel.app"
        for output in [origin, json.dumps({"deployment": {"url": origin}}), json.dumps({"url": "checked.vercel.app"})]:
            self.assertEqual(release.deployment_output(output), origin)
        for output in ["https://attacker.example", origin + "/path", origin + "\nhttps://attacker.example"]:
            with self.assertRaises(RuntimeError):
                release.deployment_output(output)

    def run_main(self, tips, smoke_error=None, alias=None):
        def cmd(args, cwd=None):
            if args[:3] == ["git", "rev-parse", "HEAD"]:
                return self.sha
            if args[:2] == ["vercel", "deploy"]:
                return "https://checked.vercel.app"
            return ""
        with patch.dict(release.os.environ, self.environment, clear=True), \
             patch.object(release, "command", side_effect=cmd) as commands, \
             patch.object(release, "current_commit", side_effect=tips), \
             patch.object(release, "stage_source"), \
             patch.object(release, "api", side_effect=[self.deployment, alias or self.deployment]), \
             patch.object(release, "smoke", side_effect=smoke_error):
            if smoke_error:
                with self.assertRaises(RuntimeError):
                    release.main()
            else:
                release.main()
            return [call.args[0] for call in commands.call_args_list]

    def test_superseded_commit_never_deploys(self):
        calls = self.run_main(["b" * 40])
        self.assertFalse(any(args[:2] == ["vercel", "deploy"] for args in calls))

    def test_failed_smoke_never_promotes(self):
        calls = self.run_main([self.sha], RuntimeError("Database not ready"))
        self.assertFalse(any(args[:2] == ["vercel", "promote"] for args in calls))

    def test_commit_superseded_during_build_never_promotes(self):
        calls = self.run_main([self.sha, "b" * 40])
        self.assertFalse(any(args[:2] == ["vercel", "promote"] for args in calls))

    def test_only_tested_production_deployment_is_promoted(self):
        calls = self.run_main([self.sha, self.sha])
        deploy = next(args for args in calls if args[:2] == ["vercel", "deploy"])
        self.assertIn("--skip-domain", deploy)
        promote = next(args for args in calls if args[:2] == ["vercel", "promote"])
        self.assertEqual(promote[2], "https://checked.vercel.app")

    def test_rejects_pull_request_and_wrong_repository(self):
        for changes in [{"GITHUB_REF": "refs/pull/1/merge"}, {"GITHUB_REPOSITORY": "attacker/frontend"}, {"VERCEL_TOKEN": ""}]:
            with patch.dict(release.os.environ, {**self.environment, **changes}, clear=True), self.assertRaises(RuntimeError):
                release.main()

    def test_source_stage_rejects_private_files_and_symlinks(self):
        for name in [".env.production", "data/retry.json", "TASKS.md", "../outside", "link.txt"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory) / "source"
                root.mkdir()
                if name == "link.txt":
                    (root / name).symlink_to("/dev/null")
                output = Path(directory) / "stage"
                output.mkdir()
                with patch.object(release, "ROOT", root), patch.object(release, "command", return_value=name + "\0"), self.assertRaises(RuntimeError):
                    release.stage_source(output, self.target)

    def test_source_stage_rejects_modified_committed_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "source"
            root.mkdir()
            (root / "file.txt").write_bytes(b"modified")
            output = Path(directory) / "stage"
            output.mkdir()
            with patch.object(release, "ROOT", root), patch.object(release, "command", return_value="file.txt\0"), patch.object(release.subprocess, "check_output", return_value=b"committed"), self.assertRaises(RuntimeError):
                release.stage_source(output, self.target)


if __name__ == "__main__":
    unittest.main()
