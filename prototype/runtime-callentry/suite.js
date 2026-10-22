// SPDX-License-Identifier: AGPL-3.0-or-later
// Same generated programs run through both transports in fresh workers.
async function runSuite(session, fixtures, question) {
 self.NativeInputRules=await (await fetch('/native/input-rules.json')).json();
 const rows=[];
 function call(name,expression) {
  let result;const t=performance.now();try {result=session.evaluate(expression);}catch(e){throw new Error(name+": "+e.message);}
  const row={name,expression,result,elapsedMs:performance.now()-t};rows.push(row);self.postMessage({type:"program",...row});return result;
 }
 for(const c of fixtures) {
  const spec=session.manifest.tests[c.test];
  const args=[c.student,c.teacher].map(x=>'eval_string('+JSON.stringify(x.replace(/\b(and|or|not)\b/g,t=>({and:'nounand',or:'nounor',not:'nounnot'}[t])))+')');
  if(spec[0]) {
   const opt=JSON.stringify(c.options || '0.05');
   args.push(['NumAbsolute','NumRelative'].includes(c.test) ? 'block([_ctm_option],_ctm_option:errcatch(parse_string('+opt+')),if _ctm_option=[] then 0.05 else eval_string('+opt+'))' : 'eval_string('+opt+')');
  }
  if(spec[2])args.push(JSON.stringify(c.student));
  call(c.id,'block([simp:'+spec[1]+',assume_pos:false,assume_real:false],AT'+c.test+'('+args.join(',')+'))');
 }
 const captured=[];
 const proxy={manifest:session.manifest,evaluate(expression){const result=call('native-'+captured.length,expression);captured.push(result);return result;}};
 const engine=new NativeStackEngine({session:proxy});
 const variant=await engine.prepare(question,question.variants?.[0]?.seed || 1);
 const answers={ans:variant.teachers.ans.source};
 const validation=await engine.validate(question,variant,answers);
 const grade=await engine.grade(question,variant,answers);
 if(validation.status!=='valid' || grade.status!=='graded' || grade.score!==1)throw new Error('The native-rational teacher answer must validate and grade fully correct');
 const unicode='\u00e6\u00f8\u00e5\u2212\u03c0';
 const unicodeResult=call('unicode-string',JSON.stringify(unicode));
 if(unicodeResult!==unicode)throw new Error('Unicode roundtrip mismatch: '+JSON.stringify(unicodeResult));
 const unicodeQuestion=structuredClone(question);
 unicodeQuestion.native.tokens.push({id:'unicode',source:JSON.stringify(unicode),format:'latex',wrap:false,phase:'prepare',context:'html'});
 unicodeQuestion.questiontext+='<p>@@CTM_NATIVE_unicode@@</p>';
 const unicodeVariant=await engine.prepare(unicodeQuestion,1);
 const rendered=NativeStackEngine.renderTemplate(unicodeQuestion.questiontext,unicodeVariant.tokenValues);
 if(unicodeVariant.tokenValues.unicode.value!==unicode || !rendered.includes('<p>'+unicode+'</p>'))throw new Error('Unicode CASText token mismatch');
 return {rows,native:{variant,validation,grade,unicode:{value:unicodeResult,variant:unicodeVariant,rendered}}};
}
