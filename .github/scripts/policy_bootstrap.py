import base64
import json
import os
import re
import sys
import types
import urllib.parse
import urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Authenticated API redirect refused")

revision = os.environ["POLICY_SHA"]
if not re.fullmatch(r"[0-9a-f]{40}", revision):
    raise ValueError("Invalid trusted workflow revision")
if os.environ["DEFAULT_BRANCH"] != "dev":
    sys.exit("Contributor automation activates when dev is the default branch.")
allowed = {"enforce_pr_assignments", "check_pr_description", "approve_pr_ci", "auto_merge_prs"}
modules = os.environ["POLICY_MODULES"].split(",")
entrypoint = os.environ["POLICY_ENTRYPOINT"]
if entrypoint not in modules or not set(modules) <= allowed:
    raise ValueError("Invalid trusted policy modules")
for module in modules:
    path = ".github/scripts/" + module + ".py"
    query = urllib.parse.urlencode({"ref": revision})
    request = urllib.request.Request(
        "https://api.github.com/repos/" + os.environ["GITHUB_REPOSITORY"]
        + "/contents/" + path + "?" + query,
        headers={"Authorization": "Bearer " + os.environ["GITHUB_TOKEN"],
                 "Accept": "application/vnd.github+json",
                 "User-Agent": "mierkhat-contributor-policy"},
    )
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        content = json.load(response)
    if content.get("type") != "file" or content.get("encoding") != "base64":
        raise ValueError("Trusted policy module unavailable")
    source = base64.b64decode(content["content"])
    loaded = types.ModuleType(module)
    sys.modules[module] = loaded
    exec(compile(source, path, "exec"), loaded.__dict__)
sys.exit(sys.modules[entrypoint].main())
