/** Next steps of opportunities, from their stage. */
public with sharing class OpportunityService {
    static final Map<String, String> NEXT = new Map<String, String>{
        'Prospecting' => 'Book a discovery call',
        'Qualification' => 'Confirm budget and decision maker',
        'Proposal/Price Quote' => 'Send the proposal',
        'Negotiation/Review' => 'Agree on terms',
        'Closed Won' => 'Hand over to delivery'
    };

    public static void setNextStep(List<Opportunity> opportunities) {
        for (Opportunity o : opportunities) {
            if (String.isBlank(o.NextStep) && NEXT.containsKey(o.StageName)) o.NextStep = NEXT.get(o.StageName);
        }
    }
}