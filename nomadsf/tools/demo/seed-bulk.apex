// Made-up records for the bulk objects of make-bulk.mjs: PER_OBJECT rows in each of OBJECTS objects, linked to
// existing accounts. Run with the placeholders replaced, e.g.:
//   sed -e s/PER_OBJECT/100/ -e s/OBJECTS/15/ seed-bulk.apex > /tmp/b.apex && sf apex run -o <org> -f /tmp/b.apex
Integer perObject = PER_OBJECT;
Integer objectCount = OBJECTS;
List<Account> accounts = [SELECT Id FROM Account ORDER BY Name LIMIT 50];
List<String> statuses = new List<String>{ 'New', 'Active', 'On Hold', 'Closed' };
Integer total = 0;
for (Integer o = 1; o <= objectCount; o++) {
    String name = 'Bulk_Item_' + (o < 10 ? '0' : '') + o + '__c';
    Schema.SObjectType t = Schema.getGlobalDescribe().get(name);
    if (t == null) continue;
    List<SObject> rows = new List<SObject>();
    for (Integer i = 1; i <= perObject; i++) {
        SObject r = t.newSObject();
        r.put('Name', 'Item ' + o + '-' + i);
        r.put('Code__c', 'B' + o + '-' + i);
        r.put('Amount__c', Decimal.valueOf(Math.mod(i * 7919 + o * 31, 10000)) / 10);
        r.put('Quantity__c', Math.mod(i * 13 + o, 200));
        r.put('Status__c', statuses[Math.mod(i + o, statuses.size())]);
        r.put('Due_Date__c', Date.today().addDays(Math.mod(i * 17, 120) - 60));
        r.put('Active__c', Math.mod(i, 3) != 0);
        r.put('Contact_Email__c', 'item' + o + '.' + i + '@bulk.example.com');
        r.put('Rate__c', Math.mod(i * 7, 100));
        if (Math.mod(i, 4) == 0) r.put('Notes__c', 'Made-up note for item ' + o + '-' + i + '.');
        if (!accounts.isEmpty()) r.put('Account__c', accounts[Math.mod(i, accounts.size())].Id);
        rows.add(r);
    }
    insert rows;
    total += rows.size();
}
System.debug('Inserted ' + total + ' bulk record(s).');
