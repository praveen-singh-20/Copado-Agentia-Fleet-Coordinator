// Creates a small Salesforce DX Git repository for samples and tests:
//   main                      the org as it is today
//   feature/US-0000101..105   five in-flight Copado stories (the "Customer Tier" rollout)
//
// Usage: node scripts/make-sample-repo.ts <target-folder> [--variant original|revised]
// Nothing here talks to Salesforce or Copado.

import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const XML = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

const field = (name: string, label: string, type: string, extra = '') => `${XML}<CustomField ${NS}>\n    <fullName>${name}</fullName>\n    <label>${label}</label>\n    <type>${type}</type>\n${extra}</CustomField>\n`;
const fieldPerm = (f: string, r: boolean, e: boolean) => `    <fieldPermissions>\n        <editable>${e}</editable>\n        <field>${f}</field>\n        <readable>${r}</readable>\n    </fieldPermissions>\n`;
const objPerm = (o: string, edit: boolean) => `    <objectPermissions>\n        <allowCreate>${edit}</allowCreate>\n        <allowDelete>false</allowDelete>\n        <allowEdit>${edit}</allowEdit>\n        <allowRead>true</allowRead>\n        <modifyAllRecords>false</modifyAllRecords>\n        <object>${o}</object>\n        <viewAllRecords>false</viewAllRecords>\n    </objectPermissions>\n`;
const profile = (license: string, perms: string) => `${XML}<Profile ${NS}>\n    <custom>true</custom>\n${perms}    <userLicense>${license}</userLicense>\n</Profile>\n`;
const permset = (label: string, perms: string) => `${XML}<PermissionSet ${NS}>\n${perms}    <label>${label}</label>\n</PermissionSet>\n`;
const report = (groupField: string) => `${XML}<Report ${NS}>\n    <columns>\n        <field>ACCOUNT.NAME</field>\n    </columns>\n    <format>Summary</format>\n    <groupingsDown>\n        <dateGranularity>Day</dateGranularity>\n        <field>${groupField}</field>\n        <sortOrder>Asc</sortOrder>\n    </groupingsDown>\n    <name>Accounts by Tier</name>\n    <reportType>AccountList</reportType>\n</Report>\n`;

const overlay = (mappings: { field: string; direction: string }[]) =>
  JSON.stringify(
    {
      components: [
        {
          id: 'IntegrationMapping:ERP_Account_Sync',
          type: 'IntegrationMapping',
          attributes: { system: 'SAP ERP', runAs: 'PermissionSet:Integration_User', fieldMappings: mappings },
          tags: ['integration', 'external-consumer'],
        },
      ],
      dependencies: [
        ...mappings.map((m) => ({ from: 'IntegrationMapping:ERP_Account_Sync', to: m.field, kind: 'writes' })),
        { from: 'IntegrationMapping:ERP_Account_Sync', to: 'PermissionSet:Integration_User', kind: 'runs-as' },
      ],
      tags: { 'CustomField:Account.Tax_Id__c': ['pii'] },
      attributes: { 'Report:Sales_Reports/Accounts_By_Tier': { audience: ['Profile:Sales'] } },
    },
    null,
    2,
  ) + '\n';

const baseFiles: Record<string, string> = {
  'sfdx-project.json': JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '61.0' }, null, 2) + '\n',
  'force-app/main/default/objects/Account/fields/Tier_Legacy__c.field-meta.xml': field('Tier_Legacy__c', 'Tier (Legacy)', 'Text', '    <length>20</length>\n'),
  'force-app/main/default/objects/Account/fields/Tax_Id__c.field-meta.xml': field('Tax_Id__c', 'Tax ID', 'EncryptedText', '    <length>20</length>\n'),
  'force-app/main/default/flows/Legacy_Tier_Update.flow-meta.xml': `${XML}<Flow ${NS}>
    <assignments>
        <name>Set_Tier</name>
        <label>Set Tier</label>
        <assignmentItems>
            <assignToReference>$Record.Tier_Legacy__c</assignToReference>
            <operator>Assign</operator>
            <value><stringValue>Standard</stringValue></value>
        </assignmentItems>
    </assignments>
    <label>Legacy Tier Update</label>
    <processType>AutoLaunchedFlow</processType>
    <start>
        <object>Account</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordBeforeSave</triggerType>
        <connector><targetReference>Set_Tier</targetReference></connector>
    </start>
    <status>Active</status>
</Flow>
`,
  'force-app/main/default/classes/AccountTierService.cls': `public with sharing class AccountTierService {
    // Discount by tier
    public static void apply(List<Account> accounts) {
        for (Account acc : accounts) {
            if (acc.Tier_Legacy__c == 'Gold') {
                acc.Description = 'Discount 10%';
            }
        }
    }
}
`,
  'force-app/main/default/classes/AccountTierService.cls-meta.xml': `${XML}<ApexClass ${NS}><apiVersion>61.0</apiVersion><status>Active</status></ApexClass>\n`,
  'force-app/main/default/classes/TierBatchJob.cls': `public class TierBatchJob implements Database.Batchable<SObject> {
    public Database.QueryLocator start(Database.BatchableContext bc) {
        String q = 'SELECT Id, Tier_Legacy__c FROM Account';
        return Database.getQueryLocator(q);
    }
    public void execute(Database.BatchableContext bc, List<SObject> scope) {}
    public void finish(Database.BatchableContext bc) {}
}
`,
  'force-app/main/default/classes/TierBatchJob.cls-meta.xml': `${XML}<ApexClass ${NS}><apiVersion>58.0</apiVersion><status>Active</status></ApexClass>\n`,
  'force-app/main/default/triggers/AccountTrigger.trigger': `trigger AccountTrigger on Account (before insert, before update) {
    AccountTierService.apply(Trigger.new);
}
`,
  'force-app/main/default/triggers/AccountTrigger.trigger-meta.xml': `${XML}<ApexTrigger ${NS}><apiVersion>61.0</apiVersion><status>Active</status></ApexTrigger>\n`,
  'force-app/main/default/profiles/Sales.profile-meta.xml': profile('Salesforce', fieldPerm('Account.Tier_Legacy__c', true, true) + objPerm('Account', true)),
  'force-app/main/default/profiles/Customer_Community.profile-meta.xml': profile('Customer Community', objPerm('Account', false)),
  'force-app/main/default/permissionsets/Integration_User.permissionset-meta.xml': permset('ERP Integration User', fieldPerm('Account.Tier_Legacy__c', true, true) + objPerm('Account', true)),
  'force-app/main/default/reports/Sales_Reports/Accounts_By_Tier.report-meta.xml': report('Account.Tier_Legacy__c'),
  'force-app/main/default/dashboards/Sales_Dashboards/Sales_Exec.dashboard-meta.xml': `${XML}<Dashboard ${NS}>
    <dashboardType>SpecifiedUser</dashboardType>
    <leftSection>
        <components>
            <componentType>Bar</componentType>
            <report>Sales_Reports/Accounts_By_Tier</report>
        </components>
    </leftSection>
    <runningUser>admin@example.com</runningUser>
    <title>Sales Executive</title>
</Dashboard>
`,
  'fleet.overlay.json': overlay([{ field: 'CustomField:Account.Tier_Legacy__c', direction: 'inbound' }]),
};

type Edit = Record<string, string | null>;

function stories(variant: 'original' | 'revised'): Record<string, { title: string; edits: Edit }> {
  const revised = variant === 'revised';
  return {
    'US-0000101': {
      title: 'Add Customer Tier picklist to Account',
      edits: {
        'force-app/main/default/objects/Account/fields/Customer_Tier__c.field-meta.xml': field(
          'Customer_Tier__c',
          'Customer Tier',
          'Picklist',
          '    <valueSet>\n        <valueSetDefinition>\n' + ['Bronze', 'Silver', 'Gold', 'Platinum'].map((v) => `            <value><fullName>${v}</fullName><default>false</default><label>${v}</label></value>\n`).join('') + '        </valueSetDefinition>\n    </valueSet>\n',
        ),
      },
    },
    'US-0000102': {
      title: 'Route Gold and Platinum accounts to the Key Accounts queue',
      edits: {
        'force-app/main/default/flows/Account_Tier_Routing.flow-meta.xml': `${XML}<Flow ${NS}>
    <decisions>
        <name>Is_Key_Account</name>
        <label>Is key account</label>
        <rules>
            <name>Gold_Or_Platinum</name>
            <conditionLogic>or</conditionLogic>
            <conditions>
                <leftValueReference>$Record.Customer_Tier__c</leftValueReference>
                <operator>EqualTo</operator>
                <rightValue><stringValue>Gold</stringValue></rightValue>
            </conditions>
            <label>Gold or Platinum</label>
        </rules>
    </decisions>
    <label>Account Tier Routing</label>
    <processType>AutoLaunchedFlow</processType>
    <start>
        <object>Account</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
        <connector><targetReference>Is_Key_Account</targetReference></connector>
    </start>
    <status>Active</status>
</Flow>
`,
      },
    },
    'US-0000103': {
      title: 'Field-level security for Customer Tier',
      edits: {
        'force-app/main/default/profiles/Sales.profile-meta.xml': profile('Salesforce', fieldPerm('Account.Customer_Tier__c', true, false) + fieldPerm('Account.Tier_Legacy__c', true, true) + objPerm('Account', true)),
        'force-app/main/default/permissionsets/Integration_User.permissionset-meta.xml': permset('ERP Integration User', fieldPerm('Account.Customer_Tier__c', true, revised) + fieldPerm('Account.Tier_Legacy__c', true, true) + objPerm('Account', true)),
      },
    },
    'US-0000104': {
      title: 'ERP sync writes Customer Tier',
      edits: {
        'fleet.overlay.json': overlay(revised ? [{ field: 'CustomField:Account.Customer_Tier__c', direction: 'inbound' }] : [{ field: 'CustomField:Account.Tier_Legacy__c', direction: 'inbound' }, { field: 'CustomField:Account.Customer_Tier__c', direction: 'inbound' }]),
      },
    },
    'US-0000105': {
      title: revised ? 'Report by Customer Tier; deprecate the legacy field' : 'Report by Customer Tier and retire the legacy tier field',
      edits: revised
        ? {
            'force-app/main/default/reports/Sales_Reports/Accounts_By_Tier.report-meta.xml': report('Account.Customer_Tier__c'),
            'force-app/main/default/objects/Account/fields/Tier_Legacy__c.field-meta.xml': field('Tier_Legacy__c', 'Tier (Legacy - deprecated)', 'Text', '    <length>20</length>\n    <description>Deprecated: use Customer_Tier__c</description>\n'),
          }
        : {
            'force-app/main/default/reports/Sales_Reports/Accounts_By_Tier.report-meta.xml': report('Account.Customer_Tier__c'),
            'force-app/main/default/profiles/Sales.profile-meta.xml': profile('Salesforce', objPerm('Account', true)),
            'force-app/main/default/objects/Account/fields/Tier_Legacy__c.field-meta.xml': null,
          },
    },
  };
}

export function makeSampleRepo(target: string, variant: 'original' | 'revised' = 'original'): string {
  const dir = path.resolve(target);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fleet Sample', '-c', 'user.email=sample@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe' }).toString();
  const write = (files: Edit) => {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(dir, rel);
      if (content === null) rmSync(p, { force: true });
      else {
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, content);
      }
    }
  };
  git('init', '-q', '-b', 'main');
  write(baseFiles);
  git('add', '-A');
  git('commit', '-q', '-m', 'Org baseline');
  for (const [story, { title, edits }] of Object.entries(stories(variant))) {
    git('checkout', '-q', '-b', `feature/${story}`, 'main');
    write(edits);
    git('add', '-A');
    git('commit', '-q', '-m', `${story}: ${title}`);
  }
  git('checkout', '-q', 'main');
  return dir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node scripts/make-sample-repo.ts <target-folder> [--variant original|revised]');
    process.exit(1);
  }
  const variant = process.argv.includes('--variant') && process.argv[process.argv.indexOf('--variant') + 1] === 'revised' ? 'revised' : 'original';
  const dir = makeSampleRepo(target, variant);
  console.log(`Sample repo (${variant}) created at ${dir}\nBranches: main, feature/US-0000101 … feature/US-0000105`);
}
