'use strict';

// Only load the transport functions. Never start the driver or read user settings.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = readFileSync(join(__dirname, '..', 'driver.js'), 'utf8');
const start = source.indexOf('const CDP_TIMEOUT_MS =');
const end = source.indexOf('/* ---------------- 页面内探针', start);
assert.ok(start >= 0 && end > start, 'Transport source markers must exist');

function fixture(fetchImpl = async () => ({ ok: true, json: async () => [] })) {
  let nextTimer = 0;
  const timers = new Map();
  const sockets = [];
  class FakeSocket {
    constructor() { this.readyState = 0; this.listeners = new Map(); this.sent = []; sockets.push(this); }
    addEventListener(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(fn);
    }
    removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
    emit(name, event = {}) { for (const fn of [...(this.listeners.get(name) || [])]) fn(event); }
    open() { this.readyState = 1; this.emit('open'); }
    close() { this.readyState = 3; this.emit('close'); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
  }
  const api = vm.runInNewContext(source.slice(start, end) + '\n({connect, pickCoursePage})', {
    WebSocket: FakeSocket, AbortController, fetch: fetchImpl, PORT: 9222,
    lastCourseId: '', log: () => {},
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return {
    api, sockets, timers,
    expire(ms) {
      for (const [id, timer] of [...timers]) {
        if (timer.ms === ms && timers.delete(id)) timer.fn();
      }
    },
    async connected() {
      const ready = api.connect('ws://mock.invalid');
      const ws = sockets.at(-1);
      ws.open();
      return { client: await ready, ws };
    },
  };
}

test('handshake has a deadline and closes the socket', async () => {
  const f = fixture();
  const ready = f.api.connect('ws://mock.invalid');
  assert.equal(f.timers.size, 1, 'Handshake must have a timeout');
  const rejected = assert.rejects(ready, /超时/);
  f.expire(20000);
  await rejected;
  assert.equal(f.sockets[0].readyState, 3);
  assert.equal(f.timers.size, 0);
});

test('close before open rejects immediately and removes the open listener', async () => {
  const f = fixture();
  const ready = f.api.connect('ws://mock.invalid');
  const ws = f.sockets[0];
  assert.ok(ws.listeners.get('close')?.size, 'Must handle close during handshake');
  const rejected = assert.rejects(ready, /关闭/);
  ws.close();
  await rejected;
  assert.equal(f.timers.size, 0);
  assert.equal(ws.listeners.get('open')?.size || 0, 0);
});

test('error during handshake rejects and cleans up', async () => {
  const f = fixture();
  const ready = f.api.connect('ws://mock.invalid');
  const rejected = assert.rejects(ready, /WebSocket/);
  f.sockets[0].emit('error');
  await rejected;
  assert.equal(f.sockets[0].readyState, 3);
  assert.equal(f.timers.size, 0);
});

test('responses match request IDs, while malformed messages are ignored', async () => {
  const f = fixture();
  const { client, ws } = await f.connected();
  assert.equal(f.timers.size, 0);
  const first = client.send('Runtime.enable');
  const second = client.send('Page.enable');
  for (const data of ['invalid', 'null', '[]', '{"method":"event"}']) {
    assert.doesNotThrow(() => ws.emit('message', { data }));
  }
  ws.emit('message', { data: JSON.stringify({ id: ws.sent[1].id, result: { order: 2 } }) });
  ws.emit('message', { data: JSON.stringify({ id: ws.sent[0].id, result: { order: 1 } }) });
  assert.equal((await first).result.order, 1);
  assert.equal((await second).result.order, 2);
  assert.equal(f.timers.size, 0);
  ws.close();
});

test('post-open error releases all pending requests and rejects new sends', async () => {
  const f = fixture();
  const { client, ws } = await f.connected();
  const pending = [client.send('Runtime.enable'), client.send('Page.enable')];
  ws.emit('error');
  assert.equal(client.isClosed(), true);
  for (const result of await Promise.all(pending)) assert.match(result.error.message, /WebSocket/);
  assert.equal(f.timers.size, 0);
  assert.ok((await client.send('Page.enable')).error);
  assert.equal(ws.sent.length, 2);
  assert.equal(ws.readyState, 3);
});

test('one request timeout releases the other requests too', async () => {
  const f = fixture();
  const { client, ws } = await f.connected();
  const normal = client.send('Runtime.evaluate');
  const screenshot = client.send('Page.captureScreenshot');
  assert.deepEqual([...f.timers.values()].map(t => t.ms).sort(), [20000, 60000]);
  f.expire(20000);
  assert.match((await normal).error.message, /超时/);
  assert.match((await screenshot).error.message, /超时/);
  assert.equal(f.timers.size, 0);
  assert.equal(client.isClosed(), true);
  assert.equal(ws.readyState, 3);
});

test('send failure closes the connection and clears request timers', async () => {
  const f = fixture();
  const { client, ws } = await f.connected();
  ws.send = () => { throw new Error('mock send failure'); };
  const result = await client.send('Runtime.enable');
  assert.match(result.error.message, /mock send failure/);
  assert.equal(f.timers.size, 0);
  assert.equal(ws.readyState, 3);
});

test('tag listing deadline aborts an unresponsive server', async () => {
  let signal;
  const f = fixture((_url, options) => {
    signal = options?.signal;
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  const pending = f.api.pickCoursePage();
  assert.ok(signal, 'Fetch must use an abort signal');
  const rejected = assert.rejects(pending, /超时/);
  f.expire(20000);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(f.timers.size, 0);
});

test('tag listing deadline includes reading the response body', async () => {
  let signal;
  let bodyStarted;
  const readingBody = new Promise(resolve => { bodyStarted = resolve; });
  const f = fixture(async (_url, options) => {
    signal = options?.signal;
    return { ok: true, json: () => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')));
      bodyStarted();
    }) };
  });
  const pending = f.api.pickCoursePage();
  await readingBody;
  assert.ok(signal, 'Body read must be abortable');
  const rejected = assert.rejects(pending, /超时/);
  f.expire(20000);
  await rejected;
  assert.equal(f.timers.size, 0);
});

test('HTTP failures and invalid page lists report the actual cause', async () => {
  const unavailable = fixture(async () => ({ ok: false, status: 503, json: async () => [] }));
  await assert.rejects(unavailable.api.pickCoursePage(), /HTTP 503/);
  assert.equal(unavailable.timers.size, 0);
  const malformed = fixture(async () => ({ ok: true, json: async () => ({ unexpected: true }) }));
  await assert.rejects(malformed.api.pickCoursePage(), /格式/);
  assert.equal(malformed.timers.size, 0);
});

test('valid study tab is found even if the list has invalid entries', async () => {
  const page = { type: 'page', url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=123', webSocketDebuggerUrl: 'ws://mock.invalid' };
  const f = fixture(async () => ({ ok: true, json: async () => [null, {}, page] }));
  const found = await f.api.pickCoursePage();
  assert.equal(found.page, page);
  assert.equal(found.pages.length, 1);
  assert.equal(f.timers.size, 0);
});
