// After sharing-1-private and sharing-2-rules: Bob (role Support Lead) owns a few invoices, so the owner rule shares
// them with Sales Leads (Dina) and Who can see has a real answer to explain
User bob = [SELECT Id FROM User WHERE FirstName = 'Bob' AND IsActive = true LIMIT 1];
List<Invoice__c> some = [SELECT Id FROM Invoice__c WHERE Status__c = 'Sent' AND OwnerId != :bob.Id ORDER BY Name LIMIT 5];
for (Invoice__c i : some) i.OwnerId = bob.Id;
update some;
System.debug('Bob owns ' + [SELECT COUNT() FROM Invoice__c WHERE OwnerId = :bob.Id] + ' invoice(s).');
