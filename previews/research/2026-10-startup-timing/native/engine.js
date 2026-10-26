/* Native STACK preparation, validation and response-tree execution.
 * The UI contract is CTM's. Author code is trusted; learner expressions enter
 * Maxima only after NativeInput admission and string quoting.
 * SPDX-License-Identifier: AGPL-3.0-or-later */
(function (scope) {
  'use strict';

  const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
  const INTERNAL_FAULT = 'Internal CAS fault during native validation';
  const TOKEN = /@@CTM_NATIVE_([A-Za-z0-9_]+)@@/g;
  const MUTATING_CALL = /\b(?:system|load|batch|batchload|kill|remvalue|remfunction|declare|remove|assume|forget|activate|deactivate|newcontext|killcontext|supcontext|atvalue|compile|translate|modedeclare|define|set_random_state|make_random_state|stack_randseed|put|qput|rem|array|fillarray|arrayapply|appendfile|writefile|stringout|save|openw|opena|with_stdout|delete_file|rename_file|eval_string|parse_string|funmake|apply|depends|gradef|matchdeclare|defmatch|defrule|remrule|tellsimp|tellsimpafter|setup_autoload|autoload|setelmx|push|pop|print|printf|disp|display)\s*\(/i;
  // STACK exposes several RNG helpers, including rand_with_prohib and
  // random_subset. Their names must not bypass the continuation policy.
  const RANDOM_CALL = /\b(?:rand[A-Za-z0-9_]*|multiselqn[A-Za-z0-9_]*)\s*\(/i;
  // Maxima does not implement JSON's \n/\u string escapes. Preserve actual
  // control characters explicitly rather than changing feedback or JSON data.
  const quote = value => {
    const parts = String(value).split(/([\x00-\x1f\x7f])/).filter(Boolean).map(part =>
      /^[\x00-\x1f\x7f]$/.test(part) ? 'ascii(' + part.charCodeAt(0) + ')' : JSON.stringify(part));
    return parts.length > 1 ? 'sconcat(' + parts.join(',') + ')' : parts[0] || '""';
  };
  const bool = value => value ? 'true' : 'false';
  const unique = values => Array.from(new Set(values));
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const map = entries => '["stack_map"' + entries.map(([key, value]) => ',[' + quote(key) + ',' + value + ']').join('') + ']';
  const array = values => '[' + values.join(',') + ']';
  const evaluate = expression => 'eval_string(' + quote(expression) + ')';
  const stringValue = expression => 'string(' + expression + ')';
  const nodeName = value => {
    const name = String(value);
    if (!NAME.test(name) || name.startsWith('_ctm_')) throw new Error('Unsupported native variable name: ' + name);
    return name;
  };

  // Split trusted author statements without changing semicolons in strings,
  // comments or nested expressions. A bounded variable-assignment subset is
  // intentional: native Maxima is not Moodle's PHP input controller.
  function statements(source) {
    const result = [];
    let item = '', depth = 0, quoted = false, escaped = false, comment = false;
    source = String(source || '');
    for (let at = 0; at < source.length; at++) {
      const c = source[at], next = source[at + 1];
      if (comment) { if (c === '*' && next === '/') { comment = false; at++; } continue; }
      if (!quoted && c === '/' && next === '*') { comment = true; at++; continue; }
      if (quoted) {
        item += c;
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
        continue;
      }
      if (c === '"') { quoted = true; item += c; continue; }
      if ('([{'.includes(c)) depth++;
      if (')]}'.includes(c)) depth--;
      if (depth < 0) throw new Error('Unbalanced native author expression');
      if ((c === ';' || c === '$') && depth === 0) {
        if (item.trim()) result.push(item.trim());
        item = '';
      } else item += c;
    }
    if (quoted || comment || depth) throw new Error('Unclosed native author expression');
    if (item.trim()) result.push(item.trim());
    if (result.length > 256) throw new Error('Native author statement bound exceeded');
    return result;
  }

  function assignments(source) {
    const list = statements(source);
    for (const statement of list) {
      const match = /^([A-Za-z][A-Za-z0-9_]*)\s*:(?!=)/.exec(statement);
      if (!match) throw new Error('Native author code requires name:expression assignments');
      nodeName(match[1]);
      pureExpression(statement.slice(match[0].length), true);
    }
    return list;
  }

  function pureExpression(source, allowRandom = false) {
    if (!String(source || '').trim()) return;
    const parts = statements(source);
    if (parts.length !== 1) throw new Error('A native author operand must be one expression');
    const code = parts[0].replace(/"(?:\\.|[^"\\])*"/g,'""');
    if (code.includes(':') || code.includes('?')) throw new Error('Nested assignments or Lisp escapes are outside this native author subset');
    if (MUTATING_CALL.test(code)) throw new Error('State-mutating author calls are outside this native expression subset');
    if (!allowRandom && RANDOM_CALL.test(code)) throw new Error('Random response-tree expressions are outside this native subset; freeze random values in question variables');
  }

  function localNames(question, prt) {
    const names = (question.native?.locals || assignments(question.variables).map(s => s.match(/^\w+/)[0])).slice();
    if (prt) names.push(...(prt.locals || assignments(prt.feedbackvariables).map(s => s.match(/^\w+/)[0])));
    names.push(...question.inputs.map(input => input.name));
    return unique(names.map(nodeName));
  }

  function feedbackLocals(prt) {
    return unique((prt.locals || assignments(prt.feedbackvariables).map(statement => statement.match(/^\w+/)[0])).map(nodeName));
  }

  function context(question, extra = [], prt) {
    return ['simp:' + bool(question.simplify !== false),
      'assume_pos:' + bool(question.assumepositive), 'assume_real:' + bool(question.assumereal),
      '%ERR:["stack_map"]', '%NOTES:["stack_map"]', '%FEEDBACK:["stack_map"]', '%stmt:"ctm-native"',
      ...localNames(question, prt), ...extra];
  }

  function block(locals, expressions) {
    return 'block([' + unique(locals).join(',') + '],' + expressions.filter(Boolean).join(',') + ')';
  }

  function restore(variant, admitted) {
    if (!variant || !variant.env || !Number.isSafeInteger(variant.seed)) throw new Error('A native prepared variant is required');
    const result = ['simp:false'];
    for (const [name, source] of Object.entries(variant.env)) result.push(nodeName(name) + ':' + evaluate(source));
    if (admitted) for (const [name, entry] of Object.entries(admitted)) result.push(nodeName(name) + ':' + evaluate(entry.source));
    return result;
  }

  function snapshot(names) {
    // Snapshot the already computed values without another simplification.
    // The previous answer test may have changed simp for its own argument
    // policy; it must not rewrite held author/feedback values at a pause.
    return block(['simp:false'], [map(names.map(name => [name, stringValue(name)]))]);
  }

  function typeOf(expression) {
    return 'if matrixp(' + expression + ') then "matrix" else if setp(' + expression + ') then "set"' +
      ' else if listp(' + expression + ') then "list" else if stringp(' + expression + ') then "string"' +
      ' else if equationp(' + expression + ') then "equation"' +
      ' else if member(safe_op(' + expression + '),["nounand","nounor","nounnot","and","or","not","implies","xor","xnor"])' +
      ' or is(' + expression + '=true) or is(' + expression + '=false) then "logical" else "scalar"';
  }

  function tagged(expression) {
    return map([['source', stringValue(expression)], ['type', typeOf(expression)]]);
  }

  function tokenValue(token) {
    const value = '_ctm_token_value';
    const format = token.format || 'latex';
    const rendered = format === 'json' ? 'stackjson_stringify(' + value + ')' :
      format === 'source' ? stringValue(value) : '(if stringp(' + value + ') then ' + value + ' else tex1(' + value + '))';
    return block([value], [value + ':' + evaluate(token.source),
      map([['format', quote(format)], ['value', rendered], ['string', 'stringp(' + value + ')'], ['wrap', bool(token.wrap !== false)]])]);
  }

  function tokenValues(question, template, prepare) {
    const ids = template == null ? null : new Set(Array.from(String(template).matchAll(TOKEN), match => match[1]));
    const tokens = (question.native?.tokens || []).filter(token => ids ? ids.has(token.id) : !prepare || token.phase !== 'feedback');
    return map(tokens.map(token => [token.id, tokenValue(token)]));
  }

  function renderTemplate(template, values, options = {}) {
    return String(template || '').replace(TOKEN, (marker, id) => {
      if (!Object.prototype.hasOwnProperty.call(values || {}, id)) throw new Error('Missing native CASText token: ' + id);
      const token = values[id];
      if (!token || typeof token.value !== 'string') throw new Error('Invalid native CASText token: ' + id);
      if (token.format === 'source' || token.format === 'json') return options.sourceMode === 'raw' ? token.value : escape(token.value);
      if (token.string) return escape(token.value);
      return token.wrap === false ? escape(token.value) : '\\(' + escape(token.value) + '\\)';
    });
  }

  function renderFeedbackPiece(piece) {
    if (Object.prototype.hasOwnProperty.call(piece,'nativeFeedback')) {
      const raw = piece.nativeFeedback;
      if (typeof raw !== 'string') throw new Error('Invalid native feedback protocol');
      if (!raw) return '';
      if (scope.NativeFeedback && typeof scope.NativeFeedback.format === 'function') return scope.NativeFeedback.format(raw);
      return '<span class="stack-native-feedback-raw">Native STACK feedback (untranslated): <code>' + escape(raw) + '</code></span>';
    }
    return piece.literal ? piece.template : renderTemplate(piece.template,piece.tokens);
  }

  function feedbackPiece(question, template) {
    return map([['template', quote(template || '')], ['tokens', tokenValues(question, template || '', false)]]);
  }

  function number(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid native numeric configuration');
    return String(value);
  }

  function rounding(value) { return Math.round(Math.max(0, Math.min(1, value)) * 1e10) / 1e10; }

  function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }

  async function hash(value) {
    const bytes = new TextEncoder().encode(canonical(value));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value => value.toString(16).padStart(2,'0')).join('');
  }

  function answerNoteMatches(expected, notes) {
    expected = String(expected || '').trim();
    if (!expected) return false;
    if (expected === '()') return true;
    if (!notes.length) return expected === 'NULL';
    if (expected === 'NULL') return false;
    const anchoredStart = expected.startsWith('['), anchoredEnd = !expected.endsWith(')');
    if (/^[[(]/.test(expected)) expected = expected.slice(1);
    if (/[\])]$/.test(expected)) expected = expected.slice(0,-1);
    const wanted = expected.split('|').map(note => note.trim());
    if (anchoredStart && wanted[0] !== notes[0].trim() || anchoredEnd && wanted.at(-1) !== notes.at(-1).trim()) return false;
    let position = 0;
    for (const note of wanted) {
      while (position < notes.length && notes[position].trim() !== note) position++;
      if (position === notes.length) return false;
      position++;
    }
    return true;
  }

  class NativeStackEngine {
    constructor({session, pythonCheck, onEvent} = {}) {
      if (!session || typeof session.evaluate !== 'function') throw new Error('A native Maxima session is required');
      this.session = session;
      this.pythonCheck = pythonCheck;
      this.onEvent = onEvent || (() => {});
    }

    emit(data) { this.onEvent(data); }

    evaluate(operation, question, expression) {
      const result = this.session.evaluate(expression);
      this.emit({event:'native-evaluate', operation, question:question.name, expression, result});
      return result;
    }

    async binding(question, variant) {
      if (question.native?.schema !== 1 || typeof question.native.id !== 'string' || !question.native.id) throw new Error('Unsupported native question plan identity');
      const manifest = this.session.manifest;
      if (!manifest || typeof manifest.stackRevision !== 'string' || !manifest.stackRevision) throw new Error('The native STACK revision is missing');
      return {schema:1,backend:'maxima-native',planSchema:question.native.schema,questionId:question.native.id,
        questionHash:await hash(question),seed:variant.seed,stackRevision:manifest.stackRevision,
        stackLibraryVersion:String(manifest.stackLibraryVersion),
        runtimeHash:manifest.runtimeAssets?.find(asset => asset.path === 'maxima.wasm')?.sha256 || null,
        preparedHash:await hash({seed:variant.seed,env:variant.env,teachers:variant.teachers,tokenValues:variant.tokenValues,qtests:variant.qtests})};
    }

    async assertVariant(question, variant) {
      if (!variant || !variant.env || typeof variant.env !== 'object' || Array.isArray(variant.env) || !Number.isSafeInteger(variant.seed)) {
        throw new Error('A native prepared variant is required');
      }
      const names = unique((question.native?.locals || assignments(question.variables).map(statement => statement.match(/^\w+/)[0])).map(nodeName)).sort();
      const actual = Object.keys(variant.env).sort();
      if (canonical(names) !== canonical(actual) || actual.some(name => typeof variant.env[name] !== 'string')) throw new Error('Native prepared environment does not match declared question variables');
      if (!variant.native || canonical(variant.native) !== canonical(await this.binding(question,variant))) {
        throw new Error('Native prepared variant does not match this question, backend, seed or STACK build');
      }
    }

    async prepare(question, seed = 1) {
      if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2147483647) throw new Error('Native seed must be an integer from 0 to 2147483647');
      const definitions = assignments(question.variables);
      for (const input of question.inputs) pureExpression(input.teacher,true);
      for (const token of question.native?.tokens || []) pureExpression(token.source,token.phase !== 'feedback');
      for (const prt of question.prts) {
        for (const statement of assignments(prt.feedbackvariables)) pureExpression(statement.slice(statement.indexOf(':') + 1));
        if (feedbackLocals(prt).some(name => question.inputs.some(input => input.name === name))) throw new Error('Feedback variables cannot reassign learner inputs in this native continuation subset');
        for (const node of prt.nodes) {
          pureExpression(node.student);
          pureExpression(node.teacher);
          if (node.test !== 'PythonChecker') pureExpression(node.options);
        }
      }
      for (const test of question.qtests || []) for (const expression of Object.values(test.inputs || {})) pureExpression(expression,true);
      const names = question.native?.locals || definitions.map(statement => statement.match(/^\w+/)[0]);
      const teachers = map(question.inputs.map(input => [input.name, map([
        ['source', stringValue(input.name)],
        // Empty string models have no display content. Maxima versions
        // otherwise differ between empty TeX and a visible text-space box.
        ['latex', 'if stringp(' + input.name + ') then (if slength(' + input.name + ')=0 then "" else tex1(' + input.name + ')) else tex1(' + input.name + ')'],
        ['type', typeOf(input.name)],
        ['shape', '(if matrixp(' + input.name + ') then matrix_size(' + input.name + ') else und)']
      ])]));
      // Author qtests evaluate with each input bound to its model answer, in
      // order, as STACK compute_response does. Grading receives the resulting
      // written source, never an unevaluated teacher-variable alias.
      const testContext = question.inputs.map(input => input.name + ':stackmap_get(_ctm_models,' + quote(input.name) + ')');
      const testAnswer = (name, expression) => {
        const input = question.inputs.find(input => input.name === name);
        if (!input) throw new Error('Unknown native authored-test input: ' + name);
        if (['string','json'].includes(input.type)) return block(['_ctm_qvalue'], [
          '_ctm_qvalue:' + evaluate(expression),
          'if not stringp(_ctm_qvalue) then error("String/JSON authored test must evaluate to a string")',
          '_ctm_qvalue'
        ]);
        if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(expression).trim())) return quote(String(expression).trim());
        // Compute trusted aliases with the native environment but retain the
        // unsimplified entered operations. Otherwise 2/4 becomes 1/2 before a
        // LowestTerms/EqualComAss test ever sees the authored response.
        return block(['simp:false'], [stringValue(evaluate(expression))]);
      };
      const qtests = array((question.qtests || []).map(test => block([], [
        ...testContext,
        map([['testcase', quote(test.testcase)], ['answers', map(Object.entries(test.inputs || {}).map(([name, expression]) =>
          [name, testAnswer(name,expression)]))]])
      ])));
      const expression = block(context(question,['_ctm_models']), [
        'set_random_state(make_random_state(' + seed + '))', ...definitions,
        ...question.inputs.map(input => input.name + ':' + evaluate(input.teacher)),
        '_ctm_models:' + map(question.inputs.map(input => [input.name,input.name])),
        map([['seed', String(seed)], ['env', snapshot(names)], ['teachers', teachers],
          ['tokenValues', tokenValues(question, null, true)], ['qtests', qtests]])
      ]);
      const variant = this.evaluate('prepare', question, expression);
      if (!variant || variant.seed !== seed || !variant.env || !variant.teachers || !variant.tokenValues) throw new Error('Malformed native prepared variant');
      variant.native = await this.binding(question,variant);
      return variant;
    }

    admission(question, variant, answers) {
      if (!scope.NativeInput || typeof scope.NativeInput.admit !== 'function') throw new Error('The native input controller is missing');
      const admitted = {}, inputs = {};
      for (const input of question.inputs) {
        const raw = answers?.[input.name];
        if (typeof raw !== 'string' || !raw.trim()) {
          inputs[input.name] = {valid:false,latex:'',feedback:'Enter an answer'};
          continue;
        }
        try { admitted[input.name] = scope.NativeInput.admit(raw, input, question, variant); }
        catch (error) {
          if (!scope.NativeInput.AdmissionError || !(error instanceof scope.NativeInput.AdmissionError)) throw error;
          inputs[input.name] = {valid:false,latex:'',feedback:String(error.message || error)};
        }
      }
      return {admitted, inputs};
    }

    validationExpression(question, variant, admitted) {
      const checks = [];
      for (const input of question.inputs) {
        if (!admitted[input.name]) continue;
        const student = evaluate(admitted[input.name].source);
        const teacher = evaluate(variant.teachers[input.name].source);
        const path = 'sconcat(maxima_tempdir,"/ctm-native-validation.txt")';
        const lowest = bool(input.requirelowestterms);
        const validation = input.checkanswertype ?
          'stack_validate([_ctm_s],' + lowest + ',_ctm_t,0)' :
          'stack_validate_typeless([_ctm_s],' + lowest + ',_ctm_t,0,false)';
        const scalar = !['string','json'].includes(input.type);
        const extra = [];
        if (input.type === 'numerical') extra.push('if not numberp(ev(_ctm_s,simp)) then _ctm_lines:endcons("Enter a numerical answer",_ctm_lines)');
        if (input.type === 'matrix') {
          const dimensions = input.matrix;
          const shape = dimensions ?
            [dimensions.rows, dimensions.cols].map((axis, at) => {
              if (!axis) throw new Error('Invalid native matrix dimensions');
              return '(_ctm_shape[' + (at + 1) + ']<' + number(axis.min) + ' or _ctm_shape[' + (at + 1) + ']>' + number(axis.max) +
                (axis.auto ? '' : ' or _ctm_shape[' + (at + 1) + ']#' + number(axis.initial)) + ')';
            }).join(' or ') : '_ctm_shape#matrix_size(_ctm_t)';
          extra.push('if not matrixp(_ctm_s) then _ctm_lines:endcons("Enter a matrix",_ctm_lines)' +
            ' else (_ctm_shape:matrix_size(_ctm_s),if ' + shape + ' then _ctm_lines:endcons("Matrix dimensions do not match this input",_ctm_lines))');
        }
        // A held input may evaluate successfully with simp:false but fail
        // during a numerical check, TeX conversion or canonical rendering.
        // All learner-dependent work belongs to the same error boundary.
        const learnerChecks = [
          '_ctm_s:' + student,
          scalar ? 'with_stdout(' + path + ',_ctm_v:' + validation + ')' : '_ctm_v:_ctm_s',
          ...(scalar ? ['_ctm_stream:openr(' + path + ')','_ctm_line:readline(_ctm_stream)',
            'while not is(_ctm_line=false) do (if slength(_ctm_line)>0 then _ctm_lines:endcons(_ctm_line,_ctm_lines),_ctm_line:readline(_ctm_stream))',
            'close(_ctm_stream)'] : []),
          'if length(%ERR)>1 then _ctm_lines:endcons("Native STACK could not evaluate this expression",_ctm_lines)',
          ...extra,
          '_ctm_good:is(_ctm_lines=[] and length(%ERR)=1)',
          map([['valid','_ctm_good'], ['latex','if _ctm_good then tex1(_ctm_s) else ""'],
            ['feedback','simplode(_ctm_lines," ")'], ['source','if _ctm_good then string(ev(_ctm_s,simp)) else ""']])
        ];
        // A Maxima error or Lisp arithmetic error is the learner's domain
        // error (1/0) and stays invalid in this healthy session. Any other
        // Lisp error is an internal CAS fault: fail the request so the
        // session's existing poison/restart path discards this worker.
        checks.push([input.name, block(['_ctm_s','_ctm_t','_ctm_v','_ctm_r','_ctm_lines','_ctm_stream','_ctm_line','_ctm_shape','_ctm_good',
          '%ERR:["stack_map"]','%NOTES:["stack_map"]','%FEEDBACK:["stack_map"]'], [
          'simp:false', '_ctm_lines:[]', '_ctm_t:' + teacher,
          '_ctm_r:ctm_classified_errcatch(' + block([],learnerChecks) + ')',
          'if _ctm_r[1]="internal" then error(' + quote(INTERNAL_FAULT + ': ') + ',errormsgtostring())',
          'if _ctm_r[1]="learner" then ' + map([['valid','false'],['latex','""'],
            ['feedback','"Native STACK could not evaluate this expression"'],['source','""']]) + ' else _ctm_r[2]'
        ])]);
      }
      return block(context(question), [...restore(variant), map(checks)]);
    }

    async _validate(question, variant, answers) {
      await this.assertVariant(question,variant);
      const {admitted, inputs} = this.admission(question, variant, answers);
      const native = Object.keys(admitted).length ? this.evaluate('validate', question, this.validationExpression(question, variant, admitted)) : {};
      const values = {};
      for (const input of question.inputs) {
        const result = native[input.name];
        if (!result) continue;
        if (typeof result.valid !== 'boolean' || typeof result.latex !== 'string' || typeof result.feedback !== 'string') throw new Error('Malformed native validation result');
        values[input.name] = result.source;
        inputs[input.name] = {valid:result.valid, latex:result.latex, feedback:result.feedback};
      }
      return {admitted,inputs,values,valid:question.inputs.every(input => inputs[input.name]?.valid === true)};
    }

    async validate(question, variant, answers) {
      const result = await this._validate(question, variant, answers);
      return {status:result.valid ? 'valid' : 'invalid', inputs:result.inputs,
        feedback:result.valid ? 'Review the parsed answers' : 'Correct invalid answers before grading'};
    }

    branch(question, node, branchName) {
      const branch = node[branchName];
      const score = branch.mode === '=' ? number(branch.score) : 'ev(_ctm_score' + branch.mode + '(' + number(branch.score) + '),simp)';
      const piece = node.quiet || !branch.feedback ? [] : ['_ctm_feedback:endcons(' + feedbackPiece(question, branch.feedback) + ',_ctm_feedback)'];
      return '(' + [
        '_ctm_score:' + score,
        '_ctm_notes:endcons(' + quote(branch.note || '') + ',_ctm_notes)',
        '_ctm_path:endcons(' + map([['node',quote(node.name)],['branch',quote(branchName)],['note',quote(branch.note || '')]]) + ',_ctm_path)',
        ...piece, '_ctm_current:' + quote(branch.next)
      ].join(',') + ')';
    }

    prtExpression(question, prt, variant, admitted, continuation, pythonResult) {
      const names = feedbackLocals(prt);
      if (names.some(name => question.inputs.some(input => input.name === name))) {
        throw new Error('Feedback variables cannot reassign learner inputs in this native continuation subset');
      }
      const locals = context(question, ['_ctm_current','_ctm_score','_ctm_notes','_ctm_feedback','_ctm_path','_ctm_events','_ctm_steps','_ctm_r','_ctm_v','_ctm_paused'], prt);
      const expressions = restore(variant, admitted);
      if (continuation) {
        if (canonical(Object.keys(continuation.environment || {}).sort()) !== canonical([...names].sort())) {
          throw new Error('Native continuation feedback environment does not match this response tree');
        }
        for (const [name, source] of Object.entries(continuation.environment)) expressions.push(nodeName(name) + ':' + evaluate(source));
        expressions.push('_ctm_current:' + quote(continuation.node), '_ctm_score:' + number(continuation.score),
          '_ctm_notes:' + array(continuation.notes.map(quote)),
          '_ctm_path:' + array(continuation.path.map(item => map(Object.entries(item).map(([key,value]) => [key,quote(value)])))),
          '_ctm_feedback:' + this.literal(continuation.feedback));
      } else {
        const feedback = assignments(prt.feedbackvariables);
        if (feedback.some(statement => RANDOM_CALL.test(statement.replace(/"(?:\\.|[^"\\])*"/g,'""')))) {
          throw new Error('Random feedback variables are outside this native continuation subset; freeze random values in question variables');
        }
        expressions.push('simp:' + bool(prt.autosimplify !== false), ...feedback,
          '_ctm_current:"0"','_ctm_score:0','_ctm_notes:[]','_ctm_feedback:[]','_ctm_path:[]');
      }
      expressions.push('_ctm_events:[]','_ctm_steps:0','_ctm_paused:false');
      const clauses = [];
      for (const node of prt.nodes) {
        if ([node.student,node.teacher,node.test === 'PythonChecker' ? '' : node.options].some(source =>
          RANDOM_CALL.test(String(source || '').replace(/"(?:\\.|[^"\\])*"/g,'""')))) {
          throw new Error('Random response-tree expressions are outside this native subset; freeze random values in question variables');
        }
        let action;
        if (node.test === 'PythonChecker') {
          if (continuation?.node === node.name && pythonResult) {
            const branch = this.branch(question, node, pythonResult.correct ? 'true' : 'false');
            // Match the existing CTM controller: authored branch feedback
            // precedes the checker's plain-text feedback on this same node.
            action = pythonResult.feedback && !node.quiet ? '(' + branch + ',_ctm_feedback:endcons(' +
              map([['template',quote(escape(pythonResult.feedback))],['tokens',map([])],['literal','true']]) + ',_ctm_feedback))' : branch;
          } else {
            // Maxima return() inside do/while exits only that loop. Store the
            // continuation explicitly, then select it after the loop ends.
            action = '(_ctm_paused:' + map([
              ['kind','"python"'], ['node',quote(node.name)], ['score','_ctm_score'], ['notes','_ctm_notes'],
              ['feedback','_ctm_feedback'], ['path','_ctm_path'], ['events','_ctm_events'], ['environment',snapshot(names)],
              ['student',tagged(evaluate(node.student))], ['teacher',tagged(evaluate(node.teacher))]
            ]) + ',_ctm_current:"-1")';
          }
        } else {
          const spec = this.session.manifest.tests[node.test];
          if (!spec || !/^[A-Za-z0-9]+$/.test(node.test)) throw new Error('Unsupported native answer test: ' + node.test);
          const args = [evaluate(node.student), evaluate(node.teacher)];
          if (spec[0]) {
            const option = String(node.options || '').trim();
            if (!option && !['NumAbsolute','NumRelative'].includes(node.test)) throw new Error('Native answer-test options are required: ' + node.test);
            args.push(evaluate(option || '0.05'));
          }
          if (spec[2]) args.push(quote(admitted[node.student]?.raw || node.student));
          action = '(' + [
            'simp:' + bool(spec[1]), '%ERR:["stack_map"]','%NOTES:["stack_map"]','%FEEDBACK:["stack_map"]',
            '_ctm_r:errcatch(AT' + node.test + '(' + args.join(',') + '))',
            'if _ctm_r=[] or length(%ERR)>1 then error("Native answer-test evaluation failed")',
            '_ctm_v:first(_ctm_r)',
            'if not listp(_ctm_v) or length(_ctm_v)<4 then error("Malformed native answer-test result")',
            'if not member(_ctm_v[1],[true,false]) or not member(_ctm_v[2],[true,false]) then error("Invalid native answer-test verdict")',
            'if not is(ssearch("STACKERROR",string(_ctm_v[3]))=false) or not is(ssearch("ATNumDecPlaces_OptNotInt",string(_ctm_v[3]))=false)' +
              ' then error("Native answer-test author configuration failed")',
            '_ctm_events:endcons(' + map([['event','"native-at"'],['prt',quote(prt.name)],['node',quote(node.name)],
              ['test',quote(node.test)],['cas_valid','_ctm_v[1]'],['correct','_ctm_v[2]'],['answerNote','_ctm_v[3]'],['nativeFeedback','_ctm_v[4]']]) + ',_ctm_events)',
            'if is(_ctm_v[2]=true) then ' + this.branch(question,node,'true') + ' else ' + this.branch(question,node,'false'),
            ...(!node.quiet ? ['if not stringp(_ctm_v[4]) then error("Invalid native feedback protocol")',
              'if not is(_ctm_v[4]="") then _ctm_feedback:endcons(' + map([['nativeFeedback','_ctm_v[4]']]) + ',_ctm_feedback)'] : [])
          ].join(',') + ')';
        }
        clauses.push('if _ctm_current=' + quote(node.name) + ' then ' + action);
      }
      // Use one mutually exclusive dispatch per iteration: a node can change
      // current to a later identifier, which must not also run in this loop's
      // remaining clauses. Maxima owns all branch decisions and score updates.
      const dispatch = clauses.join(' else ') + ' else error("Unknown native response-tree node")';
      expressions.push('while _ctm_current#"-1" do (_ctm_steps:ev(_ctm_steps+1,simp),if _ctm_steps>' + (prt.nodes.length + 1) +
        ' then error("Native response-tree cycle"),' + dispatch + ')');
      expressions.push('if listp(_ctm_paused) then _ctm_paused else ' +
        map([['kind','"done"'],['score','ev(max(0,min(1,_ctm_score)),simp)'],['notes','_ctm_notes'],
          ['feedback','_ctm_feedback'],['path','_ctm_path'],['events','_ctm_events']]));
      return block(locals, expressions);
    }

    literal(value) {
      if (value === null) return 'und';
      if (typeof value === 'boolean') return bool(value);
      if (typeof value === 'string') return quote(value);
      if (typeof value === 'number') return number(value);
      if (Array.isArray(value)) return array(value.map(item => this.literal(item)));
      if (value && typeof value === 'object') return map(Object.entries(value).map(([key,item]) => [key,this.literal(item)]));
      throw new Error('Invalid native continuation value');
    }

    async grade(question, variant, answers) {
      const validation = await this._validate(question, variant, answers);
      const inputs = validation.inputs;
      if (!validation.valid) return {status:'invalid',score:0,inputs,prts:{},feedback:'Check your answers before grading'};
      const prts = {};
      for (const prt of question.prts) {
        let state = null, pythonResult = null, result;
        for (let step = 0; step <= prt.nodes.length; step++) {
          result = this.evaluate('prt', question, this.prtExpression(question, prt, variant, validation.admitted, state, pythonResult));
          if (!result || !['done','python'].includes(result.kind) || !Array.isArray(result.events)) throw new Error('Malformed native response-tree result');
          for (const event of result.events) this.emit(event);
          if (result.kind === 'done') break;
          const node = prt.nodes.find(node => node.name === result.node && node.test === 'PythonChecker');
          if (!node || typeof this.pythonCheck !== 'function') throw new Error('PythonChecker is not configured for this native question');
          this.emit({event:'python-checker',phase:'pause',prt:prt.name,node:node.name});
          pythonResult = await this.pythonCheck({descriptor:question.python_checkers,options:node.options,
            student:result.student,teacher:result.teacher,
            assumptions:{real:Boolean(question.assumereal),positive:Boolean(question.assumepositive)}});
          if (!pythonResult || typeof pythonResult.valid !== 'boolean' || typeof pythonResult.correct !== 'boolean') throw new Error('Malformed PythonChecker result');
          this.emit({event:'python-checker',phase:'resume',prt:prt.name,node:node.name,valid:pythonResult.valid,correct:pythonResult.correct});
          if (!pythonResult.valid) {
            const feedback = node.quiet ? 'Invalid answer' : pythonResult.feedback || 'Invalid answer';
            if (inputs[node.student]) inputs[node.student] = {...inputs[node.student],valid:false,feedback};
            for (const input of Object.values(inputs)) delete input.assessment;
            return {status:'invalid',score:0,inputs,prts,feedback};
          }
          if (pythonResult.assessment && !node.quiet && inputs[node.student]) inputs[node.student].assessment = pythonResult.assessment;
          state = result;
        }
        if (result?.kind !== 'done') throw new Error('Native Python continuation bound exceeded');
        const notes = result.notes || [];
        prts[prt.name] = {score:rounding(result.score), feedback:(result.feedback || []).map(renderFeedbackPiece).filter(Boolean).join(' '),
          notes, note:notes.filter(Boolean).join(' | '), path:result.path};
      }
      const totalWeight = question.prts.reduce((total,prt) => total + prt.value, 0);
      if (!(totalWeight > 0)) throw new Error('Native PRT weights must have a positive total');
      const score = rounding(question.prts.reduce((total,prt) => total + prt.value * prts[prt.name].score, 0) / totalWeight);
      return {status:'graded',score,inputs,prts,feedback:Object.values(prts).map(prt => prt.feedback).filter(Boolean).join(' ')};
    }

    async tests(question, variants) {
      if (!Array.isArray(variants)) variants = [variants];
      const rows = [];
      for (const variant of variants) {
        for (const expected of question.qtests || []) {
          const prepared = (variant.qtests || []).find(test => String(test.testcase) === String(expected.testcase));
          if (!prepared) throw new Error('Native authored test was not prepared: ' + expected.testcase);
          const actual = await this.grade(question,variant,prepared.answers);
          const checks = Object.entries(expected.expected || {}).map(([name,wanted]) => {
            const prt = actual.prts[name];
            const penalty = prt && prt.score < 1 ? question.penalty : 0;
            return {prt:name,passed:Boolean(prt && Math.abs(prt.score - wanted.score) < 1e-8 && Math.abs(penalty - wanted.penalty) < 1e-8 &&
              answerNoteMatches(wanted.note,prt.notes.filter(Boolean))),expected:wanted,
              actual:{score:prt?.score ?? null,penalty,note:prt?.note || ''}};
          });
          rows.push({testcase:expected.testcase,seed:variant.seed,passed:checks.length > 0 && checks.every(check => check.passed),
            inputs:prepared.answers,checks,expected:expected.expected,actual});
        }
      }
      return {passed:rows.length > 0 && rows.every(row => row.passed),results:rows};
    }
  }
  NativeStackEngine.INTERNAL_FAULT = INTERNAL_FAULT;
  NativeStackEngine.renderTemplate = renderTemplate;
  NativeStackEngine.statements = statements;
  scope.NativeStackEngine = NativeStackEngine;
})(typeof self === 'undefined' ? globalThis : self);
