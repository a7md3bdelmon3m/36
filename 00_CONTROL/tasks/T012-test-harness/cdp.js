// Minimal CDP driver — no npm dependencies, uses Node 22's built-in WebSocket.
// Talks directly to a running headless Chrome instance via DevTools Protocol.
//
// T012 EXTENSION (backup/restore harness, ADR-026): identical to
// R3-001-test-harness/cdp.js's copy, with one addition —
// Page.javascriptDialogOpening auto-accept. handleBackupImport in
// app.js calls the browser's native confirm() before restoring, which
// would otherwise hang a headless CDP session indefinitely (no human
// present to click it). Kept as a separate copy in this harness
// directory rather than modifying the shared original used by every
// other harness, so no other suite's behavior changes silently.
async function connectToNewTab(cdpHttpBase) {
  const res = await fetch(`${cdpHttpBase}/json/new?about:blank`, { method: 'PUT' });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const consoleLines = [];
  const requestUrls = [];
  const dialogsSeen = [];

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const parts = (msg.params.args || []).map((a) => a.value ?? a.description ?? '');
      consoleLines.push(`[${msg.params.type}] ${parts.join(' ')}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleLines.push(`[exception] ${d.text} ${d.exception ? (d.exception.description || d.exception.value || '') : ''}`);
    } else if (msg.method === 'Network.requestWillBeSent') {
      requestUrls.push(msg.params.request.url);
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      dialogsSeen.push({ type: msg.params.type, message: msg.params.message });
      // Auto-accept (equivalent to a user clicking "OK"/"Yes") — this is
      // what handleBackupImport's confirm() expects on the accept path.
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  async function navigate(url) {
    consoleLines.length = 0;
    requestUrls.length = 0;
    await send('Page.navigate', { url });
    // Wait for load via polling document.readyState (simple, avoids extra event races).
    for (let i = 0; i < 100; i++) {
      const r = await send('Runtime.evaluate', { expression: 'document.readyState' });
      if (r.result && r.result.value === 'complete') break;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    // Extra settle time for async module init (app.js init()).
    await new Promise((r2) => setTimeout(r2, 400));
  }

  async function evaluate(expression, awaitPromise = true) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  function getConsole() {
    return [...consoleLines];
  }

  function getRequestUrls() {
    return [...requestUrls];
  }

  function getDialogsSeen() {
    return [...dialogsSeen];
  }

  async function close() {
    ws.close();
    await fetch(`${cdpHttpBase}/json/close/${target.id}`).catch(() => {});
  }

  return { navigate, evaluate, getConsole, getRequestUrls, getDialogsSeen, close };
}

module.exports = { connectToNewTab };
