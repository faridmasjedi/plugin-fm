/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
module.exports = {
  extends: ['eslint-config-salesforce-typescript', 'eslint-config-salesforce-license', 'plugin:sf-plugin/recommended'],
  root: true,
  ignorePatterns: ['test/**'],
  rules: {
    'header/header': 'off', // Temporarily disable header check
    'sf-plugin/no-hardcoded-messages-flags': 'off', // Temporarily disable this rule
    'sf-plugin/no-missing-messages': 'off', // Temporarily disable this rule
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-unsafe-call': 'off',
    '@typescript-eslint/no-unsafe-member-access': 'off',
  },
};
