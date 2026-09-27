'use client';
import { useId, useMemo, useState } from 'react';
import { Button, Field, Input, Select, Textarea } from '@w360/ui';
import { sendProductsAction } from '@/app/actions/commerce';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

export interface SendableProduct {
  id: string;
  catalogId: string;
  catalogName: string | null;
  retailerId: string;
  name: string | null;
  priceText: string | null;
}

export interface ProductMessageLimits {
  productsPerMessage: number;
  headerLength: number;
  bodyLength: number;
  footerLength: number;
  sectionTitleLength: number;
}

type Kind = 'product' | 'product_list' | 'catalog';

/** The server lists at most this many products for a conversation (by name). */
const SENDABLE_LIMIT = 500;

function clientKey() {
  return `products-${crypto.randomUUID()}`;
}

const label = (p: SendableProduct) =>
  `${p.name ?? p.retailerId}${p.priceText ? ` · ${p.priceText}` : ''}`;

/**
 * Sends one product, several products (one section) or the whole catalog in the conversation while
 * the customer service window is open. Products come from one catalog of the conversation's number.
 */
export function ProductSender({
  slug,
  conversationId,
  products,
  limits,
}: {
  slug: string;
  conversationId: string;
  products: SendableProduct[];
  limits: ProductMessageLimits;
}) {
  const p = useId();
  const catalogs = useMemo(() => {
    const seen = new Map<string, string>();
    for (const product of products) {
      if (!seen.has(product.catalogId)) {
        seen.set(product.catalogId, product.catalogName ?? 'Catalog');
      }
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [products]);
  const [chosenCatalog, setCatalogId] = useState(catalogs[0]?.id ?? '');
  // The list can change after a refresh (a catalog disconnected): fall back to the first catalog.
  const catalogId = catalogs.some((c) => c.id === chosenCatalog)
    ? chosenCatalog
    : (catalogs[0]?.id ?? '');
  const inCatalog = products.filter((x) => x.catalogId === catalogId);
  const [kind, setKind] = useState<Kind>('product');
  const [productId, setProductId] = useState(inCatalog[0]?.id ?? '');
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [header, setHeader] = useState('');
  const [sectionTitle, setSectionTitle] = useState('');
  const [body, setBody] = useState('');
  const [footer, setFooter] = useState('');
  const [key, setKey] = useState(clientKey);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A choice from another catalog (after switching catalogs) falls back to the first product.
  const single = inCatalog.some((x) => x.id === productId) ? productId : (inCatalog[0]?.id ?? '');
  const chosen = picked.filter((id) => inCatalog.some((x) => x.id === id));
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? inCatalog.filter(
        (x) =>
          (x.name ?? '').toLowerCase().includes(needle) ||
          x.retailerId.toLowerCase().includes(needle),
      )
    : inCatalog;
  const full = chosen.length >= limits.productsPerMessage;
  const ready =
    kind === 'product'
      ? Boolean(single)
      : kind === 'catalog'
        ? Boolean(single) && Boolean(body.trim())
        : chosen.length > 0 && Boolean(header.trim()) && Boolean(body.trim());

  return (
    <ClientForm
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSent(null);
        const message =
          kind === 'product'
            ? { kind, productId: single, body, footer }
            : kind === 'catalog'
              ? { kind, thumbnailProductId: single, body, footer }
              : {
                  kind,
                  header,
                  body,
                  footer,
                  sections: [{ title: sectionTitle, productIds: chosen }],
                };
        void sendProductsAction(slug, { conversationId, clientKey: key, message }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else {
            setSent(kind === 'catalog' ? 'Catalog sent.' : 'Products sent.');
            setKey(clientKey());
            setPicked([]);
          }
        });
      }}
    >
      <FormError message={error} />
      <FormSuccess message={sent} />
      {products.length >= SENDABLE_LIMIT ? (
        <p className="text-xs text-muted-foreground">
          Showing the first {SENDABLE_LIMIT} products by name.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${p}-kind`} label="Send">
          {(aria) => (
            <Select {...aria} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="product">One product</option>
              <option value="product_list">Several products</option>
              <option value="catalog">The whole catalog</option>
            </Select>
          )}
        </Field>
        {catalogs.length > 1 ? (
          <Field id={`${p}-catalog`} label="Catalog">
            {(aria) => (
              <Select {...aria} value={catalogId} onChange={(e) => setCatalogId(e.target.value)}>
                {catalogs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
      </div>
      {kind === 'product_list' ? (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">
            Products ({chosen.length} of at most {limits.productsPerMessage})
          </legend>
          <Input
            aria-label="Filter products"
            placeholder="Filter by name or retailer id"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <ul className="grid max-h-60 gap-1 overflow-y-auto rounded-md border border-border p-2 text-sm">
            {visible.map((x) => {
              const checked = chosen.includes(x.id);
              return (
                <li key={x.id}>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={checked}
                      disabled={!checked && full}
                      onChange={(e) =>
                        setPicked(
                          e.target.checked ? [...chosen, x.id] : chosen.filter((id) => id !== x.id),
                        )
                      }
                    />
                    <span className="break-words">{label(x)}</span>
                  </label>
                </li>
              );
            })}
            {visible.length === 0 ? (
              <li className="text-muted-foreground">No product matches.</li>
            ) : null}
          </ul>
        </fieldset>
      ) : (
        <Field
          id={`${p}-product`}
          label={kind === 'catalog' ? 'Product shown on the message' : 'Product'}
        >
          {(aria) => (
            <Select {...aria} value={single} onChange={(e) => setProductId(e.target.value)}>
              {inCatalog.map((x) => (
                <option key={x.id} value={x.id}>
                  {label(x)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {kind === 'product_list' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${p}-header`} label="Heading">
            {(aria) => (
              <Input
                {...aria}
                required
                maxLength={limits.headerLength}
                value={header}
                onChange={(e) => setHeader(e.target.value)}
              />
            )}
          </Field>
          <Field id={`${p}-section`} label="Section title (optional)">
            {(aria) => (
              <Input
                {...aria}
                maxLength={limits.sectionTitleLength}
                value={sectionTitle}
                onChange={(e) => setSectionTitle(e.target.value)}
              />
            )}
          </Field>
        </div>
      ) : null}
      <Field id={`${p}-body`} label={kind === 'product' ? 'Message (optional)' : 'Message'}>
        {(aria) => (
          <Textarea
            {...aria}
            rows={2}
            required={kind !== 'product'}
            maxLength={limits.bodyLength}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        )}
      </Field>
      <Field id={`${p}-footer`} label="Footer (optional)">
        {(aria) => (
          <Input
            {...aria}
            maxLength={limits.footerLength}
            value={footer}
            onChange={(e) => setFooter(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={busy || !ready}>
          {busy
            ? 'Sending…'
            : kind === 'catalog'
              ? 'Send catalog'
              : kind === 'product'
                ? 'Send product'
                : 'Send products'}
        </Button>
      </div>
    </ClientForm>
  );
}
