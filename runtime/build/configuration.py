# SPDX-License-Identifier: AGPL-3.0-or-later
"""The one current no-gnuplot build configuration; compiler experiments are later."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def configuration():
    return json.loads((ROOT / 'runtime/build/configuration.json').read_text())


def startup(config):
    assert config == configuration()
    body = (ROOT / 'runtime/build/no-plot.mac').read_bytes()
    assert hashlib.sha256(body).hexdigest() == config['startupSha256']
    return body.decode().strip() + '\n'
