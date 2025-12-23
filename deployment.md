In salesforce, we do have different ways of validationg and deployment.

Lets make a new command: fm:deployment or fm:validation, or whatever you think will work.

- On this new one, we want some inputs:

1. is it validation? Or deployment? or quick deployment
2. If it is validation, do we need to run tests?
   - if no, then just validate/deploy without test
   - if yes, do we need all tests to be run?
   - Or do we want some specified tests to run?
   - What if we create a solution to check which tests should be run? Then on each apex, we can find which tests are needed to run? Can we make this to run those specific tests? We should consider to check if we need to run all those tests related to triggers as well or not.
   - We need to check if we want to run validation/deployment with pre-destructive or post-destructive?
   - Can we make somehow to run it in a combination of pre-destructive and post-destructive?
   - for quick deployment, we need validation job Id.
   - Any other idea if you have that we can add here.
   - Any idea for any manual steps, like pre or post deploy steps? Pre steps will be needed on validation and post deploy steps can be done after deployment or quick deployment
