/**
 * Method Call Recorder.
 *
 * Wraps an object in a Proxy. Every method invocation is appended to a replayable
 * log as a record describing: the method name, the arguments, and the result.
 *
 * Results are classified as one of:
 *   - 'sync'   : the method returned a non-thenable value.
 *   - 'fulfilled': the method returned a Promise that fulfilled.
 *   - 'rejected' : the method returned a Promise that rejected.
 *
 * The log is a plain array of records and can be replayed against another object
 * via `replay`. This is useful for golden-master testing, audit trails, and
 * deterministic replay in environments where the original object is unavailable
 * (e.g. a remote service stub).
 *
 * Design decisions (stated plainly so the tests and README agree):
 *
 * 1. Only FUNCTION properties are intercepted. Getting a non-function property
 *    returns the underlying value directly and records nothing. This keeps the
 *    log focused on *behaviour* rather than state, which is what makes it
 *    replayable against a different object that has the same methods.
 *
 * 2. The proxy is transparent for `typeof`, `instanceof`, and property
 *    enumeration — we proxy `get` only. This is the smallest surface that still
 *    records every call.
 *
 * 3. Asynchronous results are recorded when the promise settles, not when it is
 *    created. The log is therefore eventually-consistent; `drain()` returns a
 *    promise that resolves once all in-flight calls have settled, so tests can
 *    be deterministic without sleeping.
 *
 * 4. `replay` calls methods synchronously in log order. If a record's result
 *    was a rejection, `replay` re-throws the original error. It does NOT wait
 *    for returned promises to settle before moving to the next record — that
 *    would serialise unrelated async work and is not what "replay" means here.
 *    If you need serialised async replay, consume the log yourself.
 */

/**
 * @typedef {Object} SyncRecord
 * @property {string} method
 * @property {unknown[]} args
 * @property {'sync'} kind
 * @property {unknown} result
 */

/**
 * @typedef {Object} FulfilledRecord
 * @property {string} method
 * @property {unknown[]} args
 * @property {'fulfilled'} kind
 * @property {unknown} result
 */

/**
 * @typedef {Object} RejectedRecord
 * @property {string} method
 * @property {unknown[]} args
 * @property {'rejected'} kind
 * @property {unknown} error  // The rejection reason, preserved by reference.
 */

/**
 * @typedef {SyncRecord|FulfilledRecord|RejectedRecord} RecordEntry
 */

/**
 * @typedef {Object} Recorder
 * @property {T} proxy               The wrapped object; call methods on this.
 * @property {RecordEntry[]} log     The append-only call log.
 * @property {() => Promise<void>} drain Resolve once all in-flight async calls have settled.
 */

/**
 * Returns true when `v` looks like a thenable. We duck-type rather than checking
 * for Promise instances because some test doubles return custom thenables.
 *
 * @param {unknown} v
 * @returns {v is PromiseLike<unknown>}
 */
function isThenable(v) {
  return (
    v !== null &&
    (typeof v === 'object' || typeof v === 'function') &&
    typeof /** @type {any} */ (v).then === 'function'
  );
}

/**
 * Wrap `target` so every method call is appended to a replayable log.
 *
 * @template {object} T
 * @param {T} target The object whose method calls should be recorded.
 * @returns {Recorder<T>}
 */
export function record(target) {
  if (target === null || typeof target !== 'object') {
    throw new TypeError('record() expects an object');
  }

  /** @type {RecordEntry[]} */
  const log = [];

  // Track outstanding promises so `drain()` can wait for them deterministically.
  /** @type {Set<Promise<unknown>>} */
  const pending = new Set();

  /** @type {ProxyHandler<T>} */
  const handler = {
    get(obj, prop, receiver) {
      // `prop` can be a symbol (e.g. Symbol.toPrimitive, then). We only care
      // about string-keyed function properties; everything else passes through.
      if (typeof prop !== 'string') {
        return Reflect.get(obj, prop, receiver);
      }

      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') {
        return value;
      }

      // Bind the original method so `this` inside it is the real target, not
      // the proxy. Otherwise methods that do `this._x` would hit the proxy's
      // get trap again and, worse, would record those internal reads as calls.
      const fn = value.bind(obj);

      // Return a wrapper that performs the call and records the outcome.
      // Arrow function so `this` is irrelevant at the call site.
      const wrapper = (...args) => {
        let result;
        try {
          result = Reflect.apply(fn, undefined, args);
        } catch (err) {
          // A synchronous throw is recorded as a rejected record, then
          // re-thrown. The caller sees the original error; the log sees the
          // failure. This matches how a rejected promise would be logged.
          /** @type {RejectedRecord} */
          const rec = { method: prop, args, kind: 'rejected', error: err };
          log.push(rec);
          throw err;
        }

        if (isThenable(result)) {
          // We attach handlers to the user's thenable to record the settlement
          // outcome. We use a second `then` that swallows the rejection on the
          // recording side so the recording chain never produces an unhandled
          // rejection; the caller still observes the original rejection via
          // `result` itself.
          const settled = Promise.resolve(result).then(
            (v) => {
              /** @type {FulfilledRecord} */
              const rec = { method: prop, args, kind: 'fulfilled', result: v };
              log.push(rec);
            },
            (err) => {
              /** @type {RejectedRecord} */
              const rec = { method: prop, args, kind: 'rejected', error: err };
              log.push(rec);
            }
          );
          pending.add(settled);
          // Remove from the set once settled so `drain` doesn't hold onto it.
          settled.finally(() => pending.delete(settled));
          return result;
        }

        /** @type {SyncRecord} */
        const rec = { method: prop, args, kind: 'sync', result };
        log.push(rec);
        return result;
      };

      return wrapper;
    },
  };

  const proxy = /** @type {T} */ (new Proxy(target, handler));

  /**
   * Resolves once every recorded async call has settled. Use this in tests
   * instead of sleeping. Returns immediately when nothing is in flight.
   *
   * @returns {Promise<void>}
   */
  const drain = () =>
    new Promise((resolve) => {
      const check = () => {
        if (pending.size === 0) resolve();
        else Promise.allSettled([...pending]).then(check);
      };
      check();
    });

  return { proxy, log, drain };
}

/**
 * Replay a recorded log against `target`, calling each method in order.
 *
 * For 'rejected' records the original error is re-thrown synchronously, which
 * halts replay. This is deliberate: a replay that silently swallowed errors
 * would hide real divergence between the log and the target. If you want to
 * tolerate rejections, filter the log before calling `replay`.
 *
 * Returned values from async methods are NOT awaited; see the module docstring.
 *
 * @template {object} T
 * @param {T} target
 * @param {RecordEntry[]} entries
 * @returns {void}
 */
export function replay(target, entries) {
  if (target === null || typeof target !== 'object') {
    throw new TypeError('replay() target must be an object');
  }
  if (!Array.isArray(entries)) {
    throw new TypeError('replay() entries must be an array');
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.method !== 'string') {
      throw new TypeError('replay() found a malformed log entry');
    }

    const fn = target[entry.method];
    if (typeof fn !== 'function') {
      throw new TypeError(
        `replay() target has no method named '${entry.method}'`
      );
    }

    if (entry.kind === 'rejected') {
      // Re-throw the preserved reason. We do not call the method, because the
      // original call never returned a value either.
      throw entry.error;
    }

    // For 'sync' and 'fulfilled' records we call the method with the recorded
    // args. We ignore the return value; replay is about reproducing side
    // effects, not asserting outputs.
    Reflect.apply(fn, target, entry.args);
  }
}
