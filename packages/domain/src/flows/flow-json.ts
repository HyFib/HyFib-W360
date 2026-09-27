/**
 * WhatsApp Flow JSON checks (browser-safe: the editor runs them as the member types). HyFib checks
 * the structure it relies on; Meta validates every component when the JSON is uploaded and returns
 * `validation_errors` with lines and columns (research M-162), which the flow page shows. Screen
 * rules come from Meta's Flow JSON reference as quoted by third-party code (research M-106, M-168):
 * `SUCCESS` is reserved, a screen holds at most 50 components, and terminal screens end the flow.
 */

export const FLOW_CATEGORIES = [
  'SIGN_UP',
  'SIGN_IN',
  'APPOINTMENT_BOOKING',
  'LEAD_GENERATION',
  'CONTACT_US',
  'CUSTOMER_SUPPORT',
  'SURVEY',
  'OTHER',
] as const;
export type FlowCategory = (typeof FLOW_CATEGORIES)[number];

export const FLOW_LIMITS = {
  /** HyFib's limit on the Flow JSON a company stores (Meta's own limit is not documented here). */
  jsonBytes: 256 * 1024,
  screens: 100,
  componentsPerScreen: 50,
  nameLength: 60,
  /** Interactive message texts (research M-157, M-159, M-165). */
  headerLength: 60,
  bodyLength: 1024,
  footerLength: 60,
  ctaLength: 30,
} as const;

const SCREEN_ID_RE = /^[A-Za-z0-9_]{1,100}$/;
const VERSION_RE = /^\d{1,2}\.\d{1,2}$/;

export interface FlowJsonIssue {
  path: string;
  message: string;
}

export interface FlowJsonSummary {
  version: string;
  /** Present when the flow exchanges data with an endpoint while it is open. */
  dataApiVersion: string | null;
  screens: string[];
  firstScreen: string;
  /** Keys the flow returns when it completes (from `complete` actions), for mapping answers. */
  answerKeys: string[];
}

export type FlowJsonCheck =
  | { ok: true; json: Record<string, unknown>; summary: FlowJsonSummary }
  | { ok: false; issues: FlowJsonIssue[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every key of the `payload` of `complete` actions anywhere in the JSON. */
function completeKeys(node: unknown, into: Set<string>, depth = 0): void {
  if (depth > 64) return;
  if (Array.isArray(node)) {
    for (const item of node) completeKeys(item, into, depth + 1);
    return;
  }
  if (!isObject(node)) return;
  if (node.name === 'complete' && isObject(node.payload)) {
    for (const key of Object.keys(node.payload)) into.add(key);
  }
  for (const value of Object.values(node)) completeKeys(value, into, depth + 1);
}

/** Parses and checks Flow JSON text. */
export function checkFlowJson(text: string): FlowJsonCheck {
  const issues: FlowJsonIssue[] = [];
  if (new TextEncoder().encode(text).length > FLOW_LIMITS.jsonBytes) {
    return {
      ok: false,
      issues: [{ path: '$', message: `Use at most ${FLOW_LIMITS.jsonBytes / 1024} KB of JSON.` }],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid JSON';
    return { ok: false, issues: [{ path: '$', message: `This is not valid JSON (${detail}).` }] };
  }
  if (!isObject(parsed)) {
    return { ok: false, issues: [{ path: '$', message: 'The Flow JSON must be an object.' }] };
  }
  const version = parsed.version;
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    issues.push({
      path: '$.version',
      message: 'Set "version" to a Flow JSON version such as "7.1".',
    });
  }
  const dataApi = parsed.data_api_version;
  if (dataApi !== undefined && (typeof dataApi !== 'string' || !VERSION_RE.test(dataApi))) {
    issues.push({
      path: '$.data_api_version',
      message: 'Set "data_api_version" to a version such as "3.0", or remove it.',
    });
  }
  const screens = parsed.screens;
  const ids: string[] = [];
  let terminal = 0;
  if (!Array.isArray(screens) || screens.length === 0) {
    issues.push({ path: '$.screens', message: 'Add at least one screen.' });
  } else if (screens.length > FLOW_LIMITS.screens) {
    issues.push({ path: '$.screens', message: `Use at most ${FLOW_LIMITS.screens} screens.` });
  } else {
    screens.forEach((screen, i) => {
      const at = `$.screens[${i}]`;
      if (!isObject(screen)) {
        issues.push({ path: at, message: 'Each screen must be an object.' });
        return;
      }
      const id = screen.id;
      if (typeof id !== 'string' || !SCREEN_ID_RE.test(id)) {
        issues.push({
          path: `${at}.id`,
          message: 'Give the screen an id of letters, digits and underscores.',
        });
      } else if (id === 'SUCCESS') {
        issues.push({ path: `${at}.id`, message: '"SUCCESS" is reserved; use another screen id.' });
      } else if (ids.includes(id)) {
        issues.push({ path: `${at}.id`, message: `Another screen already uses the id "${id}".` });
      } else {
        ids.push(id);
      }
      const layout = screen.layout;
      if (!isObject(layout) || !Array.isArray(layout.children)) {
        issues.push({ path: `${at}.layout`, message: 'Give the screen a layout with children.' });
      } else if (layout.children.length > FLOW_LIMITS.componentsPerScreen) {
        issues.push({
          path: `${at}.layout.children`,
          message: `A screen can hold at most ${FLOW_LIMITS.componentsPerScreen} components.`,
        });
      }
      if (screen.terminal === true) terminal += 1;
    });
    if (terminal === 0 && issues.length === 0) {
      issues.push({
        path: '$.screens',
        message: 'Mark at least one screen as terminal ("terminal": true) so the flow can end.',
      });
    }
  }
  const firstScreen = ids[0];
  if (issues.length > 0 || firstScreen === undefined) {
    return {
      ok: false,
      issues: issues.length > 0 ? issues : [{ path: '$.screens', message: 'Add a screen.' }],
    };
  }
  const keys = new Set<string>();
  completeKeys(parsed.screens, keys);
  return {
    ok: true,
    json: parsed,
    summary: {
      version: version as string,
      dataApiVersion: typeof dataApi === 'string' ? dataApi : null,
      screens: ids,
      firstScreen,
      answerKeys: [...keys].filter((k) => k !== 'flow_token').sort(),
    },
  };
}

/** A small working flow to start from: one screen asking for a name and an email. */
export const STARTER_FLOW_JSON = `{
  "version": "7.1",
  "screens": [
    {
      "id": "DETAILS",
      "title": "Your details",
      "terminal": true,
      "layout": {
        "type": "SingleColumnLayout",
        "children": [
          { "type": "TextInput", "name": "full_name", "label": "Name", "required": true },
          { "type": "TextInput", "name": "email", "label": "Email", "input-type": "email", "required": true },
          {
            "type": "Footer",
            "label": "Send",
            "on-click-action": {
              "name": "complete",
              "payload": { "full_name": "\${form.full_name}", "email": "\${form.email}" }
            }
          }
        ]
      }
    }
  ]
}
`;
