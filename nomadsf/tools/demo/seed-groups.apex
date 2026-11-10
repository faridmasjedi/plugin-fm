// Roles for some users, and groups and roles inside groups and queues (Access › Groups & queues shows who is in them).
// Its own roles: the org's sample roles cannot be given to these users.
Map<String, UserRole> roles = new Map<String, UserRole>();
for (UserRole r : [SELECT Id, DeveloperName, ParentRoleId FROM UserRole WHERE DeveloperName IN ('Support_Manager', 'Support_Lead')]) roles.put(r.DeveloperName, r);
if (!roles.containsKey('Support_Manager')) {
  UserRole m = new UserRole(Name = 'Support Manager', DeveloperName = 'Support_Manager');
  insert m;
  roles.put('Support_Manager', m);
}
if (!roles.containsKey('Support_Lead')) {
  UserRole l = new UserRole(Name = 'Support Lead', DeveloperName = 'Support_Lead');
  insert l;
  roles.put('Support_Lead', l);
}
UserRole lead = roles.get('Support_Lead');
if (lead.ParentRoleId != roles.get('Support_Manager').Id) {
  lead.ParentRoleId = roles.get('Support_Manager').Id;
  update lead;
}
Map<String, User> users = new Map<String, User>();
for (User u : [SELECT Id, FirstName FROM User WHERE FirstName IN ('Dina', 'Chen', 'Bob') AND IsActive = true]) users.put(u.FirstName, u);
users.get('Dina').UserRoleId = roles.get('Support_Manager').Id;
users.get('Chen').UserRoleId = roles.get('Support_Lead').Id;
users.get('Bob').UserRoleId = roles.get('Support_Lead').Id;
update users.values();
System.debug('Roles set.');
