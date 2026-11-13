if ([SELECT COUNT() FROM Account WHERE Name = 'Northwind Traders'] == 0) {
  Account a = new Account(Name = 'Northwind Traders', Industry = 'Retail', Phone = '+61 2 5550 4400');
  insert a;
  insert new List<Contact>{
    new Contact(AccountId = a.Id, FirstName = 'Mia', LastName = 'Chen', Email = 'mia.chen@northwind.example.com'),
    new Contact(AccountId = a.Id, FirstName = 'Leo', LastName = 'Park', Email = 'leo.park@northwind.example.com')
  };
  insert new Case(AccountId = a.Id, Subject = 'Late delivery to the Sydney store', Status = 'New', Origin = 'Email');
}
