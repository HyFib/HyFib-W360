-- Choice-type custom contact fields (P3-01, ADR-407).
--
-- Contact fields took text, a number, a date or yes/no (0005). A field can now be a choice, as a
-- deal field can (0301, ADR-385): a fixed list of 1 to 50 options, in order, from which a contact
-- takes one. The options are a text array on the field; only choice fields have one. The check
-- below holds their shape exactly as 0301 holds deal fields': each option has 1 to 80 characters,
-- no line break and no space at either end, and the number of line breaks once they are joined
-- proves no option holds one. That options differ ignoring case, and that a contact's value is one
-- of them, the service checks (`contacts/fields.ts`), under the company's contact-field lock that
-- every write of values takes.
--
-- A company has at most 50 contact fields, so the table is small: the type check is replaced and
-- both checks are validated here, under this migration's lock. Every type the old check allowed is
-- still allowed, so old servers keep working; the column is new and null for every existing field.
ALTER TABLE app.contact_fields
  ADD COLUMN options text[],
  DROP CONSTRAINT contact_fields_type_check,
  ADD CONSTRAINT contact_fields_type_check
    CHECK (type IN ('text', 'number', 'date', 'boolean', 'choice')),
  ADD CONSTRAINT contact_fields_options CHECK (
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
-- Owners and administrators (and keys with contact_fields.manage) add, reorder and remove unused
-- options; the key and the type still never change.
GRANT UPDATE (options) ON app.contact_fields TO w360_app;
