@IsTest
private class InvoiceServiceTest {
    @TestSetup
    static void setup() {
        Account a = new Account(Name = 'Test account');
        insert a;
        insert new List<Invoice__c>{
            new Invoice__c(Account__c = a.Id, Amount__c = 100, Status__c = 'Sent', Due_Date__c = Date.today().addDays(-3)),
            new Invoice__c(Account__c = a.Id, Amount__c = 50, Status__c = 'Sent', Due_Date__c = Date.today().addDays(10)),
            new Invoice__c(Account__c = a.Id, Amount__c = 70, Status__c = 'Paid', Due_Date__c = Date.today().addDays(-20))
        };
    }

    @IsTest
    static void pastDueSentInvoicesBecomeOverdue() {
        List<Invoice__c> changed = InvoiceService.markOverdue([SELECT Status__c, Due_Date__c FROM Invoice__c]);
        System.assertEquals(1, changed.size());
        System.assertEquals('Overdue', changed[0].Status__c);
    }

    @IsTest
    static void owedCountsSentAndOverdue() {
        Id accountId = [SELECT Id FROM Account LIMIT 1].Id;
        System.assertEquals(150, InvoiceService.owedByAccount(new Set<Id>{ accountId }).get(accountId));
        System.assertEquals(3, InvoiceController.getInvoices(accountId).size());
    }

    @IsTest
    static void batchMarksOverdue() {
        Test.startTest();
        Database.executeBatch(new InvoiceOverdueBatch());
        Test.stopTest();
        System.assertEquals(1, [SELECT COUNT() FROM Invoice__c WHERE Status__c = 'Overdue']);
    }
}