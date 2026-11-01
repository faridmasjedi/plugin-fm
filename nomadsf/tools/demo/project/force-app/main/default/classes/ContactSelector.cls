/** Contacts of accounts, as the other classes need them. */
public with sharing class ContactSelector {
    public static List<Contact> byAccount(Set<Id> accountIds) {
        return [SELECT Id, Name, Email, Title, AccountId FROM Contact WHERE AccountId IN :accountIds ORDER BY Name];
    }
}