import { describe, expect, it } from 'vitest';
import {
  columnLetters,
  excelDate,
  makeZip,
  readTableFile,
  readWorkbook,
  sheetNames,
  writeWorkbook,
} from '../src/index.js';

describe('Excel workbooks', () => {
  it('names columns and sheets the way Excel does', () => {
    expect([0, 25, 26, 51, 701, 702].map(columnLetters)).toEqual(['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
    expect(sheetNames(['Account', 'account', 'a/b:c*?', 'x'.repeat(40)])).toEqual([
      'Account',
      'account 2',
      'a b c',
      'x'.repeat(31),
    ]);
  });

  it('writes one sheet per table and reads the same tables back, values as text', async () => {
    const sheets = [
      {
        name: 'Account',
        columns: ['Id', 'Name', 'Zip'],
        rows: [
          { Id: '001A', Name: 'Acme & <Co> "x"', Zip: '00123' },
          { Id: '001B', Name: 'Ünïcødé', Zip: '' },
        ],
      },
      { name: 'Contact', columns: ['Id', 'AccountId'], rows: [{ Id: '003A', AccountId: '001A' }] },
    ];
    const back = await readWorkbook(writeWorkbook(sheets));
    expect(back).toEqual([
      {
        name: 'Account',
        columns: ['Id', 'Name', 'Zip'],
        rows: [
          { Id: '001A', Name: 'Acme & <Co> "x"', Zip: '00123' },
          { Id: '001B', Name: 'Ünïcødé', Zip: '' },
        ],
      },
      { name: 'Contact', columns: ['Id', 'AccountId'], rows: [{ Id: '003A', AccountId: '001A' }] },
    ]);
  });

  it("reads Excel's own files: shared strings, rich text, numbers, booleans, gaps", async () => {
    const zip = makeZip([
      {
        path: 'xl/workbook.xml',
        content: '<workbook><sheets><sheet name="Leads &amp; more" sheetId="1" r:id="rId1"/></sheets></workbook>',
      },
      {
        path: 'xl/_rels/workbook.xml.rels',
        content: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      },
      {
        path: 'xl/sharedStrings.xml',
        content:
          '<sst><si><t>Name</t></si><si><r><t>Rich</t></r><r><t> text</t></r></si><si><t>Score</t></si><si><t>Hot</t></si></sst>',
      },
      {
        path: 'xl/worksheets/sheet1.xml',
        content:
          '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c><c r="C1" t="s"><v>3</v></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42.5</v></c><c r="C2" t="b"><v>1</v></c></row>' +
          '<row r="4"><c r="C4" t="b"><v>0</v></c></row></sheetData></worksheet>',
      },
    ]);
    expect(await readTableFile('leads.xlsx', zip)).toEqual([
      {
        name: 'Leads & more',
        columns: ['Name', 'Score', 'Hot'],
        rows: [
          { Name: 'Rich text', Score: '42.5', Hot: 'true' },
          { Name: '', Score: '', Hot: 'false' },
        ],
      },
    ]);
  });

  it('turns dates typed in Excel (numbers with a date format) back into dates', async () => {
    expect(excelDate(46329)).toBe('2026-11-03');
    expect(excelDate(46329.6041666667)).toBe('2026-11-03T14:30:00Z');
    const zip = makeZip([
      {
        path: 'xl/workbook.xml',
        content: '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
      },
      {
        path: 'xl/_rels/workbook.xml.rels',
        content: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      },
      {
        path: 'xl/styles.xml',
        content:
          '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>',
      },
      {
        path: 'xl/worksheets/sheet1.xml',
        content:
          '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>A</t></is></c><c r="B1" t="inlineStr"><is><t>B</t></is></c><c r="C1" t="inlineStr"><is><t>C</t></is></c></row>' +
          '<row r="2"><c r="A2" s="1"><v>46329</v></c><c r="B2" s="2"><v>46329</v></c><c r="C2" s="0"><v>46329</v></c></row></sheetData></worksheet>',
      },
    ]);
    expect((await readWorkbook(zip))[0].rows).toEqual([{ A: '2026-11-03', B: '2026-11-03', C: '46329' }]);
  });

  it('reads a zip of CSVs (⤓) and a single CSV as named tables', async () => {
    const zip = makeZip([
      { path: '01-Account.csv', content: '﻿Id,Name\n001A,Acme\n' },
      { path: '02-Contact.csv', content: 'Id,LastName\n003A,Lee\n' },
      { path: '__MACOSX/._01-Account.csv', content: 'x' },
    ]);
    expect((await readTableFile('page.zip', zip)).map((t) => [t.name, t.rows.length])).toEqual([
      ['Account', 1],
      ['Contact', 1],
    ]);
    expect((await readTableFile('Case.csv', new TextEncoder().encode('Id\n500A\n')))[0]).toMatchObject({
      name: 'Case',
      rows: [{ Id: '500A' }],
    });
  });
});
