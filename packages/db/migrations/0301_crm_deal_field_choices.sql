-- Choice-type custom deal fields (P4-04, ADR-385).
--
-- Deal fields took text, a number, a date or yes/no (0293, ADR-373). A field can now be a choice:
-- a fixed list of 1 to 50 options, in order, from which a deal takes one. The options are a text
-- array on the field; only choice fields have one. The check below holds their shape: each option
-- has 1 to 80 characters, no line break and no space at either end, and the number of line breaks
-- once they are joined proves no option holds one. That options differ ignoring case, and that a
-- deal's value is one of them, the service checks (`crm/deal-fields.ts`), under the company's
-- deal-field lock that every write of values takes.
--
-- A company has at most 50 deal fields, so the table is small: the type check is replaced and both
-- checks are validated here, under this migration's lock. Every type the old check allowed is still
-- allowed, so old servers keep working; the column is new and null for every existing field.
ALTER TABLE app.crm_deal_fields
  ADD COLUMN options text[],
  DROP CONSTRAINT crm_deal_fields_type_check,
  ADD CONSTRAINT crm_deal_fields_type_check
    CHECK (type IN ('text', 'number', 'date', 'boolean', 'choice')),
  ADD CONSTRAINT crm_deal_fields_options CHECK (
    CASE
      WHEN type <> 'choice' THEN options IS NULL
      -- CASE, not AND, keeps array_position from ever seeing a multidimensional array (it raises
      -- an error on one), since the order AND's arguments are evaluated in is not defined.
      WHEN options IS NULL OR coalesce(array_ndims(options), 0) <> 1 THEN false
      ELSE coalesce(
        cardinality(options) BETWEEN 1 AND 50
        AND array_position(options, NULL) IS NULL
        AND array_to_string(options, E'\n')
          ~ '^[^\n ]([^\n]{0,78}[^\n ])?(\n[^\n ]([^\n]{0,78}[^\n ])?)*$'
        AND char_length(array_to_string(options, E'\n'))
          - char_length(replace(array_to_string(options, E'\n'), E'\n', ''))
          = cardinality(options) - 1,
        false)
    END);
-- Owners and administrators add, reorder and remove unused options; the type still never changes.
GRANT UPDATE (options) ON app.crm_deal_fields TO w360_app;
