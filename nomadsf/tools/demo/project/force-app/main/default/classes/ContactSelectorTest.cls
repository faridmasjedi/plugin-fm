@IsTest
private class ContactSelectorTest {
    @IsTest
    static void findsTheContactsOfAnAccount() {
        Account a = new Account(Name = 'Test account');
        insert a;
        insert new Contact(LastName = 'Lee', AccountId = a.Id);
        System.assertEquals(1, ContactSelector.byAccount(new Set<Id>{ a.Id }).size());
    }
}