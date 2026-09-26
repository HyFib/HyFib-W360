/**
 * CSV reading and writing for contact import and export (RFC 4180, no dependency).
 *
 * Reading: quoted fields may contain delimiters, doubled quotes and line breaks; CRLF, LF and CR
 * line endings are accepted; a UTF-8 byte-order mark is ignored; the delimiter (comma, semicolon
 * or tab) is detected from the header line. Hard limits keep a hostile file from exhausting memory.
 *
 * Writing: every field that could be read as a spreadsheet formula (starting with =, +, -, @, tab
 * or carriage return) is prefixed with an apostrophe so spreadsheet programs show it as text
 * (CSV/formula injection). Values that are validated E.164 phone numbers are written unchanged:
 * "+" followed only by digits cannot form a formula.
 */
export interface CsvLimits {
  maxBytes: number;
  maxRows: number;
  maxColumns: number;
  maxFieldLength: number;
}

export const DEFAULT_CSV_LIMITS: CsvLimits = {
  maxBytes: 5 * 1024 * 1024,
  maxRows: 5000,
  maxColumns: 50,
  maxFieldLength: 1000,
};

export class CsvError extends Error {
  constructor(
    message: string,
    readonly line: number | null,
  ) {
    super(message);
    this.name = 'CsvError';
  }
}

export interface ParsedCsv {
  headers: string[];
  /** Data rows (header excluded); each row is padded or truncated to the header width. */
  rows: string[][];
  delimiter: ',' | ';' | '\t';
}

function detectDelimiter(text: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    else if (!inQuotes && (ch === ',' || ch === ';' || ch === '\t')) counts[ch] += 1;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t';
  return ',';
}

export function parseCsv(input: string, limits: CsvLimits = DEFAULT_CSV_LIMITS): ParsedCsv {
  if (Buffer.byteLength(input, 'utf8') > limits.maxBytes) {
    throw new CsvError(
      `The file is larger than ${Math.floor(limits.maxBytes / 1024 / 1024)} MB.`,
      null,
    );
  }
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let quotedField = false;
  let line = 1;
  let recordLine = 1;

  const pushField = () => {
    if (field.length > limits.maxFieldLength) {
      throw new CsvError(
        `A value on line ${recordLine} is longer than ${limits.maxFieldLength} characters.`,
        recordLine,
      );
    }
    record.push(field);
    if (record.length > limits.maxColumns) {
      throw new CsvError(
        `Line ${recordLine} has more than ${limits.maxColumns} columns.`,
        recordLine,
      );
    }
    field = '';
    quotedField = false;
  };
  const pushRecord = () => {
    pushField();
    // Blank lines (a single empty unquoted field) are skipped.
    if (!(record.length === 1 && record[0] === '')) {
      records.push(record);
      if (records.length > limits.maxRows + 1) {
        throw new CsvError(`The file has more than ${limits.maxRows} rows.`, recordLine);
      }
    }
    record = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field.length > 0 || quotedField) {
        throw new CsvError(`Line ${line} has a quote in the middle of a value.`, line);
      }
      inQuotes = true;
      quotedField = true;
    } else if (ch === delimiter) {
      pushField();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      pushRecord();
      line += 1;
      recordLine = line;
    } else {
      if (quotedField) {
        throw new CsvError(`Line ${line} has text after a closing quote.`, line);
      }
      field += ch;
    }
  }
  if (inQuotes)
    throw new CsvError(`A quoted value starting on line ${recordLine} is not closed.`, recordLine);
  if (field.length > 0 || quotedField || record.length > 0) pushRecord();

  const [header, ...data] = records;
  if (!header) throw new CsvError('The file is empty.', null);
  const headers = header.map((h) => h.trim());
  if (headers.every((h) => h === '')) throw new CsvError('The header row is empty.', 1);
  const width = headers.length;
  const rows = data.map((r) =>
    r.length === width
      ? r
      : r.length > width
        ? r.slice(0, width)
        : [...r, ...Array<string>(width - r.length).fill('')],
  );
  return { headers, rows, delimiter };
}

const FORMULA_START = /^[=+\-@\t\r]/;
const E164_ONLY = /^\+[1-9][0-9]{6,14}$/;

/** Neutralises spreadsheet formulas (see module comment). */
export function neutraliseCell(value: string): string {
  if (E164_ONLY.test(value)) return value;
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** Reverses `neutraliseCell` for values read back from our own exports. */
export function restoreCell(value: string): string {
  return value.length > 1 && value.startsWith("'") && FORMULA_START.test(value.slice(1))
    ? value.slice(1)
    : value;
}

function quote(value: string): string {
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** One CSV line (CRLF-terminated) with formula neutralisation and RFC 4180 quoting. */
export function csvLine(values: readonly (string | number | boolean | null | undefined)[]): string {
  return `${values
    .map((v) => (v === null || v === undefined ? '' : quote(neutraliseCell(String(v)))))
    .join(',')}\r\n`;
}

/** UTF-8 byte-order mark so spreadsheet programs detect the encoding of exported files. */
export const CSV_BOM = '\uFEFF';
