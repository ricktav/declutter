#!/bin/bash
# Run the Mini-side Systems collectors against one HomeBase API.
# Fleet (containers / web / databases / directory projects), /projects/ (tokens),
# then Proxmox (VMs / LXC / guest ports / GUI). Dry unless --apply.
# Optional --local adds this host's Docker via services-report-local.ts.
#
#   ./scripts/services-report-all.sh
#   ./scripts/services-report-all.sh --apply
#   ./scripts/services-report-all.sh --apply --base http://127.0.0.1:3001
#   ./scripts/services-report-all.sh --apply --ssh root@10.50.0.155
#   ./scripts/services-report-all.sh --apply --local --item 51
#   ./scripts/services-report-all.sh --timeout 120
#
# Each step is capped by a perl alarm (macOS has no timeout(1)); default 300s
# or HOMEBASE_STEP_TIMEOUT. launchd: scripts/launchd/nl.homebase.services-report.plist
# Until this branch is on production, point the plist at the worktree that has
# these scripts, not /Volumes/T7/declutter on main.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

# Strings, not empty arrays: bash 3.2 + set -u treats APPLY[@] as unbound.
APPLY=""
BASE_URL="${HOMEBASE_BASE:-http://127.0.0.1:3001}"
SSH_TARGET="${HOMEBASE_PVE_SSH:-root@10.50.0.155}"
LOCAL=0
ITEM=""
STEP_TIMEOUT="${HOMEBASE_STEP_TIMEOUT:-300}"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=--apply; shift ;;
    --dry) APPLY=""; shift ;;
    --local) LOCAL=1; shift ;;
    --timeout)
      if [ -z "${2:-}" ] || [ "${2#--}" != "$2" ]; then
        echo "services-report-all: --timeout needs seconds" >&2
        exit 2
      fi
      STEP_TIMEOUT="$2"
      shift 2
      ;;
    --item)
      if [ -z "${2:-}" ] || [ "${2#--}" != "$2" ]; then
        echo "services-report-all: --item needs an id" >&2
        exit 2
      fi
      ITEM="$2"
      LOCAL=1
      shift 2
      ;;
    --base)
      if [ -z "${2:-}" ] || [ "${2#--}" != "$2" ]; then
        echo "services-report-all: --base needs a URL" >&2
        exit 2
      fi
      BASE_URL="$2"
      shift 2
      ;;
    --ssh)
      if [ -z "${2:-}" ] || [ "${2#--}" != "$2" ]; then
        echo "services-report-all: --ssh needs user@host" >&2
        exit 2
      fi
      SSH_TARGET="$2"
      shift 2
      ;;
    *)
      echo "services-report-all: unknown arg $1" >&2
      exit 2
      ;;
  esac
done

if [ "$LOCAL" -eq 0 ] && [ "${HOMEBASE_LOCAL:-}" = "1" ]; then
  LOCAL=1
fi

fail=0
run() {
  echo "=== $* ===" >&2
  # Fork + alarm + kill: macOS has no timeout(1); exec-then-alarm is lost if
  # node ignores SIGALRM. 124 = this step hit STEP_TIMEOUT.
  perl -e '
    my $secs = shift;
    die "timeout secs\n" unless $secs =~ /^\d+$/ && $secs > 0;
    my $pid = fork();
    die "fork: $!\n" unless defined $pid;
    if ($pid == 0) { exec @ARGV; exit 127; }
    $SIG{ALRM} = sub { kill "TERM", $pid; sleep 1; kill "KILL", $pid; exit 124; };
    alarm $secs;
    waitpid $pid, 0;
    my $st = $?;
    alarm 0;
    if ($st & 127) { exit 128 + ($st & 127); }
    exit $st >> 8;
  ' "$STEP_TIMEOUT" node --experimental-strip-types "$@"
  st=$?
  if [ "$st" -ne 0 ]; then
    if [ "$st" -eq 124 ]; then
      echo "TIMEOUT after ${STEP_TIMEOUT}s: $*" >&2
    fi
    echo "FAILED: $* (exit $st)" >&2
    fail=1
  fi
}

run scripts/services-report-fleet.ts ${APPLY:+"$APPLY"} --base "$BASE_URL"
run scripts/services-report-projects.ts ${APPLY:+"$APPLY"} --base "$BASE_URL"
run scripts/services-report-proxmox.ts --ssh "$SSH_TARGET" ${APPLY:+"$APPLY"} --base "$BASE_URL"
if [ "$LOCAL" -eq 1 ]; then
  run scripts/services-report-local.ts ${APPLY:+"$APPLY"} --base "$BASE_URL" ${ITEM:+--item} ${ITEM:+"$ITEM"}
fi

if [ "$fail" -ne 0 ]; then
  echo "services-report-all: one or more collectors failed" >&2
  exit 1
fi
echo "services-report-all: ok${APPLY:+ (applied)}" >&2
