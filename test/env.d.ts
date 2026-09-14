/**
 * Brings Node's own types (`node:test`, `node:assert/strict`, `Buffer`) into
 * the typecheck. `@types/node` is installed, but TypeScript 6 no longer
 * picks every `@types` package up on its own, and the app has no reason to
 * ask for Node's: only the tests and their stubs run there.
 */
/// <reference types="node" />
