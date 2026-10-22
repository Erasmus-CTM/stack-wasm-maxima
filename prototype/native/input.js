// SPDX-License-Identifier: AGPL-3.0-or-later
// Recognize a bounded student expression with the unmodified STACK-MP-lite
// parser, then admit only mathematical AST nodes. Native STACK does validation
// and assessment. This is not Moodle's full PHP corrective input controller.
(function (scope) {
  'use strict';
  const LIMITS = Object.freeze({mathCharacters:4096, textBytes:65536, nodes:1024, depth:60,
    collectionDepth:6, collectionEntries:128, collectionLength:32, matrixDimension:16,
    matrixEntries:64, numericDigits:100, numericExponent:300, power:100, jsonDepth:12, jsonNodes:4096});
  const SAFE_FUNCTIONS = Object.freeze({
    sqrt:[1,1], abs:[1,1], sin:[1,1], cos:[1,1], tan:[1,1], sec:[1,1], csc:[1,1], cot:[1,1],
    asin:[1,1], acos:[1,1], atan:[1,1], asec:[1,1], acsc:[1,1], acot:[1,1],
    sinh:[1,1], cosh:[1,1], tanh:[1,1], sech:[1,1], csch:[1,1], coth:[1,1],
    asinh:[1,1], acosh:[1,1], atanh:[1,1], asech:[1,1], acsch:[1,1], acoth:[1,1],
    arcsin:[1,1], arccos:[1,1], arctan:[1,1], arcsec:[1,1], arccsc:[1,1], arccot:[1,1],
    arcsinh:[1,1], arccosh:[1,1], arctanh:[1,1], arcsech:[1,1], arccsch:[1,1], arccoth:[1,1],
    exp:[1,1], log:[1,1], ln:[1,1], signum:[1,1], floor:[1,1], ceiling:[1,1],
    conjugate:[1,1], realpart:[1,1], imagpart:[1,1], gcd:[2,2], lcm:[2,2], mod:[2,2],
    min:[1,16], max:[1,16], matrix:[1,16], root:[1,2]
  });
  const FUNCTION_ALIASES = {ln:'log', arcsin:'asin', arccos:'acos', arctan:'atan', arcsec:'asec',
    arccsc:'acsc', arccot:'acot', arcsinh:'asinh', arccosh:'acosh', arctanh:'atanh',
    arcsech:'asech', arccsch:'acsch', arccoth:'acoth'};
  const CONSTANTS = {e:'%e', i:'%i', pi:'%pi', Pi:'%pi', '%e':'%e', '%i':'%i', '%pi':'%pi'};
  const OPERATORS = new Set(['+','-','*','/','^','**','=','<','>','<=','>=','#',
    'and','or','xor','xnor','implies','nounand','nounor']);
  const PREFIXES = new Set(['+','-','not','nounnot']);
  const LOGIC = {and:'nounand', or:'nounor', not:'nounnot'};
  const NAME = /^%?[A-Za-z][A-Za-z_0-9]*$/;
  const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const own = (value, name) => Object.prototype.hasOwnProperty.call(value, name);

  class AdmissionError extends Error {
    constructor(message, code='invalid-input') { super(message); this.name = 'AdmissionError'; this.code = code; }
  }
  function invalid(message, code) { throw new AdmissionError(message, code); }
  function enabled(value) { return value === true || value === 1 || value === '1'; }
  function words(value) { return Array.isArray(value) ? value : String(value || '').split(/[,\s]+/).filter(Boolean); }
  function caseMessage(name, spellings, kind) {
    const variants = spellings.filter(word => word.toLowerCase() === name.toLowerCase());
    if (variants.length && !variants.includes(name)) {
      return `Input is case sensitive: ${name} is an unknown ${kind}. Did you mean ${variants.join(', ')}?`;
    }
    return null;
  }
  function rules() {
    const data = scope.NativeInputRules;
    if (!data || data.schema !== 1 || !Array.isArray(data.readable) || !Array.isArray(data.replacements)) {
      throw new Error('The pinned native input-security data is unavailable');
    }
    return data;
  }
  function forbiddenNames(question, variant) {
    const names = new Set([...Object.keys(variant?.env || {}), ...(question?.native?.locals || []),
      ...(question?.inputs || []).map(input => input.name)]);
    for (const prt of question?.prts || []) {
      for (const name of prt.locals || []) names.add(name);
      // The compiler supplies locals; this conservative read also protects
      // direct worker consumers from ordinary feedback-variable leakage.
      for (const match of String(prt.feedbackvariables || '').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|[;$])\s*([A-Za-z][A-Za-z_0-9]*)\s*:(?!=)/g)) names.add(match[1]);
    }
    for (const match of String(question?.variables || '').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|[;$])\s*([A-Za-z][A-Za-z_0-9]*)\s*:(?!=)/g)) names.add(match[1]);
    return names;
  }
  function plainString(value) {
    // Maxima's reader does not share JSON's \n/\u escape semantics. Keep
    // controls out of the source spelling and construct them with ascii().
    const parts = [], chunks = String(value).split(/([\x00-\x1f\x7f])/u);
    for (const chunk of chunks) {
      if (!chunk) continue;
      if (/^[\x00-\x1f\x7f]$/.test(chunk)) parts.push('ascii(' + chunk.charCodeAt(0) + ')');
      else parts.push('"' + chunk.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"');
    }
    return parts.length > 1 ? 'sconcat(' + parts.join(',') + ')' : (parts[0] || '""');
  }
  function checkJSON(raw) {
    let value;
    try { value = JSON.parse(raw); } catch { invalid('Enter valid JSON.', 'json-syntax'); }
    let count = 0;
    function visit(item, depth) {
      if (++count > LIMITS.jsonNodes || depth > LIMITS.jsonDepth) invalid('JSON input exceeds the supported size or depth.', 'input-bound');
      if (typeof item === 'number' && !Number.isFinite(item)) invalid('JSON numbers must be finite.', 'json-number');
      if (typeof item === 'string' && /[\ud800-\udfff]/u.test(item)) invalid('JSON strings must contain valid Unicode.', 'character');
      if (item && typeof item === 'object') for (const child of Object.values(item)) visit(child, depth + 1);
    }
    visit(value, 0);
  }
  function normalizedText(raw, data) {
    let text = raw;
    for (const [before, after] of data.replacements) if (text.includes(before)) text = text.split(before).join(after);
    if (/[^\x20-\x7e]/.test(text)) invalid('Unsupported character in mathematical input.', 'character');
    if (/[;:$@&\\~`?"']/.test(text) || /\/\*|\*\//.test(text)) {
      invalid('Only a mathematical expression is allowed.', 'syntax');
    }
    const noLogic = text.replace(/\b(?:nounand|nounor|nounnot|and|or|not|xor|xnor|implies)\b/g, '|');
    if (/[A-Za-z0-9_)]+ +[A-Za-z0-9_(]+/.test(noLogic)) {
      invalid('Spaces between mathematical terms are not allowed. Use an explicit operator.', 'spaces');
    }
    return text.trim();
  }
  function admit(raw, input={}, question={}, variant={}) {
    if (typeof raw !== 'string') invalid('The answer must be a string.', 'input-type');
    if (/[\ud800-\udfff]/u.test(raw)) invalid('Input must contain valid Unicode.', 'character');
    const type = input.type || 'algebraic';
    if (type === 'string' || type === 'json') {
      if (new TextEncoder().encode(raw).length > LIMITS.textBytes) invalid('Text input exceeds 65536 UTF-8 bytes.', 'input-bound');
      if (type === 'json') checkJSON(raw);
      return {raw, source:plainString(raw), type};
    }
    if (!['algebraic','numerical','matrix'].includes(type)) throw new Error('Unsupported native input type: ' + type);
    if (raw.length > LIMITS.mathCharacters) invalid('Mathematical input exceeds 4096 characters.', 'input-bound');
    if (input.strictsyntax !== undefined && !enabled(input.strictsyntax)) throw new Error('Native admission requires strictsyntax=1');
    if (input.allowwords && words(input.allowwords).length) throw new Error('Native admission does not support allowwords');
    if (input.insertstars !== undefined && ![0,1,'0','1'].includes(input.insertstars)) throw new Error('Native admission supports insertstars 0 or 1');
    const data = rules(), parser = scope.StackMaximaParser;
    if (!parser?.parse_decimal_dot) throw new Error('The pinned native expression parser is unavailable');
    const text = normalizedText(raw, data);
    if (!text) invalid('Enter an answer.', 'blank');
    const forbidden = forbiddenNames(question, variant);
    const forbiddenWords = new Set(words(input.forbidwords));
    const readable = new Set(data.readable), unreadable = new Set(data.unreadable), functions = new Set(data.functions);
    const globallyForbidden = new Set(data.globallyForbidden), callable = new Set(data.callable);
    let node;
    try { node = parser.parse_decimal_dot(text, Number(input.insertstars) === 1 ? '*' : undefined, false); }
    catch { invalid('The mathematical expression could not be parsed.', 'syntax'); }
    let nodes = 0, entries = 0;
    function nameSource(name, role) {
      if (!NAME.test(name) || forbidden.has(name)) invalid('Forbidden variable or constant: ' + name + '.', 'forbidden-name');
      if (forbiddenWords.has(name)) invalid('The expression ' + name + ' is forbidden.', 'forbidden-word');
      if (role === 'function') {
        const caseError = caseMessage(name, data.functions, 'function');
        if (caseError) invalid(caseError, 'case');
        if (!own(SAFE_FUNCTIONS, name) || !callable.has(FUNCTION_ALIASES[name] || name)) invalid('Unsupported mathematical function: ' + name + '.', 'unsupported-function');
        return FUNCTION_ALIASES[name] || name;
      }
      if (globallyForbidden.has(name)) invalid('The expression ' + name + ' is forbidden.', 'forbidden-name');
      const caseError = caseMessage(name, data.variables, 'variable');
      if (caseError) invalid(caseError, 'case');
      function allowed(part) {
        if (unreadable.has(part) || forbidden.has(part)) return false;
        if (readable.has(part)) return true;
        if (part.startsWith('%') || !/^[A-Za-z][A-Za-z_0-9]*$/.test(part)) return false;
        return part.length <= 2 && !functions.has(part) || /[0-9]$/.test(part);
      }
      if (!allowed(name) && !name.split('_').every(part => allowed(part))) {
        invalid('Forbidden variable or constant: ' + name + '.', 'forbidden-name');
      }
      return CONSTANTS[name] || name;
    }
    function numberSource(value) {
      value = String(value);
      if (!NUMBER.test(value)) invalid('Unsupported numeric literal.', 'number');
      const [mantissa, exponent='0'] = value.split(/[eE]/);
      if (mantissa.replace('.', '').length > LIMITS.numericDigits || Math.abs(Number(exponent)) > LIMITS.numericExponent) {
        invalid('Numeric literal exceeds the supported bound.', 'input-bound');
      }
      if (enabled(input.forbidfloat) && /[.eE]/.test(value)) invalid('Floating-point numbers are not allowed.', 'float');
      return value;
    }
    // This approximate calculation is used only to reject enormous literal
    // exponents. It never supplies a mathematical value to the checker.
    function literal(n) {
      const kind = n.constructor.name;
      if (kind === 'MPInteger' || kind === 'MPFloat') return Number(n.value);
      if (kind === 'MPGroup' && n.items.length === 1) return literal(n.items[0]);
      if (kind === 'MPPrefixOp' && ['+','-'].includes(n.op.trim())) {
        const value = literal(n.rhs); return value === null ? null : (n.op.trim() === '-' ? -value : value);
      }
      if (kind === 'MPOperation' && ['+','-','*','/','^','**'].includes(n.op.trim())) {
        const a = literal(n.lhs), b = literal(n.rhs);
        if (a === null || b === null) return null;
        if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 1e6 || Math.abs(b) > 1e6) return Infinity;
        switch (n.op.trim()) {case '+':return a+b; case '-':return a-b; case '*':return a*b; case '/':return a/b; default:return Math.pow(a,b);}
      }
      return null;
    }
    function visit(n, depth=0, collectionDepth=0) {
      if (!n || ++nodes > LIMITS.nodes || depth > LIMITS.depth) invalid('Expression exceeds the supported size or depth.', 'input-bound');
      const kind = n.constructor.name;
      if (kind === 'MPInteger' || kind === 'MPFloat') return numberSource(n.value);
      if (kind === 'MPBoolean') {
        if (![true,false,'true','false'].includes(n.value)) invalid('Invalid logical constant.');
        return n.value === true || n.value === 'true' ? 'true' : 'false';
      }
      if (kind === 'MPIdentifier') return nameSource(n.value, 'variable');
      if (kind === 'MPGroup') {
        if (n.items.length !== 1) invalid('Only one mathematical expression is allowed.', 'syntax');
        return '(' + visit(n.items[0], depth+1, collectionDepth) + ')';
      }
      if (kind === 'MPList' || kind === 'MPSet') {
        if (n.items.length > LIMITS.collectionLength || collectionDepth >= LIMITS.collectionDepth ||
            (entries += n.items.length) > LIMITS.collectionEntries) invalid('Collection exceeds the supported size or depth.', 'input-bound');
        const bounds = kind === 'MPList' ? ['[',']'] : ['{','}'];
        return bounds[0] + n.items.map(item => visit(item, depth+1, collectionDepth+1)).join(',') + bounds[1];
      }
      if (kind === 'MPOperation') {
        const op = n.op.trim();
        if (!OPERATORS.has(op)) invalid('Unsupported mathematical operator: ' + op + '.', 'syntax');
        if (op === '^' || op === '**') {
          const exponent = literal(n.rhs);
          if (exponent !== null && (!Number.isFinite(exponent) || Math.abs(exponent) > LIMITS.power)) invalid('Power exceeds the supported exponent bound of 100.', 'input-bound');
        }
        // MP-lite was designed for CAS-generated input and differs from
        // Maxima's student precedence for some logic/equation combinations.
        // Retain operator order and explicit groups, never invent parentheses.
        return visit(n.lhs, depth+1, collectionDepth) + ' ' + (LOGIC[op] || (op === '**' ? '^' : op)) + ' ' + visit(n.rhs, depth+1, collectionDepth);
      }
      if (kind === 'MPPrefixOp') {
        const op = n.op.trim();
        if (!PREFIXES.has(op)) invalid('Unsupported mathematical prefix operator.', 'syntax');
        return (LOGIC[op] || op) + (op === 'not' || op === 'nounnot' ? ' ' : '') + visit(n.rhs, depth+1, collectionDepth);
      }
      if (kind === 'MPFunctionCall') {
        if (n.name.constructor.name !== 'MPIdentifier') {
          // MP-lite represents adjacent parenthesized products as calls.
          // In insertion mode 1, admit only an explicit mathematical product
          // with one argument; computed callable names remain impossible.
          if (Number(input.insertstars) === 1 && n.args.length === 1 &&
              ['MPGroup','MPInteger','MPFloat'].includes(n.name.constructor.name)) {
            return visit(n.name, depth+1, collectionDepth) + ' * (' + visit(n.args[0], depth+1, collectionDepth) + ')';
          }
          invalid('Computed function names are not allowed.', 'syntax');
        }
        const original = n.name.value, name = nameSource(original, 'function');
        const arity = SAFE_FUNCTIONS[original];
        if (n.args.length < arity[0] || n.args.length > arity[1]) invalid('Unsupported number of arguments for ' + original + '.', 'arity');
        if (name === 'matrix') {
          const rows = n.args.map(row => { while (row.constructor.name === 'MPGroup' && row.items.length === 1) row = row.items[0]; return row; });
          const columns = rows[0]?.items?.length;
          if (!columns || rows.length > LIMITS.matrixDimension || columns > LIMITS.matrixDimension || rows.length*columns > LIMITS.matrixEntries ||
              rows.some(row => row.constructor.name !== 'MPList' || row.items.length !== columns ||
                row.items.some(item => ['MPList','MPSet','MPFunctionCall'].includes(item.constructor.name) &&
                  (item.constructor.name !== 'MPFunctionCall' || item.name.value === 'matrix')))) invalid('Enter a rectangular matrix with at most 64 scalar entries.', 'matrix-shape');
        }
        return name + '(' + n.args.map(arg => visit(arg, depth+1, collectionDepth)).join(',') + ')';
      }
      invalid('Unsupported mathematical syntax: ' + kind + '.', 'syntax');
    }
    const source = visit(node);
    if (source.length > 16384) invalid('Canonical expression exceeds the supported size.', 'input-bound');
    return {raw:text, source, type};
  }
  scope.NativeInput = Object.freeze({admit, AdmissionError, limits:LIMITS, quoteString:plainString,
    supportedFunctions:Object.freeze(Object.keys(SAFE_FUNCTIONS))});
})(self);
