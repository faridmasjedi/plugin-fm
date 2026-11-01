// The newer permission sets and groups, given to the demo users (after users.apex; demo scratch orgs only).
String domain = [SELECT Username FROM User WHERE FirstName = 'Ann' AND LastName = 'Lee' LIMIT 1].Username.substringAfter('@');
Map<String, Id> users = new Map<String, Id>();
for (User u : [SELECT Id, FirstName FROM User WHERE Username LIKE :('%@' + domain)]) users.put(u.FirstName, u.Id);
Map<String, Id> sets = new Map<String, Id>();
for (PermissionSet s : [SELECT Id, Name FROM PermissionSet WHERE Name IN ('Opportunity_Manager', 'Report_Builder', 'Invoice_Viewer', 'Invoice_Manager', 'Case_Escalation')]) sets.put(s.Name, s.Id);
Map<String, Id> groups = new Map<String, Id>();
for (PermissionSetGroup g : [SELECT Id, DeveloperName FROM PermissionSetGroup WHERE DeveloperName IN ('Finance_Team', 'Support_Leads')]) groups.put(g.DeveloperName, g.Id);
List<PermissionSetAssignment> assigns = new List<PermissionSetAssignment>();
if (users.containsKey('Ann')) {
    assigns.add(new PermissionSetAssignment(AssigneeId = users.get('Ann'), PermissionSetId = sets.get('Opportunity_Manager')));
    if (sets.containsKey('Report_Builder')) assigns.add(new PermissionSetAssignment(AssigneeId = users.get('Ann'), PermissionSetId = sets.get('Report_Builder')));
}
for (String who : new List<String>{ 'Bob', 'Chen' })
    if (users.containsKey(who)) assigns.add(new PermissionSetAssignment(AssigneeId = users.get(who), PermissionSetId = sets.get('Invoice_Viewer')));
if (users.containsKey('Dina')) assigns.add(new PermissionSetAssignment(AssigneeId = users.get('Dina'), PermissionSetGroupId = groups.get('Finance_Team')));
if (users.containsKey('Ann')) assigns.add(new PermissionSetAssignment(AssigneeId = users.get('Ann'), PermissionSetGroupId = groups.get('Support_Leads')));
insert assigns;
System.debug('Gave ' + assigns.size() + ' assignments');
