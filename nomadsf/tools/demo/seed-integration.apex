// Integration settings of this sandbox (Compare & move › Sandbox refresh compares them): ENDPOINT is set by the script
Integration_Settings__c s = Integration_Settings__c.getOrgDefaults();
s.Endpoint__c = 'ENDPOINT';
s.Enabled__c = true;
upsert s;
System.debug('Integration settings: ' + s.Endpoint__c);
