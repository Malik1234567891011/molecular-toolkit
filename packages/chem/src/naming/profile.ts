/**
 * Naming conventions. The engine always produces structure-equivalent names; profiles only
 * choose which accepted form is shown first (spec §9.3, "course convention").
 */
export interface NamingProfile {
  id: string;
  label: string;
  /** '2013': longest chain first (current IUPAC). '1993': most multiple bonds first (older textbooks). */
  chainSeniority: '2013' | '1993';
  /** '2013': a ring always beats a chain. 'larger': the unit with more skeletal atoms wins (older textbooks). */
  ringVsChain: '2013' | 'larger';
  /** '2013': butan-2-ol, but-1-ene. 'traditional': 2-butanol, 1-butene. */
  locantStyle: '2013' | 'traditional';
  /** 'systematic': propan-2-yl. 'common': isopropyl. 'cas': 1-methylethyl. */
  substituentStyle: 'systematic' | 'common' | 'cas';
  /** 'pin': only names retained as IUPAC preferred names (phenol, benzoic acid, acetic acid …). 'common': also toluene, acetone, anisole … */
  retained: 'pin' | 'common' | 'none';
  /** Include the locant in single stereodescriptors: (2R) vs (R). */
  stereoLocants: boolean;
}

export const PROFILE_2013: NamingProfile = {
  id: 'iupac-2013',
  label: 'IUPAC 2013 (preferred names)',
  chainSeniority: '2013',
  ringVsChain: '2013',
  locantStyle: '2013',
  substituentStyle: 'systematic',
  retained: 'pin',
  stereoLocants: true,
};

export const PROFILE_TEXTBOOK: NamingProfile = {
  id: 'textbook-classic',
  label: 'Classic textbook (1979/1993 rules)',
  chainSeniority: '1993',
  ringVsChain: 'larger',
  locantStyle: 'traditional',
  substituentStyle: 'common',
  retained: 'common',
  stereoLocants: false,
};

export const PROFILE_MODERN_COURSE: NamingProfile = {
  id: 'modern-course',
  label: 'Modern course (2013 rules, common prefixes)',
  chainSeniority: '2013',
  ringVsChain: '2013',
  locantStyle: '2013',
  substituentStyle: 'common',
  retained: 'pin',
  stereoLocants: true,
};

export const PROFILES = [PROFILE_2013, PROFILE_MODERN_COURSE, PROFILE_TEXTBOOK];

export const ENGINE_VERSION = 'course-rules 1.0.0';
