# SPDX-License-Identifier: AGPL-3.0-or-later
"""Compare pinned ECL target-info as bounded data, without a Lisp reader/eval.

The sole order normalization is MACHINE's keyword-keyed HOST-TYPE-HASH.
Reader labels are alpha-renamed as a graph: cycles and sharing are retained.
All other order, atom spelling, string bytes, fields and values stay exact.
This comparison describes configuration data, not binary ABI compatibility.
"""
import hashlib
import json
import re

MAX_BYTES = 1024 * 1024
MAX_NODES = 100000
MAX_DEPTH = 128
MAX_LABELS = 1024
ATOM = re.compile(r'''[^\s()";'`,|\\]+''')
LABEL = re.compile(r'#([0-9]+)([=#])')
KEYWORD = re.compile(r':[A-Z][A-Z0-9*-]*\Z')


def require(condition, message):
    if not condition:
        raise ValueError('Target-info: ' + message)


def record(body):
    return {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}


class Reader:
    """An intentionally small syntax reader; dispatch forms are inert nodes."""

    def __init__(self, body):
        require(0 < len(body) <= MAX_BYTES, 'invalid byte length')
        self.text = body.decode('ascii')
        self.pos = 0
        self.nodes = 0
        self.labels = {}
        self.references = set()
        self.tables = []

    def whitespace(self):
        while self.pos < len(self.text) and self.text[self.pos] in ' \t\r\n':
            self.pos += 1

    def read(self, depth=0):
        self.nodes += 1
        require(self.nodes <= MAX_NODES and depth <= MAX_DEPTH, 'syntax limit exceeded')
        self.whitespace()
        require(self.pos < len(self.text), 'unexpected end of input')
        start = self.pos
        char = self.text[start]
        if char == '(':
            self.pos += 1
            rows = []
            while True:
                self.whitespace()
                require(self.pos < len(self.text), 'unterminated list')
                if self.text[self.pos] == ')':
                    self.pos += 1
                    return ('list', rows)
                rows.append(self.read(depth + 1))
        if char == '"':
            self.pos += 1
            while self.pos < len(self.text):
                char = self.text[self.pos]
                self.pos += 1
                if char == '\\':
                    require(self.pos < len(self.text), 'unterminated string escape')
                    self.pos += 1
                elif char == '"':
                    return ('string', self.text[start:self.pos])
            raise ValueError('Target-info: unterminated string')
        label = LABEL.match(self.text, start)
        if label:
            self.pos = label.end()
            require(len(label[1]) <= 4, 'label exceeds limit')
            number = int(label[1])
            require(number < MAX_LABELS, 'label exceeds limit')
            if label[2] == '=':
                require(number not in self.labels, 'duplicate label')
                self.labels[number] = None
                self.labels[number] = self.read(depth + 1)
            self.references.add(number)
            return ('ref', number)
        dispatch = self.text[start:start + 2]
        if dispatch in ('#.', '#S', '#A', '#Y'):
            self.pos += 2
            value = self.read(depth + 1)
            require(value[0] == 'list', 'dispatch must contain a list')
            node = (dispatch, value)
            if dispatch == '#.':
                self.tables.append(node)
            return node
        atom = ATOM.match(self.text, start)
        require(atom is not None, 'unsupported syntax at byte ' + str(start))
        token = atom[0]
        require('#' not in token or (token.startswith('#:') and len(token) > 2 and '#' not in token[1:]),
                'unsupported reader dispatch')
        self.pos = atom.end()
        return ('atom', token)

    def parse(self):
        root = self.read()
        self.whitespace()
        require(self.pos == len(self.text), 'trailing form')
        require(self.references <= self.labels.keys(), 'undefined label')
        # Alias-only loops carry no datum; ordinary list/array cycles are valid.
        for number in self.labels:
            seen = set()
            node = ('ref', number)
            while node[0] == 'ref':
                require(node[1] not in seen, 'label-only cycle')
                seen.add(node[1])
                node = self.labels[node[1]]
        for table in self.tables:
            hash_entries(table)
        return root


def atom(node, value=None):
    return node[0] == 'atom' and (value is None or node[1] == value)


def items(node):
    require(node[0] == 'list', 'expected list')
    return node[1]


def hash_entries(node):
    """Validate the only permitted #. form, without invoking any function."""
    require(node[0] == '#.', 'expected serialized hash table')
    call = items(node[1])
    require(len(call) == 3 and atom(call[0], 'EXT:HASH-TABLE-FILL'),
            'unrecognized read-eval data form')
    constructor = items(call[1])
    names = [':SIZE', ':SYNCHRONIZED', ':WEAKNESS', ':HASH-FUNCTION',
             ':REHASH-SIZE', ':REHASH-THRESHOLD', ':TEST']
    require(len(constructor) == 15 and atom(constructor[0], 'MAKE-HASH-TABLE')
            and all(atom(constructor[1 + 2 * i], name) for i, name in enumerate(names)),
            'unrecognized hash constructor')
    test = items(constructor[-1])
    require(len(test) == 2 and atom(test[0], 'QUOTE')
            and atom(test[1]) and test[1][1] in ('EQ', 'EQUAL'), 'unrecognized hash test')
    quote = items(call[2])
    require(len(quote) == 2 and atom(quote[0], 'QUOTE'), 'unquoted hash entries')
    rows = items(quote[1])
    keys = []
    for row in rows:
        pair = items(row)
        require(len(pair) >= 2, 'invalid hash entry')
        key = pair[0]
        # This pinned format uses symbols or lists of symbols as keys.
        require(atom(key) or (key[0] == 'list' and all(atom(x) for x in key[1])),
                'unsupported hash key')
        keys.append(json.dumps(key, separators=(',', ':')))
    require(len(keys) == len(set(keys)), 'duplicate hash key')
    return quote[1], test[1][1]


def machine_table(root):
    rows = items(root)
    names = []
    machine = None
    for row in rows:
        values = items(row)
        require(values and atom(values[0]), 'invalid configuration entry')
        name = values[0][1]
        names.append(name)
        if name == 'C::*MACHINE*':
            require(len(values) == 3 and atom(values[1], '.') and values[2][0] == '#S',
                    'invalid MACHINE record')
            machine = items(values[2][1])
    require(len(names) == len(set(names)), 'duplicate configuration key')
    require(machine is not None and len(machine) == 9 and atom(machine[0], 'C::MACHINE')
            and [x[1] for x in machine[1::2] if atom(x)] ==
            [':C-TYPES', ':HOST-TYPE-HASH', ':SORTED-TYPES', ':INLINE-INFORMATION'],
            'unrecognized MACHINE fields')
    table, test = hash_entries(machine[4])
    require(test == 'EQ', 'HOST-TYPE-HASH must use EQ')
    for row in items(table):
        values = items(row)
        require(len(values) == 3 and atom(values[1], '.') and atom(values[0])
                and KEYWORD.fullmatch(values[0][1]) is not None,
                'invalid HOST-TYPE-HASH entry')
    return table, names


def canonical(body):
    reader = Reader(body)
    root = reader.parse()
    table, names = machine_table(root)
    label_ids = {}

    def visit(node, depth=0):
        require(depth <= MAX_DEPTH, 'graph nesting limit exceeded')
        kind, value = node
        if kind == 'ref':
            if value in label_ids:
                return ['ref', label_ids[value]]
            label_ids[value] = len(label_ids)
            return ['define', label_ids[value], visit(reader.labels[value], depth + 1)]
        if kind == 'list':
            ordered = sorted(value, key=lambda row: row[1][0][1]) if node is table else value
            return ['list', [visit(row, depth + 1) for row in ordered]]
        if kind in ('atom', 'string'):
            return [kind, value]
        return [kind, visit(value, depth + 1)]

    body = json.dumps(visit(root), ensure_ascii=True, separators=(',', ':')).encode('ascii')
    require(len(body) <= MAX_BYTES * 4, 'canonical output limit exceeded')
    return body, {'configurationKeys': names, 'readerLabels': len(reader.labels),
                  'hostTypeEntries': len(items(table))}


def compare(original, instrumented):
    before, before_shape = canonical(original)
    after, after_shape = canonical(instrumented)
    require(before == after and before_shape == after_shape, 'configuration graph changed')
    return {'schema': 1, 'comparison': 'ecl-target-info-host-type-hash-graph-v1',
            'matches': True, 'rawBytesEqual': original == instrumented,
            'original': record(original), 'instrumented': record(instrumented),
            'originalCanonical': record(before), 'instrumentedCanonical': record(after),
            **before_shape,
            'normalization': ['Order of C::*MACHINE* :HOST-TYPE-HASH entries only',
                              'Reader-label numbering; graph cycles and sharing retained'],
            'scope': 'All configuration data compared without evaluation. All other order and values exact. Not a binary ABI or production admission proof.'}
