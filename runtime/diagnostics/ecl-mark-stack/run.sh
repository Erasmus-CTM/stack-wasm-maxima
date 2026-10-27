#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Usage: run.sh ECL compiled|interpreted FIRST LAST
# Runs one fresh ECL process per recursion depth in FIRST..LAST and prints
# each depth whose collection aborts with "Unexpected mark stack overflow".
# Exits 1 if any depth aborted, 0 if none did, 2 on any other failure.
# Set NOASLR=1 to run under "setarch -R", which makes the result per depth
# repeatable; with address randomisation the aborting depths move between runs.
set -u
ecl=${1:?usage: run.sh ECL compiled|interpreted FIRST LAST}
mode=${2:?}
first=${3:?}
last=${4:?}
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
case $mode in
  compiled)
    cp "$here/deep.lisp" "$work/"
    (cd "$work" && "$ecl" --norc --eval '(compile-file "deep.lisp")' --eval '(ext:quit)') \
      >"$work/compile.log" 2>&1 && [ -f "$work/deep.fas" ] || { cat "$work/compile.log"; exit 2; }
    file=$work/deep.fas ;;
  interpreted) file=$here/deep-bc.lisp ;;
  *) echo "unknown mode $mode" >&2; exit 2 ;;
esac
prefix=
[ "${NOASLR:-0}" = 1 ] && prefix="setarch $(uname -m) -R"
aborts=0
d=$first
while [ "$d" -le "$last" ]; do
  # The expected sum guards against a collection that frees live data.
  $prefix "$ecl" --norc --load "$file" \
    --eval "(unless (= (deep $d) (/ (* $d (1+ $d)) 2)) (ext:quit 3))" \
    --eval '(ext:quit)' >"$work/out.log" 2>&1
  status=$?
  if grep -q 'Unexpected mark stack overflow' "$work/out.log"; then
    echo "depth $d: Unexpected mark stack overflow (exit status $status)"
    aborts=$((aborts + 1))
  elif [ "$status" -ne 0 ]; then
    echo "depth $d: unexpected exit status $status"
    cat "$work/out.log"
    exit 2
  fi
  d=$((d + 1))
done
echo "$aborts aborting depths in $first..$last ($mode)"
[ "$aborts" -eq 0 ]
