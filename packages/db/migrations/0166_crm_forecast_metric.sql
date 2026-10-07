-- 0166_crm_forecast_metric: the Reports page's weighted CRM forecast (P4-04, ADR-252).
--
-- Open deals by the month they are expected to close, with their value weighed by each stage's
-- chance of winning (ADR-242), are computed when the page loads; only the metric's definition is
-- persisted, as for every metric (ADR-026), so the registry and the database stay the same.
INSERT INTO ops.metric_definitions (key, version, label, unit, description, numerator, denominator, window_rule,
  timezone_rule, missing_data, freshness, available) VALUES
  ('crm.forecast', 1, 'Weighted forecast', 'count',
   'Open deals by the month they are expected to close, with their value and that value weighed by each stage’s chance of winning, in each pipeline’s currency, now.',
   'Open deals in active stages, by expected close month: this month (dates already past included), the next two months, later, and without a date.',
   NULL,
   NULL,
   'Months of the company’s time zone.',
   'Deals in stages without a chance of winning count in the deals and the value but add nothing to the weighted value. Deals without a value count in the number of deals only.',
   'The state when the page loads.', true);
