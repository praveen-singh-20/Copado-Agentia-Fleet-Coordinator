#!/usr/bin/env node
// TEST STUB for the Agentia CLI. It is NOT Copado and returns canned answers so the
// adapters can be exercised without an org. Used only by the test suite via AGENTIA_BIN.
//
// AGENTIA_STUB_LOG       file that receives one JSON line per call (args + cwd)
// AGENTIA_STUB_SCENARIO  JSON file: { "responses": [{ "match": ["cicd","work","submit"], "active": "US-1",
//                        "exit": 1, "stdout": "...", "stderr": "..." }] }  first match wins
// AGENTIA_STUB_STATE     file holding the active story (written by `cicd work set`)

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const env = process.env;
if (env.AGENTIA_STUB_LOG) appendFileSync(env.AGENTIA_STUB_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\n');

if (args[0] === '--version') {
  console.log('@copado/agentia-cli/0.0.0-test-stub');
  process.exit(0);
}

const stateFile = env.AGENTIA_STUB_STATE;
let active = stateFile && existsSync(stateFile) ? readFileSync(stateFile, 'utf8').trim() : '';
if (args[0] === 'cicd' && args[1] === 'work' && args[2] === 'set' && stateFile) {
  active = args[3];
  writeFileSync(stateFile, active);
}

const scenario = env.AGENTIA_STUB_SCENARIO && existsSync(env.AGENTIA_STUB_SCENARIO) ? JSON.parse(readFileSync(env.AGENTIA_STUB_SCENARIO, 'utf8')) : { responses: [] };
const contains = (needle) => {
  let i = 0;
  for (const a of args) if (a === needle[i]) i++;
  return i === needle.length;
};
const hit = scenario.responses.find((r) => contains(r.match) && (!r.active || r.active === active) && (!r.promptIncludes || args.join(' ').includes(r.promptIncludes)));
if (hit) {
  if (hit.stdout) process.stdout.write(typeof hit.stdout === 'string' ? hit.stdout : JSON.stringify(hit.stdout));
  if (hit.stderr) process.stderr.write(hit.stderr);
  process.exit(hit.exit ?? 0);
}
process.stdout.write(JSON.stringify({ status: 0, result: { stub: true, command: args.filter((a) => a !== '--json').join(' '), active } }));
