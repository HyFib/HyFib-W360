import { apiReference, buildOpenApiDocument, type ApiReference } from '@w360/domain';
import { getWebConfig } from './runtime';

export interface PublicApiDocs {
  /** The OpenAPI document `/api/v1/openapi.json` answers. */
  json: string;
  /** What the API reference page shows of the same document. */
  reference: ApiReference;
}

let built: PublicApiDocs | undefined;

/**
 * The public API's OpenAPI document and the API reference made from it (ADR-152), built once and
 * kept in memory (each server bundle that imports this, the page's and the route's, keeps a copy):
 * both depend on the code and the configured address alone, never on a request, a session or the
 * database, so the page and the document can never describe different APIs.
 */
export function publicApiDocs(): PublicApiDocs {
  if (!built) {
    const serverUrl = new URL('/api/v1', getWebConfig().APP_BASE_URL).toString();
    const document = buildOpenApiDocument(serverUrl);
    built = { json: JSON.stringify(document), reference: apiReference(document) };
  }
  return built;
}
