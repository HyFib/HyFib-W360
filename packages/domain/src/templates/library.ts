import { TEMPLATE_LIMITS, type TemplateDefinition } from './definition';

/**
 * Starter templates (W-070, ADR-232): HyFib's own copy, in English, that a member starts a template
 * draft from and changes before saving. Meta reviews every template on submission and decides its
 * category; a starter is a suggestion, never an approved template. Starters hold no website or
 * phone button: those need the company's own address or number.
 */
export interface TemplateStarter {
  /** The name the draft takes, in Meta's form (lower case, digits and underscores). */
  key: string;
  label: string;
  /** When to use it, for the list members choose from. */
  description: string;
  definition: TemplateDefinition;
}

const utility = (
  body: string,
  examples: string[],
  extra: Partial<Pick<TemplateDefinition, 'header' | 'buttons'>> = {},
): TemplateDefinition => ({
  category: 'UTILITY',
  header: extra.header ?? { type: 'none' },
  body: { text: body, examples },
  footer: null,
  buttons: extra.buttons ?? [],
});

const marketing = (header: string, body: string, examples: string[]): TemplateDefinition => ({
  category: 'MARKETING',
  header: { type: 'text', text: header, example: null },
  body: { text: body, examples },
  footer: null,
  buttons: [],
});

export const TEMPLATE_STARTERS: readonly TemplateStarter[] = [
  {
    key: 'order_confirmation',
    label: 'Order confirmation',
    description: 'Confirms an order the customer placed, with its total.',
    definition: utility(
      'Hi {{1}}, thank you for your order. We have received it and will message you here when it ships. The order total is {{2}}.',
      ['Asha', '₹2,499.00'],
      { header: { type: 'text', text: 'Order {{1}} confirmed', example: '#1042' } },
    ),
  },
  {
    key: 'shipping_update',
    label: 'Shipping update',
    description: 'Tells the customer their order has shipped and how to follow it.',
    definition: utility(
      'Hi {{1}}, your order {{2}} has shipped with {{3}}. The tracking number is {{4}}.',
      ['Asha', '#1042', 'Blue Dart', 'BD123456789IN'],
      { header: { type: 'text', text: 'Your order is on its way', example: null } },
    ),
  },
  {
    key: 'delivery_confirmation',
    label: 'Delivery confirmation',
    description: 'Confirms a delivery and asks the customer to report any problem.',
    definition: utility(
      'Hi {{1}}, your order {{2}} has been delivered. If anything is missing or damaged, reply to this message and we will sort it out.',
      ['Asha', '#1042'],
    ),
  },
  {
    key: 'appointment_reminder',
    label: 'Appointment reminder',
    description: 'Reminds the customer of an appointment, with buttons to confirm or reschedule.',
    definition: utility(
      'Hi {{1}}, this is a reminder of your appointment with {{2}} on {{3}} at {{4}}. Please confirm, or tell us if you need another time.',
      ['Asha', 'Dr. Rao', '12 October', '4:30 PM'],
      {
        header: { type: 'text', text: 'Appointment reminder', example: null },
        buttons: [
          { type: 'QUICK_REPLY', text: 'Confirm' },
          { type: 'QUICK_REPLY', text: 'Reschedule' },
        ],
      },
    ),
  },
  {
    key: 'booking_confirmation',
    label: 'Booking confirmation',
    description: 'Confirms a booking with its date and reference.',
    definition: utility(
      'Hi {{1}}, your booking for {{2}} on {{3}} is confirmed. Your booking reference is {{4}}.',
      ['Asha', '2 guests', 'Saturday 18 October, 8 PM', 'BK-7781'],
    ),
  },
  {
    key: 'payment_reminder',
    label: 'Payment reminder',
    description: 'Reminds the customer of a payment that is due.',
    definition: utility(
      'Hi {{1}}, this is a reminder that {{2}} for {{3}} is due on {{4}}. If you have already paid, please ignore this message.',
      ['Asha', '₹1,200.00', 'invoice INV-208', '15 October'],
    ),
  },
  {
    key: 'payment_received',
    label: 'Payment received',
    description: 'Confirms a payment the customer made.',
    definition: utility('Hi {{1}}, we have received your payment of {{2}} for {{3}}. Thank you.', [
      'Asha',
      '₹1,200.00',
      'invoice INV-208',
    ]),
  },
  {
    key: 'request_update',
    label: 'Request update',
    description: 'Tells the customer how their request or ticket is progressing.',
    definition: utility(
      'Hi {{1}}, there is an update on your request {{2}}: {{3}}. Reply to this message if you have any questions.',
      ['Asha', '#5531', 'a technician will visit tomorrow between 10 AM and 1 PM'],
    ),
  },
  {
    key: 'welcome_message',
    label: 'Welcome',
    description: 'Greets a customer who just agreed to receive offers.',
    definition: marketing(
      'Welcome',
      'Hi {{1}}, thank you for signing up for messages from {{2}}. We will let you know here about new arrivals and offers.',
      ['Asha', 'Green Leaf'],
    ),
  },
  {
    key: 'back_in_stock',
    label: 'Back in stock',
    description: 'Tells customers a product they wanted is available again.',
    definition: marketing(
      'Back in stock',
      'Hi {{1}}, good news: {{2}} is back in stock. Reply to this message and we will help you order it.',
      ['Asha', 'the blue linen kurta'],
    ),
  },
  {
    key: 'seasonal_offer',
    label: 'Seasonal offer',
    description: 'Announces a sale with its end date.',
    definition: marketing(
      'Our sale is on',
      'Hi {{1}}, our {{2}} sale runs until {{3}}, with {{4}} off selected items. Reply to this message to ask about anything you like.',
      ['Asha', 'Diwali', '20 October', 'up to 30%'],
    ),
  },
  {
    key: 'cart_reminder',
    label: 'Cart reminder',
    description: 'Reminds a customer of the items they left in their cart.',
    definition: marketing(
      'Still thinking it over?',
      'Hi {{1}}, you left {{2}} in your cart. Reply to this message if you have any questions, and we will be happy to help.',
      ['Asha', '2 items'],
    ),
  },
];

/** The starter with this key, or null. */
export function findTemplateStarter(key: string): TemplateStarter | null {
  return TEMPLATE_STARTERS.find((s) => s.key === key) ?? null;
}

/** A draft a starter gives a company: its name, its definition and its opt-out button, if any. */
export interface StarterDraft {
  name: string;
  definition: TemplateDefinition;
  /** The text of the quick reply that stops offers, on a marketing starter given one. */
  optOutButton: string | null;
}

/**
 * A starter's draft for a company. A marketing starter gets a quick reply carrying the company's
 * first marketing opt-out keyword, when it fits a button: a customer's tap sends the keyword, which
 * HyFib records as their marketing opt-out (consent keywords). Without one, the starter has no
 * opt-out button.
 */
export function starterDraft(
  starter: TemplateStarter,
  company: { marketingOptOutKeywords: readonly string[] },
): StarterDraft {
  const definition = structuredClone(starter.definition);
  const keyword = company.marketingOptOutKeywords[0]?.trim();
  const optOutButton =
    definition.category === 'MARKETING' && keyword && keyword.length <= TEMPLATE_LIMITS.buttonText
      ? keyword
      : null;
  if (optOutButton) {
    definition.buttons = [...definition.buttons, { type: 'QUICK_REPLY', text: optOutButton }];
  }
  return { name: starter.key, definition, optOutButton };
}
