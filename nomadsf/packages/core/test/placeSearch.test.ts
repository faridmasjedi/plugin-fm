import { describe, expect, it } from 'vitest';
import { aiTaskPrompt, rankPlaces, stem, words } from '../src/index.js';

const places = [
  { id: 'jobs', say: 'stop a running batch job', also: 'abort cancel queued' },
  { id: 'logs', say: 'debug logs for a user', also: 'trace flag' },
  { id: 'find', say: 'find a user', also: 'search username' },
  { id: 'orgs', say: 'compare metadata of two orgs', also: 'sandbox production' },
  { id: 'csv', say: 'compare a CSV with the org' },
  { id: 'lwc', say: 'edit a Lightning web component', also: 'lwc' },
  { id: 'apex', say: 'edit an Apex class' },
  { id: 'save', say: 'what runs when a record is saved' },
];
const top = (q: string) => rankPlaces(q, places, 1)[0]?.place.id;

describe('finding a place from what someone wants to do', () => {
  it('stems and joins words', () => {
    expect(stem('deploying')).toBe('deploy');
    expect(stem('saved')).toBe(stem('save'));
    expect(words('give Bob a perm set')).toEqual(['giv', 'bob', 'permissionset']);
  });
  it('synonyms and word forms', () => {
    expect(top('kill the batch')).toBe('jobs');
    expect(top('aborting batches')).toBe('jobs');
    expect(top('what happens when i save an opportunity')).toBe('save');
  });
  it('typos', () => expect(top('stpo a bacth job')).toBe('jobs'));
  it('names it does not know do not count against a place', () => expect(top('debug log for ann')).toBe('logs'));
  it('two orgs named mean the places for two orgs', () => expect(top('compare prod and uat')).toBe('orgs'));
  it('a specific word picks the specific place', () => expect(top('edit lwc')).toBe('lwc'));
  it('nothing when nothing fits', () => expect(rankPlaces('the and of', places)).toEqual([]));
  it('the AI is asked with the places and the sentence only', () => {
    const { message } = aiTaskPrompt('find-place', { question: 'stop a job', places: '0 | Develop › Jobs | stop' });
    expect(message).toContain('0 | Develop › Jobs | stop');
    expect(message).toContain('stop a job');
  });
});
