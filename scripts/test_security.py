"""Regression checks for security gate rejection, not application policy mocks."""
import copy
import importlib.util
from pathlib import Path
import unittest
import yaml


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name.replace("_", "-") + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class WorkflowPolicy(unittest.TestCase):
    def test_current_workflow_and_reject_privilege_changes(self):
        checker = module("check_workflows")
        data = yaml.load(Path(".github/workflows/verify.yml").read_text(), Loader=yaml.BaseLoader)
        checker.validate(data)
        mutations = [
            lambda d: d.update(permissions={"contents": "write"}),
            lambda d: d["on"].update(pull_request_target={}),
            lambda d: d["jobs"]["security"].update(permissions={"contents": "write"}),
            lambda d: d["jobs"]["security"].update(env={"KEY": "${{ secrets [ 'KEY' ] }}"}),
            lambda d: d.update(env={"KEY": "${{ secrets.KEY }}"}),
            lambda d: d["jobs"]["application"].update(environment="production"),
            lambda d: d["jobs"]["security"].update({"continue-on-error": "true"}),
            lambda d: d["jobs"]["security"].update({"if": "false"}),
            lambda d: d["jobs"]["security"]["steps"][0].update(uses="actions/checkout@main"),
            lambda d: d["jobs"]["security"]["steps"][0]["with"].update({"persist-credentials": "true"}),
            lambda d: d["jobs"]["ci"].update(needs=["application"]),
        ]
        if "production" in data["jobs"]:
            mutations.append(lambda d: d["jobs"]["production"].update({"if": "always()"}))
        for mutate in mutations:
            candidate = copy.deepcopy(data)
            mutate(candidate)
            with self.subTest(candidate=candidate), self.assertRaises(SystemExit):
                checker.validate(candidate)

    def test_sdk_barrel_rejects_executable_or_external_export(self):
        checker = module("scan_security")
        checker.validate_barrel('export * from "./policy.js";\nexport type * as ContractTypes from "./generated/types.js";\n')
        for candidate in ['export * from "./../scripts/evil.js";', 'export const x = eval(input);', 'export * from "https://evil.test/x.js";', 'export * from "./ok.js";\nfetch(url);']:
            with self.assertRaises(SystemExit):
                checker.validate_barrel(candidate)


class ScannerRejection(unittest.TestCase):
    def test_real_analyzer_blocks_sql_and_eval(self):
        import json
        import subprocess
        import sys
        import tempfile
        with tempfile.TemporaryDirectory(prefix="mierkhat-security-") as directory:
            target = Path(directory) / "injection.ts"
            target.write_text('function handler(req, db) { db.query(req.body.sql); eval(req.query.code); }')
            result = subprocess.run([str(Path(sys.prefix) / "bin" / "semgrep"), "scan", "--config", ".github/security-rules", "--config", ".github/semgrep-project.yml", "--error", "--strict", "--metrics", "off", "--disable-version-check", "--no-git-ignore", "--json", str(target)], text=True, capture_output=True)
            self.assertEqual(result.returncode, 1, result.stderr)
            findings = json.loads(result.stdout)["results"]
            self.assertTrue(any("mierkhat-sql-request-injection" in f["check_id"] for f in findings))
            self.assertTrue(any("eval" in f["check_id"] for f in findings))
