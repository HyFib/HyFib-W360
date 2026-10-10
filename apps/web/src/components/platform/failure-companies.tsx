import { TBody, TD, TH, THead, TR, Table } from '@w360/ui';
import type { FailureCompany, FailureCompanyYear } from '@w360/domain';
import { chartCount, chartShare, otherCompaniesText } from '@w360/domain/ops-chart';
import { MonthBars, ShareBar, YearMonths } from '@/components/platform/failure-reasons';
import { CompanyLink } from '@/components/platform/ops';

/** A listed company's name, or how many companies the rest holds, as text. */
function companyText(company: FailureCompany): string {
  if (company.tenantId !== null && company.name !== null) return company.name;
  return otherCompaniesText(company.companies);
}

/**
 * A listed company as a screen reader names its months: its name with its slug, which tells two
 * companies of one name apart; the rest by how many companies it holds.
 */
function companySpoken(company: FailureCompany): string {
  return company.tenantId !== null && company.name !== null && company.slug !== null
    ? `${company.name} (/${company.slug})`
    : companyText(company);
}

/** A listed company as a link to its platform page, or the rest as text. */
function CompanyName({ company }: { company: FailureCompany }) {
  return company.tenantId !== null && company.name !== null && company.slug !== null ? (
    <CompanyLink id={company.tenantId} name={company.name} slug={company.slug} />
  ) : (
    companyText(company)
  );
}

/** A share of a company's sends failed, or a dash when it has none (`failedOfSent`). */
const failedShareText = (share: number | null) => (share === null ? '—' : chartShare(share));

/**
 * The year's failed sends by company (ADR-362): the companies with the most first, then the rest
 * together; each with its failed sends and its share of those failed, written and drawn as a bar in
 * the failed sends' colour, its sends and the share of them failed (ADR-364), so a company that
 * fails much because it sends much reads apart from one whose sends fail often, and its months
 * beside it (`MonthBars`), so a company whose sends began failing, or one failing all year, stands
 * out; folded tables under it give every month's count and share. When no send failed, a note says
 * so.
 */
export function FailureCompaniesTable({
  year,
  label,
  monthsLabel,
  sharesLabel,
  empty,
}: {
  year: FailureCompanyYear;
  /** The table's accessible name. */
  label: string;
  /** The folded table of counts', which holds no other table's name. */
  monthsLabel: string;
  /** The folded table of shares', which holds no other table's name (ADR-364). */
  sharesLabel: string;
  /** What the note says when no send failed. */
  empty: string;
}) {
  if (year.failed === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    // min-w-0 and the table's own box: it scrolls there rather than widening the card on a phone.
    <div className="grid min-w-0 gap-2">
      <Table aria-label={label}>
        <THead>
          <TR>
            <TH>Company</TH>
            <TH>Failed</TH>
            <TH>Share of the failed</TH>
            <TH>Sent</TH>
            <TH>Share of its sends failed</TH>
            <TH>Month by month</TH>
          </TR>
        </THead>
        <TBody>
          {year.companies.map((company, index) => (
            <TR key={company.tenantId ?? 'the rest'}>
              <TD className="min-w-48">
                <CompanyName company={company} />
              </TD>
              <TD className="tabular-nums">{chartCount(company.failed)}</TD>
              <TD>
                <div className="flex items-center gap-2">
                  <ShareBar share={company.share} />
                  <span className="tabular-nums">{chartShare(company.share)}</span>
                </div>
              </TD>
              <TD className="tabular-nums">{chartCount(company.sent)}</TD>
              <TD className="tabular-nums">{failedShareText(company.failedShare)}</TD>
              <TD>
                <MonthBars
                  label={companySpoken(company)}
                  months={year.months}
                  counts={year.byMonth[index] ?? []}
                  sent={year.sentByMonth[index] ?? []}
                />
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <YearMonths
        label={monthsLabel}
        summary="Companies month by month as a table"
        heading="Company"
        each="each company"
        months={year.months}
        rows={year.companies.map((company, index) => ({
          key: company.tenantId ?? 'the rest',
          name: <CompanyName company={company} />,
          counts: year.byMonth[index] ?? [],
          sent: year.sentByMonth[index] ?? [],
        }))}
        shares={{
          label: sharesLabel,
          summary: 'Share of each company’s sends failed, month by month, as a table',
        }}
      />
    </div>
  );
}
