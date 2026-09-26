/** Additional authenticated data binding a stored WABA credential to its company and account. */
export function credentialAad(tenantId: string, whatsappAccountId: string): string {
  return `tenant:${tenantId}|whatsapp_account:${whatsappAccountId}`;
}
