import importlib.util
import io
import os
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location("compatibility", Path(__file__).with_name("check-compatibility.py"))
compatibility = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compatibility)


class FetchTests(unittest.TestCase):
    def response(self):
        result = MagicMock()
        result.__enter__.return_value.read.return_value = b"pinned bytes"
        return result

    def error(self, code, headers=None):
        return urllib.error.HTTPError("https://api.github.com/pinned", code, "error", headers or {}, io.BytesIO())

    def test_transient_failure_retries_and_limits_token_to_api(self):
        opener = MagicMock()
        opener.open.side_effect = [self.error(403, {"X-RateLimit-Remaining": "0", "Retry-After": "2"}), self.response(), self.response()]
        with patch.dict(os.environ, {"GITHUB_TOKEN": "test-credential"}), patch.object(compatibility.urllib.request, "build_opener", return_value=opener), patch.object(compatibility.time, "sleep") as sleep:
            self.assertEqual(compatibility.fetch_bytes("https://api.github.com/pinned"), b"pinned bytes")
            self.assertEqual(compatibility.fetch_bytes("https://raw.githubusercontent.com/pinned"), b"pinned bytes")
        sleep.assert_called_once_with(2)
        self.assertEqual(opener.open.call_args_list[0].args[0].get_header("Authorization"), "Bearer test-credential")
        self.assertFalse(opener.open.call_args_list[-1].args[0].has_header("Authorization"))

    def test_permanent_error_does_not_retry(self):
        for code in (401, 403, 404):
            opener = MagicMock(); opener.open.side_effect = self.error(code)
            with patch.object(compatibility.urllib.request, "build_opener", return_value=opener), patch.object(compatibility.time, "sleep") as sleep:
                with self.assertRaises(urllib.error.HTTPError) as caught: compatibility.fetch_bytes("https://api.github.com/pinned")
                caught.exception.close()
            sleep.assert_not_called(); self.assertEqual(opener.open.call_count, 1)

    def test_timeout_and_server_errors_have_bounded_attempts(self):
        for error in (TimeoutError(), self.error(503)):
            opener = MagicMock(); opener.open.side_effect = error
            with patch.object(compatibility.urllib.request, "build_opener", return_value=opener), patch.object(compatibility.time, "sleep") as sleep:
                with self.assertRaises(RuntimeError): compatibility.fetch_bytes("https://api.github.com/pinned")
            self.assertEqual(opener.open.call_count, 3); self.assertEqual(sleep.call_count, 2)

    def test_rate_limit_longer_than_budget_fails_without_waiting(self):
        opener = MagicMock(); opener.open.side_effect = self.error(429, {"Retry-After": "3600"})
        with patch.object(compatibility.urllib.request, "build_opener", return_value=opener), patch.object(compatibility.time, "sleep") as sleep:
            with self.assertRaises(RuntimeError): compatibility.fetch_bytes("https://api.github.com/pinned")
        sleep.assert_not_called(); self.assertEqual(opener.open.call_count, 1)

    def test_authenticated_redirect_cannot_forward_to_another_host(self):
        redirect = compatibility.PublicRedirects()
        request = urllib.request.Request("https://api.github.com/pinned", headers={"Authorization": "Bearer test-credential"})
        for url in ("https://example.org/", "https://raw.githubusercontent.com/pinned", "http://api.github.com/pinned"):
            with self.assertRaises(ValueError): redirect.redirect_request(request, None, 302, "redirect", {}, url)


if __name__ == "__main__":
    unittest.main()
