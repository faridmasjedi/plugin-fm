/** Invoices past their due date, and what each account owes. */
public with sharing class InvoiceService {
    public static List<Invoice__c> markOverdue(List<Invoice__c> invoices) {
        List<Invoice__c> changed = new List<Invoice__c>();
        for (Invoice__c i : invoices) {
            if (i.Status__c == 'Sent' && i.Due_Date__c != null && i.Due_Date__c < Date.today()) {
                i.Status__c = 'Overdue';
                changed.add(i);
            }
        }
        return changed;
    }

    public static Map<Id, Decimal> owedByAccount(Set<Id> accountIds) {
        Map<Id, Decimal> owed = new Map<Id, Decimal>();
        for (AggregateResult r : [
            SELECT Account__c account, SUM(Amount__c) total
            FROM Invoice__c
            WHERE Account__c IN :accountIds AND Status__c IN ('Sent', 'Overdue')
            GROUP BY Account__c
        ]) {
            owed.put((Id) r.get('account'), (Decimal) r.get('total'));
        }
        return owed;
    }
}