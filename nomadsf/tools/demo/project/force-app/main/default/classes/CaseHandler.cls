/** New cases from Gold customers start as High priority. */
public with sharing class CaseHandler {
    public static void beforeInsert(List<Case> cases) {
        Set<Id> accountIds = new Set<Id>();
        for (Case c : cases) if (c.AccountId != null) accountIds.add(c.AccountId);
        Map<Id, Account> accounts = new Map<Id, Account>([SELECT Customer_Tier__c FROM Account WHERE Id IN :accountIds]);
        for (Case c : cases) {
            Account a = accounts.get(c.AccountId);
            if (a != null && a.Customer_Tier__c == 'Gold' && c.Priority != 'High') c.Priority = 'High';
        }
    }
}
