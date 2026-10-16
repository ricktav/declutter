#!/bin/sh
# Run on the machine being measured. Prints TSV on stdout for
# scripts/storage-report-starred.ts (keep skip rules in sync with
# api/lib/storageMeasure.ts / scripts/storage-report-local.mjs).
# Needs df, du, find — no Node. stderr is progress.
#   sh scripts/storage-measure-remote.sh --dirs 15
TOP_N=15
while [ $# -gt 0 ]; do
  case "$1" in
    --dirs)
      TOP_N=$2
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
case "$TOP_N" in
  ''|*[!0-9]*) TOP_N=15 ;;
esac
if [ "$TOP_N" -lt 1 ]; then TOP_N=1; fi
if [ "$TOP_N" -gt 100 ]; then TOP_N=100; fi
TAB=`printf '\t'`

skip_mount() {
  mp=$1
  [ "$mp" = / ] && return 1
  [ "$mp" = /System/Volumes/Data ] && return 1
  [ "$mp" = /System ] && return 0
  case "$mp" in
    /System/*|/private/var/vm|/private/var/vm/*|/dev|/dev/*) return 0 ;;
    *CoreSimulator*) return 0 ;;
    /proc|/proc/*|/sys|/sys/*|/run|/run/*|/snap|/snap/*) return 0 ;;
    *com.apple.TimeMachine*|*localsnapshots*) return 0 ;;
  esac
  echo "$mp" | grep -qi '\.timemachine' && return 0
  return 1
}

skip_fs() {
  case "$(echo "$1" | tr 'A-Z' 'a-z')" in
    tmpfs|devtmpfs|overlay|squashfs|ramfs|proc|sysfs|cgroup|cgroup2|nsfs|autofs|devfs|efivarfs|tracefs|securityfs|pstore|bpf|debugfs|hugetlbfs|mqueue|fusectl|rpc_pipefs|binfmt_misc|nfs|nfs4|cifs|smbfs|afpfs|fuse.sshfs|fuse.rclone) return 0 ;;
  esac
  return 1
}

UNAME=`uname`
TMP=`mktemp -t homebase-df.XXXXXX` || exit 1
trap 'rm -f "$TMP"' EXIT
if [ "$UNAME" = Darwin ]; then
  df -kP > "$TMP"
  DARWIN=1
else
  if df -kPT > "$TMP" 2>/dev/null; then
    DARWIN=0
  else
    df -kP > "$TMP"
    DARWIN=1
  fi
fi

# rows: device fs container mount blocks used avail
ROWS=`mktemp -t homebase-vol.XXXXXX` || exit 1
trap 'rm -f "$TMP" "$ROWS"' EXIT
: > "$ROWS"

awk -v darwin="$DARWIN" '
  NR == 1 { next }
  $1 !~ /^\/dev\// { next }
  $1 ~ /\/loop/ { next }
  {
    if (darwin == 1) {
      fs = "-"
      blocks = $2; used = $3; avail = $4
      mp = $0
      sub(/^[^ \t]+[ \t]+[0-9]+[ \t]+[0-9]+[ \t]+[0-9]+[ \t]+[^ \t]+[ \t]+/, "", mp)
    } else {
      fs = $2
      blocks = $3; used = $4; avail = $5
      mp = $0
      sub(/^[^ \t]+[ \t]+[^ \t]+[ \t]+[0-9]+[ \t]+[0-9]+[ \t]+[0-9]+[ \t]+[^ \t]+[ \t]+/, "", mp)
    }
    if (blocks == "" || mp == "") next
    dev = $1
    sub(/^\/dev\//, "", dev)
    printf "%s\t%s\t%s\t%s\t%s\t%s\n", dev, fs, mp, blocks, used, avail
  }
' "$TMP" | while IFS="$TAB" read -r dev fs mp blocks used avail; do
  skip_fs "$fs" && continue
  skip_mount "$mp" && continue
  container=-
  case "$dev" in
    disk[0-9]*s[0-9]*)
      container=`echo "$dev" | sed -n 's/^\(disk[0-9][0-9]*\)s[0-9][0-9]*.*/\1/p'`
      [ -n "$container" ] || container=-
      ;;
  esac
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$dev" "$fs" "$container" "$mp" "$blocks" "$used" "$avail" >> "$ROWS"
done

HAS_DATA=0
awk -F '\t' '$4 == "/System/Volumes/Data" { found=1 } END { exit found ? 0 : 1 }' "$ROWS" && HAS_DATA=1

while IFS="$TAB" read -r dev fs container mp blocks used avail; do
  [ -n "$mp" ] || continue
  cap=`awk -v b="$blocks" 'BEGIN { printf "%.0f", b * 1024 }'`
  if [ "$container" != - ]; then
    usedb=`awk -v u="$used" 'BEGIN { printf "%.0f", u * 1024 }'`
  else
    usedb=`awk -v b="$blocks" -v a="$avail" 'BEGIN { printf "%.0f", (b - a) * 1024 }'`
  fi
  printf 'VOL\t%s\t%s\t%s\t%s\t%s\t%s\n' "$mp" "$dev" "$fs" "$container" "$cap" "$usedb"
done < "$ROWS"

# Biggest top-level folders. On a Mac, du from "/" follows firmlinks into Data.
while IFS="$TAB" read -r dev fs container mp blocks used avail; do
  [ -n "$mp" ] || continue
  if [ "$mp" = / ] && [ "$HAS_DATA" -eq 1 ]; then
    continue
  fi
  echo "measuring $mp …" >&2
  DIRTMP=`mktemp -t homebase-dirs.XXXXXX` || continue
  find "$mp" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | while IFS= read -r p; do
    base=`basename "$p"`
    case "$base" in
      .Trashes) ;;
      .*) continue ;;
    esac
    out=`du -xsk "$p" 2>/dev/null`
    [ -n "$out" ] || out=`du -sk "$p" 2>/dev/null`
    kb=`echo "$out" | awk '{ print $1; exit }'`
    case "$kb" in
      ''|*[!0-9]*) continue ;;
    esac
    bytes=`awk -v k="$kb" 'BEGIN { printf "%.0f", k * 1024 }'`
    if [ "$mp" = /System/Volumes/Data ]; then
      dirpath="/$base"
    else
      dirpath=$p
    fi
    printf '%s\t%s\n' "$bytes" "$dirpath" >> "$DIRTMP"
  done
  sort -nr "$DIRTMP" | head -n "$TOP_N" | while IFS="$TAB" read -r bytes dirpath; do
    [ -n "$dirpath" ] || continue
    printf 'DIR\t%s\t%s\t%s\n' "$mp" "$dirpath" "$bytes"
  done
  rm -f "$DIRTMP"
done < "$ROWS"
