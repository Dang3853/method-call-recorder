import { test } from 'node:test';
import assert from 'node:assert/strict';

import { record, replay } from '../src/core.js';

// ---------------------------------------------------------------------------
// Synchronous recording
// ---------------------------------------------------------------------------

test('records a sync method call with its arguments and result', () => {
  const obj = { add: (a, b) => a + b };
  const { proxy, log } = record(obj);

  const out = proxy.add(2, 3);

  assert.equal(out, 5);
  assert.deepEqual(log, [
    { method: 'add', args: [2, 3], kind: 'sync', result: 5 },
  ]);
});

test('records multiple calls in order', () => {
  const calls = [];
  const obj = {
    a: () => { calls.push('a'); return 1; },
    b: () => { calls.push('b'); return 2; },
  };
  const { proxy, log } = record(obj);

  proxy.a();
  proxy.b();
  proxy.a();

  assert.deepEqual(calls, ['a', 'b', 'a']);
  assert.equal(log.length, 3);
  assert.deepEqual(log.map((r) => r.method), ['a', 'b', 'a']);
});

test('does not record reads of non-function properties', () => {
  const obj = { x: 42, getX: function () { return this.x; } };
  const { proxy, log } = record(obj);

  // Reading a plain property should not log anything.
  assert.equal(proxy.x, 42);
  assert.equal(log.length, 0);

  // But a method that reads `this.x` internally should still work and log.
  assert.equal(proxy.getX(), 42);
  assert.equal(log.length, 1);
});

test('binds the original method so internal `this` works', () => {
  const obj = {
    _count: 0,
    inc: function () { this._count += 1; return this._count; },
    get: function () { return this._count; },
  };
  const { proxy, log } = record(obj);

  assert.equal(proxy.inc(), 1);
  assert.equal(proxy.inc(), 2);
  assert.equal(proxy.get(), 2);

  // Internal `this` reads must NOT be recorded — only the public calls.
  assert.equal(log.length, 3);
});

test('records a sync throw as a rejected entry and re-throws', () => {
  const obj = {
    boom: () => { throw new Error('nope'); },
  };
  const { proxy, log } = record(obj);

  assert.throws(() => proxy.boom('x'), /nope/);
  assert.equal(log.length, 1);
  assert.equal(log[0].method, 'boom');
  assert.deepEqual(log[0].args, ['x']);
  assert.equal(log[0].kind, 'rejected');
  assert.ok(log[0].error instanceof Error);
  assert.equal(log[0].error.message, 'nope');
});

// ---------------------------------------------------------------------------
// Asynchronous recording
// ---------------------------------------------------------------------------

test('records a fulfilled promise', async () => {
  const obj = { fetch: (id) => Promise.resolve({ id, ok: true }) };
  const { proxy, log, drain } = record(obj);

  const p = proxy.fetch(7);
  // The log is not populated until the promise settles.
  assert.equal(log.length, 0);

  const out = await p;
  assert.deepEqual(out, { id: 7, ok: true });

  await drain();
  assert.equal(log.length, 1);
  assert.equal(log[0].method, 'fetch');
  assert.deepEqual(log[0].args, [7]);
  assert.equal(log[0].kind, 'fulfilled');
  assert.deepEqual(log[0].result, { id: 7, ok: true });
});

test('records a rejected promise', async () => {
  const obj = { fail: (msg) => Promise.reject(new Error(msg)) };
  const { proxy, log, drain } = record(obj);

  const p = proxy.fail('boom');
  assert.equal(log.length, 0);

  await assert.rejects(p, /boom/);
  await drain();

  assert.equal(log.length, 1);
  assert.equal(log[0].method, 'fail');
  assert.deepEqual(log[0].args, ['boom']);
  assert.equal(log[0].kind, 'rejected');
  assert.ok(log[0].error instanceof Error);
  assert.equal(log[0].error.message, 'boom');
});

test('drain resolves immediately when nothing is in flight', async () => {
  const obj = { sync: () => 1 };
  const { proxy, drain } = record(obj);
  proxy.sync();
  // Should not hang.
  await drain();
});

test('drain waits for multiple concurrent promises', async () => {
  let resolveA, resolveB;
  const obj = {
    a: () => new Promise((r) => { resolveA = r; }),
    b: () => new Promise((r) => { resolveB = r; }),
  };
  const { proxy, log, drain } = record(obj);

  proxy.a();
  proxy.b();
  assert.equal(log.length, 0);

  resolveA('A');
  resolveB('B');
  await drain();

  assert.equal(log.length, 2);
  const methods = log.map((r) => r.method).sort();
  assert.deepEqual(methods, ['a', 'b']);
});

test('preserves the original return value for async methods', async () => {
  // The proxy must return the user's original thenable, not a wrapped one,
  // so callers that branch on specific Promise subclasses are unaffected.
  const original = Promise.resolve('value');
  const obj = { get: () => original };
  const { proxy } = record(obj);

  const returned = proxy.get();
  assert.equal(returned, original);
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

test('replay calls methods in log order with recorded args', () => {
  const seen = [];
  const target = {
    a: (x) => { seen.push(['a', x]); },
    b: (y) => { seen.push(['b', y]); },
  };

  const entries = [
    { method: 'a', args: [1], kind: 'sync', result: undefined },
    { method: 'b', args: [2], kind: 'sync', result: undefined },
  ];

  replay(target, entries);

  assert.deepEqual(seen, [['a', 1], ['b', 2]]);
});

test('replay re-throws the original error for rejected records', () => {
  const target = { never: () => {} };
  const err = new Error('original');
  const entries = [
    { method: 'never', args: [], kind: 'rejected', error: err },
  ];

  assert.throws(() => replay(target, entries), (e) => e === err);
});

test('replay calls fulfilled records but does not await them', async () => {
  // A fulfilled record means the original call returned a promise that
  // settled. On replay we call the method; we do NOT await its return.
  let called = false;
  const target = {
    async: () => { called = true; return Promise.resolve('x'); },
  };
  const entries = [
    { method: 'async', args: [], kind: 'fulfilled', result: 'x' },
  ];

  replay(target, entries);
  assert.equal(called, true);
});

test('replay throws on a missing method', () => {
  const target = {};
  const entries = [{ method: 'missing', args: [], kind: 'sync', result: undefined }];
  assert.throws(() => replay(target, entries), /no method named 'missing'/);
});

test('replay throws on a malformed entry', () => {
  const target = { a: () => {} };
  assert.throws(() => replay(target, [null]), /malformed/);
  assert.throws(() => replay(target, [{ args: [] }]), /malformed/);
});

// ---------------------------------------------------------------------------
// Edge cases the implementation explicitly handles
// ---------------------------------------------------------------------------

test('record throws on a non-object', () => {
  assert.throws(() => record(null), /expects an object/);
  assert.throws(() => record(42), /expects an object/);
});

test('symbol property reads pass through and are not recorded', () => {
  const sym = Symbol('peek');
  const obj = { [sym]: 'symbol-value', m: () => 1 };
  const { proxy, log } = record(obj);

  assert.equal(proxy[sym], 'symbol-value');
  proxy.m();
  assert.equal(log.length, 1);
});

test('methods that return undefined are recorded as sync', () => {
  const obj = { noop: () => {} };
  const { proxy, log } = record(obj);

  const out = proxy.noop();
  assert.equal(out, undefined);
  assert.deepEqual(log, [
    { method: 'noop', args: [], kind: 'sync', result: undefined },
  ]);
});

test('arguments array preserves object identity', () => {
  const payload = { id: 1 };
  const obj = { send: (p) => p };
  const { proxy, log } = record(obj);

  proxy.send(payload);
  assert.equal(log[0].args[0], payload);
});
