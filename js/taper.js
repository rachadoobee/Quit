/**
 * taper.js — Tapering plan calculations
 *
 * KEY RULE: Week 1 is the first reduction week. There is NO baseline /
 * observation week. The programme starts reducing immediately from day 1,
 * but Week 1's allowance equals the starting daily usage (e.g. 10), so the
 * very first week is at the starting allowance and reductions begin in Week 2.
 *
 * Reduction: 25% per week, rounded to nearest whole number, minimum 1,
 * until the allowance would hit 0 — at which point we add a final "quit" week
 * with allowance 0.
 *
 * Example from 10/day:
 *   Week 1: 10, 2: 8, 3: 6, 4: 5, 5: 4, 6: 3, 7: 2, 8: 1, 9: 0 (quit)
 */

/**
 * Generate the default taper plan from a starting daily usage.
 * @param {number} startingUsage - whole number of pouches/day at the start.
 * @returns {Array<{week:number, allowance:number}>}
 */
function generateTaperPlan(startingUsage) {
  const plan = [];
  let allowance = Math.max(0, Math.round(startingUsage));

  // Week 1 sits at the starting allowance; reductions apply from week 2 on.
  let week = 1;
  plan.push({ week, allowance });

  // Reduce 25% each subsequent week, rounding to nearest whole, min 1,
  // until we reach 1, then append a final quit week at 0.
  while (allowance > 1) {
    week += 1;
    // 25% reduction => keep 75% of previous, rounded to nearest whole.
    let next = Math.round(allowance * 0.75);
    // Ensure we always make progress and never drop below 1 prematurely.
    if (next >= allowance) next = allowance - 1;
    if (next < 1) next = 1;
    allowance = next;
    plan.push({ week, allowance });
  }

  // Final quit week: allowance 0.
  if (allowance !== 0) {
    week += 1;
    plan.push({ week, allowance: 0 });
  }

  return plan;
}

/**
 * Generate a taper plan that reaches 0 by a chosen quit date, reducing by a
 * roughly constant amount each week (linear taper).
 *
 * Week 1 still sits at the starting usage (no free baseline week). The final
 * plan week — the one containing/at the quit date — has allowance 0. We spread
 * the reduction as evenly as possible across the weeks in between, rounding to
 * whole pouches.
 *
 * @param {number} startingUsage - whole pouches/day at the start.
 * @param {string|Date} startDate - programme start date.
 * @param {string|Date} quitDate - the date the user wants to be at 0.
 * @returns {Array<{week:number, allowance:number}>}
 */
function generatePlanForQuitDate(startingUsage, startDate, quitDate) {
  const start = startDate instanceof Date ? startDate : new Date(startDate);
  const quit = quitDate instanceof Date ? quitDate : new Date(quitDate);
  const startMid = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const quitMid = new Date(quit.getFullYear(), quit.getMonth(), quit.getDate());

  const begin = Math.max(0, Math.round(startingUsage));

  // Which programme week does the quit date fall in? Week 1 = days 1–7.
  const msPerDay = 24 * 60 * 60 * 1000;
  const dayIndex = Math.floor((quitMid - startMid) / msPerDay); // 0 = day 1
  // Quit week is where allowance becomes 0.
  let quitWeek = Math.floor(Math.max(0, dayIndex) / 7) + 1;

  // We need at least a week 2 to taper through (week 1 holds the start value).
  // If the quit date is too soon, fall back to the earliest sensible plan:
  // week 1 at start, week 2 at 0.
  if (quitWeek < 2) quitWeek = 2;

  // Weeks that actually reduce: weeks 2 .. (quitWeek - 1) step down from the
  // starting value to just above 0; week `quitWeek` is 0.
  // Number of reducing steps from `begin` down to 0:
  const steps = quitWeek - 1; // e.g. quitWeek 9 → 8 steps (weeks 2..9)

  const plan = [{ week: 1, allowance: begin }];
  for (let w = 2; w <= quitWeek; w++) {
    // Linear interpolation: at step i of `steps`, allowance = begin * (1 - i/steps).
    const i = w - 1; // 1-based step number
    let allowance = Math.round(begin * (1 - i / steps));
    if (allowance < 0) allowance = 0;
    // The final week must be exactly 0.
    if (w === quitWeek) allowance = 0;
    plan.push({ week: w, allowance });
  }

  // Guard against rounding leaving a flat stretch at the top: ensure the plan
  // is non-increasing and strictly reaches 0 at the end.
  for (let i = 1; i < plan.length; i++) {
    if (plan[i].allowance > plan[i - 1].allowance) {
      plan[i].allowance = plan[i - 1].allowance;
    }
  }

  return plan;
}

/**
 * Work out which programme week a given date falls in.
 * Week 1 = days 1–7 from the start date (start date itself is day 1).
 * @param {string} programmeStartDate - ISO string of the start date.
 * @param {Date} [today]
 * @returns {number} 1-based week number (can exceed the plan length).
 */
function getProgrammeWeek(programmeStartDate, today = new Date()) {
  const start = new Date(programmeStartDate);
  // Normalise both to local midnight so partial days don't shift the count.
  const startMid = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const msPerDay = 24 * 60 * 60 * 1000;
  const dayIndex = Math.floor((todayMid - startMid) / msPerDay); // 0 on day 1
  if (dayIndex < 0) return 1; // before the programme starts → treat as week 1
  return Math.floor(dayIndex / 7) + 1;
}

/**
 * Number of whole days since the programme started (day 1 = 1).
 * @param {string} programmeStartDate - ISO string.
 * @param {Date} [today]
 * @returns {number}
 */
function getDaysSinceStart(programmeStartDate, today = new Date()) {
  const start = new Date(programmeStartDate);
  const startMid = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const msPerDay = 24 * 60 * 60 * 1000;
  const diff = Math.floor((todayMid - startMid) / msPerDay);
  return diff < 0 ? 0 : diff + 1;
}

/**
 * Return today's allowance based on the stored plan and programme week.
 * If the programme has run past the end of the plan, the allowance is the
 * last week's value (0 once they reach the quit week).
 * @param {Array<{week:number, allowance:number}>} taperPlan
 * @param {string} programmeStartDate - ISO string.
 * @param {Date} [today]
 * @returns {number}
 */
function getTodayAllowance(taperPlan, programmeStartDate, today = new Date()) {
  if (!taperPlan || taperPlan.length === 0) return 0;
  const week = getProgrammeWeek(programmeStartDate, today);
  // Clamp to the available plan; beyond the plan, hold the final allowance.
  const entry =
    taperPlan.find((p) => p.week === week) || taperPlan[taperPlan.length - 1];
  return entry.allowance;
}

/**
 * Compute the allowance for a specific date (used for history/charts).
 * @param {Array<{week:number, allowance:number}>} taperPlan
 * @param {string} programmeStartDate - ISO string.
 * @param {string|Date} date
 * @returns {number}
 */
function getAllowanceForDate(taperPlan, programmeStartDate, date) {
  const d = date instanceof Date ? date : new Date(date);
  return getTodayAllowance(taperPlan, programmeStartDate, d);
}

/**
 * Project the calendar date for the start of each plan week.
 * Used to render "projected quit date" columns.
 * @param {Array<{week:number, allowance:number}>} taperPlan
 * @param {string} programmeStartDate - ISO string.
 * @returns {Array<{week:number, allowance:number, date:Date}>}
 */
function planWithDates(taperPlan, programmeStartDate) {
  const start = new Date(programmeStartDate);
  const startMid = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  return taperPlan.map((p) => {
    const date = new Date(startMid);
    date.setDate(startMid.getDate() + (p.week - 1) * 7);
    return { ...p, date };
  });
}

/**
 * The projected quit date — the start date of the first week whose
 * allowance is 0.
 * @param {Array<{week:number, allowance:number}>} taperPlan
 * @param {string} programmeStartDate - ISO string.
 * @returns {Date|null}
 */
function getProjectedQuitDate(taperPlan, programmeStartDate) {
  const dated = planWithDates(taperPlan, programmeStartDate);
  const quitWeek = dated.find((p) => p.allowance === 0);
  return quitWeek ? quitWeek.date : null;
}

window.Taper = {
  generateTaperPlan,
  generatePlanForQuitDate,
  getProgrammeWeek,
  getDaysSinceStart,
  getTodayAllowance,
  getAllowanceForDate,
  planWithDates,
  getProjectedQuitDate,
};
