/**
 * achievements.js — Achievement definitions and unlock logic
 *
 * Each achievement is a plain object:
 *   { id, name, description, icon (emoji), category, isUnlocked(stats) }
 *
 * `isUnlocked(stats)` is a pure predicate. The caller (app.js) computes a
 * `stats` snapshot and passes it in. The stats contract is:
 *
 *   stats = {
 *     daysSinceStart: number,        // 1 on day 1
 *     currentStreak: number,         // consecutive within-allowance days incl. today
 *     longestStreak: number,         // best ever run of within-allowance days
 *     perfectCalendarWeek: boolean,  // 7 within-allowance days in one calendar week
 *     startingAllowance: number,     // original week-1 allowance
 *     currentAllowance: number,      // today's allowance from the plan
 *     completedWeek1AtStart: boolean,// finished week 1 at the starting allowance
 *     hadZeroDay: boolean,           // at least one full day with 0 pouches logged
 *     reachedQuitWeek: boolean,      // programme week >= 9 (or final plan week)
 *     moneySaved: number,            // £ saved so far
 *   }
 */

const ACHIEVEMENTS = [
  /* ---------------- Time-based ---------------- */
  {
    id: 'first-day',
    name: 'First step',
    description: 'Complete day 1 on the programme.',
    icon: '👣',
    category: 'time',
    isUnlocked: (s) => s.daysSinceStart >= 1,
  },
  {
    id: 'week-1',
    name: 'One week strong',
    description: '7 days on the programme.',
    icon: '📅',
    category: 'time',
    isUnlocked: (s) => s.daysSinceStart >= 7,
  },
  {
    id: 'fortnight',
    name: 'Fortnight fighter',
    description: '14 days on the programme.',
    icon: '🗓️',
    category: 'time',
    isUnlocked: (s) => s.daysSinceStart >= 14,
  },
  {
    id: 'month-1',
    name: 'One month',
    description: '30 days on the programme.',
    icon: '🌙',
    category: 'time',
    isUnlocked: (s) => s.daysSinceStart >= 30,
  },
  {
    id: 'streak-3',
    name: 'Streak: 3 days',
    description: '3 consecutive days within allowance.',
    icon: '🔥',
    category: 'time',
    isUnlocked: (s) => s.longestStreak >= 3,
  },
  {
    id: 'streak-7',
    name: 'Streak: 7 days',
    description: '7 consecutive days within allowance.',
    icon: '🔥',
    category: 'time',
    isUnlocked: (s) => s.longestStreak >= 7,
  },
  {
    id: 'streak-14',
    name: 'Streak: 14 days',
    description: '14 consecutive days within allowance.',
    icon: '🔥',
    category: 'time',
    isUnlocked: (s) => s.longestStreak >= 14,
  },
  {
    id: 'streak-30',
    name: 'Streak: 30 days',
    description: '30 consecutive days within allowance.',
    icon: '🔥',
    category: 'time',
    isUnlocked: (s) => s.longestStreak >= 30,
  },
  {
    id: 'perfect-week',
    name: 'Perfect week',
    description: '7 consecutive within-allowance days in the same calendar week.',
    icon: '⭐',
    category: 'time',
    isUnlocked: (s) => s.perfectCalendarWeek === true,
  },

  /* ---------------- Usage-based ---------------- */
  {
    id: 'first-reduction',
    name: 'First reduction',
    description: 'Complete week 1 at the starting allowance.',
    icon: '📉',
    category: 'usage',
    isUnlocked: (s) => s.completedWeek1AtStart === true,
  },
  {
    id: 'halfway',
    name: 'Halfway there',
    description: 'Daily allowance reaches 50% or less of the original.',
    icon: '🪜',
    category: 'usage',
    isUnlocked: (s) =>
      s.startingAllowance > 0 &&
      s.currentAllowance <= s.startingAllowance * 0.5,
  },
  {
    id: 'single-figures',
    name: 'Single figures',
    description: 'Daily allowance reaches 5 or fewer.',
    icon: '✋',
    category: 'usage',
    isUnlocked: (s) => s.currentAllowance <= 5,
  },
  {
    id: 'almost-free',
    name: 'Almost free',
    description: 'Daily allowance reaches 2 or fewer.',
    icon: '🕊️',
    category: 'usage',
    isUnlocked: (s) => s.currentAllowance <= 2,
  },
  {
    id: 'zero-day',
    name: 'Zero day',
    description: 'First day with 0 pouches logged.',
    icon: '🚫',
    category: 'usage',
    isUnlocked: (s) => s.hadZeroDay === true,
  },
  {
    id: 'quit-day',
    name: 'Quit day',
    description: 'Reach the quit week of your plan.',
    icon: '🏁',
    category: 'usage',
    isUnlocked: (s) => s.reachedQuitWeek === true,
  },

  /* ---------------- Money-based ---------------- */
  {
    id: 'tenner',
    name: 'First tenner',
    description: '£10 saved.',
    icon: '💷',
    category: 'money',
    isUnlocked: (s) => s.moneySaved >= 10,
  },
  {
    id: 'twenty-five',
    name: 'Twenty-five',
    description: '£25 saved.',
    icon: '💷',
    category: 'money',
    isUnlocked: (s) => s.moneySaved >= 25,
  },
  {
    id: 'fifty',
    name: 'Fifty quid',
    description: '£50 saved.',
    icon: '💰',
    category: 'money',
    isUnlocked: (s) => s.moneySaved >= 50,
  },
  {
    id: 'hundred',
    name: 'Three figures',
    description: '£100 saved.',
    icon: '💰',
    category: 'money',
    isUnlocked: (s) => s.moneySaved >= 100,
  },
  {
    id: 'two-hundred',
    name: 'Two hundred',
    description: '£200 saved.',
    icon: '🏆',
    category: 'money',
    isUnlocked: (s) => s.moneySaved >= 200,
  },
];

/**
 * Given a stats snapshot and the set of already-unlocked ids, return the
 * list of achievement ids that should be newly unlocked.
 * @param {object} stats
 * @param {Set<string>|Array<string>} alreadyUnlocked
 * @returns {string[]} newly-unlocked ids
 */
function getNewlyUnlocked(stats, alreadyUnlocked) {
  const have =
    alreadyUnlocked instanceof Set
      ? alreadyUnlocked
      : new Set(alreadyUnlocked);
  return ACHIEVEMENTS.filter(
    (a) => !have.has(a.id) && a.isUnlocked(stats)
  ).map((a) => a.id);
}

/** Look up an achievement definition by id. */
function getAchievement(id) {
  return ACHIEVEMENTS.find((a) => a.id === id) || null;
}

window.Achievements = {
  ALL: ACHIEVEMENTS,
  getNewlyUnlocked,
  getAchievement,
};
