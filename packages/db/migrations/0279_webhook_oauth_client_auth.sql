-- How a webhook endpoint's OAuth client authenticates to its authorization server (P5-09,
-- ADR-357).
--
-- Since 0121 the worker sends the client's identifier and secret in an HTTP Basic header (RFC 6749
-- section 2.3.1, the method an authorization server must support for clients with a password).
-- Some servers take the client's credentials only in the request body, which the same section
-- allows (client_id and client_secret as form parameters): an endpoint can now choose. The methods
-- are named as RFC 7591 names them: client_secret_basic, as before, or client_secret_post. Every
-- endpoint starts with client_secret_basic, the default, unused without a client; the services set
-- it with every client they add or change and put the default back when they remove one, while a
-- web server from before this migration leaves it as it is. A constant default adds the column
-- without rewriting the table, and a company has at most 10 endpoints, so the check is validated
-- here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN oauth_client_auth text NOT NULL DEFAULT 'client_secret_basic',
  ADD CONSTRAINT webhook_endpoints_oauth_client_auth CHECK (
    oauth_client_auth IN ('client_secret_basic', 'client_secret_post'));

-- The runtime role sets it when it adds an endpoint (its table grant) and changes it with the
-- client (0025 grants updates column by column). Both roles read it through their table grants:
-- the worker, as the runtime role, builds its token requests with it.
GRANT UPDATE (oauth_client_auth) ON app.webhook_endpoints TO w360_app;
