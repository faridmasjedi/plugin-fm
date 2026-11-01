trigger CaseTrigger on Case (before insert) {
    CaseHandler.beforeInsert(Trigger.new);
}