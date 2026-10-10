-- The skip reasons in the skipped campaign recipients a webhook endpoint takes (P5-09, ADR-359).
--
-- An endpoint that takes campaign.recipient_skipped (0280) receives every recipient the campaigns
-- and numbers it names skip, whatever the reason: a receiver that reaches contacts another way when
-- WhatsApp could not (no number, no marketing opt-in, the frequency cap, the end of the sending
-- period) was sent the recipients who opted out, are suppressed or were erased as well, and had to
-- leave them alone itself. An endpoint can now name the reasons whose skips it takes
-- (campaign_skip_reasons: 1 to 9 of the reasons a campaign recipient can be skipped for, 0006),
-- only while it takes campaign.recipient_skipped, so the list never outlives its event. A skipped
-- recipient is delivered when its reason is on the list too; null takes every reason, as before. A
-- company has at most 10 endpoints, so the check is validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN campaign_skip_reasons text[],
  ADD CONSTRAINT webhook_endpoints_campaign_skip_reasons CHECK (
    campaign_skip_reasons IS NULL
    OR (cardinality(campaign_skip_reasons) BETWEEN 1 AND 9
        AND array_ndims(campaign_skip_reasons) = 1
        AND array_position(campaign_skip_reasons, NULL) IS NULL
        AND campaign_skip_reasons <@ ARRAY['contact_erased', 'no_phone', 'suppressed', 'opted_out',
          'no_marketing_opt_in', 'missing_variable', 'frequency_capped', 'cost_unknown',
          'expired']::text[]
        AND 'campaign.recipient_skipped' = ANY (event_types)));

-- The runtime role sets it when it adds an endpoint (its table grant) and changes it with the events
-- (0025 grants updates column by column). Both roles read it through their table grants.
GRANT UPDATE (campaign_skip_reasons) ON app.webhook_endpoints TO w360_app;

-- Capture ----------------------------------------------------------------------------------------

-- 0280's set-based capture with the reason list: a skipped recipient's event is written only when
-- an active endpoint that takes it, and whose campaign, number and skip reason lists are null or
-- hold the campaign, the number it sends from and the recipient's reason, would receive it, and
-- delivered to each such endpoint. Same signature, so its owner and grants stay (0280).
CREATE OR REPLACE FUNCTION app.capture_campaign_recipient_skips(p_tenant uuid, p_campaign uuid,
  p_channel uuid, p_recipients uuid[], p_contacts uuid[], p_reasons text[]) RETURNS void
  LANGUAGE sql
  SET search_path = pg_catalog, pg_temp
  AS $$
  WITH targets AS (
    SELECT e.id, e.campaign_skip_reasons FROM app.webhook_endpoints e
     WHERE e.tenant_id = p_tenant AND e.state = 'active'
       AND 'campaign.recipient_skipped' = ANY (e.event_types)
       AND (e.campaign_ids IS NULL OR p_campaign = ANY (e.campaign_ids))
       AND (e.channel_account_ids IS NULL OR p_channel = ANY (e.channel_account_ids))
  ), events AS (
    INSERT INTO app.webhook_events (id, tenant_id, type, contact_id, status, detail, occurred_at)
    SELECT gen_random_uuid(), p_tenant, 'campaign.recipient_skipped', s.contact_id, s.reason,
           jsonb_build_object('recipientId', s.id), clock_timestamp()
      FROM unnest(p_recipients, p_contacts, p_reasons)
           WITH ORDINALITY AS s (id, contact_id, reason, n)
     WHERE EXISTS (SELECT 1 FROM targets t
                    WHERE t.campaign_skip_reasons IS NULL
                       OR s.reason = ANY (t.campaign_skip_reasons))
     ORDER BY s.n
    RETURNING id, status
  )
  INSERT INTO app.webhook_deliveries (id, tenant_id, endpoint_id, event_id)
  SELECT gen_random_uuid(), p_tenant, t.id, ev.id
    FROM events ev
    JOIN targets t ON t.campaign_skip_reasons IS NULL OR ev.status = ANY (t.campaign_skip_reasons);
$$;
