(function () {
  'use strict';
  var current = document.currentScript;
  // Keep the pinned implementation when another extension loads its own editor.
  var MatrixInput = window.MatrixInput;
  var backendDescriptor = window.CTMStackBackend || {};
  var workerURL = backendDescriptor.workerURL ?
    new URL(backendDescriptor.workerURL, document.baseURI) : new URL('worker.js', current.src);
  var worker = null;
  var pending = null;
  var sequence = 0;
  var pipeline = Promise.resolve();

  var starting = null;

  function resetWorker(error) {
    if (worker) worker.terminate();
    worker = null;
    starting = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pending = null;
    }
  }

  // The worker loads CTM Assessment's Python from the scripts on this page:
  // ctm-libs' runtime and ctm-checkers' page scripts with the STACK engine.
  function pageScripts() {
    var runtime = window.MathExerciseRuntime, checkers = window.CTMCheckers, stack = window.CTMCheckersStack;
    if (!runtime || !runtime.scriptURL || !checkers || !checkers.scriptURL || !stack || !stack.scriptURL) {
      throw new Error('The grader is missing on this page (ctm-libs\' runtime or ctm-checkers\' scripts).');
    }
    return { runtime: runtime.scriptURL, checkers: [checkers.scriptURL, stack.scriptURL], loadTimeout: backendDescriptor.loadTimeout || runtime.loadTimeout };
  }

  function onMessage(event) {
    var msg = event.data;
    if (!pending || pending.id !== msg.id) return;
    var task = pending;
    pending = null;
    clearTimeout(task.timer);
    if (msg.ok) task.resolve(msg.result);
    else task.reject(new Error(msg.error || 'The grader failed.'));
  }

  // A worker that has loaded Python and the STACK engine. Loading is bounded
  // by the runtime's load limit (the worker reports a failure itself; this
  // timer only covers a worker that never answers).
  function ensureWorker() {
    if (starting) return starting;
    starting = new Promise(function (resolve, reject) {
      var scripts = pageScripts();
      worker = new Worker(workerURL);
      worker.onmessage = onMessage;
      worker.onerror = function (event) {
        resetWorker(new Error(event.message || 'The grading worker could not start.'));
      };
      var id = ++sequence;
      var timer = setTimeout(function () {
        resetWorker(new Error('Python did not finish loading. Try again.'));
      }, (scripts.loadTimeout || 180000) + 30000);
      var target = worker;
      // A worker that failed to load is not reused: the next request starts another.
      pending = { id: id, resolve: function () { resolve(target); }, timer: timer, reject: function (error) {
        if (worker === target) { target.terminate(); worker = null; }
        starting = null;
        reject(error);
      } };
      target.postMessage({ id: id, type: 'init', runtime: scripts.runtime, checkers: scripts.checkers });
    });
    starting.catch(function () { starting = null; });
    return starting;
  }

  // Run one Python request at a time: Pyodide's interpreter is not reentrant.
  // The calculation timer starts when the worker is ready.
  function evaluate(payload) {
    var result = pipeline.catch(function () {}).then(function () {
      return ensureWorker().then(function (target) {
        return new Promise(function (resolve, reject) {
          var id = ++sequence;
          var timer = setTimeout(function () {
            resetWorker(new Error('The calculation timed out. Try again.'));
          }, 120000);
          pending = { id: id, resolve: resolve, reject: reject, timer: timer };
          try { target.postMessage(Object.assign({ id: id }, payload)); }
          catch (error) { resetWorker(error); }
        });
      });
    });
    pipeline = result;
    return result;
  }

  var MATHJAX_URL = 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-chtml.js';
  var mathQueue = Promise.resolve();

  function ensureMathJax() {
    if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') {
      return Promise.resolve(window.MathJax.startup && window.MathJax.startup.promise)
        .then(function () { return window.MathJax; });
    }
    if (window.__stackSympyMathJax) return window.__stackSympyMathJax;
    var ownedScript = null;
    var pending = (async function () {
      // Keep an existing page's MathJax configuration. Version 3 recognizes
      // both \( ... \) and \[ ... \] by default; configure our own only when
      // Quarto has not installed one for ordinary document mathematics.
      if (!window.MathJax) {
        window.MathJax = {
          tex: { inlineMath: [['\\(', '\\)']], displayMath: [['\\[', '\\]']] }
        };
      }
      var script = document.querySelector('script[src*="mathjax"]');
      if (!script) {
        script = document.createElement('script');
        script.src = MATHJAX_URL;
        script.async = true;
        script.dataset.stackSympyMathjax = '1';
        ownedScript = script;
        var loaded = new Promise(function (resolve, reject) {
          script.onload = resolve;
          script.onerror = function () { reject(new Error('Could not load MathJax.')); };
        });
        document.head.appendChild(script);
        await loaded;
      } else if (!window.MathJax.startup || !window.MathJax.startup.promise) {
        await new Promise(function (resolve, reject) {
          var timer, poll;
          function finish(error) {
            clearTimeout(timer);
            clearInterval(poll);
            script.removeEventListener('load', loaded);
            script.removeEventListener('error', failed);
            if (error) reject(error); else resolve();
          }
          function loaded() { finish(); }
          function failed() { finish(new Error('Could not load MathJax.')); }
          timer = setTimeout(function () { finish(new Error('MathJax did not initialize.')); }, 30000);
          poll = setInterval(function () {
            if (window.MathJax && (typeof window.MathJax.typesetPromise === 'function' ||
                window.MathJax.startup && window.MathJax.startup.promise)) finish();
          }, 50);
          script.addEventListener('load', loaded);
          script.addEventListener('error', failed);
        });
      }
      if (window.MathJax.startup && window.MathJax.startup.promise) {
        await window.MathJax.startup.promise;
      }
      if (typeof window.MathJax.typesetPromise !== 'function') {
        throw new Error('MathJax did not expose a typesetting API.');
      }
      return window.MathJax;
    })();
    window.__stackSympyMathJax = pending;
    pending.catch(function () {
      if (ownedScript && ownedScript.isConnected) ownedScript.remove();
      if (window.__stackSympyMathJax === pending) delete window.__stackSympyMathJax;
    });
    return pending;
  }

  function math(element) {
    // MathJax's document state is shared across cards and is not reentrant.
    mathQueue = mathQueue.catch(function () {}).then(async function () {
      var mj = await ensureMathJax();
      if (element.isConnected) await mj.typesetPromise([element]);
    }).catch(function (error) { console.warn('STACK SymPy math display:', error); });
    return mathQueue;
  }

  function clearMath(element) {
    if (window.MathJax && typeof window.MathJax.typesetClear === 'function') {
      try { window.MathJax.typesetClear([element]); }
      catch (error) { console.warn('STACK SymPy math cleanup:', error); }
    }
  }

  function message(container, text, state) {
    clearMath(container);
    container.replaceChildren();
    container.dataset.state = state || '';
    var line = document.createElement('p');
    line.textContent = text;
    container.appendChild(line);
    math(container);
  }

  function node(tag, className, value) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (value != null) element.textContent = String(value);
    return element;
  }

  function showGrade(card, result) {
    var output = card.querySelector('.stack-result');
    clearMath(output);
    output.replaceChildren();
    output.dataset.state = result.status === 'invalid' ? 'invalid' : result.score >= 1 ? 'correct' : 'retry';
    if (result.status === 'invalid') {
      output.appendChild(node('p', 'stack-verdict', 'Check the input and try again.'));
    } else {
      output.appendChild(node('p', 'stack-verdict', result.score >= 1 ? 'Correct.' :
        result.score > 0 ? 'Partially correct (' + Math.round(result.score * 100) + '%).' : 'Not quite. Try again.'));
    }
    var inputResults = result.inputs || {};
    Object.keys(inputResults).forEach(function (name) {
      var detail = inputResults[name];
      var item = card.querySelector('.stack-answer[data-name="' + CSS.escape(name) + '"]');
      if (item) item.setAttribute('aria-invalid', detail.valid === false ? 'true' : 'false');
      var validation = card.querySelector('.stack-validation[data-name="' + CSS.escape(name) + '"]');
      if (detail.feedback && validation) {
        clearMath(validation);
        validation.textContent = detail.feedback;
      }
      else if (detail.feedback) output.appendChild(node('p', 'stack-input-feedback', name + ': ' + detail.feedback));
    });
    Object.keys(result.prts || {}).forEach(function (name) {
      var detail = result.prts[name];
      if (detail.feedback) {
        // The Python CASText renderer has already enforced an HTML allowlist.
        var feedback = node('div', 'stack-prt-feedback');
        feedback.innerHTML = detail.feedback;
        var inline = card.querySelector('.stack-feedback[data-name="' + CSS.escape(name) + '"]');
        if (inline) {
          clearMath(inline);
          inline.innerHTML = detail.feedback;
        }
        else output.appendChild(feedback);
      }
    });
    math(card);
  }

  function showValidation(card, result) {
    var output = card.querySelector('.stack-result');
    clearMath(output);
    output.replaceChildren();
    output.dataset.state = result.status === 'valid' ? 'valid' : 'invalid';
    output.appendChild(node('p', 'stack-verdict', result.status === 'valid' ?
      'Your answer is ready to check. Review the preview first.' : 'Please correct the marked input and validate again.'));
    Object.keys(result.inputs || {}).forEach(function (name) {
      var detail = result.inputs[name];
      var input = card.querySelector('.stack-answer[data-name="' + CSS.escape(name) + '"]');
      var validation = card.querySelector('.stack-validation[data-name="' + CSS.escape(name) + '"]');
      if (input) input.setAttribute('aria-invalid', detail.valid ? 'false' : 'true');
      if (!validation) {
        validation = node('span', 'stack-validation');
        output.appendChild(node('p', '', name + ': '));
        output.appendChild(validation);
      }
      validation.dataset.state = detail.valid ? 'valid' : 'invalid';
      validation.dataset.latex = detail.latex || '';
      clearMath(validation);
      validation.textContent = detail.valid ? 'Interpreted as \\(' + detail.latex + '\\)' : detail.feedback;
      math(validation);
    });
  }

  function showTests(card, result) {
    var output = card.querySelector('.stack-result');
    clearMath(output);
    output.replaceChildren();
    output.dataset.state = result.passed ? 'correct' : 'retry';
    output.appendChild(node('p', 'stack-verdict', result.passed ? 'All question tests passed.' : 'Some question tests failed.'));
    var list = node('ul', 'stack-test-list');
    (result.results || []).forEach(function (test) {
      list.appendChild(node('li', '', (test.passed ? 'Pass' : 'Fail') +
        ' · ' + test.testcase + ' (seed ' + test.seed + ')'));
    });
    output.appendChild(list);
  }

  // The frozen question HTML is the learner's task. The card itself also
  // contains authored tests and the original XML in source panels.
  function feedbackTask(variant) {
    var template = document.createElement('template');
    template.innerHTML = variant.question_html;
    template.content.querySelectorAll('.stack-answer[data-name]').forEach(function (input) {
      input.replaceWith(document.createTextNode('[Answer ' + input.dataset.name + ']'));
    });
    template.content.querySelectorAll('.stack-validation, .stack-feedback').forEach(function (item) { item.remove(); });
    return window.AIFeedback.contextText(template.content);
  }

  function safeCheckEvidence(result) {
    var summary = { status: result.status === 'graded' ? 'graded' : 'invalid' };
    if (typeof result.score === 'number' && Number.isFinite(result.score)) summary.score = result.score;
    return [{ label: 'Previous answer check', text: JSON.stringify(summary) }];
  }

  function initialize(card) {
    var data = card.querySelector('script.stack-sympy-data');
    if (!data) return;
    var payload;
    try { payload = JSON.parse(data.textContent); }
    catch (error) {
      message(card.querySelector('.stack-result'), 'Question data could not be read.', 'error');
      return;
    }
    var selector = card.querySelector('.stack-variant');
    var version = 0;
    var validatedSnapshot = null;
    var checkedEvidence = null;
    var feedbackHandle = null;
    var matrixEditors = new Map();
    var check = card.querySelector('.stack-check');
    var validate = card.querySelector('.stack-validate');
    if (check) check.disabled = true;
    function cellSource(raw) {
      var depth = 0;
      for (var i = 0; i < raw.length; i++) {
        var ch = raw[i];
        if (ch === '(') depth++;
        else if (ch === ')') { if (--depth < 0) return '()'; }
        else if (ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === ',' && depth === 0) return '()';
      }
      return depth === 0 ? '(' + raw + ')' : '()';
    }
    function readAnswers() {
      var answers = {};
      card.querySelectorAll('.stack-answer[data-name]').forEach(function (input) {
        var editor = matrixEditors.get(input);
        if (!editor) { answers[input.dataset.name] = input.value; return; }
        var value = editor.read();
        var rows = [];
        for (var r = 0; r < value.rows; r++) {
          // Parentheses keep raw commas/brackets inside their own scalar cell.
          // Incomplete cells become () and are rejected by the bounded parser.
          rows.push('[' + value.raw.slice(r * value.cols, (r + 1) * value.cols)
            .map(cellSource).join(',') + ']');
        }
        answers[input.dataset.name] = 'matrix(' + rows.join(',') + ')';
      });
      return answers;
    }
    function mountMatrices() {
      card.querySelectorAll('.stack-matrix[data-name]').forEach(function (host, index) {
        if (matrixEditors.has(host)) return;
        if (!MatrixInput) throw new Error('The bundled matrix input could not load.');
        var renderer = MatrixInput.create({
          idPrefix: card.dataset.stackId + '-matrix-' + index,
          zeroDimensions: 'reject', maxEntries: 64,
          labels: {matrixRows: 'Rows', matrixColumns: 'Columns',
            matrixAddRow: 'Add row', matrixRemoveRow: 'Remove row',
            matrixAddColumn: 'Add column', matrixRemoveColumn: 'Remove column'},
          onChange: function () { invalidate(); }
        });
        host.innerHTML = renderer.renderHTML(JSON.parse(host.dataset.matrixSpec)).html;
        matrixEditors.set(host, renderer.mount(host));
      });
    }
    function destroyMatrices() {
      matrixEditors.forEach(function (editor) { editor.destroy(); });
      matrixEditors.clear();
    }
    function clearPresentation() {
      var output = card.querySelector('.stack-result');
      clearMath(output);
      output.replaceChildren();
      output.removeAttribute('data-state');
      matrixEditors.forEach(function (editor) { editor.setState({status: 'empty'}); });
      card.querySelectorAll('.stack-answer[data-name]').forEach(function (item) { item.removeAttribute('aria-invalid'); });
      card.querySelectorAll('.stack-validation, .stack-feedback').forEach(function (item) {
        clearMath(item);
        item.textContent = '';
        delete item.dataset.latex;
        delete item.dataset.state;
      });
    }
    function invalidate() {
      version++;
      validatedSnapshot = null;
      checkedEvidence = null;
      if (feedbackHandle) feedbackHandle.cancel({ clearOutput: true });
      if (check) check.disabled = true;
      clearPresentation();
    }
    var variantAt = function () {
      var index = selector ? Number(selector.value) : 0;
      return payload.variants[index] || payload.variants[0];
    };
    function responseIdentity() {
      return JSON.stringify([version, selector ? selector.value : '0', readAnswers()]);
    }
    // AI feedback is CTM Assessment's (ctm-libs, AIFeedback). A build without
    // AI (ai-feedback: enabled: false, CTM_FEEDBACK=off) loads none: the card
    // then has no Feedback button, and native checking works as always.
    var F = window.AIFeedback;
    if (card.hasAttribute('data-stack-feedback') && F && F.attach && F.contextText && F.contextMaterials &&
        F.settingsButton && F.resolvePolicy && F.applyPolicy) {
      var config;
      try { config = JSON.parse(card.dataset.stackFeedback); }
      catch (error) { config = {}; }
      var actions = card.querySelector('.stack-actions');
      var uiCode = String(config.uiLanguage || document.documentElement.lang || 'en').split('-')[0];
      if (uiCode === 'no') uiCode = 'nb';
      var feedbackButton = node('button', 'stack-feedback-button ai-feedback-button',
        F.locales && F.locales[uiCode] ? F.locales[uiCode].button : 'Feedback');
      feedbackButton.type = 'button';
      var feedbackOutput = node('div', 'ai-feedback-output');
      feedbackOutput.setAttribute('aria-live', 'polite');
      if (actions) {
        actions.appendChild(feedbackButton);
        actions.after(feedbackOutput);
      } else card.append(feedbackButton, feedbackOutput);
      var gear = F.settingsButton(config.uiLanguage);
      if (actions) actions.appendChild(gear); else feedbackButton.after(gear);
      feedbackHandle = F.attach({
        id: 'stack-' + card.dataset.stackId,
        integration: 'math-exercise',
        contextRefs: function () {
          return config.context && config.context.mode === 'explicit' ? config.context.refs : '';
        },
        policySelection: config.policySelection || {},
        uiLanguage: config.uiLanguage,
        button: feedbackButton,
        output: feedbackOutput,
        getRequest: function () {
          var answers = readAnswers();
          var names = Object.keys(answers);
          if (!Array.from(card.querySelectorAll('.stack-answer[data-name]')).some(function (input) {
            var editor = matrixEditors.get(input);
            return editor ? editor.read().raw.some(function (cell) { return cell.trim(); }) : input.value.trim();
          })) {
            throw new Error('Enter an answer before requesting feedback.');
          }
          var identity = responseIdentity();
          return {
            _responseIdentity: identity,
            profile: 'mathematics',
            task: feedbackTask(variantAt()),
            responses: names.map(function (name) {
              return { id: name, label: name, value: answers[name], format: 'text' };
            }),
            materials: F.contextMaterials(config.context || {}),
            evidence: checkedEvidence && checkedEvidence.identity === identity ? checkedEvidence.summary : [],
            feedback: { language: config.language || config.uiLanguage || document.documentElement.lang || 'en' }
          };
        }
      });
    }
    function clear() {
      version++;
      validatedSnapshot = null;
      checkedEvidence = null;
      if (feedbackHandle) feedbackHandle.reset();
      if (check) check.disabled = true;
      card.querySelectorAll('.stack-answer[data-name]').forEach(function (item) {
        var editor = matrixEditors.get(item);
        if (editor) editor.reset(); else item.value = '';
        item.removeAttribute('aria-invalid');
      });
      var output = card.querySelector('.stack-result');
      clearMath(output);
      output.replaceChildren();
      output.removeAttribute('data-state');
      card.querySelectorAll('.stack-validation, .stack-feedback').forEach(function (item) {
        clearMath(item);
        item.textContent = '';
        delete item.dataset.latex;
        delete item.dataset.state;
      });
    }
    if (selector) selector.addEventListener('change', function () {
      var variant = variantAt();
      var prompt = card.querySelector('.stack-prompt');
      if (prompt && variant) {
        destroyMatrices();
        clearMath(prompt);
        prompt.innerHTML = variant.question_html;
        mountMatrices();
        math(prompt);
      }
      clear();
    });
    card.addEventListener('input', function (event) {
      if (event.target.matches('.stack-answer[data-name]')) {
        invalidate();
      }
    });
    card.addEventListener('reset', function () { clear(); });
    async function act(type, button) {
      var resultBox = card.querySelector('.stack-result');
      if (type === 'grade') {
        checkedEvidence = null;
        if (feedbackHandle) feedbackHandle.reset('run');
      }
      var generation = version;
      var variant = variantAt();
      var answers = readAnswers();
      var snapshot = JSON.stringify(answers);
      if (type === 'grade' && validatedSnapshot !== snapshot) {
        if (check) check.disabled = true;
        message(resultBox, 'Validate the current inputs before checking.', 'invalid');
        return;
      }
      button.disabled = true;
      message(resultBox, type === 'grade' ? 'Checking with ' + (backendDescriptor.label || 'SymPy') + '…' :
        type === 'validate' ? 'Parsing your inputs…' : 'Running authored tests…', 'loading');
      try {
        var result = await evaluate({ type: type, question: payload.question, variant: variant, answers: answers });
        if (generation !== version || JSON.stringify(readAnswers()) !== snapshot) return;
        if (type === 'grade') {
          showGrade(card, result);
          checkedEvidence = { identity: responseIdentity(), summary: safeCheckEvidence(result) };
        }
        else if (type === 'validate') {
          showValidation(card, result);
          validatedSnapshot = result.status === 'valid' ? snapshot : null;
          if (check) check.disabled = validatedSnapshot === null;
        } else showTests(card, result);
        if (type === 'grade' || type === 'validate') {
          matrixEditors.forEach(function (editor, host) {
            var detail = (result.inputs || {})[host.dataset.name];
            // Only an explicit Python answer test supplies vector assessment.
            // These colors explain its result; PRT branches still award credit.
            editor.setState(type === 'grade' && result.status === 'graded' && detail &&
              detail.valid !== false && detail.assessment ? detail.assessment :
              {status: detail && detail.valid === false ? 'invalid' : 'empty'});
          });
        }
      } catch (error) {
        if (generation === version) message(resultBox, 'Could not check this answer: ' + error.message, 'error');
      } finally {
        if (type === 'grade') button.disabled = validatedSnapshot !== JSON.stringify(readAnswers());
        else button.disabled = false;
      }
    }
    if (check) check.addEventListener('click', function () { act('grade', check); });
    if (validate) validate.addEventListener('click', function () { act('validate', validate); });
    var tests = card.querySelector('.stack-tests');
    if (tests) tests.addEventListener('click', function () { act('tests', tests); });
    var actions = card.querySelector('.stack-actions');
    if (actions) {
      var reset = node('button', 'stack-reset', 'Reset answers');
      reset.type = 'button';
      reset.addEventListener('click', clear);
      actions.appendChild(reset);
    }
    mountMatrices();
    math(card);
  }

  document.querySelectorAll('.stack-sympy:not(.stack-diagnostic)').forEach(initialize);
})();
