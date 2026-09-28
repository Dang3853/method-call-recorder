/**
 * Public entry point for the method-call-recorder library.
 *
 * Re-exports the factory and types so consumers can do:
 *   import { record } from 'method-call-recorder';
 */

export { record, replay } from './core.js';
