// Values that look real, from small built-in lists (no packages). A seed makes the same plan give the same records.

/** A seeded random number generator (mulberry32): `rand()` in [0, 1). */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const LISTS = {
  firstName: [
    'Ava',
    'Liam',
    'Mia',
    'Noah',
    'Zara',
    'Omar',
    'Lena',
    'Kai',
    'Priya',
    'Mateo',
    'Hana',
    'Theo',
    'Amara',
    'Leo',
    'Sofia',
    'Arjun',
    'Chloe',
    'Felix',
    'Nora',
    'Ravi',
    'Isla',
    'Jonas',
    'Maya',
    'Elias',
    'Yuki',
    'Diego',
    'Freya',
    'Samir',
    'Clara',
    'Tomas',
    'Aisha',
    'Hugo',
    'Ines',
    'Malik',
    'Elena',
    'Oscar',
    'Leila',
    'Finn',
    'Nina',
    'Ezra',
    'Anika',
    'Marco',
    'Sana',
    'Lucas',
    'Ruth',
    'Ivan',
    'Grace',
    'Tariq',
    'Julia',
    'Kenji',
  ],
  lastName: [
    'Nguyen',
    'Patel',
    'Garcia',
    'Okafor',
    'Kowalski',
    'Rossi',
    'Haddad',
    'Larsen',
    'Tanaka',
    'Murphy',
    'Silva',
    'Fischer',
    'Dubois',
    'Khan',
    'Novak',
    'Evans',
    'Costa',
    'Jansen',
    'Ito',
    'Moreau',
    'Ahmed',
    'Schmidt',
    'Brown',
    'Lopez',
    'Kim',
    'Petrov',
    'Walsh',
    'Romero',
    'Sato',
    'Hughes',
    'Mendes',
    'Berg',
    'Chen',
    'Park',
    'Ali',
    'Wright',
    'Ferreira',
    'Bauer',
    'Reyes',
    'Lindqvist',
  ],
  companyFirst: [
    'Harbor',
    'Bluegum',
    'Saltwater',
    'Northgate',
    'Copperline',
    'Ironbark',
    'Silverleaf',
    'Redwood',
    'Seabright',
    'Highfield',
    'Clearwater',
    'Stonebridge',
    'Goldcrest',
    'Pinecrest',
    'Brightpath',
    'Kestrel',
    'Lakeside',
    'Granite',
    'Summit',
    'Riverbend',
    'Meridian',
    'Oakline',
    'Westwind',
    'Cobalt',
    'Juniper',
    'Falcon',
    'Evergreen',
    'Larkspur',
    'Tidewater',
    'Sunridge',
  ],
  companyLast: [
    'Logistics',
    'Analytics',
    'Foods',
    'Health',
    'Energy',
    'Systems',
    'Partners',
    'Labs',
    'Retail',
    'Holdings',
    'Consulting',
    'Media',
    'Freight',
    'Engineering',
    'Capital',
    'Software',
    'Studios',
    'Supply',
    'Clinics',
    'Motors',
  ],
  city: [
    'Sydney',
    'Melbourne',
    'Brisbane',
    'Perth',
    'Auckland',
    'Singapore',
    'London',
    'Manchester',
    'Dublin',
    'Berlin',
    'Hamburg',
    'Amsterdam',
    'Paris',
    'Lyon',
    'Madrid',
    'Lisbon',
    'Milan',
    'Stockholm',
    'Oslo',
    'Toronto',
    'Vancouver',
    'Chicago',
    'Austin',
    'Denver',
    'Seattle',
    'Boston',
    'Tokyo',
    'Osaka',
    'Seoul',
    'Dubai',
  ],
  street: [
    'Harbour St',
    'King St',
    'George St',
    'Queen St',
    'Station Rd',
    'Park Ave',
    'Market St',
    'Victoria Rd',
    'High St',
    'Elm St',
    'Bridge Rd',
    'Mill Ln',
    'Church St',
    'Ocean Dr',
    'Hill St',
  ],
  title: [
    'CEO',
    'CFO',
    'CTO',
    'Head of Sales',
    'Sales Manager',
    'Account Executive',
    'Office Manager',
    'Procurement Lead',
    'Operations Manager',
    'IT Director',
    'Marketing Manager',
    'Accounts Payable',
    'Customer Success Lead',
    'Engineer',
  ],
  words: [
    'order',
    'delivery',
    'invoice',
    'renewal',
    'upgrade',
    'support',
    'contract',
    'account',
    'shipment',
    'request',
    'billing',
    'login',
    'report',
    'integration',
    'portal',
    'licence',
    'training',
    'warranty',
    'refund',
    'quote',
  ],
  sentence: [
    'Customer asked about the next delivery date.',
    'Invoice was sent twice by mistake.',
    'Cannot log in to the customer portal.',
    'Request to upgrade to the premium plan.',
    'Shipment arrived damaged, replacement needed.',
    'Question about the renewal price.',
    'Integration stopped sending orders last night.',
    'Wants a quote for twenty more licences.',
    'Report shows the wrong totals for March.',
    'Asked for training for two new staff.',
  ],
};

const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const between = (rand, lo, hi) => lo + rand() * (hi - lo);
const slug = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 30) || 'company';
const iso = (d) => d.toISOString().slice(0, 10);

/**
 * A generator for one run: it remembers what it gave so names and e-mails do not repeat, and counts for patterns.
 * `today` is fixed in tests.
 */
export function makeFaker(seed = 1, today = new Date()) {
  const rand = seeded(seed);
  const used = new Set();
  const unique = (make) => {
    for (let i = 0; i < 50; i++) {
      const v = make(i);
      if (!used.has(v)) {
        used.add(v);
        return v;
      }
    }
    const v = `${make(0)} ${used.size + 1}`;
    used.add(v);
    return v;
  };
  const f = {
    rand,
    pick: (list) => pick(rand, list),
    int: (lo, hi) => Math.floor(between(rand, lo, hi + 1)),
    firstName: () => pick(rand, LISTS.firstName),
    lastName: () => pick(rand, LISTS.lastName),
    company: () => unique(() => `${pick(rand, LISTS.companyFirst)} ${pick(rand, LISTS.companyLast)}`),
    city: () => pick(rand, LISTS.city),
    street: () => `${f.int(1, 480)} ${pick(rand, LISTS.street)}`,
    postalCode: () => String(f.int(1000, 9999)),
    title: () => pick(rand, LISTS.title),
    sentence: () => pick(rand, LISTS.sentence),
    words: (n = 3) =>
      Array.from({ length: n }, () => pick(rand, LISTS.words))
        .join(' ')
        .replace(/^./, (c) => c.toUpperCase()),
    /** E-mail from a person's name (or a word); always example.com. */
    email: (first = f.firstName(), last = f.lastName(), company = '') =>
      unique((i) => `${slug(first)}.${slug(last)}${i ? i + 1 : ''}@${company ? `${slug(company)}.` : ''}example.com`),
    url: (company = f.company()) => `https://${slug(company)}.example.com`,
    /** A pattern's # are digits: "+61 2 5550 ####". */
    digits: (pattern = '+61 2 5550 ####') => pattern.replace(/#/g, () => String(f.int(0, 9))),
    number: (lo = 0, hi = 1000, scale = 0) => Number(between(rand, lo, hi).toFixed(scale)),
    boolean: (chance = 0.5) => rand() < chance,
    /** A date `from`..`to` days from today. */
    date: (from = -365, to = 365) => iso(new Date(today.getTime() + f.int(from, to) * 86400000)),
    datetime: (from = -30, to = 30) =>
      new Date(today.getTime() + f.int(from * 24, to * 24) * 3600000).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    /** "Gold 20%, Silver 50%, Bronze 30%" or plain "a, b, c". */
    weighted: (spec) => {
      const items = String(spec)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const m = /^(.*?)\s+(\d+(?:\.\d+)?)%$/.exec(s);
          return m ? { v: m[1], w: Number(m[2]) } : { v: s, w: 1 };
        });
      if (!items.length) return null;
      const total = items.reduce((a, b) => a + b.w, 0);
      let r = rand() * total;
      for (const it of items) if ((r -= it.w) < 0) return it.v;
      return items[items.length - 1].v;
    },
  };
  return f;
}

/** A pattern: {0000} = the record's number with leading zeros, {n} = its number, {parent.Field} = its parent's value. */
export function fillPattern(pattern, n, parent = {}) {
  return String(pattern)
    .replace(/\{(0+)\}/g, (_, zeros) => String(n).padStart(zeros.length, '0'))
    .replace(/\{n\}/g, String(n))
    .replace(/\{parent\.(\w+)\}/g, (_, field) => String(parent[field] ?? ''));
}
