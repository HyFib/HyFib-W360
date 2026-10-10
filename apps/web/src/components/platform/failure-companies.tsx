import { TBody, TD, TH, THead, TR, Table } from '@w360/ui';
import type { FailureCompany, FailureCompanyYear } from '@w360/domain';
import { chartCount, chartShare } from '@w360/domain/ops-chart';
import { MonthBars, ShareBar, YearMonths } from '@/components/platform/failure-reasons';
import { CompanyLink } from '@/components/platform/ops';

/** A listed company's name, or how many companies the rest holds, as text. */
function companyText(company: FailureCompany): string {
  if (company.tenantId !== null && company.name !== null) return company.name;
  return `${company.companies} other ${company.companies === 1 ? 'company' : 'companies'}`;
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

/**
 * The year's failed sends by company (ADR-362): the companies with the most first, then the rest
 * together; each with its sends and its share of those failed, written and drawn as a bar in the
 * failed sends' colour, and its months beside it (`MonthBars`), so a company whose sends began
 * failing, or one failing all year, stands out; a folded table under it gives every month's count.
 * When no send failed, a note says so.
 */
export function FailureCompaniesTable({
  year,
  label,
  monthsLabel,
  empty,
}: {
  year: FailureCompanyYear;
  /** The table's accessible name. */
  label: string;
  /** The folded table's, which holds the table's own in no part. */
  monthsLabel: string;
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
              <TD>
                <MonthBars
                  label={companySpoken(company)}
                  months={year.months}
                  counts={year.byMonth[index] ?? []}
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
        }))}
      />
    </div>
  );
}
