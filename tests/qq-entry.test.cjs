'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { bootstrap } = require('../src/qq/entry.cjs');

test('application entry installs observation before original main and preserves result', async () => {
  const order = [];
  const processObject = new EventEmitter();
  processObject.env = {};
  const globalObject = {};
  const result = {};
  let closed = 0;
  const options = { processObject, globalObject, dir: path.resolve('work/entry-test'),
    createCapture() { order.push('capture'); return { close() { closed++; } }; },
    startServer: async () => { order.push('server'); return { close() { closed++; } }; },
    requireMain() { order.push('main'); return result; } };
  const original = path.resolve('work/qq-main.cjs');
  assert.equal(bootstrap(original, options), result);
  assert.deepEqual(order, ['capture', 'main']);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['capture', 'main', 'server']);
  assert.equal(bootstrap(original, options), result);
  processObject.emit('exit');
  assert.equal(closed, 2);
});

test('original main failure closes even a server which finishes starting later', async () => {
  const globalObject = {}, processObject = new EventEmitter();
  let captures = 0, servers = 0;
  const failure = new Error('main failed');
  assert.throws(() => bootstrap(path.resolve('work/qq-main.cjs'), {
    globalObject, processObject, dir: path.resolve('work/entry-test'),
    createCapture: () => ({ close() { captures++; } }),
    startServer: async () => ({ close() { servers++; } }),
    requireMain() { throw failure; }
  }), error => error === failure);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(captures, 1);
  assert.equal(servers, 1);
});

test('bridge configuration failure reports diagnostics and lets QQ original main run', () => {
  const reports = [];
  let captures = 0;
  const result = bootstrap(path.resolve('work/qq-main.cjs'), {
    globalObject: {}, processObject: new EventEmitter(),
    createCapture: () => ({ close() { captures++; } }),
    env: {}, log: error => reports.push(error.message), requireMain: () => 42
  });
  assert.equal(result, 42);
  assert.equal(captures, 1);
  assert.match(reports[0], /FWD_RPC_DIR/);
});
