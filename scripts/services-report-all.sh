#!/bin/bash
# Run the Mini-side Systems collectors against one HomeBase API.
# Fleet (containers / web / databases / directory projects), /projects/ (tokens),
# then Proxmox (VMs / LXC / guest ports / GUI). Dry unless --apply.
#
#   ./scripts/services-report-all.sh
#   ./scripts/services-report-all.sh --apply
#   ./scripts/services-report-all.sh --apply --base http://127.0.0.1:3001
#   ./scripts/services-report-all.sh --apply --ssh root@10.50.0.155
#
# launchd on macmini-m4: scripts/launchd/nl.homebase.services-report.plist
# (07:40 local). Until this branch is on production, point the plist at the
# worktree that has these scripts, not /Volumes/T7/declutter on main.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

APPLY=()
BASE=(--base "${HOMEBASE_BASE:-http://127.0.0.1:3001}")
SSH=(--ssh "${HOMEBASE_PVE_SSH:-root@10.50.0.155}")
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=(--apply); shift ;;
    --dry) APPLY=(); shift ;;
    --base)
      if [ -z "${2:-}" ] || [ "${2#--}" != "$2" ]; then
        echo "services-report-all: --base needs a URL" >&2
        exit 2
      fi
      BASE=(--base "$2")
      shift 2
      ;;
    --ssh)
      if [ -z "${2:-}" ] || [ "${2#--}" != "$2" ]; then
        echo "services-report-all: --ssh needs user@host" >&2
        exit 2
      fi
      SSH=(--ssh "$2")
      shift 2
      ;;
    *)
      echo "services-report-all: unknown arg $1" >&2
      exit 2
      ;;
  esac
done

NODE=(node --experimental-strip-types)
fail=0
run() {
  echo "=== $* ===" >&2
  if ! "${NODE[@]}" "$@"; then
    echo "FAILED: $*" >&2
    fail=1
  fi
}

run scripts/services-report-fleet.ts "${APPLY[@]}" "${BASE[@]}"
run scripts/services-report-projects.ts "${APPLY[@]}" "${BASE[@]}"
run scripts/services-report-proxmox.ts "${SSH[@]}" "${APPLY[@]}" "${BASE[@]}"

if [ "$fail" -ne 0 ]; then
  echo "services-report-all: one or more collectors failed" >&2
  exit 1
fi
echo "services-report-all: ok${APPLY[*]:+ (applied)}" >&2
