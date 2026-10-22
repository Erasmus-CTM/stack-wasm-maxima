// SPDX-License-Identifier: AGPL-3.0-or-later
// The native question path shares CTM's worker/card protocol. Python is loaded
// only by an actually visited PythonChecker continuation.
'use strict';
importScripts('../runtime/maxima-session.js', 'stack-parser.js', 'input.js', 'python-bridge.js', 'engine.js');
let queue = Promise.resolve(), starting, session, engine, python, currentRequest, configuration;
const counters = {nativeEvaluations:0, pythonCheckerCount:0, restarts:0};
const timings = {};
function metadata() {
  return {id:'maxima-native', mode:'native-with-optional-python', validation:'stack-maxima', controller:'native-prt',
    ...counters, pythonLoaded:python?.state === 'ready', timings:{...timings}};
}
function event(data) {
  self.postMessage({type:'backend-event',backend:'maxima-native',requestId:currentRequest,...data});
}
function init(message) {
  if (!starting) {
    starting = (async () => {
      const started = performance.now();
      const response = await fetch(new URL('input-rules.json', self.location.href));
      if (!response.ok) throw new Error('Native input rules HTTP ' + response.status);
      self.NativeInputRules = await response.json();
      session = new self.MaximaSession({
        baseURL:new URL('../maxima-runtime/',self.location.href).href,
        stackSourceURL:new URL('../stack-sources.json',self.location.href).href,
        onEvent: data => event({...data,event:'runtime-' + data.event}),
        onEvaluate: data => {
          counters.nativeEvaluations++;
        }
      });
      await session.init();
      python ||= new self.NativePythonBridge({runtime:message.runtime,checkers:message.checkers,
        onEvent:data => event(data)});
      engine = new self.NativeStackEngine({session, onEvent:data => {
        if (data.event === 'native-evaluate' && message.recordPrograms !== true) {
          event({event:data.event,operation:data.operation,question:data.question});
        } else event(data);
      },
        pythonCheck:async request => {
          const began = performance.now();
          const result = await python.invoke(request);
          counters.pythonCheckerCount++;
          timings.pythonLastCallMs = performance.now() - began;
          event({event:'python-checker-result',...result});
          return result;
        }});
      timings.readyMs = performance.now() - started;
      timings.maximaStages = session.initialization?.stages;
      event({event:'ready',...metadata()});
    })().catch(error => { starting = null; session?.terminate(); throw error; });
  }
  return starting;
}
async function handle(message) {
  currentRequest = message.id;
  try {
    let result;
    if (message.type === 'init') {
      configuration = {runtime:message.runtime,checkers:message.checkers,recordPrograms:message.recordPrograms === true};
      await init(configuration); result = 'ready';
    }
    else {
      if (!configuration) throw new Error('The native worker was not initialized.');
      if (!starting) await init(configuration);
      await starting;
      const began = performance.now();
      if (message.type === 'prepare') result = await engine.prepare(message.question, message.seed ?? 1);
      else if (message.type === 'validate') result = await engine.validate(message.question,message.variant,message.answers || {});
      else if (message.type === 'grade') result = await engine.grade(message.question,message.variant,message.answers || {});
      else if (message.type === 'tests') result = await engine.tests(message.question,message.variants || [message.variant]);
      else if (message.type === 'diagnostics') result = metadata();
      else throw new Error('Unknown native worker request');
      timings.requestMs = performance.now() - began;
    }
    self.postMessage({id:message.id,ok:true,result,backend:metadata()});
  } catch(error) {
    if (session?.poisoned) {
      session.terminate(); starting = null; engine = null;
      counters.restarts++;
      event({event:'native-restart-needed',error:String(error?.message || error)});
    }
    self.postMessage({id:message.id,ok:false,error:String(error?.message || error),backend:metadata()});
  } finally { currentRequest = null; }
}
self.onmessage = ({data}) => { queue = queue.then(() => handle(data), () => handle(data)); };
