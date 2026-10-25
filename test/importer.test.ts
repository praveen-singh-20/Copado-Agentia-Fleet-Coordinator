import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseXml, txt, kids } from '../src/xml/xml.ts';
import { importSfdx, splitApex } from '../src/importer/sfdx.ts';
import { diffToChanges } from '../src/importer/diff.ts';
import { importAtRef, revParse } from '../src/importer/git.ts';
import { sampleRepo } from './helpers.ts';

test('xml parser handles declarations, comments, CDATA, entities and namespaces', () => {
  const x = parseXml('<?xml version="1.0"?><!-- c --><A xmlns="x"><b>1 &amp; 2</b><b><![CDATA[<raw>]]></b><c x="y"/></A>');
  assert.equal(x.name, 'A');
  assert.deepEqual(kids(x, 'b').map((b) => txt(b)), ['1 & 2', '<raw>']);
  assert.equal(kids(x, 'c')[0].attrs.x, 'y');
  assert.throws(() => parseXml('<a><b></a>'), /Mismatched/);
});

test('apex splitter separates code, comments and string literals', () => {
  const { code, strings } = splitApex("// x Foo__c\nString q = 'SELECT Bar__c FROM A'; /* Baz__c */ a.Qux__c = 1;");
  assert.ok(!code.includes('Foo__c') && !code.includes('Baz__c') && !code.includes('Bar__c'));
  assert.ok(code.includes('Qux__c'));
  assert.deepEqual(strings, ['SELECT Bar__c FROM A']);
});

test('importing a real SFDX project finds dependencies with their provenance', () => {
  const repo = sampleRepo();
  const { snapshot, warnings } = importSfdx(repo);
  assert.deepEqual(warnings, []);
  const dep = (from: string, to: string) => snapshot.dependencies.find((d) => d.from === from && d.to === to);
  assert.equal(dep('ApexClass:AccountTierService', 'CustomField:Account.Tier_Legacy__c')?.source, 'source-code');
  assert.equal(dep('ApexClass:TierBatchJob', 'CustomField:Account.Tier_Legacy__c')?.source, 'inference', 'field inside a SOQL string');
  assert.equal(dep('Flow:Legacy_Tier_Update', 'CustomField:Account.Tier_Legacy__c')?.kind, 'writes', 'before-save assignment');
  assert.equal(dep('Report:Sales_Reports/Accounts_By_Tier', 'CustomField:Account.Tier_Legacy__c')?.kind, 'groups-by');
  assert.ok(dep('Dashboard:Sales_Dashboards/Sales_Exec', 'Report:Sales_Reports/Accounts_By_Tier'));
  assert.ok(dep('ApexTrigger:AccountTrigger', 'ApexClass:AccountTierService'));
  assert.equal(dep('IntegrationMapping:ERP_Account_Sync', 'CustomField:Account.Tier_Legacy__c')?.source, 'configuration');
  const c = (id: string) => snapshot.components.find((x) => x.id === id)!;
  assert.deepEqual(c('Profile:Sales').nodes!['fieldPermissions:Account.Tier_Legacy__c'], { readable: true, editable: true });
  assert.ok(c('Profile:Customer_Community').tags!.includes('external'));
  assert.ok(c('PermissionSet:Integration_User').tags!.includes('integration'));
  assert.ok(c('ApexClass:AccountTierService').tags!.includes('production-automation'), 'called by an active trigger');
  assert.ok(c('CustomField:Account.Tax_Id__c').tags!.includes('pii'), 'overlay tag');
  assert.equal(c('CustomObject:Account').attributes.implicit, true, 'standard object placeholder');
});

test('diff of a story branch yields the right change ops and ignores untouched files', async () => {
  const repo = sampleRepo();
  const base = await importAtRef(repo, (await revParse(repo, 'main'))!, 'main');
  const head = await importAtRef(repo, (await revParse(repo, 'feature/US-0000105'))!, 'US-0000105');
  const ops = diffToChanges(base.snapshot, head.snapshot);
  const desc = ops.map((o) => `${o.op} ${'id' in o ? o.id : o.component.id}${'node' in o ? `#${o.node}` : ''}`);
  assert.deepEqual(desc.sort(), [
    'delete CustomField:Account.Tier_Legacy__c',
    'remove-node Profile:Sales#fieldPermissions:Account.Tier_Legacy__c',
    'update Report:Sales_Reports/Accounts_By_Tier',
  ]);
  assert.ok(!desc.some((d) => d.includes('ApexClass')), 'apex files did not change, so no op even though the field is gone');
  const flow = diffToChanges(base.snapshot, (await importAtRef(repo, (await revParse(repo, 'feature/US-0000102'))!, 'x')).snapshot);
  assert.equal(flow.length, 1);
  assert.equal(flow[0].op, 'create');
  assert.ok(flow[0].op === 'create' && flow[0].references!.some((r) => r.to === 'CustomField:Account.Customer_Tier__c'), 'reference to a field this branch does not have is kept');
  assert.equal(path.basename(repo), 'repo');
});
