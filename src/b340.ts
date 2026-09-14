/**
 * 340B covered entities and their contract pharmacy networks.
 *
 * Source: HRSA OPAIS "Covered Entity Daily Export (JSON)", mirrored into
 * b340_covered_entity / b340_contract_pharmacy. The export cannot be fetched by
 * anything we run — see mcps/drug-prices/README.md and
 * supabase/migrations/169_340b_covered_entities.sql — so a human drops it
 * monthly and every answer here states the as_of it came from.
 *
 * The mirror deliberately holds NO authorizing-official or primary-contact
 * names or phone numbers, so no query here can return them.
 */

// HRSA's 23 entity-type codes. Callers say "hospital", not "DSH", so the
// families below are what the `type` argument actually resolves against; an
// exact code is still accepted. Without this an agent asking the obvious
// question gets zero rows and reads it as "no 340B hospitals in Texas".
export const ENTITY_TYPES: Record<string, string> = {
  DSH: 'Disproportionate share hospital',
  CAH: 'Critical access hospital',
  SCH: 'Sole community hospital',
  RRC: 'Rural referral center',
  PED: "Children's hospital",
  CAN: 'Free-standing cancer hospital',
  CH: 'Community health center',
  FQHCLA: 'Federally qualified health center look-alike',
  FQHC638: 'Tribal / urban Indian FQHC (Title V, P.L. 93-638)',
  UI: 'Urban Indian organization',
  NH: 'Native Hawaiian health center',
  HM: 'Health care for the homeless',
  FP: 'Title X family planning',
  STD: 'Sexually transmitted disease clinic',
  TB: 'Tuberculosis clinic',
  HV: 'Hemophilia treatment center',
  BL: 'Black lung clinic',
  RWI: 'Ryan White Part A',
  RWII: 'Ryan White Part B',
  RWIIR: 'Ryan White Part B — rebate',
  RWIID: 'Ryan White Part B — ADAP',
  RW4: 'Ryan White Part D',
  SPNS: 'Ryan White Special Projects of National Significance',
};

const TYPE_FAMILIES: Record<string, string[]> = {
  hospital: ['DSH', 'CAH', 'SCH', 'RRC', 'PED', 'CAN'],
  hospitals: ['DSH', 'CAH', 'SCH', 'RRC', 'PED', 'CAN'],
  'disproportionate share': ['DSH'],
  'critical access': ['CAH'],
  'sole community': ['SCH'],
  'rural referral': ['RRC'],
  rural: ['CAH', 'RRC'],
  children: ['PED'],
  "children's": ['PED'],
  pediatric: ['PED'],
  cancer: ['CAN'],
  'health center': ['CH', 'FQHCLA', 'FQHC638'],
  'health centers': ['CH', 'FQHCLA', 'FQHC638'],
  fqhc: ['CH', 'FQHCLA', 'FQHC638'],
  'community health center': ['CH'],
  'look-alike': ['FQHCLA'],
  tribal: ['FQHC638', 'UI', 'NH'],
  'urban indian': ['UI'],
  'native hawaiian': ['NH'],
  homeless: ['HM'],
  'family planning': ['FP'],
  std: ['STD'],
  sti: ['STD'],
  tuberculosis: ['TB'],
  tb: ['TB'],
  hemophilia: ['HV'],
  'black lung': ['BL'],
  'ryan white': ['RWI', 'RWII', 'RWIIR', 'RWIID', 'RW4', 'SPNS'],
  hiv: ['RWI', 'RWII', 'RWIIR', 'RWIID', 'RW4', 'SPNS'],
  aids: ['RWI', 'RWII', 'RWIIR', 'RWIID', 'RW4', 'SPNS'],
  'grantee': ['CH', 'FP', 'STD', 'TB', 'HM', 'BL', 'RWI', 'RWII', 'RW4'],
};

/** Returns the codes a caller's `type` means, or null if it means nothing. */
export function resolveTypes(raw: string): string[] | null {
  const t = raw.trim();
  if (!t) return null;
  const upper = t.toUpperCase();
  if (ENTITY_TYPES[upper]) return [upper];
  const lower = t.toLowerCase();
  if (TYPE_FAMILIES[lower]) return TYPE_FAMILIES[lower];
  // "children's hospitals" / "rural hospital" — try the longest family name the
  // caller's phrase contains, so a plural or an adjective does not fall through.
  const hit = Object.keys(TYPE_FAMILIES)
    .filter((k) => lower.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? TYPE_FAMILIES[hit] : null;
}

const US_STATES = new Set(
  ('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR ' +
   'PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI FM MH PW').split(' ')
);

const STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'puerto rico': 'PR', guam: 'GU', 'virgin islands': 'VI', 'american samoa': 'AS',
};

/** Agents pass "Texas" as often as "TX"; both resolve, anything else is named. */
export function resolveState(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const upper = t.toUpperCase();
  if (US_STATES.has(upper)) return upper;
  return STATE_NAMES[t.toLowerCase()] ?? null;
}
