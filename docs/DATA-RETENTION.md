# Data retention, export and deletion

Last updated 2026-09-26. Defaults below are **proposals** pending legal review for each launch market;
they are not a statement of legal compliance. Retention jobs are phase 5–7 unless marked built.

## Categories and default retention

| Data                                         | Location                                         | Default retention                                                                                       | Notes                                                              |
| -------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Identity (users, credentials)                | `auth.users`, `auth.accounts`                    | Until account deletion                                                                                  | Password hashes via Better Auth (scrypt).                          |
| Sessions                                     | `auth.sessions`                                  | 7-day expiry, deleted on sign-out/revocation                                                            | Expired rows cleaned by the library/maintenance.                   |
| Verification & reset tokens                  | `auth.verifications`                             | 24 h (verify) / 1 h (reset)                                                                             | Single use.                                                        |
| Company settings, memberships                | `app.tenants`, `app.memberships`                 | Until company deletion                                                                                  | Removed members keep a `removed` row for audit integrity.          |
| Invitations                                  | `app.invitations`                                | 180 days after final state (proposed)                                                                   | Token stored only as SHA-256.                                      |
| Company audit log                            | `app.audit_events`                               | 2 years (proposed), configurable per plan                                                               | Append-only; purge only through the retention path.                |
| Platform audit log                           | `ops.platform_audit_events`                      | 5 years (proposed)                                                                                      | Evidence of staff actions.                                         |
| Security events                              | `ops.security_events`                            | 1 year (proposed)                                                                                       | No message content.                                                |
| Email outbox                                 | `ops.email_outbox`                               | Payload erased immediately after delivery or permanent failure **[built]**; metadata 90 days (proposed) | Payload encrypted until then.                                      |
| Jobs                                         | `pgboss.*`                                       | Completed jobs 1–7 days per queue; dead letters 30 days **[built]**                                     | Payloads contain only ids and signatures.                          |
| Webhook receipts                             | `ops.webhook_receipts`, `ops.webhook_quarantine` | Raw payload erased after 7 days; rows (and quarantine entries) deleted after 90 days **[built]**        | Encrypted at rest; replay possible only while the payload exists.  |
| Live-update events                           | `app.tenant_events`                              | 7 days **[built]**                                                                                      | Ids and types only; clients resynchronise after longer gaps.       |
| Messages & media                             | `app.messages`, object storage                   | Company-configurable (default 2 years, proposed; not enforced yet); media not stored yet                | Deleting a contact deletes their messages (phase 3).               |
| Contacts & consent records (phase 3)         | `app.contacts`, `app.consents`                   | Contacts until deleted; consent evidence kept for the retention required to prove consent               | Consent withdrawal is recorded, not erased, where proof is needed. |
| Billing ledger, invoices, payments (phase 5) | ledger tables                                    | As required by tax law (e.g. 8 years for Indian GST records — verify)                                   | Retained even after company deletion; personal data minimised.     |

## Export

- Company export (owners, `tenant.export`): members, settings, audit log, and later contacts,
  conversations and campaigns, delivered as a time-limited private download (phase 5).
- Spreadsheet exports neutralise formula injection (cells starting with `=`, `+`, `-`, `@`, tab or
  carriage return are prefixed) (phase 3).

## Deletion semantics (distinguish clearly in UI and contracts)

1. **Application deletion:** rows removed or anonymised in our primary database by a deletion job
   after a grace period (company status `pending_deletion` → `deleted`).
2. **Provider-side deletion:** data held by Meta (WhatsApp) or Razorpay is governed by their terms;
   we request deletion where APIs exist and document where they do not.
3. **Backup expiry:** deleted data persists in encrypted backups until they expire (PITR window and
   backup retention, e.g. 7–35 days); restores re-apply pending deletions before reopening access.
4. **Legally retained records:** billing and tax records and security audit evidence are retained
   for their statutory period with personal data minimised.

## Consent withdrawal and suppression

Opt-out keywords and manual suppression stop all future marketing sends immediately, including
already-queued campaign recipients (checked at send time). Suppression entries are retained so the
opt-out is honoured if the contact is re-imported.
