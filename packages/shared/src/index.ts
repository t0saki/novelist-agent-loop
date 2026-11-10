/** @novelist/shared —— web 与 server 共用的契约：schema、枚举、DTO、纯工具函数。不得依赖 node: 内置模块。 */
export * from './ids.js';
export * from './enums.js';
export * from './text.js';
export * from './merge.js';
export * from './events.js';
export * from './harness.js';
export * from './schemas/genre.js';
export * from './schemas/book.js';
export * from './config/routing.js';
export * from './config/accounts.js';
export * from './config/settings.js';
export * from './config/slots.js';
export * from './config/presets.js';
export * from './api.js';
