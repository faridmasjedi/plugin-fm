import { apiHostFor, isDue, type BackupSchedule } from '@nomadsf/core';

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

// Scheduled backups run inside the Studio (it holds the org login and the folder); the badge
// says when one is due and Chrome has no Studio tab open to run it
type Scheduled = { id: string; name: string; schedule: BackupSchedule; created: string; lastRun?: string };

async function checkBackups(): Promise<void> {
  const { backupSchedules = [] } = (await chrome.storage.local.get('backupSchedules')) as {
    backupSchedules?: Scheduled[];
  };
  const now = new Date();
  const due = backupSchedules.filter((j) =>
    isDue(j.schedule, j.lastRun ? new Date(j.lastRun) : undefined, now, new Date(j.created))
  );
  await chrome.action.setBadgeText({ text: due.length ? String(due.length) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#a15c00' });
  await chrome.action.setTitle({
    title: due.length
      ? `NomadSF: backup due (${due.map((j) => j.name).join(', ')}). Open the Studio to run it.`
      : 'NomadSF',
  });
}

chrome.runtime.onInstalled.addListener(() => void chrome.alarms.create('nomadsf-backups', { periodInMinutes: 15 }));
chrome.runtime.onStartup.addListener(() => void checkBackups());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'nomadsf-backups') void checkBackups();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.backupSchedules) void checkBackups();
});
