# SPDX-License-Identifier: AGPL-3.0-or-later
"""The one exact ECL target overlay, its native-host boundary and delivery evidence."""
import hashlib
import json
import os
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path

DESCRIPTOR = 'runtime/build/patches/ecl-root-scanner.json'
PATCH = 'runtime/build/patches/ecl-root-scanner.patch'
SOURCE = 'src/c/alloc_2.d'
REVISION = 'e4bdb2e5b1e444e1773032a53650773848f4d6cd'
HOST = 'sources/maxima/wasm/ecl-host/bin/ecl'
CRITICAL = {'wasm/Makefile', 'wasm/build.lisp', 'src/maxima.asd'}
SUFFIXES = {'.lisp', '.lsp', '.mac', '.asd', '.c', '.h', '.d'}


def digest(body):
    return hashlib.sha256(body).hexdigest()


def record(body):
    return {'bytes': len(body), 'sha256': digest(body)}


def blob(body):
    return hashlib.sha1(b'blob ' + str(len(body)).encode() + b'\0' + body).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


def descriptor(repository):
    pins = read(repository / 'runtime/build/pins.json')
    body = (repository / DESCRIPTOR).read_bytes()
    assert pins['buildPatches'] == [{'descriptor': DESCRIPTOR, 'sha256': digest(body)}]
    value = json.loads(body)
    assert value['schema'] == 1 and value['id'] == 'ecl-eager-owned-root-ranges'
    assert value['source'] == 'ecl' and value['revision'] == REVISION and value['path'] == SOURCE
    assert value['target'] == 'wasm32-unknown-emscripten'
    assert value['applyAfter'] == 'verified-original-native-ecl32'
    assert next(p for p in pins['sources'] if p['name'] == 'ecl')['commit'] == REVISION
    assert value['patch'] == {'path': PATCH, **record((repository / PATCH).read_bytes())}
    assert read(repository / 'runtime/build/configuration.json')['targetSourceOverlaySha256'] == digest(body)
    return value


def verify_manifest_identity(manifest, repository):
    """Preparation gate; archive/report replay remains mandatory for acceptance."""
    value = descriptor(repository)
    integrity = manifest.get('sourceIntegrity')
    assert isinstance(integrity, dict)
    assert integrity.get('schema') == 1 and integrity.get('allVerifiedFilesUnmodified') is False
    assert integrity.get('overlays') == [value]
    pins = read(repository / 'runtime/build/pins.json')
    assert integrity.get('originalArchives') == [
        {'path': 'sources/' + pin['name'] + '.tar', 'sha256': pin['archive']['sha256']}
        for pin in pins['sources'] if pin['name'] in ('maxima', 'ecl')]
    for key in ('beforeSha256', 'hostSourceSha256', 'afterSha256', 'applicationSha256'):
        assert isinstance(integrity.get(key), str) and re.fullmatch('[0-9a-f]{64}', integrity[key])


def derive(repository, original):
    """Replay the distributed patch against only the hash-pinned original file."""
    value = descriptor(repository)
    assert value['original'] == {'gitBlob': blob(original), **record(original)}
    patch = (repository / PATCH).read_bytes()
    with tempfile.TemporaryDirectory(prefix='ctm-ecl-overlay-') as temp:
        root = Path(temp)
        source = root / SOURCE
        source.parent.mkdir(parents=True)
        source.write_bytes(original)
        for args in (['--check'], []):
            subprocess.run(['git', 'apply', '--whitespace=error-all', *args, '-'],
                           cwd=root, input=patch, check=True, capture_output=True)
        assert {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()} == {SOURCE}
        result = source.read_bytes()
    assert record(result) == value['derived']
    return result


def checked_after(name, path):
    return Path(path).suffix in SUFFIXES or (name == 'maxima' and path in CRITICAL)


def archive_rows(archive, pin):
    """Root every original row in an independently hash-pinned full archive."""
    assert digest(archive.read_bytes()) == pin['archive']['sha256']
    result = {}
    with tarfile.open(archive) as tar:
        for member in tar:
            if member.isdir():
                continue
            prefix = pin['archive']['prefix']
            assert member.name.startswith(prefix)
            path = member.name[len(prefix):]
            assert path and path not in result
            assert member.isfile() or member.issym(), 'Unexpected original archive member type'
            body = member.linkname.encode() if member.issym() else tar.extractfile(member).read()
            # Pinned libffi .gitattributes forces CRLF in canonical git archive;
            # compilation uses exact LF Git blobs. No other normalization.
            if pin['name'] == 'ecl' and path in {
                'src/libffi/msvc_build/aarch64/Ffi_staticLib.sln',
                'src/libffi/msvc_build/aarch64/Ffi_staticLib.vcxproj',
                'src/libffi/msvc_build/aarch64/Ffi_staticLib.vcxproj.filters',
                'src/libffi/msvc_build/aarch64/Ffi_staticLib.vcxproj.user',
            }:
                body = body.replace(b'\r\n', b'\n')
            result[path] = {'path': path, 'gitBlob': blob(body), **record(body)}
    return result


def validate_transition(before, after, value=None):
    """Require complete existing after coverage; allow exactly one derived row."""
    assert before['schema'] == after['schema'] == 1
    assert before['passed'] is True and after['passed'] is True
    assert before['phase'] == 'before' and after['phase'] in ('host', 'after')
    assert before['upstreamUnmodified'] is True and before['overlays'] == []
    assert after['upstreamUnmodified'] is (value is None)
    assert after['overlays'] == ([] if value is None else [value['id']])
    old_sources = {s['name']: s for s in before['sources']}
    new_sources = {s['name']: s for s in after['sources']}
    assert len(old_sources) == len(before['sources']) == 2
    assert len(new_sources) == len(after['sources']) == 2
    assert old_sources.keys() == new_sources.keys() == {'ecl', 'maxima'}
    changes = []
    for name, old in old_sources.items():
        new = new_sources[name]
        assert new['revision'] == old['revision']
        assert len({r['path'] for r in old['files']}) == len(old['files']), 'Duplicate original source rows'
        expected = {r['path']: r for r in old['files'] if checked_after(name, r['path'])}
        actual = {r['path']: r for r in new['files']}
        assert len(expected) > 0 and len(actual) == len(new['files'])
        assert actual.keys() == expected.keys(), 'After report lost checked source paths'
        for path, row in actual.items():
            if value is not None and name == 'ecl' and path == SOURCE:
                assert old['revision'] == value['revision']
                assert expected[path] == {'path': SOURCE, **value['original']}
                assert {k: row[k] for k in ('bytes', 'sha256')} == value['derived']
                assert row['upstreamGitBlob'] == value['original']['gitBlob']
                assert row['overlayId'] == value['id']
                changes.append((name, path))
            else:
                assert row == expected[path], name + '/' + path
    assert changes == ([] if value is None else [('ecl', SOURCE)])


def host_identity(work):
    body = (work / HOST).read_bytes()
    # ELFCLASS32, little-endian, EM_386. The build also executes the fixnum check.
    assert body[:6] == b'\x7fELF\x01\x01' and body[18:20] == b'\x03\x00'
    logged = (work / 'logs/host-ecl.sha256').read_text().splitlines()
    assert len(logged) == 1 and logged[0].split()[0] == digest(body)
    install = (work / HOST).parent.parent
    files = []
    for path in sorted(install.rglob('*')):
        if path.is_symlink():
            files.append({'path': path.relative_to(install).as_posix(), 'kind': 'symlink',
                          **record(os.fsencode(os.readlink(path)))})
        elif path.is_file():
            files.append({'path': path.relative_to(install).as_posix(), 'kind': 'file',
                          **record(path.read_bytes())})
    return {'path': HOST, **record(body), 'format': 'ELF32-i386', 'installationFiles': files}


def apply(repository, work):
    from recipe_inputs import committed_recipe
    from source_state import verify
    value = descriptor(repository)
    revision, _ = committed_recipe(repository)
    output = work / 'logs/target-source-overlay.json'
    assert not output.exists(), 'Overlay application must be a fresh build phase'
    before = read(work / 'logs/source-state-before.json')
    # Read-only comparison against every originally checked byte before writing.
    host = verify(repository, work, 'host')
    validate_transition(before, host)
    identity = host_identity(work)
    source = work / 'sources/ecl' / SOURCE
    original = source.read_bytes()
    result = derive(repository, original)
    source.write_bytes(result)
    proof = {'schema': 1, 'id': value['id'], 'target': value['target'],
             'recipeRevision': revision, 'descriptorSha256': digest((repository / DESCRIPTOR).read_bytes()),
             'patchSha256': value['patch']['sha256'], 'original': value['original'], 'derived': value['derived'],
             'nativeHost': identity,
             'beforeSha256': digest((work / 'logs/source-state-before.json').read_bytes()),
             'hostSourceSha256': digest((work / 'logs/source-state-host.json').read_bytes())}
    output.write_text(json.dumps(proof, indent=2) + '\n')
    return proof


def integrity(repository, root, packaged=False):
    """Recheck recorded source transitions plus original archive and patch bytes."""
    value = descriptor(repository)
    before = read(root / 'logs/source-state-before.json')
    host = read(root / 'logs/source-state-host.json')
    after = read(root / 'logs/source-state-after.json')
    assert host['phase'] == 'host' and after['phase'] == 'after'
    validate_transition(before, host)
    validate_transition(before, after, value)
    pins = read(repository / 'runtime/build/pins.json')
    assert {s['name']: s['revision'] for s in before['sources']} == {
        p['name']: p['commit'] for p in pins['sources'] if p['name'] in ('maxima', 'ecl')}
    archive_root = root / ('sources' if packaged else 'source-archives')
    originals = []
    for pin in pins['sources']:
        if pin['name'] not in ('ecl', 'maxima'):
            continue
        archive = archive_root / (pin['name'] + '.tar')
        rows = archive_rows(archive, pin)
        source = next(s for s in before['sources'] if s['name'] == pin['name'])
        assert {r['path']: r for r in source['files']} == rows, 'Original source report differs from pinned ' + pin['name'] + ' archive'
        originals.append({'path': 'sources/' + archive.name, 'sha256': pin['archive']['sha256']})
    pin = next(p for p in pins['sources'] if p['name'] == 'ecl')
    archive = archive_root / 'ecl.tar'
    assert digest(archive.read_bytes()) == pin['archive']['sha256']
    with tarfile.open(archive) as tar:
        member = tar.getmember(pin['archive']['prefix'] + SOURCE)
        assert member.isfile()
        original = tar.extractfile(member).read()
        licence = tar.extractfile(pin['archive']['prefix'] + 'LICENSE').read()
    if packaged:
        assert (root / 'source-overlays/ecl/LICENSE').read_bytes() == licence
        assert (root / 'LICENSES/upstream/ecl/LICENSE').read_bytes() == licence
    else:
        assert (root / 'sources/ecl/LICENSE').read_bytes() == licence
    derived = derive(repository, original)
    row = next(r for s in after['sources'] if s['name'] == 'ecl' for r in s['files'] if r['path'] == SOURCE)
    assert row['gitBlob'] == blob(derived)
    proof_path = root / 'logs/target-source-overlay.json'
    proof = read(proof_path)
    assert proof['schema'] == 1 and proof['id'] == value['id'] and proof['target'] == value['target']
    assert proof['descriptorSha256'] == digest((repository / DESCRIPTOR).read_bytes())
    assert proof['patchSha256'] == value['patch']['sha256']
    assert proof['original'] == value['original'] and proof['derived'] == value['derived']
    assert proof['beforeSha256'] == digest((root / 'logs/source-state-before.json').read_bytes())
    assert proof['hostSourceSha256'] == digest((root / 'logs/source-state-host.json').read_bytes())
    assert proof['nativeHost']['path'] == HOST and proof['nativeHost']['format'] == 'ELF32-i386'
    assert proof['nativeHost']['sha256'] == (root / 'logs/host-ecl.sha256').read_text().split()[0]
    if not packaged:
        assert proof['nativeHost'] == host_identity(root)
        assert (root / 'sources/ecl' / SOURCE).read_bytes() == derived
    return {'schema': 1, 'allVerifiedFilesUnmodified': False,
            'scope': after['scope'], 'overlays': [value],
            'beforeSha256': proof['beforeSha256'], 'hostSourceSha256': proof['hostSourceSha256'],
            'afterSha256': digest((root / 'logs/source-state-after.json').read_bytes()),
            'applicationSha256': digest(proof_path.read_bytes()),
            'originalArchives': originals}


def verify_packaged(artifact, repository):
    manifest = read(artifact / 'manifest.json')
    verify_manifest_identity(manifest, repository)
    expected = integrity(repository, artifact, packaged=True)
    assert manifest['sourceIntegrity'] == expected
    assert read(artifact / 'source-manifest.json')['sourceIntegrity'] == expected
    critical = [r for s in read(artifact / 'logs/source-state-after.json')['sources']
                if s['name'] == 'maxima' for r in s['files'] if r['path'] in CRITICAL]
    assert len(critical) == 3
    recipe = manifest['upstreamRecipe']
    assert recipe['verifiedInputs'] == critical and recipe['verifiedFilesUnmodified'] is True
    assert recipe['patches'] == [] and recipe['scope'].startswith('Only the three pinned Maxima build inputs:')
    assert recipe['path'] == 'wasm/Makefile'
    for row in critical:
        body = (artifact / 'build-recipes/maxima' / row['path']).read_bytes()
        assert row == {'path': row['path'], 'gitBlob': blob(body), **record(body)}
    assert recipe['sha256'] == digest((artifact / 'build-recipes/maxima/wasm/Makefile').read_bytes())
    assert read(artifact / 'source-manifest.json')['upstreamRecipe'] == recipe
    proof = read(artifact / 'logs/target-source-overlay.json')
    assert proof['recipeRevision'] == manifest['recipe']['revision']
    recipe_rows = {r['path']: r for r in manifest['recipe']['files']}
    for path in (DESCRIPTOR, PATCH, 'runtime/build/source_overlay.py', 'runtime/build/source_state.py',
                 'runtime/build/apply-target-overlay.py', 'runtime/build/build.sh'):
        current = (repository / path).read_bytes()
        assert recipe_rows[path] == {'path': path, **record(current)}
        assert (artifact / 'recipe' / path).read_bytes() == current
    folder = artifact / 'source-overlays/ecl'
    assert (folder / 'descriptor.json').read_bytes() == (repository / DESCRIPTOR).read_bytes()
    assert (folder / 'root-scanner.patch').read_bytes() == (repository / PATCH).read_bytes()
    assert record((folder / SOURCE).read_bytes()) == descriptor(repository)['derived']
    assert (folder / 'LICENSE').read_bytes() == (artifact / 'LICENSES/upstream/ecl/LICENSE').read_bytes()
    return expected
