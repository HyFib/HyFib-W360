import type { WebhookOAuthPublicKey } from '@w360/domain/webhook-model';

/**
 * The public key of an endpoint's OAuth client that signs with a key pair HyFib keeps (ADR-367),
 * for the company to register with its authorization server: as a JWK set, which most servers take
 * as the client's keys, and as PEM. Public material only; the private key is never shown.
 */
export function WebhookOAuthPublicKeyDetails({ publicKey }: { publicKey: WebhookOAuthPublicKey }) {
  const block =
    'mt-1 max-w-full whitespace-pre-wrap break-all rounded-md border bg-muted p-2 font-mono text-xs';
  return (
    <details className="text-xs">
      <summary className="cursor-pointer break-all text-muted-foreground">
        Public key to register with the authorization server (key {publicKey.keyId})
      </summary>
      <div className="mt-2 grid gap-2">
        <p className="text-muted-foreground">
          Register it for the client as a JWK set or as PEM. HyFib signs each JWT with its private
          key, which is never shown, and names the key in the JWT’s kid header.
        </p>
        <div>
          <p className="font-medium">JWK set</p>
          <pre className={block}>{JSON.stringify({ keys: [publicKey.jwk] }, null, 2)}</pre>
        </div>
        <div>
          <p className="font-medium">PEM</p>
          <pre className={block}>{publicKey.pem}</pre>
        </div>
      </div>
    </details>
  );
}
