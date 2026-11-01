/** The invoices of an account, for the accountInvoices component. */
public with sharing class InvoiceController {
    @AuraEnabled(cacheable=true)
    public static List<Invoice__c> getInvoices(Id accountId) {
        return [
            SELECT Id, Name, Amount__c, Status__c, Due_Date__c
            FROM Invoice__c
            WHERE Account__c = :accountId
            ORDER BY Due_Date__c DESC
            LIMIT 50
        ];
    }
}