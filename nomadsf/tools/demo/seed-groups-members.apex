// After seed-groups.apex: a "Sales Leads" group, and a group and a role (with subordinates) inside Support Team;
// a role inside the Tier 1 Support queue. Run on its own: setup changes to users and groups go in two runs.
List<Group> leads = [SELECT Id FROM Group WHERE DeveloperName = 'Sales_Leads' AND Type = 'Regular'];
Group salesLeads = leads.isEmpty() ? new Group(Name = 'Sales Leads', DeveloperName = 'Sales_Leads', Type = 'Regular') : leads[0];
if (leads.isEmpty()) insert salesLeads;
Map<String, Id> roleGroup = new Map<String, Id>();
for (Group g : [SELECT Id, Type, Related.Name FROM Group WHERE Type IN ('Role', 'RoleAndSubordinatesInternal') AND RelatedId IN (SELECT Id FROM UserRole WHERE DeveloperName IN ('Support_Manager', 'Support_Lead'))]) roleGroup.put(g.Type + ':' + g.Related.Name, g.Id);
Id dina = [SELECT Id FROM User WHERE FirstName = 'Dina' AND IsActive = true LIMIT 1].Id;
Id supportTeam = [SELECT Id FROM Group WHERE Name = 'Support Team' AND Type = 'Regular' LIMIT 1].Id;
Id tier1 = [SELECT Id FROM Group WHERE Name = 'Tier 1 Support' AND Type = 'Queue' LIMIT 1].Id;
Map<Id, List<Id>> wanted = new Map<Id, List<Id>>{
  salesLeads.Id => new List<Id>{ dina },
  supportTeam => new List<Id>{ salesLeads.Id, roleGroup.get('RoleAndSubordinatesInternal:Support Manager') },
  tier1 => new List<Id>{ roleGroup.get('Role:Support Lead') }
};
Set<String> have = new Set<String>();
for (GroupMember m : [SELECT GroupId, UserOrGroupId FROM GroupMember WHERE GroupId IN :wanted.keySet()]) have.add(m.GroupId + ':' + m.UserOrGroupId);
List<GroupMember> adds = new List<GroupMember>();
for (Id g : wanted.keySet())
  for (Id m : wanted.get(g))
    if (m != null && !have.contains(g + ':' + m)) adds.add(new GroupMember(GroupId = g, UserOrGroupId = m));
insert adds;
System.debug('Added ' + adds.size() + ' group member(s).');
