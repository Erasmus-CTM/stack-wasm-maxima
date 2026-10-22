// SPDX-License-Identifier: AGPL-3.0-or-later
// Exercise the real pinned recognizer, not a mocked parser or grader.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import vm from 'node:vm';

const directory = resolve(process.argv[2] || '.cache/m3-input');
const provenance = JSON.parse(await readFile(resolve(directory,'input-provenance.json')));
const parser = await readFile(resolve(directory,'stack-parser.js'));
const rules = await readFile(resolve(directory,'input-rules.json'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(parser),provenance.parser.sha256);
assert.equal(sha(rules),provenance.rules.sha256);
assert.equal(provenance.stackRevision,'33383047af39c204bf4442802a058f8b918b2b1b');
const self = {NativeInputRules:JSON.parse(rules)};
const context = vm.createContext({self,TextEncoder});
vm.runInContext(parser.toString(),context);
vm.runInContext(await readFile(new URL('input.js',import.meta.url),'utf8'),context);
const admit = (raw,options={},question={},variant={}) => self.NativeInput.admit(raw,{type:'algebraic',strictsyntax:true,insertstars:0,...options},question,variant);
let checked = 0;
function source(raw,expected,options={},question={},variant={}) {
  const result=admit(raw,options,question,variant);
  assert.equal(result.source,expected,raw);checked++;
  return result;
}
function rejected(raw,code,options={},question={},variant={}) {
  assert.throws(()=>admit(raw,options,question,variant),error=>error.name==='AdmissionError'&&error.code===code,raw);checked++;
}

source('(x+1)^2','(x + 1) ^ 2');
source('1/3 + %i/2','1 / 3 + %i / 2');
source('3.50','3.50');
source('1e-3','1e-3');
source('π + α','%pi + alpha');
source('x − 2','x - 2');
source('sin(x)+cos(x)','sin(x) + cos(x)');
source('ln(x)','log(x)');
source('arcsin(x)','asin(x)');
source('gcd(x^2-1,x-1)','gcd(x ^ 2 - 1,x - 1)');
source('[{a,b},[1,2/3]]','[{a,b},[1,2 / 3]]');
source('{}','{}');
source('matrix([(1),(2)],[(3),(4)])','matrix([(1),(2)],[(3),(4)])',{type:'matrix'});
source('8x','8 * x',{insertstars:1});
source('2(x+1)','2 * (x + 1)',{insertstars:1});
source('(x+1)(x-1)','(x + 1) * (x - 1)',{insertstars:1});
source('x_1','x_1');
source('alpha','alpha');
source('true','true');
source('false','false');
source('not p','nounnot p');
source('p and q','p nounand q');
source('p nounand q','p nounand q');
source('p nounor q','p nounor q');
source('p xor q','p xor q');
// MP-lite parses the first form into an unusual AST; the transport must
// preserve the original sequence, letting native Maxima determine precedence.
source('x=0 or y=0','x = 0 nounor y = 0');
source('(x=0) or (y=0)','(x = 0) nounor (y = 0)');
source('2^3^4','2 ^ 3 ^ 4');
source('x^-2','x ^ -2');

for(const value of ['x:1','x:=1','x;kill(all)','x$1','x,eval','x[1]','foo(x)','apply(sin,[1])','funmake(sin,[1])',
 'eval_string(x)','system(x)','load(x)','kill(all)','?foo','"abc"','x/* comment */+1','x\\y','(x,y)',
 'if x then 1 else 0','lambda([x],x)','x!','[1,2][1]','(sin)(x)']) {
  assert.throws(()=>admit(value),error=>error.name==='AdmissionError',value);checked++;
}
rejected('8x','syntax');
rejected('2 x','spaces',{insertstars:1});
rejected('sin x','spaces');
rejected('x²','character');
rejected('x\n+1','character');
rejected('PI','case');
rejected('Sin(x)','case');
rejected('sinx','forbidden-name');
rejected('%o1','forbidden-name');
rejected('ta','forbidden-name',{}, {native:{locals:['ta']}});
rejected('ta','forbidden-name',{}, {variables:'/* teacher */ta:2;'});
rejected('fb','forbidden-name',{}, {prts:[{feedbackvariables:'/* feedback */fb:1;'}]});
rejected('ans1','forbidden-name',{}, {inputs:[{name:'ans1'},{name:'ans2'}]});
rejected('z','forbidden-name',{}, {},{env:{z:'5'}});
rejected('sin(x)','forbidden-word',{forbidwords:['sin']});
rejected('x+y','forbidden-word',{forbidwords:'x, z'});
rejected('%pi','forbidden-word',{forbidwords:['pi']});
rejected('pi','forbidden-word',{forbidwords:['%pi']});
rejected('ln(x)','forbidden-word',{forbidwords:['log']});
rejected('x+y','forbidden-word',{forbidwords:['+']});
rejected('8x','forbidden-word',{insertstars:1,forbidwords:['*']});
rejected('x**2','forbidden-word',{forbidwords:['^']});
rejected('x and y','forbidden-word',{forbidwords:['nounand']});
rejected('x nounand y','forbidden-word',{forbidwords:['and']});
rejected('x^2','forbidden-word',{forbidwords:['**']});
rejected('true','forbidden-word',{forbidwords:['true']});
rejected('[1,2]','forbidden-word',{forbidwords:['[']});
rejected('gcd(1,2)','forbidden-word',{forbidwords:[',']});
rejected('3.5','float',{forbidfloat:true});
rejected('1e-3','float',{forbidfloat:true});
rejected('matrix([1,2.5])','float',{type:'matrix',forbidfloat:true});
rejected('[1,[2.5]]','float',{forbidfloat:true});
rejected('x^101','input-bound');
rejected('x^(10*11)','input-bound');
rejected('10^(10^10)','input-bound');
rejected('1e301','input-bound');
rejected('1'.repeat(101),'input-bound');
rejected('x'.repeat(4097),'input-bound');
rejected('['.repeat(7)+'1'+']'.repeat(7),'input-bound');
rejected('['+Array(33).fill('1').join(',')+']','input-bound');
rejected('matrix([1,2],[3])','matrix-shape',{type:'matrix'});
rejected('matrix('+Array(17).fill('[1]').join(',')+')','arity',{type:'matrix'});
rejected('matrix('+Array(9).fill('['+Array(8).fill('1').join(',')+']').join(',')+')','matrix-shape',{type:'matrix'});

const raw='{"points":[{"x":1,"label":"a\\n\\\"b"}]}';
const compact=source(raw,'"{\\"points\\":[{\\"x\\":1,\\"label\\":\\"a\\\\n\\\\\\"b\\"}]}"',{type:'json'});
assert.equal(compact.raw,raw);
source('a;kill(all)','"a;kill(all)"',{type:'string'});
source('a\nb','sconcat("a",ascii(10),"b")',{type:'string'});
source('\u0000','ascii(0)',{type:'string'});
source('{\n"x":1\n}','sconcat("{",ascii(10),"\\"x\\":1",ascii(10),"}")',{type:'json'});
rejected('{bad}','json-syntax',{type:'json'});
rejected('NaN','json-syntax',{type:'json'});
rejected('1e999','json-number',{type:'json'});
rejected('"\\ud800"','character',{type:'json'});
rejected('\ud800','character',{type:'string'});
rejected('['.repeat(14)+'0'+']'.repeat(14),'input-bound',{type:'json'});
rejected('a'.repeat(65537),'input-bound',{type:'string'});
source('😀','"😀"',{type:'string'});

// Author configuration failures must not become learner wrong answers.
assert.throws(()=>admit('x',{insertstars:2}),/supports insertstars/);checked++;
assert.throws(()=>admit('x',{allowwords:'system'}),/does not support allowwords/);checked++;
assert.throws(()=>admit('x',{strictsyntax:false}),/requires strictsyntax/);checked++;
assert.throws(()=>admit('sin(x)',{forbidwords:['[[basic-trig]]']}),/does not support forbidden-word shorthand/);checked++;
delete self.NativeInputRules;
assert.throws(()=>admit('x'),/input-security data is unavailable/);checked++;
console.log(`Native input admission: ${checked} real-parser mathematical, JSON, resource and isolation checks passed`);
