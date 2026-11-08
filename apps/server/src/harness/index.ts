/** lane A 公共出口：其他模块只从这里 import harness 相关符号 */
export * from './types.js';
export * from './events.js';
export * from './registry.js';
export * from './runner.js';
export * from './isolation.js';
export * from './probe.js';
export * from './home.js';
export * from './login.js';
export type { ShimSpec, ShimExit, ShimPidInfo } from './shim/spec.js';
export { KILL_FILE } from './shim/spec.js';
export * from './install.js';
export { buildOutcome, classifyText, rateLimitClass } from './classify.js';
export { fakeScriptPath, FAKE_VERSION } from './adapters/fake.js';
export type { FakeScenario } from './fake/fake-harness.js';
export { capsFrom } from './adapters/common.js';
export { makeRunFixture, compiledFromSystem } from './testing.js';
export type { RunFixture, RunFixtureOptions } from './testing.js';
