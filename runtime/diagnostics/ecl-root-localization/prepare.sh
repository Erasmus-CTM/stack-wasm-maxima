#!/bin/sh
# SPDX-License-Identifier: CC0-1.0
# Prepare inert local libraries only. Does not launch ECL or download anything.
set -eu
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    echo "Usage: sh prepare.sh NEW_OUTPUT_DIRECTORY [COUNT<=10000]" >&2
    exit 2
fi
output=$1
count=${2:-4200}
case "$count" in ''|*[!0-9]*) echo "Invalid count" >&2; exit 2;; esac
if [ "$count" -lt 1 ] || [ "$count" -gt 10000 ]; then
    echo "Count must be between 1 and 10000" >&2
    exit 2
fi
if [ -e "$output" ]; then
    echo "Output directory must not exist" >&2
    exit 2
fi
fixture_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -- "$output"
output=$(CDPATH= cd -- "$output" && pwd)
cc -shared -fPIC -O0 "$fixture_directory/module.c" -o "$output/module-00001.so"
i=2
while [ "$i" -le "$count" ]; do
    module_name=$(printf 'module-%05d.so' "$i")
    cp -- "$output/module-00001.so" "$output/$module_name"
    i=$((i + 1))
done
printf 'Prepared %s inert libraries in %s\n' "$count" "$output"
