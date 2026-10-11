import type { WebhookOAuthPublicKey } from '@w360/domain/webhook-model';

/**
 * The public key of an endpoint's OAuth client that signs with a key pair HyFib keeps (ADR-367),
 * for the company to register with its authorization server: as a JWK set, which most servers take
 * as the client's keys, and as PEM. For a next key pair (ADR-368, `inUse` given), its JWK set holds
 * the key in use too, for a server that keeps one set for the client. Public material only; the
 * private keys are never shown.
 */
export function WebhookOAuthPublicKeyDetails({
  publicKey,
  inUse,
}: {
  publicKey: WebhookOAuthPublicKey;
  /** The public key in use, when `publicKey` is the next one's. */
  inUse?: WebhookOAuthPublicKey;
}) {
  const block =
    'mt-1 max-w-full whitespace-pre-wrap break-all rounded-md border bg-muted p-2 font-mono text-xs';
  const keys = inUse ? [inUse.jwk, publicKey.jwk] : [publicKey.jwk];
  return (
    <details className="text-xs">
      <summary className="cursor-pointer break-all text-muted-foreground">
        {inUse
          ? `Next public key, to register before HyFib signs with it (key ${publicKey.keyId})`
          : `Public key to register with the authorization server (key ${publicKey.keyId})`}
      </summary>
      <div className="mt-2 grid gap-2">
        <p className="text-muted-foreground">
          {inUse
            ? 'Register it beside the key in use, as a JWK set holding both or as PEM. HyFib goes on signing with the key in use until you switch to this one; then it names this key in each JWT’s kid header.'
            : 'Register it for the client as a JWK set or as PEM. HyFib signs each JWT with its private key, which is never shown, and names the key in the JWT’s kid header.'}
        </p>
        <div>
          <p className="font-medium">{inUse ? 'JWK set, with the key in use' : 'JWK set'}</p>
          <pre className={block}>{JSON.stringify({ keys }, null, 2)}</pre>
        </div>
        <div>
          <p className="font-medium">PEM</p>
          <pre className={block}>{publicKey.pem}</pre>
        </div>
      </div>
    </details>
  );
}
