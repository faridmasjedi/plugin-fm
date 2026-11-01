// History and jobs for the demo (after seed-more.apex): invoices change status (Invoice history), the overdue batch
// is scheduled every night and runs once now (Develop › Jobs).
List<Invoice__c> invoices = [SELECT Id, Status__c, Amount__c FROM Invoice__c WHERE Status__c = 'Draft' ORDER BY Name LIMIT 8];
for (Invoice__c i : invoices) i.Status__c = 'Sent';
update invoices;
for (Invoice__c i : invoices) i.Amount__c = i.Amount__c + 250;
update invoices;
if ([SELECT COUNT() FROM CronTrigger WHERE CronJobDetail.Name = 'Invoice overdue nightly'] == 0)
    System.schedule('Invoice overdue nightly', '0 0 2 * * ?', new InvoiceOverdueBatch());
Database.executeBatch(new InvoiceOverdueBatch(), 50);
System.debug('Changed ' + invoices.size() + ' invoices; scheduled and started the overdue batch');
