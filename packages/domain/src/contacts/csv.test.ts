import { describe, expect, it } from 'vitest';
import { CsvError, csvLine, neutraliseCell, parseCsv, restoreCell } from './csv';

describe('parseCsv', () => {
  it('reads quoted fields with delimiters, doubled quotes and line breaks', () => {
    const csv = '\uFEFFphone,name,notes\r\n+919876543210,"Rao, Asha","said ""hi""\nthen left"\r\n';
    const parsed = parseCsv(csv);
    expect(parsed.headers).toEqual(['phone', 'name', 'notes']);
    expect(parsed.rows).toEqual([['+919876543210', 'Rao, Asha', 'said "hi"\nthen left']]);
  });

  it('detects semicolon and tab delimiters and accepts LF and CR line endings', () => {
    expect(parseCsv('phone;name\n+1555000111;Ann\n').rows).toEqual([['+1555000111', 'Ann']]);
    expect(parseCsv('phone\tname\r+1555000111\tAnn').rows).toEqual([['+1555000111', 'Ann']]);
  });

  it('skips blank lines and pads short rows to the header width', () => {
    const parsed = parseCsv('a,b,c\n\n1\n2,3,4,5\n');
    expect(parsed.rows).toEqual([
      ['1', '', ''],
      ['2', '3', '4'],
    ]);
  });

  it('rejects malformed quoting with the line number', () => {
    expect(() => parseCsv('a,b\n1,"open\n')).toThrow(CsvError);
    expect(() => parseCsv('a,b\n1,x"y\n')).toThrow(/Line 2/);
    expect(() => parseCsv('a,b\n"1"x,2\n')).toThrow(/after a closing quote/);
  });

  it('refuses a value holding the NUL character, naming its line (ADR-130)', () => {
    expect(() => parseCsv('name,phone\nAsha,+919800000000\n"Pri\u0000ya",+919800000001\n')).toThrow(
      /line 3 holds the NUL character \(U\+0000\)/,
    );
    // A file saved as UTF-16 and read as UTF-8: a NUL character after each letter.
    const utf16 = Buffer.from('name,phone\n', 'utf16le').toString('utf8');
    expect(() => parseCsv(utf16)).toThrow(/save it as CSV UTF-8/);
    expect(parseCsv('name\nAsha\n').rows).toEqual([['Asha']]);
  });

  it('enforces size, row, column and field limits', () => {
    const limits = { maxBytes: 100, maxRows: 2, maxColumns: 3, maxFieldLength: 5 };
    expect(() => parseCsv('a\n1\n2\n3\n', limits)).toThrow(/more than 2 rows/);
    expect(() => parseCsv('a,b,c,d\n', limits)).toThrow(/more than 3 columns/);
    expect(() => parseCsv('a\n123456\n', limits)).toThrow(/longer than 5/);
    expect(() => parseCsv('x'.repeat(101), limits)).toThrow(CsvError);
    expect(() => parseCsv('')).toThrow(/empty/);
  });
});

describe('CSV writing', () => {
  it('neutralises every formula trigger but keeps validated phone numbers', () => {
    for (const payload of ['=cmd|" /C calc"!A0', '+1+cmd', '-2+3', '@SUM(A1)', '\tx', '\rx']) {
      expect(neutraliseCell(payload).startsWith("'")).toBe(true);
    }
    expect(neutraliseCell('+919876543210')).toBe('+919876543210');
    expect(neutraliseCell('+91 98765')).toBe("'+91 98765");
    expect(neutraliseCell('Asha')).toBe('Asha');
  });

  it('keeps plain negative numbers as numbers and nothing longer', () => {
    expect(neutraliseCell('-500.00')).toBe('-500.00');
    expect(neutraliseCell('-7')).toBe('-7');
    for (const payload of ['-500.00+1', '-1e5', '-.5', '-5.', '-1,000.00', '- 5', '-5.0.0']) {
      expect(neutraliseCell(payload)).toBe(`'${payload}`);
    }
  });

  it('quotes values that need it and round-trips through the parser', () => {
    const line = csvLine(['+919876543210', 'Rao, "Asha"', '=HYPERLINK("x")', null, 42, true]);
    expect(line).toBe('+919876543210,"Rao, ""Asha""","\'=HYPERLINK(""x"")",,42,true\r\n');
    const parsed = parseCsv(`a,b,c,d,e,f\r\n${line}`);
    expect(parsed.rows[0]!.map(restoreCell)).toEqual([
      '+919876543210',
      'Rao, "Asha"',
      '=HYPERLINK("x")',
      '',
      '42',
      'true',
    ]);
  });

  it('restores only values neutralised by us', () => {
    expect(restoreCell("'=1+1")).toBe('=1+1');
    expect(restoreCell("'tis")).toBe("'tis");
    expect(restoreCell("'")).toBe("'");
  });
});
