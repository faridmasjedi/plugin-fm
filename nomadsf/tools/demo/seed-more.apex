// More made-up demo data, after seed.apex (run in a demo scratch org only): more accounts with contacts,
// cases and opportunities, and invoices for every account. Then seed-access.apex (a separate run: Salesforce
// does not mix records and permission assignments in one).
List<String> names = new List<String>{ 'Aperture Science', 'Black Mesa', 'Duff Brewing', 'Gringotts', 'Initrode', 'Monarch Solutions', 'Nakatomi Trading', 'Oceanic Air', 'Pied Piper', 'Prestige Worldwide', 'Sterling Cooper', 'Virtucon' };
List<String> industries = new List<String>{ 'Technology', 'Energy', 'Food & Beverage', 'Finance', 'Technology', 'Consulting', 'Retail', 'Transportation', 'Technology', 'Media', 'Media', 'Manufacturing' };
List<String> cities = new List<String>{ 'Sydney', 'Perth', 'Melbourne', 'Brisbane', 'Adelaide', 'Canberra', 'Sydney', 'Gold Coast', 'Melbourne', 'Hobart', 'Sydney', 'Darwin' };
List<Account> accounts = new List<Account>();
for (Integer i = 0; i < names.size(); i++) {
    accounts.add(new Account(
        Name = names[i], Industry = industries[i], AnnualRevenue = 250000 + Math.mod(i * 7919, 13) * 2400000, BillingCity = cities[i], BillingCountry = 'Australia',
        Phone = '+61 3 5550 ' + String.valueOf(3000 + i * 41), Website = 'https://' + names[i].toLowerCase().replace(' ', '') + '.example.com',
        NumberOfEmployees = 20 + i * 140, Rating = Math.mod(i, 3) == 0 ? 'Hot' : Math.mod(i, 3) == 1 ? 'Warm' : 'Cold'));
}
AccountService.setTier(accounts);
insert accounts;

List<String> first = new List<String>{ 'Mia', 'Noah', 'Olivia', 'Pavel', 'Quinn', 'Rosa', 'Sam', 'Tara', 'Umar', 'Vera', 'Wen', 'Yusuf', 'Zoe', 'Arjun' };
List<String> last = new List<String>{ 'Brown', 'Costa', 'Dubois', 'Evans', 'Ferreira', 'Garcia', 'Hughes', 'Ito', 'Jansen', 'Kowalski', 'Larsen', 'Murphy', 'Okafor', 'Rossi' };
List<String> titles = new List<String>{ 'CEO', 'Procurement Lead', 'Office Manager', 'CTO', 'Accounts Payable' };
List<Contact> contacts = new List<Contact>();
for (Integer i = 0; i < accounts.size(); i++) {
    for (Integer k = 0; k < 3 + Math.mod(i, 2); k++) {
        Integer n = Math.mod(i * 5 + k, first.size());
        String lastName = last[Math.mod(n + i * 3, last.size())];
        contacts.add(new Contact(
            AccountId = accounts[i].Id, FirstName = first[n], LastName = lastName, Title = titles[Math.mod(k + i, titles.size())],
            Email = first[n].toLowerCase() + '.' + lastName.toLowerCase() + '@' + names[i].toLowerCase().replace(' ', '') + '.example.com',
            Phone = '+61 4 5551 ' + String.valueOf(4000 + i * 13 + k), Salary__c = 65000 + Math.mod(i * 6151 + k * 3571, 110000),
            LeadSource = Math.mod(k, 2) == 0 ? 'Web' : 'Partner Referral'));
    }
}
insert contacts;

List<String> subjects = new List<String>{ 'Invoice paid twice', 'Password reset does not arrive', 'Order shows the wrong address', 'Need a copy of the contract', 'Upgrade to the premium plan', 'Item missing from delivery', 'Cannot download the invoice PDF' };
List<String> statuses = new List<String>{ 'New', 'Working', 'Escalated', 'Closed' };
List<String> origins = new List<String>{ 'Email', 'Phone', 'Web' };
List<Case> cases = new List<Case>();
for (Integer i = 0; i < contacts.size(); i++) {
    if (Math.mod(i, 3) == 2) continue;
    Contact c = contacts[i];
    cases.add(new Case(AccountId = c.AccountId, ContactId = c.Id, Subject = subjects[Math.mod(i, subjects.size())], Priority = Math.mod(i, 5) == 0 ? 'High' : 'Medium',
        Status = statuses[Math.mod(i, statuses.size())], Origin = origins[Math.mod(i, origins.size())]));
}
insert cases;

List<String> stages = new List<String>{ 'Prospecting', 'Qualification', 'Proposal/Price Quote', 'Negotiation/Review', 'Closed Won', 'Closed Lost' };
List<Opportunity> opps = new List<Opportunity>();
for (Integer i = 0; i < accounts.size(); i++) {
    for (Integer k = 0; k < 2; k++) {
        opps.add(new Opportunity(AccountId = accounts[i].Id, Name = names[i] + (k == 0 ? ' — new licences' : ' — services'),
            StageName = stages[Math.mod(i + k * 2, stages.size())], CloseDate = Date.today().addDays(-20 + i * 11 + k * 30), Amount = 12000 + i * 5300 + k * 9000));
    }
}
insert opps;

// Invoices for every account (older ones paid, some overdue)
List<String> invoiceStatus = new List<String>{ 'Paid', 'Paid', 'Sent', 'Overdue', 'Draft' };
List<Invoice__c> invoices = new List<Invoice__c>();
Integer n = 0;
for (Account a : [SELECT Id FROM Account ORDER BY Name]) {
    for (Integer k = 0; k < 3; k++) {
        String status = invoiceStatus[Math.mod(n, invoiceStatus.size())];
        invoices.add(new Invoice__c(Account__c = a.Id, Amount__c = 1500 + Math.mod(n * 2777, 48000), Status__c = status,
            Due_Date__c = Date.today().addDays(status == 'Paid' ? -60 + k : status == 'Overdue' ? -12 - k : 14 + k * 7)));
        n++;
    }
}
insert invoices;

System.debug('Seeded ' + accounts.size() + ' accounts, ' + contacts.size() + ' contacts, ' + cases.size() + ' cases, ' + opps.size() + ' opportunities, ' + invoices.size() + ' invoices');
