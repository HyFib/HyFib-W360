-- A webhook endpoint's OAuth client can authenticate with a JWT signed with its secret (P5-09,
-- ADR-366).
--
-- Since 0279 an endpoint's client sends its identifier and secret in an HTTP Basic header or in the
-- request body (RFC 6749 section 2.3.1). Some authorization servers want the secret never sent at
-- all: the client proves it holds it with a short-lived JWT signed with it (HMAC SHA-256), sent as
-- a client assertion (RFC 7523 sections 2.2 and 3), the method RFC 7591's registry and OpenID
-- Connect name client_secret_jwt. The column takes it as a third value; the services set it only
-- when a company chooses it, and workers of this release, rolled out before web servers, build its
-- token requests. A company has at most 10 endpoints, so the check is validated here.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_oauth_client_auth,
  ADD CONSTRAINT webhook_endpoints_oauth_client_auth CHECK (
    oauth_client_auth IN ('client_secret_basic', 'client_secret_post', 'client_secret_jwt'));
