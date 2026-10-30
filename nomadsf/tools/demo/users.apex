// Made-up users for the demo org, with permission sets, a group and a queue (DOMAIN is replaced per org).
String domain = 'DOMAIN';
Map<String, Id> profiles = new Map<String, Id>();
for (Profile p : [SELECT Id, Name FROM Profile WHERE Name IN ('Standard User', 'Standard Platform User', 'Chatter Free User')]) profiles.put(p.Name, p.Id);
List<List<String>> people = new List<List<String>>{
    new List<String>{ 'Ann', 'Lee', 'Sales Manager', 'Standard User' },
    new List<String>{ 'Bob', 'Ray', 'Account Executive', 'Standard Platform User' },
    new List<String>{ 'Chen', 'Wu', 'Sales Rep', 'Standard Platform User' },
    new List<String>{ 'Dina', 'Patel', 'Finance Analyst', 'Standard Platform User' },
    new List<String>{ 'Eli', 'Novak', 'Intern', 'Chatter Free User' }
};
List<User> users = new List<User>();
for (List<String> p : people) {
    String alias = (p[0].left(1) + p[1]).toLowerCase().left(8);
    users.add(new User(FirstName = p[0], LastName = p[1], Title = p[2], ProfileId = profiles.get(p[3]),
        Username = p[0].toLowerCase() + '.' + p[1].toLowerCase() + '@' + domain, Email = p[0].toLowerCase() + '.' + p[1].toLowerCase() + '@example.com',
        Alias = alias, TimeZoneSidKey = 'Australia/Sydney', LocaleSidKey = 'en_AU', EmailEncodingKey = 'UTF-8', LanguageLocaleKey = 'en_US'));
}
insert users;
Map<String, Id> sets = new Map<String, Id>();
for (PermissionSet s : [SELECT Id, Name FROM PermissionSet WHERE Name IN ('Sales_Ops', 'Support_Agent', 'Finance_Read')]) sets.put(s.Name, s.Id);
Id team = [SELECT Id FROM PermissionSetGroup WHERE DeveloperName = 'Sales_Team' LIMIT 1].Id;
List<PermissionSetAssignment> assigns = new List<PermissionSetAssignment>{
    new PermissionSetAssignment(AssigneeId = users[0].Id, PermissionSetGroupId = team),
    new PermissionSetAssignment(AssigneeId = users[1].Id, PermissionSetId = sets.get('Sales_Ops')),
    new PermissionSetAssignment(AssigneeId = users[2].Id, PermissionSetId = sets.get('Sales_Ops'))
};
if (sets.containsKey('Finance_Read')) assigns.add(new PermissionSetAssignment(AssigneeId = users[3].Id, PermissionSetId = sets.get('Finance_Read')));
insert assigns;
Id queue = [SELECT Id FROM Group WHERE DeveloperName = 'Tier_1_Support' LIMIT 1].Id;
Id grp = [SELECT Id FROM Group WHERE DeveloperName = 'Support_Team' LIMIT 1].Id;
insert new List<GroupMember>{
    new GroupMember(GroupId = queue, UserOrGroupId = users[1].Id), new GroupMember(GroupId = queue, UserOrGroupId = users[2].Id),
    new GroupMember(GroupId = grp, UserOrGroupId = users[1].Id), new GroupMember(GroupId = grp, UserOrGroupId = users[0].Id)
};
System.debug('Users created');
