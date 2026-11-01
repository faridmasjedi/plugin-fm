// A small git repository for the release videos (Compare & package, Release › Project): `main` is the demo
// project as deployed to the demo orgs, `feature/vip-discount` changes a class, adds a class with its test, a
// field and custom labels, and deletes a validation rule. Run: node tools/demo/make-repo.mjs → .recordings/acme-project
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = join(here, '.recordings', 'acme-project');
const app = join(repo, 'force-app/main/default');
const git = (...args) =>
  execFileSync('git', ['-c', 'user.name=Alex Morgan', '-c', 'user.email=alex@acme.example.com', ...args], {
    cwd: repo,
  });
const write = (path, text) => {
  mkdirSync(dirname(join(app, path)), { recursive: true });
  writeFileSync(join(app, path), text);
};
const META = (tag) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<${tag} xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>62.0</apiVersion>\n    <status>Active</status>\n</${tag}>\n`;

rmSync(repo, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });
cpSync(join(here, 'project'), repo, { recursive: true, filter: (p) => !/\/\.sfd?x?(\/|$)/.test(p) });
writeFileSync(join(repo, '.forceignore'), '**/jsconfig.json\n**/.eslintrc.json\n');
git('init', '-q', '-b', 'main');
git('add', '.');
git('commit', '-q', '-m', 'Acme org as deployed');

git('checkout', '-q', '-b', 'feature/vip-discount');
write(
  'classes/AccountService.cls',
  `/** Customer tiers of accounts, and the discount each tier gets. */
public with sharing class AccountService {
    public static void setTier(List<Account> accounts) {
        for (Account a : accounts) {
            if (a.AnnualRevenue == null) continue;
            a.Customer_Tier__c = a.AnnualRevenue >= 10000000 ? 'Gold' : a.AnnualRevenue >= 1000000 ? 'Silver' : 'Bronze';
            a.Discount__c = DiscountService.forTier(a.Customer_Tier__c);
        }
    }
}
`
);
write(
  'classes/DiscountService.cls',
  `/** The discount of a customer tier, in percent. */
public with sharing class DiscountService {
    public static Decimal forTier(String tier) {
        switch on tier {
            when 'Gold' { return 15; }
            when 'Silver' { return 10; }
            when 'Bronze' { return 5; }
            when else { return 0; }
        }
    }
}
`
);
write('classes/DiscountService.cls-meta.xml', META('ApexClass'));
write(
  'classes/DiscountServiceTest.cls',
  `@IsTest
private class DiscountServiceTest {
    @IsTest
    static void tiersGetTheirDiscount() {
        System.assertEquals(15, DiscountService.forTier('Gold'));
        System.assertEquals(10, DiscountService.forTier('Silver'));
        System.assertEquals(5, DiscountService.forTier('Bronze'));
        System.assertEquals(0, DiscountService.forTier(null));
    }
}
`
);
write('classes/DiscountServiceTest.cls-meta.xml', META('ApexClass'));
write(
  'objects/Account/fields/Discount__c.field-meta.xml',
  `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Discount__c</fullName>
    <label>Discount</label>
    <type>Percent</type>
    <precision>5</precision>
    <scale>2</scale>
    <description>Set from the customer tier by AccountService.</description>
</CustomField>
`
);
write(
  'labels/CustomLabels.labels-meta.xml',
  `<?xml version="1.0" encoding="UTF-8"?>
<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">
    <labels>
        <fullName>VIP_Discount_Title</fullName>
        <language>en_US</language>
        <protected>false</protected>
        <shortDescription>VIP discount title</shortDescription>
        <value>Your VIP discount</value>
    </labels>
    <labels>
        <fullName>VIP_Discount_Help</fullName>
        <language>en_US</language>
        <protected>false</protected>
        <shortDescription>VIP discount help</shortDescription>
        <value>Gold customers get 15%, Silver 10%, Bronze 5%.</value>
    </labels>
</CustomLabels>
`
);
rmSync(join(app, 'objects/Case/validationRules/Subject_Required_When_High.validationRule-meta.xml'));
git('add', '-A');
git('commit', '-q', '-m', 'VIP discount by customer tier');
git('checkout', '-q', 'main');
console.log(`Demo repository: ${repo} (main, feature/vip-discount)`);
