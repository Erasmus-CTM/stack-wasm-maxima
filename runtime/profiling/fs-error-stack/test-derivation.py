"""Text/hash transformations only; the recovered generated script is never run."""
import hashlib,json,unittest
from pathlib import Path
from unittest.mock import patch
import derive as d

ORIGINAL=Path('/workspace/work/compiler-audit-evidence/12578048686/staged/ecl-oz/maxima-runtime/maxima.js')


class Derivation(unittest.TestCase):
 def setUp(self):self.body=ORIGINAL.read_bytes()
 def test_exact_original_and_one_reversible_body_change(self):
  result,proof=d.derive(self.body);offset=proof['edit']['offset']
  original=self.body[offset:offset+proof['edit']['original']['bytes']]
  replacement_bytes=proof['edit']['replacement']['bytes']
  self.assertEqual(result[:offset]+original+result[offset+replacement_bytes:],self.body)
  self.assertEqual(result.count(d.CLASS_START),1)
  self.assertEqual(result[offset+replacement_bytes:],self.body[offset+len(original):])
  self.assertFalse(proof['acceptedUnchangedRuntime']);self.assertNotEqual(proof['original'],proof['derived'])
  self.assertEqual(proof['policy']['numericErrnos'],[44,54])
 def test_wrong_bytes_cannot_reuse_the_declared_original(self):
  for body in [self.body+b' ',self.body.replace(b"this.errno = errno",b"this.errno = 44",1),b'not the runtime']:
   with self.assertRaisesRegex(AssertionError,'Unexpected original'):d.derive(body)
 def test_ambiguous_anchor_and_changed_constructor_rejected_even_with_relabelled_hash(self):
  for body in [self.body+d.ANCHOR,self.body.replace(b'this.errno = errno',b'this.errno = 44',1)]:
   with patch.object(d,'SOURCE_SHA',hashlib.sha256(body).hexdigest()),patch.object(d,'SOURCE_BYTES',len(body)):
    with self.assertRaises(AssertionError):d.derive(body)


if __name__=='__main__':unittest.main()
