import type { WidgetConfig } from './service';

/**
 * The script a company adds to its website (`<script src=".../widget/<id>.js" async>`). It draws one
 * button (and an optional greeting) that opens the company's chat link in a new tab. It stores
 * nothing in the visitor's browser, sends no request of its own and loads nothing else; the only
 * request is the visitor's own click, which the short link counts per day without any detail about
 * the visitor. Text is set with textContent and styles through the CSSOM, so it works on sites with
 * a strict style policy (their script policy must allow this origin).
 */

/** WCAG relative luminance of an #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** White or near-black text, whichever reads better on the button colour. */
export function readableTextColor(background: string): string {
  const l = luminance(background);
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / (luminance('#111111') + 0.05);
  return onWhite >= onDark ? '#ffffff' : '#111111';
}

/** JSON that is safe inside a script (no "<", and line separators escaped for older engines). */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function renderWidgetScript(
  config: WidgetConfig,
  publicId: string,
  baseUrl: string,
): string {
  const data = {
    id: publicId,
    href: `${baseUrl.replace(/\/$/, '')}/l/${config.slug}`,
    label: config.label,
    greeting: config.greeting,
    side: config.side,
    color: config.color,
    text: readableTextColor(config.color),
  };
  return `/* HyFib W360 chat widget: stores nothing, loads nothing, counts clicks per day only. */
(function () {
  'use strict';
  var c = ${scriptJson(data)};
  var w = window;
  w.__w360Widgets = w.__w360Widgets || {};
  if (w.__w360Widgets[c.id]) return;
  w.__w360Widgets[c.id] = true;
  function set(el, styles) {
    for (var k in styles) if (Object.prototype.hasOwnProperty.call(styles, k)) el.style[k] = styles[k];
  }
  function mount() {
    var host = document.createElement('div');
    host.setAttribute('data-w360-widget', c.id);
    // An open shadow root keeps the site's styles out; it hides nothing (the button holds no secrets).
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var wrap = document.createElement('div');
    set(wrap, {
      position: 'fixed', bottom: '20px', zIndex: '2147483000', display: 'flex',
      flexDirection: 'column', gap: '8px', maxWidth: 'calc(100vw - 40px)',
      alignItems: c.side === 'left' ? 'flex-start' : 'flex-end',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    });
    wrap.style[c.side === 'left' ? 'left' : 'right'] = '20px';
    if (c.greeting) {
      var g = document.createElement('p');
      g.textContent = c.greeting;
      set(g, {
        margin: '0', padding: '10px 12px', borderRadius: '12px', background: '#ffffff',
        color: '#111111', boxShadow: '0 2px 12px rgba(0,0,0,0.18)', fontSize: '14px',
        lineHeight: '1.4', maxWidth: '280px'
      });
      wrap.appendChild(g);
    }
    var a = document.createElement('a');
    a.href = c.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.referrerPolicy = 'no-referrer';
    a.textContent = c.label;
    set(a, {
      display: 'inline-block', padding: '12px 18px', borderRadius: '999px', background: c.color,
      color: c.text, textDecoration: 'none', fontSize: '15px', fontWeight: '600',
      boxShadow: '0 2px 12px rgba(0,0,0,0.24)'
    });
    wrap.appendChild(a);
    root.appendChild(wrap);
    document.body.appendChild(host);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
`;
}
