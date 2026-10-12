# summary

Run Playwright end-to-end scenarios against a Salesforce org.

# description

Runs the Playwright tests of the project (tests/e2e) against the target org. The tests are logged in through the org's frontdoor URL, the same way 'sf org open' works, so no usernames or passwords are stored. The URL is passed to the tests as SF_FRONTDOOR_URL, together with SF_INSTANCE_URL and SF_USERNAME.

Writes a JSON result (.fm/e2e/results.json) and an HTML report with traces, screenshots and videos of failures (.fm/e2e/report). Exits with code 1 when a test fails. Create a starter setup with 'sf fm e2e init'.

# examples

- Run all scenarios against the uat org:

  <%= config.bin %> <%= command.id %> --target-org uat

- Run only the Case scenarios, with a visible browser:

  <%= config.bin %> <%= command.id %> --target-org uat --grep Case --headed

# flags.targetOrg.summary

Org to run the scenarios against.

# flags.grep.summary

Only run tests whose title matches this regular expression.

# flags.project.summary

Playwright project to run (from playwright.config.ts).

# flags.headed.summary

Show the browser while the tests run.

# info.report

HTML report: %s (open with: npx playwright show-report <dir>)
