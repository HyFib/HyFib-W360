-- Ranges and words in an endpoint's contact field value filter (P5-09, ADR-335).
--
-- Since 0253 an endpoint taking contact.created or contact.updated can name field values of the
-- contacts whose events it takes, each an exact value: a receiver keeping the contacts whose
-- lifetime value is at least 10,000, whose renewal falls in October or whose city contains
-- "Chennai" could not say so. A pair of contact_event_field_values now holds, besides the field's
-- key, one of: a value as before ({"key": "tier", "value": "gold"}); a range of numbers or dates,
-- either end or both, the ends included ({"key": "ltv", "atLeast": 10000},
-- {"key": "renewal", "atLeast": "2026-10-01", "atMost": "2026-10-31"}); or a word or phrase the
-- text contains, whatever its case ({"key": "city", "contains": "chennai"}). The services check
-- each pair against its field's type when a list adds it (a range for number and date fields, a
-- word for text fields); the check below holds the shapes, as 0253's held the pairs.
--
-- The check's CASE reads the list's shape before its members. A member is read only where it is
-- present (strict $[*] ? (exists(@.x)).x, which neither fails on a pair without it nor unwraps an
-- array), and a pair without a shape is found in lax mode, where a missing member does not exist.
-- A company has at most 10 endpoints, so the table is small and the check is validated here.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_contact_event_field_values,
  ADD CONSTRAINT webhook_endpoints_contact_event_field_values CHECK (
    contact_event_field_values IS NULL
    OR CASE
         WHEN jsonb_typeof(contact_event_field_values) <> 'array' THEN false
         WHEN jsonb_array_length(contact_event_field_values) NOT BETWEEN 1 AND 50 THEN false
         WHEN octet_length(contact_event_field_values::text) > 4500 THEN false
         -- Each pair an object of a key and the members of one shape, and nothing else, …
         WHEN jsonb_path_exists(contact_event_field_values,
                                'strict $[*] ? (@.type() != "object")') THEN false
         WHEN jsonb_path_exists(contact_event_field_values,
                                'strict $[*].keyvalue() ? (@.key != "key" && @.key != "value"
                                   && @.key != "contains" && @.key != "atLeast"
                                   && @.key != "atMost")') THEN false
         WHEN jsonb_array_length(jsonb_path_query_array(contact_event_field_values,
                                   'strict $[*].keyvalue() ? (@.key == "key")'))
              <> jsonb_array_length(contact_event_field_values) THEN false
         WHEN jsonb_path_exists(contact_event_field_values,
                                'lax $[*] ? (exists(@.value) && (exists(@.contains)
                                   || exists(@.atLeast) || exists(@.atMost)))') THEN false
         WHEN jsonb_path_exists(contact_event_field_values,
                                'lax $[*] ? (exists(@.contains)
                                   && (exists(@.atLeast) || exists(@.atMost)))') THEN false
         WHEN jsonb_path_exists(contact_event_field_values,
                                'lax $[*] ? (!(exists(@.value) || exists(@.contains)
                                   || exists(@.atLeast) || exists(@.atMost)))') THEN false
         -- … the key a field's key (0005's rule); a value text of 1 to 500 characters without
         -- spaces around it, a number or a boolean; a word text of the same kind; the ends of a
         -- range numbers or dates (YYYY-MM-DD), both of one kind and in order.
         ELSE NOT jsonb_path_exists(contact_event_field_values,
                'strict $[*].key ? (@.type() != "string" || !(@ like_regex "^[a-z][a-z0-9_]{0,39}$"))')
              AND NOT jsonb_path_exists(contact_event_field_values,
                'strict $[*] ? (exists(@.value)).value ? (@.type() != "string"
                   && @.type() != "number" && @.type() != "boolean")')
              AND NOT jsonb_path_exists(contact_event_field_values,
                'strict $[*] ? (exists(@.value)).value ? (@.type() == "string" && (@ == ""
                   || @ like_regex "^\\s|\\s$" || @ like_regex "^.{250}.{251}" flag "s"))')
              AND NOT jsonb_path_exists(contact_event_field_values,
                'strict $[*] ? (exists(@.contains)).contains ? (@.type() != "string")')
              AND NOT jsonb_path_exists(contact_event_field_values,
                'strict $[*] ? (exists(@.contains)).contains ? (@.type() == "string" && (@ == ""
                   || @ like_regex "^\\s|\\s$" || @ like_regex "^.{250}.{251}" flag "s"))')
              AND NOT jsonb_path_exists(contact_event_field_values,
                'strict $[*] ? (exists(@.atLeast)).atLeast ? (@.type() != "number"
                   && @.type() != "string")')
              AND NOT jsonb_path_exists(contact_event_field_values,
                'strict $[*] ? (exists(@.atMost)).atMost ? (@.type() != "number"
                   && @.type() != "string")')
              AND NOT jsonb_path_exists(contact_event_field_values,
                'strict $[*] ? (exists(@.atLeast)).atLeast ? (@.type() == "string"
                   && !(@ like_regex "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"))')
              AND NOT jsonb_path_exists(contact_event_field_values,
                'strict $[*] ? (exists(@.atMost)).atMost ? (@.type() == "string"
                   && !(@ like_regex "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"))')
              AND NOT jsonb_path_exists(contact_event_field_values,
                'strict $[*] ? (exists(@.atLeast) && exists(@.atMost)
                   && @.atLeast.type() != @.atMost.type())')
              AND NOT jsonb_path_exists(contact_event_field_values,
                'strict $[*] ? (exists(@.atLeast) && exists(@.atMost) && @.atLeast > @.atMost)')
              AND ('contact.created' = ANY (event_types) OR 'contact.updated' = ANY (event_types))
       END);

-- Whether a contact's change passes an endpoint's list (0253's rule, with the new shapes): always
-- for a null list; otherwise when the change of a contact.updated changed one of the listed fields
-- (`p_changes`, everything its transaction changed so far), or the contact's value of a pair's field
-- passes the pair: equal to its value (text whatever its case, numbers as numbers, true and false
-- as they are), containing its word whatever the case (a text value), or within its range, the
-- ends included (a number for number ends, a date as YYYY-MM-DD for date ends). Same signature,
-- so its owner (the migration role) and its grants (0253) stay.
CREATE OR REPLACE FUNCTION app.webhook_contact_values_match(p_values jsonb, p_attributes jsonb,
  p_changes text[])
  RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT p_values IS NULL
      OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(p_values) AS c(pair)
            CROSS JOIN LATERAL (SELECT p_attributes -> (c.pair ->> 'key') AS v,
                                       p_attributes ->> (c.pair ->> 'key') AS t) a
            WHERE ('fields.' || (c.pair ->> 'key')) = ANY (coalesce(p_changes, '{}'::text[]))
               OR CASE
                    WHEN c.pair ? 'value' THEN
                      CASE jsonb_typeof(c.pair -> 'value')
                        WHEN 'string' THEN
                          jsonb_typeof(a.v) = 'string' AND lower(a.t) = lower(c.pair ->> 'value')
                        ELSE a.v = (c.pair -> 'value')
                      END
                    WHEN c.pair ? 'contains' THEN
                      jsonb_typeof(a.v) = 'string'
                      AND strpos(lower(a.t), lower(c.pair ->> 'contains')) > 0
                    ELSE
                      CASE jsonb_typeof(coalesce(c.pair -> 'atLeast', c.pair -> 'atMost'))
                        WHEN 'number' THEN
                          jsonb_typeof(a.v) = 'number'
                          AND (NOT c.pair ? 'atLeast' OR a.v >= (c.pair -> 'atLeast'))
                          AND (NOT c.pair ? 'atMost' OR a.v <= (c.pair -> 'atMost'))
                        WHEN 'string' THEN
                          jsonb_typeof(a.v) = 'string'
                          AND a.t ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                          AND (NOT c.pair ? 'atLeast'
                               OR a.t COLLATE "C" >= (c.pair ->> 'atLeast') COLLATE "C")
                          AND (NOT c.pair ? 'atMost'
                               OR a.t COLLATE "C" <= (c.pair ->> 'atMost') COLLATE "C")
                        ELSE false
                      END
                  END);
$$;
