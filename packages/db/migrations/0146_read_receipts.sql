-- 0146_read_receipts: telling customers their messages were read, and that a member is typing
-- (P3-06, ADR-223). A company that turns this on marks the customer's latest message read in
-- WhatsApp when a member opens the conversation, and shows the customer a typing indicator while a
-- member writes a reply (research M-045). Off by default: whether customers see that the business
-- read their message is the company's choice.
--
-- A constant default adds the column without rewriting the table; existing companies keep it off.
ALTER TABLE app.messaging_settings
  ADD COLUMN read_receipts boolean NOT NULL DEFAULT false;

GRANT UPDATE (read_receipts) ON app.messaging_settings TO w360_app;
