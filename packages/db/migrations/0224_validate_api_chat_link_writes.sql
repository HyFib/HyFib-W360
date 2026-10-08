-- 0224_validate_api_chat_link_writes: validates what 0223 added NOT VALID (ADR-300). Validation
-- reads the table without blocking its writes.
ALTER TABLE app.chat_links VALIDATE CONSTRAINT chat_links_created_by_api_key_fk;
ALTER TABLE app.chat_links VALIDATE CONSTRAINT chat_links_author;
