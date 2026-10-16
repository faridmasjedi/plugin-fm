import { apiHostFor } from '@nomadsf/core';

/** Opens the Studio for the org of the page that asked (floating button on Salesforce pages). */
chrome.runtime.onMessage.addListener((message: { type?: string; page?: string }, sender) => {
  if (message.type !== 'nomadsf:open-studio' || !sender.tab?.url) return;
  const apiHost = apiHostFor(new URL(sender.tab.url).host);
  if (!apiHost) return;
  const hash = message.page && /^[a-z]+$/.test(message.page) ? `#${message.page}` : '';
  void chrome.tabs.create({
    url: chrome.runtime.getURL(`app/index.html?host=${encodeURIComponent(apiHost)}${hash}`),
    index: sender.tab.index + 1,
  });
});
