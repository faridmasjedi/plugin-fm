/** Every night: invoices past their due date become Overdue. */
public with sharing class InvoiceOverdueBatch implements Database.Batchable<SObject>, Schedulable {
    public Database.QueryLocator start(Database.BatchableContext context) {
        return Database.getQueryLocator(
            [SELECT Id, Status__c, Due_Date__c FROM Invoice__c WHERE Status__c = 'Sent' AND Due_Date__c < TODAY]
        );
    }

    public void execute(Database.BatchableContext context, List<Invoice__c> invoices) {
        update InvoiceService.markOverdue(invoices);
    }

    public void finish(Database.BatchableContext context) {
    }

    public void execute(SchedulableContext context) {
        Database.executeBatch(new InvoiceOverdueBatch(), 200);
    }
}