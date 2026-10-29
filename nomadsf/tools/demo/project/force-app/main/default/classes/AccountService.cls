/** Customer tiers of accounts. */
public with sharing class AccountService {
    public static void setTier(List<Account> accounts) {
        for (Account a : accounts) {
            if (a.AnnualRevenue == null) continue;
            a.Customer_Tier__c = a.AnnualRevenue >= 10000000 ? 'Gold' : a.AnnualRevenue >= 1000000 ? 'Silver' : 'Bronze';
        }
    }
}
