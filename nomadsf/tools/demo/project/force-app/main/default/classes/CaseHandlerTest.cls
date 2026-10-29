@IsTest
private class CaseHandlerTest {
    @IsTest
    static void goldCustomersGetHighPriority() {
        Account gold = new Account(Name = 'Gold Co', Customer_Tier__c = 'Gold');
        insert gold;
        Case c = new Case(AccountId = gold.Id, Subject = 'Help', Priority = 'Medium');
        insert c;
        System.assertEquals('High', [SELECT Priority FROM Case WHERE Id = :c.Id].Priority);
    }
}
