'use client';
import { useId, useState } from 'react';
import { formatMinor, minorToInput } from '@w360/domain/crm-money';
import { Button, Field, Input, TBody, TD, TH, THead, TR, Table } from '@w360/ui';
import {
  addDealItemAction,
  removeDealItemAction,
  searchDealProductsAction,
  updateDealAction,
} from '@/app/actions/crm';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError } from '@/components/form-status';

interface ProductChoice {
  id: string;
  name: string;
  retailerId: string;
  priceText: string | null;
}

/**
 * A deal's products (ADR-375): its items with their totals, and, for members who may change the
 * deal and see the catalogs, a product search to add one with a quantity and a unit price, removing
 * items, and the items' total as the deal's value. Every change is at the deal's version.
 */
export function DealProducts({
  slug,
  deal,
  items,
  totalMinor,
  otherCurrency,
  canEdit,
}: {
  slug: string;
  deal: {
    id: string;
    version: number;
    title: string;
    currency: string;
    valueMinor: number | null;
    ownerMembershipId: string | null;
    expectedCloseOn: string | null;
  };
  items: { id: string; name: string; quantity: number; unitPriceMinor: number; currency: string }[];
  totalMinor: number | null;
  otherCurrency: boolean;
  canEdit: boolean;
}) {
  const prefix = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductChoice[] | null>(null);
  const [chosen, setChosen] = useState<ProductChoice | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = (fn: () => Promise<{ ok: true } | { ok: false; message: string }>) => {
    setBusy(true);
    setError(null);
    void fn()
      .then((r) => {
        if (!r.ok) setError(r.message);
      })
      .catch(() => setError('The change could not be saved because the connection failed.'))
      .finally(() => setBusy(false));
  };

  const search = () =>
    run(async () => {
      const r = await searchDealProductsAction(slug, query);
      if (r.ok) setResults(r.data);
      return r;
    });

  return (
    <div className="grid gap-4">
      <FormError message={error} />
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No products on this deal.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Product</TH>
                <TH className="text-right">Quantity</TH>
                <TH className="text-right">Unit price</TH>
                <TH className="text-right">Total</TH>
                {canEdit ? (
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                ) : null}
              </TR>
            </THead>
            <TBody>
              {items.map((item) => (
                <TR key={item.id}>
                  <TD className="break-words">{item.name}</TD>
                  <TD className="text-right tabular-nums">{item.quantity}</TD>
                  <TD className="text-right tabular-nums">
                    {formatMinor(item.unitPriceMinor, item.currency)}
                  </TD>
                  <TD className="text-right tabular-nums">
                    {formatMinor(item.quantity * item.unitPriceMinor, item.currency)}
                  </TD>
                  {canEdit ? (
                    <TD className="text-right">
                      <ClientButton
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={busy}
                        aria-label={`Remove ${item.name}`}
                        onClick={() =>
                          run(() =>
                            removeDealItemAction(slug, {
                              dealId: deal.id,
                              expectedVersion: deal.version,
                              itemId: item.id,
                            }),
                          )
                        }
                      >
                        Remove
                      </ClientButton>
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
      {items.length > 0 ? (
        <p className="text-sm">
          {otherCurrency ? (
            'Some products are priced in another currency than the deal, so they have no total.'
          ) : totalMinor === null ? (
            'The products are worth more than a deal can hold.'
          ) : (
            <>
              Products total: <strong>{formatMinor(totalMinor, deal.currency)}</strong>
              {deal.valueMinor === totalMinor ? ' (the deal’s value)' : ''}
            </>
          )}
        </p>
      ) : null}
      {canEdit && totalMinor !== null && items.length > 0 && deal.valueMinor !== totalMinor ? (
        <div>
          <ClientButton
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(() =>
                updateDealAction(slug, {
                  id: deal.id,
                  expectedVersion: deal.version,
                  title: deal.title,
                  value: minorToInput(totalMinor, deal.currency),
                  ownerMembershipId: deal.ownerMembershipId,
                  expectedCloseOn: deal.expectedCloseOn,
                }),
              )
            }
          >
            Use the products total as the deal’s value
          </ClientButton>
        </div>
      ) : null}
      {canEdit ? (
        chosen ? (
          <ClientForm
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const r = await addDealItemAction(slug, {
                  dealId: deal.id,
                  expectedVersion: deal.version,
                  productId: chosen.id,
                  quantity,
                  unitPrice,
                });
                if (r.ok) {
                  setChosen(null);
                  setResults(null);
                  setQuery('');
                  setQuantity('1');
                  setUnitPrice('');
                }
                return r;
              });
            }}
          >
            <p className="text-sm">
              Adding <strong>{chosen.name}</strong>
              {chosen.priceText ? ` (catalog price ${chosen.priceText})` : ''}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id={`${prefix}-quantity`} label="Quantity">
                {(aria) => (
                  <Input
                    {...aria}
                    inputMode="numeric"
                    value={quantity}
                    maxLength={6}
                    onChange={(e) => setQuantity(e.target.value)}
                  />
                )}
              </Field>
              <Field id={`${prefix}-price`} label={`Unit price (${deal.currency})`}>
                {(aria) => (
                  <Input
                    {...aria}
                    inputMode="decimal"
                    value={unitPrice}
                    maxLength={40}
                    required
                    onChange={(e) => setUnitPrice(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || !unitPrice.trim()}>
                {busy ? 'Adding…' : 'Add product'}
              </Button>
              <ClientButton type="button" variant="outline" onClick={() => setChosen(null)}>
                Cancel
              </ClientButton>
            </div>
          </ClientForm>
        ) : (
          <div className="grid gap-2">
            <div className="flex flex-wrap items-end gap-2">
              <ClientForm
                className="flex min-w-48 flex-1 flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  search();
                }}
              >
                <Field
                  id={`${prefix}-q`}
                  label="Add a product"
                  description="Search the company's catalogs by name or retailer id."
                  className="min-w-48 flex-1"
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      value={query}
                      maxLength={100}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  )}
                </Field>
                <Button type="submit" variant="outline" disabled={busy}>
                  {busy ? 'Searching…' : 'Search products'}
                </Button>
              </ClientForm>
            </div>
            {results ? (
              results.length === 0 ? (
                <p className="text-sm text-muted-foreground">No matching product.</p>
              ) : (
                <ul className="grid gap-1" aria-label="Matching products">
                  {results.map((p) => (
                    <li key={p.id}>
                      <ClientButton
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setChosen(p)}
                      >
                        {p.name} · {p.retailerId}
                        {p.priceText ? ` · ${p.priceText}` : ''}
                      </ClientButton>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}
