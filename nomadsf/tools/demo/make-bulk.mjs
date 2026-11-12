// A big, made-up set of metadata for testing NomadSF on a project and org of real size: permission sets, permission
// set groups, Apex classes with tests, objects with fields, custom labels, custom permissions and LWCs, written to
// <project>/force-app/main/bulk. Variant "a" is what the orgs get; variant "b" is the same with changes (some
// changed, some removed, some new), so every compare has same, different, only on one side.
//
//   node tools/demo/make-bulk.mjs <project folder> [--size small|medium|big] [--variant a|b]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const project = args.find((a) => !a.startsWith('--'));
if (!project) throw new Error('Usage: node make-bulk.mjs <project folder> [--size medium] [--variant a|b]');
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
// An org holds at most 1,000 permission sets (all of them, yours included): medium fits; big is for projects only
const SIZES = {
  small: { sets: 200, services: 40, objects: 6, groups: 10, labels: 60, perms: 10, lwcs: 4 },
  medium: { sets: 900, services: 100, objects: 15, groups: 40, labels: 200, perms: 30, lwcs: 10 },
  big: { sets: 4000, services: 200, objects: 30, groups: 80, labels: 400, perms: 60, lwcs: 20 },
};
const size = SIZES[opt('size', 'medium')];
if (!size) throw new Error('--size is small, medium or big');
const b = opt('variant', 'a') === 'b';
const API = '62.0';
const NS = 'http://soap.sforce.com/2006/04/metadata';
const root = join(project, 'force-app/main/bulk');
const pad = (n, w) => String(n).padStart(w, '0');
const write = (path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const xml = (tag, body) => `<?xml version="1.0" encoding="UTF-8"?>\n<${tag} xmlns="${NS}">\n${body}\n</${tag}>\n`;
const range = (from, to) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

rmSync(root, { recursive: true, force: true });

// In variant b: what is removed (only in the org), what is new (only in the project), what is changed
const removedSets = new Set(range(size.sets - Math.round(size.sets * 0.05) + 1, size.sets));
const newSets = range(size.sets + 1, size.sets + Math.round(size.sets * 0.05));
const sets = b ? [...range(1, size.sets).filter((n) => !removedSets.has(n)), ...newSets] : range(1, size.sets);
const keptServices = Math.round(size.services * 0.9); // permission sets only point at these (never removed)
const removedServices = new Set(b ? range(size.services - 1, size.services) : []);
const services = [
  ...range(1, size.services).filter((n) => !removedServices.has(n)),
  ...(b ? range(size.services + 1, size.services + 4) : []),
];
const keptLabels = Math.round(size.labels / 2); // classes only use these
const objects = range(1, size.objects);
const obj = (n) => `Bulk_Item_${pad(n, 2)}__c`;

// ---------- objects and fields ----------
const FIELDS = [
  ['Code__c', 'Code', '<type>Text</type>\n    <length>40</length>'],
  ['Amount__c', 'Amount', '<type>Currency</type>\n    <precision>16</precision>\n    <scale>2</scale>'],
  ['Quantity__c', 'Quantity', '<type>Number</type>\n    <precision>9</precision>\n    <scale>0</scale>'],
  [
    'Status__c',
    'Status',
    `<type>Picklist</type>\n    <valueSet>\n        <restricted>true</restricted>\n        <valueSetDefinition>\n${[
      'New',
      'Active',
      'On Hold',
      'Closed',
    ]
      .map(
        (v) =>
          `            <value>\n                <fullName>${v}</fullName>\n                <default>false</default>\n                <label>${v}</label>\n            </value>`
      )
      .join('\n')}\n            <sorted>false</sorted>\n        </valueSetDefinition>\n    </valueSet>`,
  ],
  ['Due_Date__c', 'Due date', '<type>Date</type>'],
  ['Active__c', 'Active', '<type>Checkbox</type>\n    <defaultValue>false</defaultValue>'],
  ['Contact_Email__c', 'Contact e-mail', '<type>Email</type>'],
  ['Notes__c', 'Notes', '<type>LongTextArea</type>\n    <length>4000</length>\n    <visibleLines>3</visibleLines>'],
  ['Rate__c', 'Rate', '<type>Percent</type>\n    <precision>5</precision>\n    <scale>2</scale>'],
];
for (const n of objects) {
  const name = obj(n);
  write(
    `objects/${name}/${name}.object-meta.xml`,
    xml(
      'CustomObject',
      `    <deploymentStatus>Deployed</deploymentStatus>
    <description>Made-up test object ${pad(n, 2)} (NomadSF bulk set).</description>
    <enableActivities>false</enableActivities>
    <enableReports>true</enableReports>
    <enableSearch>true</enableSearch>
    <label>Bulk Item ${pad(n, 2)}</label>
    <nameField>
        <label>Bulk Item Name</label>
        <type>Text</type>
    </nameField>
    <pluralLabel>Bulk Items ${pad(n, 2)}</pluralLabel>
    <sharingModel>ReadWrite</sharingModel>`
    )
  );
  for (const [field, label, type] of FIELDS) {
    const changed = b && n === 3 && field === 'Notes__c';
    write(
      `objects/${name}/fields/${field}.field-meta.xml`,
      xml(
        'CustomField',
        `    <fullName>${field}</fullName>
    <label>${changed ? 'Internal notes' : label}</label>
    ${type}${
          field === 'Code__c' || field === 'Contact_Email__c' || field === 'Quantity__c'
            ? '\n    <required>false</required>'
            : ''
        }`
      )
    );
  }
  write(
    `objects/${name}/fields/Account__c.field-meta.xml`,
    xml(
      'CustomField',
      `    <fullName>Account__c</fullName>
    <deleteConstraint>SetNull</deleteConstraint>
    <label>Account</label>
    <referenceTo>Account</referenceTo>
    <relationshipLabel>Bulk Items ${pad(n, 2)}</relationshipLabel>
    <relationshipName>Bulk_Items_${pad(n, 2)}</relationshipName>
    <type>Lookup</type>`
    )
  );
  // Variant b: a new field on the first two objects
  if (b && n <= 2)
    write(
      `objects/${name}/fields/Priority__c.field-meta.xml`,
      xml(
        'CustomField',
        `    <fullName>Priority__c</fullName>
    <label>Priority</label>
    <type>Number</type>
    <precision>3</precision>
    <scale>0</scale>`
      )
    );
}

// ---------- custom labels and permissions ----------
const labels = b ? [...range(1, size.labels - 20), ...range(size.labels + 1, size.labels + 20)] : range(1, size.labels);
write(
  'labels/CustomLabels.labels-meta.xml',
  xml(
    'CustomLabels',
    labels
      .map(
        (n) => `    <labels>
        <fullName>Bulk_Label_${pad(n, 3)}</fullName>
        <language>en_US</language>
        <protected>false</protected>
        <shortDescription>Bulk label ${pad(n, 3)}</shortDescription>
        <value>${b && n <= 20 ? `Bulk text ${n} (changed)` : `Bulk text ${n}`}</value>
    </labels>`
      )
      .join('\n')
  )
);
for (const n of range(1, size.perms))
  write(
    `customPermissions/Bulk_Perm_${pad(n, 2)}.customPermission-meta.xml`,
    xml('CustomPermission', `    <isLicensed>false</isLicensed>\n    <label>Bulk permission ${pad(n, 2)}</label>`)
  );

// ---------- Apex: services (each on one object, some calling another) and their tests ----------
const META = (tag) => xml(tag, `    <apiVersion>${API}</apiVersion>\n    <status>Active</status>`);
const objOfService = (n) => obj(((n - 1) % size.objects) + 1);
for (const n of services) {
  const o = objOfService(n);
  const changed = b && n % 10 === 3;
  const calls = n % 10 === 0 && n > 1 && !removedServices.has(n - 1) ? n - 1 : undefined;
  write(
    `classes/BulkService${pad(n, 3)}.cls`,
    `/** Bulk test service ${pad(n, 3)}: totals of ${o}. */
public with sharing class BulkService${pad(n, 3)} {
    public static Decimal total(List<${o}> items) {
        Decimal sum = 0;
        for (${o} item : items) {
            if (item.Amount__c != null) sum += item.Amount__c;
        }
        return sum;
    }

    public static Integer countActive(List<${o}> items) {
        Integer n = 0;
        for (${o} item : items) {
            if (item.Active__c) n++;
        }
        return n;
    }

    public static String title() {
        return System.Label.Bulk_Label_${pad(((n - 1) % keptLabels) + 1, 3)};
    }${
      calls
        ? `

    public static Decimal totalWithPrevious(List<${objOfService(calls)}> previous, List<${o}> items) {
        return BulkService${pad(calls, 3)}.total(previous) + total(items);
    }`
        : ''
    }${
      changed
        ? `

    public static Decimal average(List<${o}> items) {
        return items.isEmpty() ? 0 : total(items) / items.size();
    }`
        : ''
    }
}
`
  );
  write(`classes/BulkService${pad(n, 3)}.cls-meta.xml`, META('ApexClass'));
}
// One test class for each two services
const testOf = (n) => Math.ceil(n / 2);
for (const t of [...new Set(services.map(testOf))]) {
  const covered = services.filter((n) => testOf(n) === t);
  write(
    `classes/BulkService${pad(t, 3)}Test.cls`,
    `@IsTest
private class BulkService${pad(t, 3)}Test {
${covered
  .map((n) => {
    const o = objOfService(n);
    return `    @IsTest
    static void service${pad(n, 3)}() {
        List<${o}> items = new List<${o}>{
            new ${o}(Name = 'A', Amount__c = 10, Active__c = true),
            new ${o}(Name = 'B', Amount__c = 5, Active__c = false)
        };
        System.assertEquals(15, BulkService${pad(n, 3)}.total(items));
        System.assertEquals(1, BulkService${pad(n, 3)}.countActive(items));
        System.assertNotEquals(null, BulkService${pad(n, 3)}.title());
    }`;
  })
  .join('\n\n')}
}
`
  );
  write(`classes/BulkService${pad(t, 3)}Test.cls-meta.xml`, META('ApexClass'));
}

// ---------- permission sets and groups ----------
for (const n of sets) {
  const changed = b && n % 10 === 0 && n <= size.sets;
  const objs = [((n - 1) % size.objects) + 1, ((n + 6) % size.objects) + 1].filter((v, i, a) => a.indexOf(v) === i);
  const fields = changed ? ['Amount__c', 'Status__c', 'Due_Date__c'] : ['Amount__c', 'Status__c'];
  const classes = [((n - 1) % keptServices) + 1, ((n + 40) % keptServices) + 1].filter((v, i, a) => a.indexOf(v) === i);
  const body = [
    ...classes.map(
      (c) =>
        `    <classAccesses>\n        <apexClass>BulkService${pad(
          c,
          3
        )}</apexClass>\n        <enabled>true</enabled>\n    </classAccesses>`
    ),
    ...(n % 5 === 0
      ? [
          `    <customPermissions>\n        <enabled>true</enabled>\n        <name>Bulk_Perm_${pad(
            ((n / 5 - 1) % size.perms) + 1,
            2
          )}</name>\n    </customPermissions>`,
        ]
      : []),
    `    <description>Made-up test permission set ${pad(n, 4)}${changed ? ' (changed)' : ''}.</description>`,
    ...objs.flatMap((o) =>
      fields.map(
        (f) =>
          `    <fieldPermissions>\n        <editable>${
            f !== 'Amount__c' || n % 2 === 0
          }</editable>\n        <field>${obj(
            o
          )}.${f}</field>\n        <readable>true</readable>\n    </fieldPermissions>`
      )
    ),
    '    <hasActivationRequired>false</hasActivationRequired>',
    `    <label>Bulk Access ${pad(n, 4)}${changed ? ' v2' : ''}</label>`,
    ...objs.map(
      (o) =>
        `    <objectPermissions>\n        <allowCreate>${
          n % 3 !== 0
        }</allowCreate>\n        <allowDelete>false</allowDelete>\n        <allowEdit>${
          n % 3 !== 0
        }</allowEdit>\n        <allowRead>true</allowRead>\n        <modifyAllRecords>false</modifyAllRecords>\n        <object>${obj(
          o
        )}</object>\n        <viewAllRecords>false</viewAllRecords>\n    </objectPermissions>`
    ),
  ];
  write(`permissionsets/Bulk_PS_${pad(n, 4)}.permissionset-meta.xml`, xml('PermissionSet', body.join('\n')));
}
// Full access to every bulk object and field, for the admin who seeds the records (anonymous Apex needs it)
write(
  'permissionsets/Bulk_Admin.permissionset-meta.xml',
  xml(
    'PermissionSet',
    [
      '    <description>Everything on the bulk objects (to seed and test them).</description>',
      ...objects.flatMap((o) =>
        [...FIELDS.map(([f]) => f), 'Account__c', ...(b && o <= 2 ? ['Priority__c'] : [])].map(
          (f) =>
            `    <fieldPermissions>\n        <editable>true</editable>\n        <field>${obj(
              o
            )}.${f}</field>\n        <readable>true</readable>\n    </fieldPermissions>`
        )
      ),
      '    <hasActivationRequired>false</hasActivationRequired>',
      '    <label>Bulk Admin</label>',
      ...objects.map(
        (o) =>
          `    <objectPermissions>\n        <allowCreate>true</allowCreate>\n        <allowDelete>true</allowDelete>\n        <allowEdit>true</allowEdit>\n        <allowRead>true</allowRead>\n        <modifyAllRecords>true</modifyAllRecords>\n        <object>${obj(
            o
          )}</object>\n        <viewAllRecords>true</viewAllRecords>\n    </objectPermissions>`
      ),
    ].join('\n')
  )
);
const setNames = new Set(sets);
const groups = b ? [...range(1, size.groups - 1), size.groups + 1] : range(1, size.groups);
for (const g of groups) {
  const start = ((g - 1) * 20) % size.sets;
  const members = range(start + 1, start + (b && g <= 5 ? 12 : 10)).filter((n) => setNames.has(n));
  write(
    `permissionsetgroups/Bulk_Group_${pad(g, 2)}.permissionsetgroup-meta.xml`,
    xml(
      'PermissionSetGroup',
      `    <description>Made-up test group ${pad(g, 2)}.</description>
    <hasActivationRequired>false</hasActivationRequired>
    <label>Bulk Group ${pad(g, 2)}</label>
${members.map((n) => `    <permissionSets>Bulk_PS_${pad(n, 4)}</permissionSets>`).join('\n')}
    <status>Updated</status>`
    )
  );
}

// ---------- LWCs ----------
const lwcs = b ? range(1, size.lwcs + 1) : range(1, size.lwcs);
for (const n of lwcs) {
  const name = `bulkCard${pad(n, 2)}`;
  write(
    `lwc/${name}/${name}.html`,
    `<template>\n    <lightning-card title="Bulk card ${pad(n, 2)}">\n        <p class="slds-p-horizontal_small">${
      b && n === 1 ? 'Changed text of bulk card 01' : `Text of bulk card ${pad(n, 2)}`
    }</p>\n    </lightning-card>\n</template>\n`
  );
  write(
    `lwc/${name}/${name}.js`,
    `import { LightningElement, api } from 'lwc';\n\nexport default class BulkCard${pad(
      n,
      2
    )} extends LightningElement {\n    @api recordId;\n}\n`
  );
  write(
    `lwc/${name}/${name}.js-meta.xml`,
    xml(
      'LightningComponentBundle',
      `    <apiVersion>${API}</apiVersion>\n    <isExposed>true</isExposed>\n    <targets>\n        <target>lightning__RecordPage</target>\n    </targets>`
    )
  );
}

console.log(
  `${b ? 'Variant b' : 'Variant a'} in ${root}: ${sets.length} permission sets, ${groups.length} groups, ${
    services.length
  } services + ${new Set(services.map(testOf)).size} tests, ${objects.length} objects, ${labels.length} labels, ${
    size.perms
  } custom permissions, ${lwcs.length} LWCs`
);
