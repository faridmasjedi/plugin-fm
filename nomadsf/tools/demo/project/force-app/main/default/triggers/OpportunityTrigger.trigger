trigger OpportunityTrigger on Opportunity (before insert, before update) {
    OpportunityService.setNextStep(Trigger.new);
}