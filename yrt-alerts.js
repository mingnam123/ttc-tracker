// YRT publishes no GTFS-RT alerts feed, only an HTML "service changes and updates" page. This turns that page into the same alert objects
// the TTC feed produces. It is deliberately tolerant (table rows, list items, or headings followed by paragraphs) because the markup can change.
import * as cheerio from 'cheerio';

const MONTHS = 'January February March April May June July August September October November December'.split(' ');
const DATE_RE = new RegExp(`(${MONTHS.join('|')})\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'i');
const ROUTE_RE = /\bRoutes?\s+(\d{1,3}[A-Za-z]?(?:\s*(?:,|and|&|\/)\s*\d{1,3}[A-Za-z]?)*)/gi;
const norm = s => String(s).toLowerCase().replace(/^0+(?=\d)/, '');
const clean = s => s.replace(/\s+/g, ' ').trim();

export const dateOf = s => {
  const m = DATE_RE.exec(s ?? '');
  if (!m) return null;
  const mo = MONTHS.findIndex(x => x.toLowerCase() === m[1].toLowerCase());
  return Math.floor(Date.UTC(+m[3], mo, +m[2], 5) / 1000); // ~midnight Toronto time
};

export function routesIn(text) {
  const out = new Set();
  for (const m of text.matchAll(ROUTE_RE)) for (const r of m[1].split(/\s*(?:,|and|&|\/)\s*/i)) if (r) out.add(norm(r));
  return [...out];
}

export function parseYrtAlerts(html, base = 'https://www.yrt.ca') {
  const $ = cheerio.load(String(html).replace(/<\/(td|th|li|p|div|h\d|tr|strong|b)>|<br\s*\/?>/gi, '$& '));
  $('script,style,nav,header,footer').remove();
  const root = $('main').length ? $('main') : $('body');
  const alerts = [];
  let section = '', sectionDate = null;
  const seen = new Set();

  const add = (el, label) => {
    const text = clean($(el).text());
    if (text.length < 15) return;
    const shorts = routesIn(text);
    if (!shorts.length) return;                       // only route-specific items become alerts
    const key = text.slice(0, 160);
    if (seen.has(key)) return; seen.add(key);
    const head = clean($(el).find('strong,b,th,h3,h4,a').first().text()) || text.slice(0, 90);
    const href = $(el).find('a[href]').map((_, a) => $(a).attr('href')).get().find(h => h && !/^(mailto|tel|#)/.test(h));
    const when = dateOf(text) ?? sectionDate;
    alerts.push({
      id: 'YRT:page:' + alerts.length, agency: 'YRT', routes: [], shorts,
      header: (section ? section + ' — ' : '') + head, description: text, url: href ? new URL(href, base).href : null,
      effect: /detour/i.test(text) ? 'Detour' : /(no service|suspend|discontinu)/i.test(text) ? 'Reduced service' : 'Modified service',
      cause: null, periods: [], effective: when,
    });
  };

  root.find('h1,h2,h3,h4,tr,li,p').each((_, el) => {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-4]$/.test(tag)) {
      const t = clean($(el).text());
      if (DATE_RE.test(t) || /effective|service change/i.test(t)) { section = t.length < 90 ? t : ''; sectionDate = dateOf(t); }
      return;
    }
    if (tag === 'p' && $(el).closest('tr,li').length) return;           // already covered by the row/item
    if (tag === 'li' && $(el).find('tr,li').length) return;             // leaf items only
    add(el);
  });
  return alerts;
}
