#!/usr/bin/env bash
set -euo pipefail
ci_tools="$(mktemp -d)"
trap 'rm -rf "$ci_tools"' EXIT
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz -o "$ci_tools/gitleaks.tgz"
printf '%s  %s\n' 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb "$ci_tools/gitleaks.tgz" | sha256sum --check
tar -xzf "$ci_tools/gitleaks.tgz" -C "$ci_tools" gitleaks
"$ci_tools/gitleaks" git --redact=100 --no-banner --log-opts='--all'
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz -o "$ci_tools/actionlint.tgz"
printf '%s  %s\n' 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 "$ci_tools/actionlint.tgz" | sha256sum --check
tar -xzf "$ci_tools/actionlint.tgz" -C "$ci_tools" actionlint
"$ci_tools/actionlint" -shellcheck=''
python3 -B .github/scripts/check_workflow_security.py
