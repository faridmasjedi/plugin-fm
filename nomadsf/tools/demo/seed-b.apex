// Made-up demo data for the NomadSF guide recordings (run in a demo scratch org only).
List<String> names = new List<String>{ 'Acme Corp', 'Globex', 'Initech', 'Umbrella Health', 'Stark Industries', 'Wayne Enterprises', 'Wonka Foods', 'Cyberdyne Systems', 'Hooli', 'Soylent Partners', 'Tyrell Labs', 'Vandelay Imports' };
List<String> industries = new List<String>{ 'Manufacturing', 'Energy', 'Technology', 'Healthcare', 'Manufacturing', 'Finance', 'Food & Beverage', 'Technology', 'Technology', 'Consulting', 'Biotechnology', 'Retail' };
List<Decimal> revenue = new List<Decimal>{ 25000000, 8000000, 1200000, 40000000, 90000000, 60000000, 3000000, 15000000, 70000000, 900000, 5500000, 400000 };
List<String> cities = new List<String>{ 'Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide', 'Sydney', 'Hobart', 'Canberra', 'Melbourne', 'Darwin', 'Sydney', 'Brisbane' };
List<Account> accounts = new List<Account>();
for (Integer i = 0; i < names.size(); i++) {
    accounts.add(new Account(
        Name = names[i], Industry = industries[i], AnnualRevenue = revenue[i], BillingCity = cities[i], BillingCountry = 'Australia',
        Phone = '+61 2 5550 ' + String.valueOf(1000 + i * 37), Website = 'https://' + names[i].toLowerCase().replace(' ', '') + '.example.com',
        NumberOfEmployees = 50 + i * 230));
}
AccountService.setTier(accounts);
insert accounts;
// A branch under Acme
insert new Account(Name = 'Acme Corp — North', ParentId = accounts[0].Id, Industry = 'Manufacturing', BillingCity = 'Newcastle', BillingCountry = 'Australia');

List<String> first = new List<String>{ 'Ann', 'Bob', 'Chen', 'Dina', 'Eli', 'Fatima', 'Gus', 'Hana', 'Ivan', 'Jade', 'Kofi', 'Lena' };
List<String> last = new List<String>{ 'Lee', 'Ray', 'Wu', 'Patel', 'Novak', 'Haddad', 'Moreno', 'Sato', 'Petrov', 'Nguyen', 'Mensah', 'Fischer' };
List<String> titles = new List<String>{ 'CFO', 'IT Manager', 'Buyer', 'Head of Operations' };
List<Contact> contacts = new List<Contact>();
for (Integer i = 0; i < accounts.size(); i++) {
    for (Integer k = 0; k < 2 + Math.mod(i, 3); k++) {
        Integer n = Math.mod(i * 3 + k, first.size());
        contacts.add(new Contact(
            AccountId = accounts[i].Id, FirstName = first[n], LastName = last[Math.mod(n + i, last.size())],
            Title = titles[Math.mod(k + i, titles.size())], Email = first[n].toLowerCase() + '.' + last[Math.mod(n + i, last.size())].toLowerCase() + '@' + names[i].toLowerCase().replace(' ', '') + '.example.com',
            Phone = '+61 4 5550 ' + String.valueOf(2000 + i * 11 + k), Salary__c = 70000 + Math.mod(i * 7919 + k * 104729, 90000)));
    }
}
insert contacts;

List<String> subjects = new List<String>{ 'Invoice does not match the order', 'Cannot log in to the portal', 'Delivery is late', 'Request a quote for 500 units', 'Product arrived damaged', 'Change of billing address' };
List<String> priorities = new List<String>{ 'Low', 'Medium', 'High' };
List<Case> cases = new List<Case>();
for (Integer i = 0; i < contacts.size(); i += 2) {
    Contact c = contacts[i];
    cases.add(new Case(AccountId = c.AccountId, ContactId = c.Id, Subject = subjects[Math.mod(i, subjects.size())], Priority = priorities[Math.mod(i, 3)], Status = Math.mod(i, 4) == 0 ? 'Closed' : 'New', Origin = 'Email'));
}
insert cases;

List<String> stages = new List<String>{ 'Prospecting', 'Qualification', 'Proposal/Price Quote', 'Negotiation/Review', 'Closed Won' };
List<Opportunity> opps = new List<Opportunity>();
for (Integer i = 0; i < accounts.size(); i++) {
    opps.add(new Opportunity(AccountId = accounts[i].Id, Name = names[i] + ' — renewal', StageName = stages[Math.mod(i, stages.size())], CloseDate = Date.today().addDays(15 + i * 9), Amount = 20000 + i * 7500));
}
insert opps;
System.debug('Seeded ' + accounts.size() + ' accounts, ' + contacts.size() + ' contacts, ' + cases.size() + ' cases, ' + opps.size() + ' opportunities');
