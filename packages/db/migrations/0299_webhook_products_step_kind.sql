-- Products steps among the kinds of step a webhook endpoint can choose (P4-01, P5-09, ADR-383).
--
-- Automations can now send products from the company's catalogs (the send_products node), so
-- automation.run_step names that kind of node too. An endpoint chooses it as it chooses every kind
-- the automation builder defines (0250): its run_step_node_types takes 1 to 19 of the builder's 18
-- kinds of node and outside_node. The check is replaced by a wider one, so every list it allowed is
-- still allowed and old servers keep working. A company has at most 10 endpoints, so the table is
-- small and the check is validated here.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_run_step_node_types,
  ADD CONSTRAINT webhook_endpoints_run_step_node_types CHECK (
    run_step_node_types IS NULL
    OR (cardinality(run_step_node_types) BETWEEN 1 AND 19
        AND array_ndims(run_step_node_types) = 1
        AND array_position(run_step_node_types, NULL) IS NULL
        AND run_step_node_types <@ ARRAY['send_text', 'ask_buttons', 'ask_text', 'send_template',
                                         'ask_template', 'send_flow', 'send_products',
                                         'condition', 'update_contact', 'update_conversation',
                                         'http_request', 'create_task', 'create_deal',
                                         'move_deal', 'close_deal', 'wait', 'handoff',
                                         'end', 'outside_node']::text[]
        AND 'automation.run_step' = ANY (event_types)));
