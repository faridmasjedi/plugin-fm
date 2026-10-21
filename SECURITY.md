# Security

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: **Security → Report a vulnerability** on
[faridmasjedi/plugin-fm](https://github.com/faridmasjedi/plugin-fm/security/advisories/new). Include what you found, how
to reproduce it and the version (extension, VS Code or CLI). You will get an answer as soon as possible, and a fix is
released before the details are made public.

Never include session ids, access tokens, passwords or customer data in a report.

## How NomadSF handles your data

- The browser extension calls Salesforce with the browser's own session for the org you are on. It stores no password
  or token and has no server; nothing is sent anywhere else.
- AI keys you add stay in the extension's own storage and are sent only to the provider you chose.
- Backups are written to a folder you choose on your own computer, and can be encrypted with your passphrase.
