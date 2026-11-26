"""Regression tests for static inspection, Git object boundaries, and status reporting."""

from contextlib import chdir, redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import check_workflow_security as workflow_security
import pr_safety as safety


BASE, HEAD = "a" * 40, "b" * 40
REPOSITORY = "Mierkhat/example"


class FindingsTests(unittest.TestCase):
    def test_hidden_text_is_reported_without_echoing_it(self):
        old = "existing" + " " * 40 + "alignment\n"
        changed = old + "public" + "\t" * 5 + "private\n" + "ordinary\u202etext\n"
        findings = list(safety.findings(".gitignore", old, changed))
        self.assertEqual([line for line, _ in findings], [2, 3])
        self.assertTrue(all("concealed" in reason for _, reason in findings))
        self.assertNotIn("private", str(findings))

    def test_nested_manifests_are_compared_semantically(self):
        old = json.dumps({"scripts": {"postinstall": "placeholder", "build": "old"}})
        unchanged = json.dumps({"scripts": {"build": "new", "postinstall": "placeholder"}}, indent=2)
        changed = json.dumps({"scripts": {"postinstall": "changed", "prepare": "placeholder"}})
        self.assertEqual(list(safety.findings("packages/protocol/package.json", old, unchanged)), [])
        self.assertEqual(len(list(safety.findings("evm/package.json", old, changed))), 2)
        self.assertEqual(len(list(safety.findings("evm/package.json", None, "{"))), 1)

    def test_extensionless_editor_and_eslint_surfaces(self):
        for path, contents in (("evm/init", "placeholder"), ("packages/protocol/init", "placeholder"),
                               (".vscode/tasks.json", '{"runOn": "folderOpen"}'),
                               ("packages/protocol/eslint.config.mjs", '// "node:child_process"')):
            with self.subTest(path=path):
                self.assertTrue(list(safety.findings(path, None, contents, new=True)))
        self.assertFalse(list(safety.findings(".vscode/tasks.json", None, '{"runOn": "default"}')))
        self.assertFalse(list(safety.findings("eslint.config.mjs", None, "export default [];")))


class GitObjectTests(unittest.TestCase):
    def test_objects_scanned_without_worktree_files_or_symlink_resolution(self):
        with tempfile.TemporaryDirectory() as directory, chdir(directory):
            safety.git("init", "-q")
            safety.git("config", "user.name", "Fixture")
            safety.git("config", "user.email", "fixture@example.invalid")
            safety.git("commit", "-qm", "base", "--allow-empty")
            base = safety.git("rev-parse", "HEAD").decode().strip()
            Path("source.txt").write_text("ordinary text\n")
            safety.git("add", "source.txt")
            safety.git("commit", "-qm", "benign change")
            clean = safety.git("rev-parse", "HEAD").decode().strip()
            Path("source.txt").write_text("left" + " " * 35 + "right\n")
            Path("link").symlink_to("nonexistent-target")
            safety.git("add", "source.txt", "link")
            safety.git("commit", "-qm", "static fixtures")
            head = safety.git("rev-parse", "HEAD").decode().strip()
            Path("source.txt").unlink()
            Path("link").unlink()
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertTrue(safety.scan(base, base))
                self.assertTrue(safety.scan(base, clean))
                self.assertFalse(safety.scan(clean, head))
            self.assertIn('"source.txt":1:', output.getvalue())
            self.assertIn('"link":1:', output.getvalue())
            self.assertNotIn("nonexistent-target", output.getvalue())

    @patch.object(safety, "git", side_effect=[b"", BASE.encode()])
    def test_fetch_of_moved_head_is_rejected(self, git):
        with self.assertRaisesRegex(ValueError, "head moved"):
            safety.verified_head(REPOSITORY, 7, HEAD)
        self.assertEqual(git.call_args_list[0].args[-1], "refs/pull/7/head")


class ReportingTests(unittest.TestCase):
    def setUp(self):
        self.pr = {"state": "open", "base": {"sha": BASE, "ref": "dev", "repo": {"full_name": REPOSITORY}},
                   "head": {"sha": HEAD}}

    @patch.object(safety, "api")
    def test_only_exact_live_head_gets_result(self, api):
        api.return_value = self.pr
        for success, expected in [(True, "success"), (False, "failure")]:
            safety.report(REPOSITORY, "7", BASE, HEAD, success, "12")
            self.assertEqual(api.call_args.args[1], f"statuses/{HEAD}")
            self.assertEqual(api.call_args.args[2]["context"], "PR safety")
            self.assertEqual(api.call_args.args[2]["state"], expected)
        api.reset_mock()
        self.pr["base"]["sha"] = HEAD
        with self.assertRaisesRegex(ValueError, "stale status"):
            safety.report(REPOSITORY, "7", BASE, HEAD, True, "12")
        api.assert_called_once_with(REPOSITORY, "pulls/7")

    def test_privileged_workflow_does_not_allow_head_checkout_or_broad_permissions(self):
        path = Path(__file__).resolve().parents[1] / "workflows" / "pr-safety.yml"
        text = path.read_text()
        workflow_security.validate(path.name, text, "")
        for changed in (text.replace("ref: ${{ github.event.pull_request.base.sha }}",
                                     "ref: ${{ github.event.pull_request.head.sha }}"),
                        text.replace("contents: read", "contents: write"),
                        text.replace("GITHUB_TOKEN: ${{ github.token }}", "GITHUB_TOKEN: ${{ secrets.CUSTOM }}")):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                workflow_security.validate(path.name, changed, "")


if __name__ == "__main__":
    unittest.main()
