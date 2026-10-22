// SPDX-License-Identifier: AGPL-3.0-or-later
// Display native STACK's bounded translation protocol. This module does not
// run CAS code, infer correctness, or execute Moodle's PHP/JavaScript protocol.
(function (scope) {
  'use strict';
  const REVISION = '33383047af39c204bf4442802a058f8b918b2b1b';
  const MAX_LENGTH = 131072, MAX_CALLS = 128, MAX_ARGS = 8;
  const PLACEHOLDER = /\{\$a->m([0-7])\}/g;
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const escape = text => text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  // Native TeX is text for the page's MathJax renderer. Keep a bounded display
  // vocabulary: no macro definitions, dynamic packages, URLs, or HTML helpers.
  const TEX_COMMANDS = new Set(('left right middle begin end color underline overline underbrace overbrace ' +
    'frac dfrac tfrac sqrt root of over atop choose binom matrix pmatrix bmatrix ' +
    'sin cos tan sec csc cot sinh cosh tanh sech csch coth arcsin arccos arctan ' +
    'arcsinh arccosh arctanh log ln exp det gcd lcm min max lim sup inf mod bmod pmod ' +
    'sum prod int iint iiint oint infty partial nabla prime cdot cdots ldots vdots ddots times div pm mp ' +
    'le leq ge geq ne neq equiv approx sim simeq propto to rightarrow leftarrow ' +
    'longrightarrow longleftarrow Rightarrow Leftarrow Leftrightarrow iff mapsto ' +
    'in notin ni subset supset subseteq supseteq cup cap emptyset varnothing ' +
    'land lor lnot neg wedge vee forall exists top bot ' +
    'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu ' +
    'xi omicron pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega ' +
    'Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega ' +
    'mathrm mathit mathbf mathsf mathtt mathcal mathbb operatorname mathop mathbin mathrel ' +
    'text textrm mbox rm bf it displaystyle textstyle scriptstyle scriptscriptstyle ' +
    'limits nolimits quad qquad enspace hspace vphantom phantom ' +
    'langle rangle lbrace rbrace lvert rvert vert Vert lfloor rfloor lceil rceil ' +
    'big Big bigg Bigg bigl bigr Bigl Bigr biggl biggr Biggl Biggr').split(/\s+/));

  function safeMath(text) {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return false;
    for (const match of text.matchAll(/\\([A-Za-z]+|[^A-Za-z])/g)) {
      if (/^[A-Za-z]/.test(match[1]) && !TEX_COMMANDS.has(match[1])) return false;
    }
    // Native matrix output uses array; other environments are outside scope.
    return !/\\(?:begin|end)\s*\{(?!array\})/.test(text);
  }

  function parse(raw) {
    if (raw.length > MAX_LENGTH) throw new Error('protocol length limit');
    const calls = [];
    let position = 0;
    const space = () => { while (/\s/.test(raw[position] || '') && position < raw.length) position++; };
    const literal = text => {
      if (!raw.startsWith(text, position)) throw new Error('unsupported protocol syntax');
      position += text.length;
    };
    space();
    while (position < raw.length) {
      if (calls.length >= MAX_CALLS) throw new Error('protocol call limit');
      literal("stack_trans('");
      const keyMatch = /^[A-Za-z][A-Za-z_0-9]{0,95}/.exec(raw.slice(position));
      if (!keyMatch) throw new Error('invalid translation key');
      const key = keyMatch[0]; position += key.length;
      literal("'"); space();
      const args = [];
      while (raw[position] === ',') {
        if (args.length >= MAX_ARGS) throw new Error('protocol argument limit');
        position++; space(); literal('!quot!');
        const end = raw.indexOf('!quot!', position);
        if (end < 0) throw new Error('unterminated translation argument');
        args.push(raw.slice(position, end)); position = end + 6; space();
      }
      literal(');'); space(); literal('!NEWLINE!'); space();
      calls.push({key,args});
    }
    if (!calls.length) throw new Error('empty protocol');
    return calls;
  }

  function staticHtml(value) {
    // Only these exact attribute-free tags can originate in pinned templates.
    return escape(value).replace(/&lt;(\/?)(tt|code|em|strong)&gt;/g,'<$1$2>');
  }

  function render(template, args) {
    let index = 0, html = '', text = '', required = 0;
    for (const match of template.matchAll(PLACEHOLDER)) {
      const argument = Number(match[1]); required = Math.max(required, argument + 1);
      if (argument >= args.length) throw new Error('missing translation argument');
      const before = template.slice(index, match.index);
      html += staticHtml(before) + escape(args[argument]);
      text += before.replace(/<\/?(?:tt|code|em|strong)>/g,'') + args[argument];
      index = match.index + match[0].length;
    }
    // STACK sometimes passes an unused empty argument (ATLowestTerms_wrong).
    if (args.slice(required).some(value => value !== '')) throw new Error('unused translation argument');
    const after = template.slice(index);
    html += staticHtml(after); text += after.replace(/<\/?(?:tt|code|em|strong)>/g,'');
    return {html,text};
  }

  function describe(raw) {
    if (typeof raw !== 'string') throw new TypeError('Native STACK feedback must be a string');
    if (raw === '') return {html:'',text:'',raw,translated:true,keys:[]};
    const keys = [];
    try {
      const catalogue = scope.NativeFeedbackMessages;
      if (!catalogue || catalogue.schema !== 1 || catalogue.stackRevision !== REVISION || catalogue.language !== 'en' ||
          !catalogue.messages || typeof catalogue.messages !== 'object') throw new Error('missing pinned feedback catalogue');
      const calls = parse(raw), html = [], text = [];
      for (const call of calls) {
        keys.push(call.key);
        if (!own(catalogue.messages,call.key)) throw new Error('unknown translation key: ' + call.key);
        const template = catalogue.messages[call.key];
        if (typeof template !== 'string' || template.length > 8192 || /\{\$/.test(template.replace(PLACEHOLDER,''))) {
          throw new Error('unsupported translation template');
        }
        if (!safeMath(template) || !call.args.every(safeMath)) throw new Error('unsupported display command');
        const rendered = render(template,call.args);
        if (rendered.html) { html.push(rendered.html); text.push(rendered.text); }
      }
      return {html:html.length ? '<span class="stack-native-feedback">' + html.join('<br>') + '</span>' : '',
        text:text.join('\n'),raw,translated:true,keys};
    } catch (error) {
      const label = 'Native STACK feedback (untranslated): ';
      return {html:'<span class="stack-native-feedback-raw">' + label + '<code>' + escape(raw) + '</code></span>',
        text:label + raw,raw,translated:false,keys,reason:error.message};
    }
  }

  scope.NativeFeedback = Object.freeze({format:raw => describe(raw).html,describe});
})(self);
