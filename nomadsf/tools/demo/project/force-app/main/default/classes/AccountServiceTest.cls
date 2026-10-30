@IsTest
private class AccountServiceTest {
    @IsTest
    static void tiersFollowRevenue() {
        List<Account> accounts = new List<Account>{
            new Account(Name = 'Big', AnnualRevenue = 20000000),
            new Account(Name = 'Mid', AnnualRevenue = 2000000),
            new Account(Name = 'Small', AnnualRevenue = 50000)
        };
        AccountService.setTier(accounts);
        System.assertEquals('Gold', accounts[0].Customer_Tier__c);
        System.assertEquals('Silver', accounts[1].Customer_Tier__c);
        System.assertEquals('Bronze', accounts[2].Customer_Tier__c);
    }
}
