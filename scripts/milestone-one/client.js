// Trusted fixture transport only. This is not a student-expression API.
window.runMilestoneOne = async function ({ files, batch, timeoutMs = 180000 }) {
  if (!crossOriginIsolated) return { ok: false, error: 'Cross-origin isolation is unavailable', stdout: '' };
  return new Promise(resolve => {
    const mutexBuffer = new SharedArrayBuffer(8);
    const inputBuffer = new SharedArrayBuffer(2 * 1024 * 1024);
    const sizeBuffer = new SharedArrayBuffer(4);
    const interruptBuffer = new SharedArrayBuffer(4);
    const interrupt = new Int32Array(interruptBuffer);
    const mutex = new Int32Array(mutexBuffer);
    const input = new Uint32Array(inputBuffer);
    const size = new Uint32Array(sizeBuffer);
    const commands = batch.split('\n').filter(line => line.trim());
    const totalCommands = commands.length;
    const worker = new Worker('/m1-worker.js');
    const started = performance.now();
    let interruptChecks = 0, injectedInterruptChecks = 0;
    let readyMs = null, stackReadyMs = null, stdout = '', commandsSent = 0, complete = false;
    const messageTrace = [];
    function finish(ok, error, fatal) {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      worker.terminate();
      const result = { ok, error, stdout, readyMs, totalMs: performance.now() - started,
        commandsSent, totalCommands, stackReadyMs, interruptChecks, injectedInterruptChecks, crossOriginIsolated, messageTrace,
        ...(fatal ? { fatal } : {}) };
      document.getElementById('status').textContent = JSON.stringify(result, null, 2);
      resolve(result);
    }
    const timer = setTimeout(() => finish(false, 'Wasm batch timed out'), timeoutMs);
    function wake() {
      Atomics.store(mutex, 0, 1);
      Atomics.notify(mutex, 0);
    }
    worker.onerror = event => {
      const message = event.error?.stack || event.message || 'Worker error';
      finish(false, message, { kind: 'worker-error', message });
    };
    worker.onmessage = ({ data }) => {
      if (complete) return;
      if (messageTrace.length < 1000 && data.type !== 'output') messageTrace.push(data);
      if (data.type === 'waitingForInput') {
        if (readyMs === null) readyMs = performance.now() - started;
        if (commands.length) {
          const command = [...commands.shift() + '\n'].map(char => char.codePointAt(0));
          if (command.length > input.length) return finish(false, 'Command exceeds stdin buffer');
          input.set(command);
          size[0] = command.length;
          commandsSent++;
          wake();
        }
      } else if (data.type === 'checkForInterrupt') {
        interruptChecks++;
        Atomics.store(interrupt, 0, 0);
        wake();
      } else if (data.type === 'output') {
        stdout += data.text;
        if (stackReadyMs === null && /^M1READY\|[^\r\n]+\r?\n/m.test(stdout)) stackReadyMs = performance.now() - started;
        if (stdout.length > 4 * 1024 * 1024) return finish(false, 'Diagnostic output limit exceeded');
        // Match a complete printed line, not a source echo.
        if (/^M1META\|[^\r\n]+\r?\n/m.test(stdout)) finish(true, null);
      } else if (data.type === 'm1-transport-probe') {
        injectedInterruptChecks++;
      } else if (data.type === 'm1-error') {
        finish(false, data.error, data.fatal);
      }
    };
    worker.postMessage({ files, buffers: [mutexBuffer, inputBuffer, sizeBuffer, interruptBuffer] });
  });
};
