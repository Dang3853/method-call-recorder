# method-call-recorder

Wrap an object so every method call — arguments and synchronous or asynchronous return — is appended to a replayable log.

## Usage

```js
import { record, replay } from './src/index.js';

const service = {
  greet: (name) => `hello ${name}`,
  fetch: (id) => Promise.resolve({ id }),
};

const { proxy, log, drain } = record(service);

proxy.greet('ada');
proxy.fetch(42);
await drain(); // wait for in-flight promises to settle

console.log(log);
// [
//   { method: 'greet', args: ['ada'], kind: 'sync', result: 'hello ada' },
//   { method: 'fetch', args: [42], kind: 'fulfilled', result: { id: 42 } }
// ]

// Replay against a fresh object with the same methods.
const mirror = {
  greet: (name) => `hello ${name}`,
  fetch: (id) => Promise.resolve({ id }),
};
replay(mirror, log);
```

## Exports

- `record(target)` → `{ proxy, log, drain }`
  - `proxy`: the wrapped object. Call methods on it as normal.
  - `log`: an array of records. Each record has `method`, `args`, `kind`, and either `result` (for `sync`/`fulfilled`) or `error` (for `rejected`).
  - `drain()`: returns a `Promise<void>` that resolves once every recorded async call has settled. Use this in tests instead of sleeping.
- `replay(target, log)` → `void`. Calls each method in the log in order. Re-throws the original error for `rejected` records. Does not await async returns.

## Why

The problem is audit and replay for objects whose methods have side effects: you want a faithful transcript of what was called, with what arguments, and what came back — including promises — so you can replay it later against a different instance. Existing approaches either flatten async to sync (losing the settlement outcome) or record only call sites (losing returns).

The trade-off: this library intercepts only function-valued properties. Reads of plain data properties are not recorded, because they are state, not behaviour, and recording them would make the log non-replayable against an object with different internal fields. Internal `this`-reads inside a method are likewise not recorded — the method is bound to the original target, not the proxy.

## Awkward edges

- **Async ordering.** Records for async calls appear in the log when the promise settles, not when the method is called. If call order matters across mixed sync/async calls, sort the log yourself or consume it via `drain()`.
- **Replay does not await async methods.** `replay` calls each method in log order and moves on. If you need serialised async replay, consume the log directly.
- **Rejections halt replay.** A `rejected` record causes `replay` to throw the original error. Filter the log first if you want to tolerate failures.
- **Thenables, not just Promises.** Any object with a `.then` function is treated as async and recorded on settlement.
