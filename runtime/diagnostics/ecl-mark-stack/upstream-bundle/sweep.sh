#!/bin/sh
# Usage: sh sweep.sh /path/to/ecl [FIRST LAST]
# Compiles deep.lisp, then runs (deep N) in a fresh process for each N and
# prints every N that aborts with "Unexpected mark stack overflow".
# Prefix with "setarch -R" (disable address randomisation) for repeatable results.
ecl=${1:?usage: sh sweep.sh /path/to/ecl [FIRST LAST]}
first=${2:-3600}
last=${3:-4700}
"$ecl" --norc --eval '(compile-file "deep.lisp")' --eval '(ext:quit)' >/dev/null 2>&1 || exit 2
n=$first
while [ "$n" -le "$last" ]; do
  if "$ecl" --norc --load deep.fas --eval "(deep $n)" --eval '(ext:quit)' 2>&1 |
     grep -q 'Unexpected mark stack overflow'; then
    echo "N=$n: Unexpected mark stack overflow"
  fi
  n=$((n + 1))
done
