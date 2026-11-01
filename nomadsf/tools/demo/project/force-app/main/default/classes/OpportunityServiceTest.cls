@IsTest
private class OpportunityServiceTest {
    @IsTest
    static void stageGivesTheNextStep() {
        Opportunity o = new Opportunity(Name = 'Test', StageName = 'Prospecting', CloseDate = Date.today());
        OpportunityService.setNextStep(new List<Opportunity>{ o });
        System.assertEquals('Book a discovery call', o.NextStep);
    }

    @IsTest
    static void savingAnOpportunitySetsItsNextStep() {
        Opportunity o = new Opportunity(Name = 'Test', StageName = 'Qualification', CloseDate = Date.today());
        insert o;
        System.assertEquals('Confirm budget and decision maker', [SELECT NextStep FROM Opportunity WHERE Id = :o.Id].NextStep);
    }
}
