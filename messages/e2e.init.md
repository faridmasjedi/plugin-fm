# summary

Create a Playwright setup for end-to-end scenarios against Salesforce orgs.

# description

Writes playwright.config.ts, a login fixture that signs in through the org's frontdoor URL (tests/e2e/fixtures.ts) and an example scenario (tests/e2e/smoke.spec.ts). Run the scenarios with 'sf fm e2e run --target-org <org>'.

# examples

- <%= config.bin %> <%= command.id %>

# flags.force.summary

Overwrite existing files.

# info.nextSteps

Next: npm install --save-dev @playwright/test && npx playwright install chromium, then 'sf fm e2e run --target-org <org>'. Set PW_CHANNEL=chrome to use the installed Chrome instead.
