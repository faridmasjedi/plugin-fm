import { describe, expect, it } from 'vitest';
import { aiTaskPrompt, parseCsvMapping, parseMetadataDraft } from '../src/index.js';

const fence = (o: unknown): string => `Here:\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

describe('AI for metadata and data loads', () => {
  it('asks for new metadata with the kind, the API version and the schema', () => {
    const { system, message } = aiTaskPrompt('write-metadata', {
      question: 'a trigger that fills Account.Rating',
      kind: 'ApexTrigger',
      apiVersion: '62.0',
      schema: 'Account: Rating picklist',
    });
    expect(system).toContain('metadata format');
    expect(message).toContain('Kind: ApexTrigger');
    expect(message).toContain('API version: 62.0');
    expect(message).toContain('Account: Rating picklist');
    expect(() => aiTaskPrompt('write-metadata', { question: ' ' })).toThrow('Say what you want');
  });

  it('asks to change a component with its files', () => {
    const { message } = aiTaskPrompt('change-metadata', {
      question: 'add field X',
      text: 'layouts/Account-Main.layout:\n<Layout/>',
      type: 'Layout',
      name: 'Account-Main',
    });
    expect(message).toContain('Component: Layout Account-Main');
    expect(message).toContain('<Layout/>');
    expect(() => aiTaskPrompt('change-metadata', { question: 'x', text: '' })).toThrow('Open a component');
  });

  it('reads the files of a draft and refuses paths it does not write', () => {
    const draft = parseMetadataDraft(
      fence({
        type: 'ApexTrigger',
        name: 'AccountRating',
        files: [
          { path: 'triggers/AccountRating.trigger', content: 'trigger AccountRating on Account (before insert) {}' },
          { path: 'triggers/AccountRating.trigger-meta.xml', content: '<ApexTrigger/>' },
        ],
        note: 'Fills the rating.',
      })
    );
    expect(draft.files.map((f) => f.path)).toEqual([
      'triggers/AccountRating.trigger',
      'triggers/AccountRating.trigger-meta.xml',
    ]);
    expect(draft.note).toBe('Fills the rating.');
    expect(() => parseMetadataDraft(fence({ files: [{ path: '../x.cls', content: '' }] }))).toThrow('path');
    expect(() => parseMetadataDraft(fence({ files: [{ path: 'package.xml', content: '' }] }))).toThrow('path');
    expect(() => parseMetadataDraft('no json')).toThrow('did not answer');
  });

  it('keeps a CSV mapping to the columns and fields given, one column per field', () => {
    const { mapping } = parseCsvMapping(
      fence({ mapping: { 'Company name': 'name', Telefon: 'Phone', Extra: 'Nope__c', Again: 'Name' } }),
      ['Company name', 'Telefon', 'Extra', 'Again'],
      ['Name', 'Phone', 'Id']
    );
    expect(mapping).toEqual({ 'Company name': 'Name', Telefon: 'Phone' });
  });
});

describe('the package of a draft', () => {
  it('lists the components its files make', async () => {
    const { metadataComponentsOf } = await import('../src/index.js');
    expect(
      metadataComponentsOf([
        { path: 'triggers/AccountRating.trigger', content: '' },
        { path: 'triggers/AccountRating.trigger-meta.xml', content: '' },
        { path: 'classes/RatingHandler.cls', content: '' },
        { path: 'lwc/board/board.js', content: '' },
        { path: 'lwc/board/board.html', content: '' },
        {
          path: 'objects/Account.object',
          content: '<CustomObject><fields><fullName>Score__c</fullName></fields></CustomObject>',
        },
        { path: 'objects/Thing__c.object', content: '<CustomObject><label>Thing</label></CustomObject>' },
        {
          path: 'labels/CustomLabels.labels',
          content: '<CustomLabels><labels><fullName>Hello</fullName></labels></CustomLabels>',
        },
        { path: 'permissionsets/Ops.permissionset', content: '' },
      ])
    ).toEqual([
      { type: 'ApexTrigger', name: 'AccountRating' },
      { type: 'ApexClass', name: 'RatingHandler' },
      { type: 'LightningComponentBundle', name: 'board' },
      { type: 'CustomField', name: 'Account.Score__c' },
      { type: 'CustomObject', name: 'Thing__c' },
      { type: 'CustomLabel', name: 'Hello' },
      { type: 'PermissionSet', name: 'Ops' },
    ]);
  });
});
