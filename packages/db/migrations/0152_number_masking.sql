-- 0152_number_masking: hiding customers' numbers from chosen roles (W-044, ADR-226). Owners and
-- administrators choose, in Settings → Security, the roles whose members see customers' numbers
-- masked (a few leading and trailing digits): supervisors, agents, marketers and analysts; owners
-- and administrators always see them whole. The list is read with the company on every request, so
-- a change applies to the next page a member opens. Masking is enforced in the services that give
-- members contact data, not in the database: keys and webhooks, which serve integrations, still
-- carry numbers whole.
--
-- A constant default adds the column without rewriting the table; the check reads the companies
-- once (a small table) under this migration's lock.
ALTER TABLE app.tenants
  ADD COLUMN masked_number_roles text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT tenants_masked_number_roles CHECK (
    coalesce(array_ndims(masked_number_roles), 1) = 1
    AND array_position(masked_number_roles, NULL) IS NULL
    AND masked_number_roles <@ ARRAY['supervisor', 'agent', 'marketer', 'analyst']::text[]);

-- Members change it through the company's security settings (the runtime role's column grants on
-- app.tenants, 0001); it reads it through its table grant.
GRANT UPDATE (masked_number_roles) ON app.tenants TO w360_app;
