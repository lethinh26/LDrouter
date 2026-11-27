#!/usr/bin/env bash
# Disposable Linux GitHub Actions runner ONLY. Never fall back to host networking.
set -euo pipefail
umask 077
if [[ "$(uname -s)" != Linux || "${GITHUB_ACTIONS:-}" != true || "${CI:-}" != true || "$(id -u)" == 0 ]]; then
  echo "This fixture requires an unprivileged user on a disposable Linux GitHub Actions runner." >&2
  exit 1
fi
if [[ $# != 1 ]]; then
  echo "Usage: bash tests/e2e/client_cli_smoke.sh ABSOLUTE_OFFICIAL_CLI_INSTALL_PREFIX" >&2
  exit 1
fi
prefix="$(realpath -e -- "$1")"
script="$(realpath -e -- "$(dirname -- "$0")/client_cli_smoke.mjs")"
node="$(realpath -e -- "$(command -v node)")"
node_bin="$(dirname -- "$node")"
[[ -x "$prefix/node_modules/.bin/codex" && -x "$prefix/node_modules/.bin/claude" ]]
parent_net="$(readlink /proc/self/ns/net)"
parent_pid="$(readlink /proc/self/ns/pid)"
uid="$(id -u)"
gid="$(id -g)"
root="$(mktemp -d /tmp/ldrouter-cli-smoke.XXXXXXXX)"
trap 'rm -rf -- "$root"' EXIT
cd "$root"
# sudo is used ONLY to create the isolated namespaces on the disposable runner.
# The gateway and both CLIs run as the original non-root user with no capabilities.
# PID namespace teardown kills any descendants, even if they change process groups.
timeout --kill-after=10s 300s sudo -n -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  /usr/bin/unshare --net --pid --fork --mount-proc --kill-child=SIGKILL \
  /bin/sh -eu -c '
    ip link set lo up
    exec /usr/bin/setpriv --reuid "$1" --regid "$2" --clear-groups \
      --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs \
      /usr/bin/env -i PATH="$3:/usr/bin:/bin" HOME="$4" LANG=C.UTF-8 \
      CI=true GITHUB_ACTIONS=true LD_CLI_PARENT_NET="$5" LD_CLI_PARENT_PID="$6" \
      "$7" "$8" "$4" "$9"
  ' fixture "$uid" "$gid" "$node_bin" "$root" "$parent_net" "$parent_pid" "$node" "$script" "$prefix"
