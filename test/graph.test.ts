import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetadataState, validateSnapshot } from '../src/graph/metadataGraph.ts';
import { snapshot } from './helpers.ts';

test('blast radius separates direct and indirect impacts and keeps provenance', () => {
  const s = MetadataState.fromSnapshot(snapshot());
  const br = s.blastRadius(['CustomField:Account.Tier_Legacy__c']);
  const direct = br.direct.map((e) => e.component).sort();
  assert.deepEqual(direct, [
    'ApexClass:AccountTierService',
    'ApexClass:TierBatchJob',
    'Flow:Legacy_Tier_Update',
    'IntegrationMapping:ERP_Account_Sync',
    'Report:Accounts_By_Tier',
  ]);
  const trigger = br.indirect.find((e) => e.component === 'ApexTrigger:AccountTrigger');
  assert.ok(trigger, 'trigger reached through the Apex class');
  assert.equal(trigger.depth, 2);
  assert.deepEqual(trigger.via.map((v) => v.source), ['source-code', 'source-code']);
  assert.ok(br.indirect.some((e) => e.component === 'Dashboard:Sales_Exec'), 'dashboard reached through the report');
  assert.equal(br.direct.find((e) => e.component === 'ApexClass:TierBatchJob')!.via[0].source, 'inference');
});

test('clone isolates the baseline from simulated changes', () => {
  const base = MetadataState.fromSnapshot(snapshot());
  const copy = base.clone();
  copy.apply({ op: 'delete', id: 'CustomField:Account.Tier_Legacy__c' });
  copy.apply({ op: 'set-node', id: 'Profile:Sales', node: 'fieldPermissions:Account.X__c', value: { readable: true } });
  assert.ok(base.has('CustomField:Account.Tier_Legacy__c'));
  assert.equal(base.get('Profile:Sales')!.nodes!['fieldPermissions:Account.X__c'], undefined);
  assert.equal(copy.danglingReferences().length, 5);
});

test('apply reports problems instead of throwing', () => {
  const s = MetadataState.fromSnapshot(snapshot());
  assert.deepEqual(s.apply({ op: 'update', id: 'Flow:Nope', attributes: {} }), ['Flow:Nope does not exist (update)']);
});

test('snapshot validation rejects bad ids and unknown dependency targets', () => {
  assert.throws(() => validateSnapshot({ name: 'x', capturedAt: '', origin: '', components: [{ id: 'Flow:A', type: 'ApexClass', attributes: {} }], dependencies: [] }), /must start with/);
  assert.throws(
    () =>
      validateSnapshot({
        name: 'x',
        capturedAt: '',
        origin: '',
        components: [{ id: 'Flow:A', type: 'Flow', attributes: {} }],
        dependencies: [{ from: 'Flow:A', to: 'Flow:B', kind: 'reads', source: 'metadata' }],
      }),
    /unknown component Flow:B/,
  );
});
