const amount = (value: number, one: string, many: string) =>
  `${value.toLocaleString('en-IN')} ${value === 1 ? one : many}`;

/** A plan and its add-ons in words, for example "Pro with 2 extra seats, 1 run pack". */
export function planWithAddOns(
  name: string,
  addOns: { extraSeats: number; extraNumbers: number; runPacks: number; apiRequestPacks: number },
): string {
  const parts = [
    addOns.extraSeats > 0 ? amount(addOns.extraSeats, 'extra seat', 'extra seats') : '',
    addOns.extraNumbers > 0
      ? amount(addOns.extraNumbers, 'extra WhatsApp number', 'extra WhatsApp numbers')
      : '',
    addOns.runPacks > 0 ? amount(addOns.runPacks, 'run pack', 'run packs') : '',
    addOns.apiRequestPacks > 0
      ? amount(addOns.apiRequestPacks, 'API request pack', 'API request packs')
      : '',
  ].filter(Boolean);
  return parts.length === 0 ? name : `${name} with ${parts.join(', ')}`;
}
