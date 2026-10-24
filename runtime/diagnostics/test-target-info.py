#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reject configuration drift while permitting one serialized hash permutation."""
import unittest
from target_info import Reader, canonical, compare, MAX_BYTES, MAX_DEPTH


def table(entries, test='EQ'):
    return ('#.(EXT:HASH-TABLE-FILL (MAKE-HASH-TABLE :SIZE 128 :SYNCHRONIZED T '
            ':WEAKNESS NIL :HASH-FUNCTION NIL :REHASH-SIZE 1.5d0 '
            ':REHASH-THRESHOLD 0.75 :TEST (QUOTE ' + test + ')) (QUOTE (' + entries + ')))')


def target(entries, sorted_types='(#1# #2#)', extra='', inline='NIL'):
    return ('((C::*MACHINE* . #S(C::MACHINE :C-TYPES ((:INT . -32) (:LONG . -32)) '
            ':HOST-TYPE-HASH ' + table(entries) + ' :SORTED-TYPES ' + sorted_types +
            ' :INLINE-INFORMATION ' + inline + ')) '
            '(C::*CC-FLAGS* . "-O0") (*FEATURES* :EMSCRIPTEN :BOEHM-GC) ' + extra + ')').encode()


A = '(:INT . #1=#S(C::HOST-TYPE :BITS 32 :NAME :INT :C-NAME "int"))'
B = '(:LONG . #2=#S(C::HOST-TYPE :BITS 32 :NAME :LONG :C-NAME "long"))'
ORIGINAL = target(A + ' ' + B)


class TargetInfoTests(unittest.TestCase):
    def rejects_change(self, new):
        with self.assertRaises(ValueError):
            compare(ORIGINAL, new)

    def test_permutation_and_label_numbers(self):
        new = target(B.replace('#2=', '#7=') + ' ' + A.replace('#1=', '#8='), '(#8# #7#)')
        result = compare(ORIGINAL, new)
        self.assertTrue(result['matches'])
        self.assertFalse(result['rawBytesEqual'])
        self.assertEqual(result['originalCanonical'], result['instrumentedCanonical'])

    def test_cycles_and_sharing_survive_permutation(self):
        a = '(:INT . #1=#S(C::HOST-TYPE :BITS 32 :CYCLE #3=#A(T (2) #1# #3#)))'
        b = '(:LONG . #2=#S(C::HOST-TYPE :BITS 32 :SHARED #3#))'
        original = target(a + ' ' + b)
        new = target('(:LONG . #8=#S(C::HOST-TYPE :BITS 32 :SHARED #9=#A(T (2) #7# #9#))) '
                     '(:INT . #7=#S(C::HOST-TYPE :BITS 32 :CYCLE #9#))', '(#7# #8#)')
        self.assertTrue(compare(original, new)['matches'])
        with self.assertRaises(ValueError):
            compare(original, new.replace(b':CYCLE #9#', b':CYCLE #A(T (2) #7# #9#)'))
        with self.assertRaises(ValueError):
            compare(original, new.replace(b'#7# #9#', b'#8# #9#'))

    def test_values_and_order_outside_hash_are_exact(self):
        for before, after in [(b':BITS 32', b':BITS 64'), (b'"int"', b'"long"'),
                              (b'"-O0"', b'"-O2"'),
                              (b'(#1# #2#)', b'(#2# #1#)'),
                              (b':EMSCRIPTEN :BOEHM-GC', b':BOEHM-GC :EMSCRIPTEN'),
                              (b'(:INT . -32) (:LONG . -32)', b'(:LONG . -32) (:INT . -32)'),
                              (b':REHASH-SIZE 1.5d0', b':REHASH-SIZE 2.0d0'),
                              (b':TEST (QUOTE EQ)', b':TEST (QUOTE EQUAL)'),
                              (b':HOST-TYPE-HASH', b':UNREVIEWED-FIELD')]:
            with self.subTest(change=(before, after)):
                self.rejects_change(ORIGINAL.replace(before, after))

    def test_other_hash_order_is_not_normalized(self):
        x = target(A + ' ' + B, inline=table('(F 1) (G 2)', 'EQUAL'))
        y = target(A + ' ' + B, inline=table('(G 2) (F 1)', 'EQUAL'))
        with self.assertRaises(ValueError):
            compare(x, y)

    def test_entry_and_top_level_key_changes_fail(self):
        self.rejects_change(target(A, '(#1#)'))
        self.rejects_change(target(A + ' ' + B + ' (:VOID . NIL)'))
        self.rejects_change(target(A + ' ' + B, extra='(NEW-CONFIG . 1)'))
        self.rejects_change(target(A + ' ' + B, extra='(C::*CC-FLAGS* . "-O0")'))

    def test_duplicate_hash_key_is_refused_even_if_both_inputs_match(self):
        bad = target(A + ' ' + B.replace(':LONG .', ':INT .'))
        with self.assertRaisesRegex(ValueError, 'duplicate hash key'):
            compare(bad, bad)

    def test_label_errors_fail_closed(self):
        cases = [(b'#2=', b'#1='), (b'(#1# #2#)', b'(#1# #99#)'),
                 (b'#1=#S(C::HOST-TYPE :BITS 32 :NAME :INT :C-NAME "int")', b'#1=#1#')]
        for old, new in cases:
            with self.subTest(replacement=new), self.assertRaises(ValueError):
                canonical(ORIGINAL.replace(old, new))

    def test_reader_never_evaluates_forms(self):
        for body in [b'#.(PROGN (PRINT "must not execute") (QUIT))', b'#P"/tmp/x"',
                     b'#.(EXT:HASH-TABLE-FILL (RUN-SHELL-COMMAND "bad") (QUOTE ()))',
                     b'#.(EVAL (QUOTE X))', b'(A) (B)', b'("unterminated)', b'(A',
                     b'#1=#2=#1#', b'#999999999999999999999=1']:
            with self.subTest(body=body), self.assertRaises(ValueError):
                Reader(body).parse()

    def test_bounded_reader(self):
        for body in [b'A' * (MAX_BYTES + 1), b'(' * (MAX_DEPTH + 2) + b')' * (MAX_DEPTH + 2)]:
            with self.assertRaises(ValueError):
                Reader(body).parse()


if __name__ == '__main__':
    unittest.main()
