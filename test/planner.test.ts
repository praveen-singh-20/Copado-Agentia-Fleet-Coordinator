import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../src/coordinator/planner.ts';
import type { TaskInput } from '../src/core/types.ts';
import { original } from './helpers.ts';

test('five-story batch: field first, then four stories in parallel', () => {
  const s = schedule(original().tasks);
  assert.deepEqual(s.waves.map((w) => w.tasks), [['US-101'], ['US-102', 'US-103', 'US-104', 'US-105']]);
  assert.deepEqual(s.collisions, []);
  assert.equal(s.mergeable.length, 1);
  assert.equal(s.mergeable[0].component, 'Profile:Sales');
  assert.deepEqual(s.mergeable[0].tasks, ['US-103', 'US-105']);
});

const node = (id: string, nodeName: string): TaskInput => ({
  id,
  title: id,
  changes: [{ op: 'set-node', id: 'Profile:Sales', node: nodeName, value: { readable: true } }],
});

test('same profile node in two stories is a collision and gets serialized', () => {
  const s = schedule([node('A', 'fieldPermissions:Account.X__c'), node('B', 'fieldPermissions:Account.X__c')]);
  assert.deepEqual(s.waves.map((w) => w.tasks), [['A'], ['B']]);
  assert.deepEqual(s.collisions, [{ tasks: ['A', 'B'], key: 'Profile:Sales#fieldPermissions:Account.X__c' }]);
});

test('different nodes of the same profile run in parallel', () => {
  const s = schedule([node('A', 'fieldPermissions:Account.X__c'), node('B', 'fieldPermissions:Account.Y__c')]);
  assert.deepEqual(s.waves.map((w) => w.tasks), [['A', 'B']]);
});

test('a story that uses a component waits for the story that creates it, even if submitted first', () => {
  const user: TaskInput = { id: 'USE', title: 'flow', changes: [{ op: 'create', component: { id: 'Flow:F', type: 'Flow', attributes: {} }, references: [{ to: 'CustomField:Account.N__c', kind: 'reads' }] }] };
  const maker: TaskInput = { id: 'MAKE', title: 'field', changes: [{ op: 'create', component: { id: 'CustomField:Account.N__c', type: 'CustomField', attributes: {} } }] };
  const s = schedule([user, maker]);
  assert.deepEqual(s.waves.map((w) => w.tasks), [['MAKE'], ['USE']]);
});

test('cycles are reported instead of looping', () => {
  const a: TaskInput = { id: 'A', title: 'a', changes: [{ op: 'create', component: { id: 'Flow:A', type: 'Flow', attributes: {} }, references: [{ to: 'Flow:B', kind: 'reads' }] }] };
  const b: TaskInput = { id: 'B', title: 'b', changes: [{ op: 'create', component: { id: 'Flow:B', type: 'Flow', attributes: {} }, references: [{ to: 'Flow:A', kind: 'reads' }] }] };
  assert.throws(() => schedule([a, b]), /Dependency cycle between tasks: A, B/);
});
