// The "Customer Tier rollout" scenario as deployable Salesforce DX source, for a real
// sandbox pipeline. Differences from the built-in sample repo:
//   - a Sales_User permission set instead of a custom Sales profile (no profile changes in your org)
//   - Apex test classes so the code deploys with coverage
//   - a report folder file; no dashboard and no community profile
// Written to Salesforce's source-format layout, API version 61.0.

const XML = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
const API = '61.0';
const D = 'force-app/main/default';

export type Files = Record<string, string | null>;

const textField = (name: string, label: string, description?: string) =>
  `${XML}<CustomField ${NS}>
    <fullName>${name}</fullName>${description ? `\n    <description>${description}</description>` : ''}
    <externalId>false</externalId>
    <label>${label}</label>
    <length>20</length>
    <required>false</required>
    <trackTrending>false</trackTrending>
    <type>Text</type>
    <unique>false</unique>
</CustomField>
`;

const tierField = `${XML}<CustomField ${NS}>
    <fullName>Customer_Tier__c</fullName>
    <externalId>false</externalId>
    <label>Customer Tier</label>
    <required>false</required>
    <trackTrending>false</trackTrending>
    <type>Picklist</type>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition>
            <sorted>false</sorted>
${['Bronze', 'Silver', 'Gold', 'Platinum'].map((v) => `            <value>
                <fullName>${v}</fullName>
                <default>false</default>
                <label>${v}</label>
            </value>`).join('\n')}
        </valueSetDefinition>
    </valueSet>
</CustomField>
`;

const fieldPerm = (field: string, readable: boolean, editable: boolean) => `    <fieldPermissions>
        <editable>${editable}</editable>
        <field>${field}</field>
        <readable>${readable}</readable>
    </fieldPermissions>
`;

const permset = (label: string, perms: string) => `${XML}<PermissionSet ${NS}>
${perms}    <hasActivationRequired>false</hasActivationRequired>
    <label>${label}</label>
    <objectPermissions>
        <allowCreate>true</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>true</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Account</object>
        <viewAllRecords>false</viewAllRecords>
    </objectPermissions>
</PermissionSet>
`;

const report = (groupField: string) => `${XML}<Report ${NS}>
    <columns>
        <field>ACCOUNT.NAME</field>
    </columns>
    <format>Summary</format>
    <groupingsDown>
        <dateGranularity>Day</dateGranularity>
        <field>${groupField}</field>
        <sortOrder>Asc</sortOrder>
    </groupingsDown>
    <name>Accounts by Tier</name>
    <params>
        <name>co</name>
        <value>1</value>
    </params>
    <reportType>AccountList</reportType>
    <scope>organization</scope>
    <showDetails>true</showDetails>
    <showGrandTotal>true</showGrandTotal>
    <showSubTotals>true</showSubTotals>
</Report>
`;

const clsMeta = `${XML}<ApexClass ${NS}>\n    <apiVersion>${API}</apiVersion>\n    <status>Active</status>\n</ApexClass>\n`;

export function overlay(mappings: { field: string; direction: string }[]): string {
  return (
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
        attributes: { 'Report:Sales_Reports/Accounts_By_Tier': { audience: ['PermissionSet:Sales_User'] } },
      },
      null,
      2,
    ) + '\n'
  );
}

const legacyOnly = [{ field: 'CustomField:Account.Tier_Legacy__c', direction: 'inbound' }];

/** Baseline: the org "today". Deploy to every pipeline org and commit to every environment branch. */
export const BASELINE: Files = {
  [`${D}/objects/Account/fields/Tier_Legacy__c.field-meta.xml`]: textField('Tier_Legacy__c', 'Tier (Legacy)'),
  [`${D}/objects/Account/fields/Tax_Id__c.field-meta.xml`]: textField('Tax_Id__c', 'Tax ID'),
  [`${D}/flows/Legacy_Tier_Update.flow-meta.xml`]: `${XML}<Flow ${NS}>
    <apiVersion>${API}</apiVersion>
    <assignments>
        <name>Set_Tier</name>
        <label>Set Tier</label>
        <locationX>176</locationX>
        <locationY>287</locationY>
        <assignmentItems>
            <assignToReference>$Record.Tier_Legacy__c</assignToReference>
            <operator>Assign</operator>
            <value>
                <stringValue>Standard</stringValue>
            </value>
        </assignmentItems>
    </assignments>
    <environments>Default</environments>
    <interviewLabel>Legacy Tier Update {!$Flow.CurrentDateTime}</interviewLabel>
    <label>Legacy Tier Update</label>
    <processMetadataValues>
        <name>BuilderType</name>
        <value>
            <stringValue>LightningFlowBuilder</stringValue>
        </value>
    </processMetadataValues>
    <processMetadataValues>
        <name>CanvasMode</name>
        <value>
            <stringValue>AUTO_LAYOUT_CANVAS</stringValue>
        </value>
    </processMetadataValues>
    <processType>AutoLaunchedFlow</processType>
    <start>
        <locationX>50</locationX>
        <locationY>0</locationY>
        <connector>
            <targetReference>Set_Tier</targetReference>
        </connector>
        <filterLogic>and</filterLogic>
        <filters>
            <field>Tier_Legacy__c</field>
            <operator>IsNull</operator>
            <value>
                <booleanValue>true</booleanValue>
            </value>
        </filters>
        <object>Account</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordBeforeSave</triggerType>
    </start>
    <status>Active</status>
</Flow>
`,
  [`${D}/classes/AccountTierService.cls`]: `public with sharing class AccountTierService {
    // Gives Gold accounts a discount note, based on the legacy tier.
    public static void apply(List<Account> accounts) {
        for (Account acc : accounts) {
            if (acc.Tier_Legacy__c == 'Gold') {
                acc.Description = 'Discount 10%';
            }
        }
    }
}
`,
  [`${D}/classes/AccountTierService.cls-meta.xml`]: clsMeta,
  [`${D}/classes/AccountTierServiceTest.cls`]: `@IsTest
private class AccountTierServiceTest {
    @IsTest
    static void goldAccountsGetADiscountNote() {
        Account acc = new Account(Name = 'Fleet Test', Tier_Legacy__c = 'Gold');
        insert acc;
        acc = [SELECT Description FROM Account WHERE Id = :acc.Id];
        System.assertEquals('Discount 10%', acc.Description);
    }
}
`,
  [`${D}/classes/AccountTierServiceTest.cls-meta.xml`]: clsMeta,
  [`${D}/classes/TierBatchJob.cls`]: `public class TierBatchJob implements Database.Batchable<SObject> {
    public Database.QueryLocator start(Database.BatchableContext bc) {
        String q = 'SELECT Id, Tier_Legacy__c FROM Account';
        return Database.getQueryLocator(q);
    }
    public void execute(Database.BatchableContext bc, List<SObject> scope) {
        AccountTierService.apply((List<Account>) scope);
    }
    public void finish(Database.BatchableContext bc) {}
}
`,
  [`${D}/classes/TierBatchJob.cls-meta.xml`]: clsMeta,
  [`${D}/classes/TierBatchJobTest.cls`]: `@IsTest
private class TierBatchJobTest {
    @IsTest
    static void runsOverAccounts() {
        insert new Account(Name = 'Fleet Batch Test', Tier_Legacy__c = 'Gold');
        Test.startTest();
        Database.executeBatch(new TierBatchJob());
        Test.stopTest();
        System.assertEquals(1, [SELECT COUNT() FROM Account WHERE Name = 'Fleet Batch Test']);
    }
}
`,
  [`${D}/classes/TierBatchJobTest.cls-meta.xml`]: clsMeta,
  [`${D}/triggers/AccountTrigger.trigger`]: `trigger AccountTrigger on Account (before insert, before update) {
    AccountTierService.apply(Trigger.new);
}
`,
  [`${D}/triggers/AccountTrigger.trigger-meta.xml`]: `${XML}<ApexTrigger ${NS}>\n    <apiVersion>${API}</apiVersion>\n    <status>Active</status>\n</ApexTrigger>\n`,
  [`${D}/permissionsets/Sales_User.permissionset-meta.xml`]: permset('Sales User', fieldPerm('Account.Tier_Legacy__c', true, true)),
  [`${D}/permissionsets/Integration_User.permissionset-meta.xml`]: permset('ERP Integration User', fieldPerm('Account.Tier_Legacy__c', true, true)),
  [`${D}/reports/Sales_Reports.reportFolder-meta.xml`]: `${XML}<ReportFolder ${NS}>\n    <name>Sales Reports</name>\n</ReportFolder>\n`,
  [`${D}/reports/Sales_Reports/Accounts_By_Tier.report-meta.xml`]: report('Account.Tier_Legacy__c'),
  'fleet.overlay.json': overlay(legacyOnly),
};

export interface StorySpec {
  key: string;
  title: string;
  files: Files;
}

/**
 * The five stories. `revised` = the versions after the fixes the fleet suggests
 * (integration user gets edit; the legacy field is deprecated, not deleted).
 */
export function stories(variant: 'original' | 'revised' = 'original'): StorySpec[] {
  const revised = variant === 'revised';
  return [
    {
      key: 'tier-field',
      title: 'Add Customer Tier picklist to Account',
      files: { [`${D}/objects/Account/fields/Customer_Tier__c.field-meta.xml`]: tierField },
    },
    {
      key: 'routing-flow',
      title: 'Route Gold and Platinum accounts',
      files: {
        [`${D}/flows/Account_Tier_Routing.flow-meta.xml`]: `${XML}<Flow ${NS}>
    <apiVersion>${API}</apiVersion>
    <decisions>
        <name>Is_Key_Account</name>
        <label>Is key account</label>
        <locationX>182</locationX>
        <locationY>287</locationY>
        <defaultConnectorLabel>Other</defaultConnectorLabel>
        <rules>
            <name>Gold_or_Platinum</name>
            <conditionLogic>or</conditionLogic>
            <conditions>
                <leftValueReference>$Record.Customer_Tier__c</leftValueReference>
                <operator>EqualTo</operator>
                <rightValue>
                    <stringValue>Gold</stringValue>
                </rightValue>
            </conditions>
            <conditions>
                <leftValueReference>$Record.Customer_Tier__c</leftValueReference>
                <operator>EqualTo</operator>
                <rightValue>
                    <stringValue>Platinum</stringValue>
                </rightValue>
            </conditions>
            <label>Gold or Platinum</label>
        </rules>
    </decisions>
    <environments>Default</environments>
    <interviewLabel>Account Tier Routing {!$Flow.CurrentDateTime}</interviewLabel>
    <label>Account Tier Routing</label>
    <processMetadataValues>
        <name>BuilderType</name>
        <value>
            <stringValue>LightningFlowBuilder</stringValue>
        </value>
    </processMetadataValues>
    <processMetadataValues>
        <name>CanvasMode</name>
        <value>
            <stringValue>AUTO_LAYOUT_CANVAS</stringValue>
        </value>
    </processMetadataValues>
    <processType>AutoLaunchedFlow</processType>
    <start>
        <locationX>56</locationX>
        <locationY>0</locationY>
        <connector>
            <targetReference>Is_Key_Account</targetReference>
        </connector>
        <object>Account</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
    </start>
    <status>Active</status>
</Flow>
`,
      },
    },
    {
      key: 'tier-fls',
      title: 'Field-level security for Customer Tier',
      files: {
        [`${D}/permissionsets/Sales_User.permissionset-meta.xml`]: permset('Sales User', fieldPerm('Account.Customer_Tier__c', true, false) + fieldPerm('Account.Tier_Legacy__c', true, true)),
        [`${D}/permissionsets/Integration_User.permissionset-meta.xml`]: permset('ERP Integration User', fieldPerm('Account.Customer_Tier__c', true, revised) + fieldPerm('Account.Tier_Legacy__c', true, true)),
      },
    },
    {
      key: 'erp-sync',
      title: 'ERP sync writes Customer Tier',
      files: {
        'fleet.overlay.json': overlay(revised ? [{ field: 'CustomField:Account.Customer_Tier__c', direction: 'inbound' }] : [...legacyOnly, { field: 'CustomField:Account.Customer_Tier__c', direction: 'inbound' }]),
        [`${D}/classes/ErpAccountSync.cls`]: `public with sharing class ErpAccountSync {
    // Applies the tier sent by the ERP to the matching Accounts.
    public static void applyTiers(Map<Id, String> tierByAccount) {
        List<Account> updates = new List<Account>();
        for (Id accountId : tierByAccount.keySet()) {
            updates.add(new Account(Id = accountId, Customer_Tier__c = tierByAccount.get(accountId)));
        }
        update updates;
    }
}
`,
        [`${D}/classes/ErpAccountSync.cls-meta.xml`]: clsMeta,
        [`${D}/classes/ErpAccountSyncTest.cls`]: `@IsTest
private class ErpAccountSyncTest {
    @IsTest
    static void setsTheTier() {
        Account acc = new Account(Name = 'ERP Test');
        insert acc;
        ErpAccountSync.applyTiers(new Map<Id, String>{ acc.Id => 'Gold' });
        System.assertEquals('Gold', [SELECT Customer_Tier__c FROM Account WHERE Id = :acc.Id].Customer_Tier__c);
    }
}
`,
        [`${D}/classes/ErpAccountSyncTest.cls-meta.xml`]: clsMeta,
      },
    },
    {
      key: 'tier-report',
      title: revised ? 'Report by Customer Tier; deprecate the legacy field' : 'Report by Customer Tier and retire the legacy field',
      files: revised
        ? {
            [`${D}/reports/Sales_Reports/Accounts_By_Tier.report-meta.xml`]: report('Account.Customer_Tier__c'),
            [`${D}/objects/Account/fields/Tier_Legacy__c.field-meta.xml`]: textField('Tier_Legacy__c', 'Tier (Legacy - deprecated)', 'Deprecated: use Customer_Tier__c'),
          }
        : {
            [`${D}/reports/Sales_Reports/Accounts_By_Tier.report-meta.xml`]: report('Account.Customer_Tier__c'),
            [`${D}/permissionsets/Sales_User.permissionset-meta.xml`]: permset('Sales User', ''),
            [`${D}/objects/Account/fields/Tier_Legacy__c.field-meta.xml`]: null,
          },
    },
  ];
}
