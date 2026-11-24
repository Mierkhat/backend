"""Regression tests for automated merge admission, races and contributor feedback."""

import base64
import copy
from pathlib import Path
import unittest
import re
from unittest.mock import Mock, patch
import urllib.error

import auto_merge_prs as merger

HEAD, BASE = "a" * 40, "b" * 40
REPO = "Mierkhat/frontend"
PREFIX = f"repos/{REPO}/"


def pr():
    return {"number": 1, "state": "open", "draft": False, "title": "Fix #42",
            "body": "## Summary\nFix #42 and add regression coverage.", "author_association": "NONE",
            "user": {"login": "alice", "type": "User"}, "mergeable": True,
            "mergeable_state": "clean", "changed_files": 1,
            "head": {"sha": HEAD, "ref": "fix", "repo": {"id": 2, "full_name": "alice/example"}},
            "base": {"sha": BASE, "ref": "dev", "repo": {"id": 1, "full_name": REPO}}}


def run():
    return {"id": 12, "run_attempt": 2, "event": "pull_request", "path": merger.CI_PATH,
            "head_sha": HEAD, "head_branch": "fix", "head_repository": pr()["head"]["repo"],
            "repository": {"full_name": REPO}, "status": "completed", "conclusion": "success"}


class FakeGitHub:
    def __init__(self):
        self.repository, self.policy_ref = REPO, BASE
        self.pr, self.run = pr(), run()
        self.jobs = [{"name": "CI", "head_sha": HEAD, "status": "completed", "conclusion": "success"}]
        self.files = [{"filename": "src/fix.py"}]
        self.issue = {"title": "Fix bug", "body": "Acceptance criteria", "state": "open",
                      "state_reason": None,
                      "assignees": [{"login": "alice"}]}
        self.refs = set()
        self.issues = {}
        self.comments, self.reviews, self.statuses, self.checks = [], [], [], []
        self.resolved, self.branch = True, BASE
        self.writes, self.reads = [], []
        self.extra_runs, self.extra_jobs = {}, {}

    def linked_issues(self, number):
        return self.refs

    def request(self, path, method="GET", data=None):
        self.reads.append(path)
        if method in {"PUT", "PATCH"} or method == "POST" and path != "graphql":
            self.writes.append((path, method, data))
            if path.endswith("/merge"):
                self.pr.update(state="closed", merged=True, merged_at="2026-11-24T01:00:00Z", merge_commit_sha=BASE)
                return {"merged": True}
            if "/issues/" in path and method == "PATCH" and "state_reason" in data:
                key = path.rsplit("/", 1)[1]
                issue = self.issues.get(key, self.issue)
                issue.update(data)
                return copy.deepcopy(issue)
            return {"id": 1}
        if path.startswith(PREFIX + "actions/runs/"):
            match = re.fullmatch(re.escape(PREFIX) + r"actions/runs/(\d+)", path)
            if match and int(match[1]) in self.extra_runs:
                return copy.deepcopy(self.extra_runs[int(match[1])])
            match = re.match(re.escape(PREFIX) + r"actions/runs/(\d+)/attempts/(\d+)/jobs\?", path)
            if match and (int(match[1]), int(match[2])) in self.extra_jobs:
                return {"jobs": copy.deepcopy(self.extra_jobs[(int(match[1]), int(match[2]))])}
        if path == PREFIX + "pulls/1":
            return copy.deepcopy(self.pr)
        if path == PREFIX + "actions/runs/12":
            return copy.deepcopy(self.run)
        if "/actions/workflows/ci.yml/runs?" in path:
            return {"workflow_runs": [copy.deepcopy(self.run)]}
        if "/attempts/2/jobs?" in path:
            return {"jobs": copy.deepcopy(self.jobs)}
        if "/contents/" in path:
            return {"type": "file", "encoding": "base64", "content": base64.b64encode(b"## Summary\nDescribe change").decode()}
        if "/issues/" in path:
            return copy.deepcopy(self.issues.get(path.rsplit("/", 1)[1], self.issue))
        if "/compare/" in path:
            return {"merge_base_commit": {"sha": self.branch}, "status": "ahead"}
        if "/check-runs?" in path:
            return {"check_runs": copy.deepcopy(self.checks)}
        if "/git/ref/heads/" in path:
            return {"object": {"sha": self.branch}}
        if path == "graphql":
            return {"data": {"repository": {"pullRequest": {"reviewThreads": {
                "nodes": [{"isResolved": self.resolved}],
                "pageInfo": {"hasNextPage": False, "endCursor": None}}}}}}
        raise AssertionError(path)

    def pages(self, path):
        if path.endswith("/files"):
            return iter(copy.deepcopy(self.files))
        if path.endswith("/reviews"):
            return iter(copy.deepcopy(self.reviews))
        if path.endswith("/comments"):
            return iter(copy.deepcopy(self.comments))
        if path.endswith("/statuses"):
            return iter(copy.deepcopy(self.statuses))
        raise AssertionError(path)


class IssueCompletionTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeGitHub()
        self.api.pr.update(state="closed", merged=True, merged_at="2026-11-24T01:00:00Z", merge_commit_sha=BASE)
        self.bot = merger.IssueCompletion(self.api, "dev")

    def test_only_issues_assigned_to_original_author_are_completed(self):
        self.api.pr["body"] = "Closes #42. Related #43, #44, #45. outside/other#46"
        self.api.refs = {(REPO.lower(), 47)}
        self.api.issues = {
            "43": {**self.api.issue, "assignees": [{"login": "bob"}]},
            "44": {**self.api.issue, "assignees": []},
            "45": {**self.api.issue, "pull_request": {}},
            "47": {**self.api.issue, "assignees": [{"login": "ALICE"}, {"login": "bob"}]}}
        self.assertEqual(self.bot.process(1), "COMPLETED: 2 issue(s)")
        self.assertEqual([path.rsplit("/", 1)[1] for path, _, _ in self.api.writes], ["42", "47"])
        for _, method, data in self.api.writes:
            self.assertEqual(method, "PATCH")
            self.assertEqual(data, {"state": "closed", "state_reason": "completed"})

    def test_related_references_close_but_hidden_examples_do_not(self):
        self.api.pr["title"] = "Maintenance"
        self.api.pr["body"] = "Related #42.\n<!-- #43 -->\n```\n#44\n```"
        self.assertEqual(self.bot.process(1), "COMPLETED: 1 issue(s)")
        self.assertEqual([path.rsplit("/", 1)[1] for path, _, _ in self.api.writes], ["42"])

    def test_title_and_development_links_are_included_when_assigned(self):
        self.api.pr["title"] = "Fix #43"
        self.api.pr["body"] = "Related #42"
        self.api.refs = {(REPO.lower(), 44)}
        self.api.issues = {str(n): copy.deepcopy(self.api.issue) for n in (42, 43, 44)}
        self.assertEqual(self.bot.process(1), "COMPLETED: 3 issue(s)")
        self.assertEqual([path.rsplit("/", 1)[1] for path, _, _ in self.api.writes], ["42", "43", "44"])

    def test_assignment_revoked_after_merge_prevents_issue_completion(self):
        self.api.pr.update(state="open", merged=False, merged_at=None)
        policy = Mock()
        policy.decision.return_value = (True, "assigned")
        request = self.api.request
        def revoke(path, method="GET", data=None):
            result = request(path, method, data)
            if path.endswith("/merge"):
                self.api.issue["assignees"] = []
            return result
        with patch.object(self.api, "request", side_effect=revoke):
            self.assertTrue(merger.AutoMerge(self.api, policy, "dev").process(1).startswith("MERGED"))
        self.assertEqual(len(self.api.writes), 1)
        self.assertTrue(self.api.writes[0][0].endswith("/merge"))

    def test_maintainer_role_does_not_exempt_assignment_requirement(self):
        self.api.pr["author_association"] = "OWNER"
        self.api.issue["assignees"] = [{"login": "bob"}]
        self.assertEqual(self.bot.process(1), "COMPLETED: 0 issue(s)")
        self.assertEqual(self.api.writes, [])

    def test_unmerged_closed_draft_open_and_wrong_base_are_preserved(self):
        for changes in [{"merged": False}, {"state": "open"}, {"merged_at": None},
                        {"base": {**pr()["base"], "ref": "release"}},
                        {"base": {**pr()["base"], "repo": {"full_name": "other/example"}}}]:
            with self.subTest(changes=changes):
                original = copy.deepcopy(self.api.pr)
                self.api.pr.update(changes)
                self.assertTrue(self.bot.process(1).startswith("SKIP"))
                self.assertEqual(self.api.writes, [])
                self.api.pr = original

    def test_missing_or_nonancestor_merge_revision_is_preserved(self):
        self.api.pr["merge_commit_sha"] = None
        with self.assertRaises(ValueError):
            self.bot.process(1)
        self.api.pr["merge_commit_sha"] = HEAD
        with self.assertRaises(ValueError):
            self.bot.process(1)
        self.assertEqual(self.api.writes, [])

    def test_failed_pending_skipped_ci_or_external_check_blocks_completion(self):
        for status in ["failure", "cancelled", "skipped", "neutral", None]:
            with self.subTest(status=status):
                self.api.jobs[0]["conclusion"] = status
                self.assertTrue(self.bot.process(1).startswith("WAIT"))
                self.assertEqual(self.api.writes, [])
        self.api.jobs[0]["conclusion"] = "success"
        self.api.checks = [{"name": "external", "status": "in_progress", "conclusion": None}]
        self.assertTrue(self.bot.process(1).startswith("WAIT"))
        self.assertEqual(self.api.writes, [])

    def test_duplicate_mentions_and_native_completion_are_idempotent(self):
        self.api.pr["body"] = "Closes #42, #42"
        self.api.refs = {(REPO.lower(), 42)}
        self.assertEqual(self.bot.process(1), "COMPLETED: 1 issue(s)")
        self.assertEqual(self.bot.process(1), "COMPLETED: 0 issue(s)")
        self.assertEqual(len(self.api.writes), 1)

    def test_assignment_revoked_while_checks_are_read_is_preserved(self):
        verifier = merger.AutoMerge.current_ci
        def revoke(bot, candidate):
            self.api.issue["assignees"] = [{"login": "bob"}]
            return verifier(bot, candidate)
        with patch.object(merger.AutoMerge, "current_ci", revoke):
            self.assertEqual(self.bot.process(1), "COMPLETED: 0 issue(s)")
        self.assertEqual(self.api.writes, [])

    def test_closed_not_planned_is_marked_completed_only_when_assigned(self):
        self.api.issue.update(state="closed", state_reason="not_planned")
        self.assertEqual(self.bot.process(1), "COMPLETED: 1 issue(s)")
        self.assertEqual(self.api.issue["state_reason"], "completed")

    def test_dry_run_writes_nothing(self):
        self.assertEqual(self.bot.process(1, True), "WOULD COMPLETE: 1 issue(s)")
        self.assertEqual(self.api.writes, [])

    def test_partial_failure_is_retried_without_reclosing_completed_issues(self):
        self.api.pr["body"] = "Closes #42, #43"
        self.api.issues["43"] = copy.deepcopy(self.api.issue)
        request = self.api.request
        def fail(path, method="GET", data=None):
            if path.endswith("/issues/43") and method == "PATCH":
                raise urllib.error.HTTPError("https://api.github.com", 403, "denied", {}, None)
            return request(path, method, data)
        with patch.object(self.api, "request", side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, "periodic sweep will retry"):
                self.bot.process(1)
        self.assertEqual(self.api.issue["state_reason"], "completed")
        self.assertEqual(self.api.issues["43"]["state"], "open")
        self.assertEqual(self.bot.process(1), "COMPLETED: 1 issue(s)")

    def test_recent_reconciliation_paginates_and_stops_at_cutoff(self):
        recent = "2026-11-24T01:00:00Z"
        old = "2026-01-01T00:00:00Z"
        with patch.object(merger, "datetime") as clock:
            from datetime import datetime, timezone
            clock.now.return_value = datetime(2026, 11, 24, tzinfo=timezone.utc)
            clock.fromisoformat.side_effect = datetime.fromisoformat
            with patch.object(self.api, "pages", return_value=iter([
                {"number": 1, "updated_at": recent, "merged_at": recent},
                {"number": 2, "updated_at": recent, "merged_at": None},
                {"number": 3, "updated_at": old, "merged_at": old}])):
                self.assertEqual([x["number"] for x in self.bot.recent()], [1])

    def test_authenticated_cross_repository_writer_preserves_assignees(self):
        self.api.pr["title"] = "Maintenance"
        self.api.pr["body"] = "Related Mierkhat/backend#43"
        writer = Mock()
        writer.request.return_value = {"state": "closed", "state_reason": "completed"}
        with patch.dict(merger.os.environ, {"ISSUE_COMPLETION_TOKEN": "test-only"}), patch.object(merger, "GitHub", return_value=writer):
            bot = merger.IssueCompletion(self.api, "dev")
            self.assertEqual(bot.process(1), "COMPLETED: 1 issue(s)")
        writer.request.assert_called_once_with("repos/mierkhat/backend/issues/43", "PATCH", {"state": "closed", "state_reason": "completed"})
        self.assertEqual(self.api.issue["assignees"], [{"login": "alice"}])

    def test_other_organization_repositories_are_outside_completion_scope(self):
        self.api.pr["title"] = "Maintenance"
        self.api.pr["body"] = "Related Mierkhat/other#43 and outside/project#44"
        self.assertEqual(self.bot.process(1), "COMPLETED: 0 issue(s)")
        self.assertEqual(self.api.writes, [])
        self.assertFalse(any("/issues/" in path for path in self.api.reads))

    def test_failed_closure_retries_without_remerging(self):
        original = self.api.request
        fail = True
        def request(path, method="GET", data=None):
            nonlocal fail
            if method == "PATCH" and fail:
                fail = False
                raise OSError("temporary issue write failure")
            return original(path, method, data)
        with patch.object(self.api, "request", side_effect=request):
            with self.assertRaises(RuntimeError):
                self.bot.process(1)
            self.assertEqual(self.bot.process(1), "COMPLETED: 1 issue(s)")
        self.assertFalse(any(path.endswith("/merge") for path, _, _ in self.api.writes))


if __name__ == "__main__":
    unittest.main()
