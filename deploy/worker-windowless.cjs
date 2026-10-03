'use strict';
// Applied before the controller and every Node child; no console-producing wrapper.
const cp = require('node:child_process');
const {syncBuiltinESMExports} = require('node:module');
function windowlessEnv(environment = process.env) {
  const option = '--require=' + JSON.stringify(__filename);
  const existing = environment.NODE_OPTIONS || '';
  return {...environment, NODE_OPTIONS: existing.includes(option) ? existing : [existing, option].filter(Boolean).join(' ')};
}
const marker = Symbol.for('aimoney.windowless-child-process');
if (!cp[marker]) {
  Object.defineProperty(cp, marker, {value: true});
  const hide = options => ({...options, windowsHide: true, env: windowlessEnv(options?.env || process.env)});
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = cp[name];
    cp[name] = function (...parameters) {
      const index = Array.isArray(parameters[1]) || parameters[1] === undefined ? 2 : 1;
      if (typeof parameters[index] === 'function') parameters.splice(index, 0, hide());
      else parameters[index] = hide(parameters[index]);
      return Reflect.apply(original, this, parameters);
    };
  }
  for (const name of ['exec', 'execSync']) {
    const original = cp[name];
    cp[name] = function (...parameters) {
      if (typeof parameters[1] === 'function') parameters.splice(1, 0, hide());
      else parameters[1] = hide(parameters[1]);
      return Reflect.apply(original, this, parameters);
    };
  }
  const originalFork = cp.fork;
  cp.fork = function (...parameters) {
    const index = Array.isArray(parameters[1]) || parameters[1] === undefined ? 2 : 1;
    parameters[index] = hide(parameters[index]);
    return Reflect.apply(originalFork, this, parameters);
  };
  syncBuiltinESMExports();
}
module.exports = {windowlessEnv};
