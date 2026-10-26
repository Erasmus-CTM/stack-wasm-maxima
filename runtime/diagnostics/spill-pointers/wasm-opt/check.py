#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Run wasm-opt on operand.wat with and without --flatten; count spill stores per function."""
import argparse
from pathlib import Path
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent
EXPECTED = {
    'plain': {'control': 1, 'operand': 0, 'local-operand': 0},
    'flatten': {'control': 1, 'operand': 1, 'local-operand': 1},
}


def stores(text, name):
    match = re.search(r'\(func \$' + re.escape(name) + r'\b.*?\n \)', text, re.S)
    return match.group(0).count('i32.store') if match else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wasm-opt', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    print(subprocess.run([args.wasm_opt, '--version'], check=True, capture_output=True, text=True).stdout.strip())
    ok = True
    for kind, passes in (('plain', ['--spill-pointers']), ('flatten', ['--flatten', '--spill-pointers'])):
        out = args.output / (kind + '.wat')
        argv = [args.wasm_opt, str(HERE / 'operand.wat'), *passes, '-S', '-o', str(out)]
        print('$', ' '.join(argv))
        subprocess.run(argv, check=True)
        text = out.read_text()
        for name, expected in EXPECTED[kind].items():
            found = stores(text, name)
            print(f'{kind:8} ${name:14} spill stores: {found} (expected {expected})')
            ok &= found == expected
    print('passed' if ok else 'FAILED')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
