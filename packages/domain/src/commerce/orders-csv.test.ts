import { describe, expect, it } from 'vitest';
import { ORDER_CSV_COLUMNS, orderCsvLine, type OrderCsvRow } from './orders-csv';

const row: OrderCsvRow = {
  id: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01',
  reference: 'ORD-7Q2X',
  receivedAt: new Date('2026-10-01T09:30:00Z'),
  status: 'confirmed',
  statusChangedAt: new Date('2026-10-01T10:00:00Z'),
  paidAt: null,
  contactName: 'Asha Rao',
  contactPhone: '+919876543210',
  contactErased: false,
  items: '2 × Product 001; 1 × sku-9',
  itemCount: 3,
  droppedItems: 0,
  currency: 'INR',
  subtotalMinor: 29008,
  customerNote: 'Deliver after 6 pm',
};
const cells = (line: string) => line.replace(/\r\n$/, '').split(',');
const asIs = (phone: string | null) => phone;

describe('WhatsApp orders as CSV (ADR-235)', () => {
  it('writes one line per order in the order of the columns, amounts exact', () => {
    const line = orderCsvLine(row, asIs);
    expect(line.endsWith('\r\n')).toBe(true);
    expect(cells(line)).toEqual([
      row.id,
      'ORD-7Q2X',
      '2026-10-01T09:30:00.000Z',
      'confirmed',
      '2026-10-01T10:00:00.000Z',
      '',
      'Asha Rao',
      '+919876543210',
      '2 × Product 001; 1 × sku-9',
      '3',
      '0',
      'INR',
      '290.08',
      'Deliver after 6 pm',
    ]);
    expect(cells(line)).toHaveLength(ORDER_CSV_COLUMNS.length);
    // A currency without minor units, and a total HyFib could not work out.
    expect(cells(orderCsvLine({ ...row, currency: 'JPY', subtotalMinor: 1500 }, asIs))[12]).toBe(
      '1500',
    );
    expect(cells(orderCsvLine({ ...row, subtotalMinor: null }, asIs))[12]).toBe('');
    expect(cells(orderCsvLine({ ...row, currency: null, subtotalMinor: 100 }, asIs))[12]).toBe('');
    expect(cells(orderCsvLine({ ...row, paidAt: new Date('2026-10-02T00:00:00Z') }, asIs))[5]).toBe(
      '2026-10-02T00:00:00.000Z',
    );
  });

  it('shows numbers as the member may see them, and never an erased contact’s details', () => {
    const masked = orderCsvLine(row, () => '+919•••••••10');
    // Not a whole number, so neutralised like any other value starting with "+".
    expect(cells(masked)[7]).toBe("'+919•••••••10");
    const erased = cells(orderCsvLine({ ...row, contactErased: true }, asIs));
    expect([erased[6], erased[7], erased[13]]).toEqual(['Erased contact', '', '']);
  });

  it('neutralises formulas and quotes what a CSV needs quoted', () => {
    const line = orderCsvLine(
      { ...row, customerNote: '=HYPERLINK("http://x")', contactName: 'Rao, Asha' },
      asIs,
    );
    expect(line).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(line).toContain('"Rao, Asha"');
  });
});
