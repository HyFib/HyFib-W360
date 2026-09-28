-- 0033_ledger_balance_check_definer: the ledger's balance check runs as its definer, whoever commits.
--
-- app.assert_ledger_transaction_balanced() is the deferred constraint trigger that checks at commit
-- that every ledger transaction balances (0004). It ran with the privileges of whichever role fired
-- it. PostgreSQL 17 fires deferred triggers as the role that is current at COMMIT, so a posting made
-- inside a SECURITY DEFINER function called by a role that cannot read app.ledger_entries failed at
-- commit with "permission denied" (42501). The platform role is such a role: a platform owner's
-- refund request (ops.platform_request_credit_refund, 0032) holds credit, and on PostgreSQL 17 every
-- request was refused. PostgreSQL 18 fires AFTER triggers as the role that queued them (here the
-- definer), which is why only PostgreSQL 17 failed.
--
-- The check reads only the entries of the transaction named by the inserted row, and a trigger
-- function cannot be called directly, so running it as w360_definer (which reads the ledger through
-- its definer_all policy since 0004) gives no role anything new.
ALTER FUNCTION app.assert_ledger_transaction_balanced() SECURITY DEFINER;
REVOKE EXECUTE ON FUNCTION app.assert_ledger_transaction_balanced() FROM PUBLIC;
ALTER FUNCTION app.assert_ledger_transaction_balanced() OWNER TO w360_definer;
