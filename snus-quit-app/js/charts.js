/**
 * charts.js — Chart rendering via Chart.js (loaded from CDN in index.html)
 *
 * Provides three render functions used by the Progress screen. Each takes a
 * canvas element and the pre-computed data series, builds a Chart.js chart,
 * and returns the Chart instance so the caller can destroy it before re-render.
 *
 * All colour decisions (green/amber/red per bar) are made by the caller and
 * passed in, keeping this module purely about drawing.
 */

// Shared palette pulled from CSS variables so charts match the theme.
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

const COLORS = {
  green: () => cssVar('--accent', '#22c55e'),
  amber: () => '#f59e0b',
  red: () => '#ef4444',
  muted: () => cssVar('--muted', '#6b7280'),
  text: () => cssVar('--text', '#111111'),
};

/**
 * Decide a bar's colour from usage vs allowance.
 * green = within, amber = exactly 1 over, red = 2+ over.
 */
function usageColor(usage, allowance) {
  const over = usage - allowance;
  if (over <= 0) return COLORS.green();
  if (over === 1) return COLORS.amber();
  return COLORS.red();
}

/**
 * Chart 1 — Daily usage (last 14 days) as a colour-coded bar chart with a
 * per-bar allowance reference (drawn as a stepped dashed line dataset).
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{label:string, usage:number, allowance:number}>} days
 * @returns {Chart}
 */
function renderDailyUsage(canvas, days) {
  const labels = days.map((d) => d.label);
  const usage = days.map((d) => d.usage);
  const allowances = days.map((d) => d.allowance);
  const barColors = days.map((d) => usageColor(d.usage, d.allowance));

  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Pouches',
          data: usage,
          backgroundColor: barColors,
          borderRadius: 4,
          order: 2,
        },
        {
          // Allowance shown as a dashed stepped line over the bars.
          type: 'line',
          label: 'Allowance',
          data: allowances,
          borderColor: COLORS.muted(),
          borderDash: [6, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          stepped: true,
          fill: false,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: COLORS.text() } } },
      scales: {
        x: { ticks: { color: COLORS.muted() }, grid: { display: false } },
        y: {
          beginAtZero: true,
          ticks: { color: COLORS.muted(), precision: 0 },
          grid: { color: 'rgba(128,128,128,0.15)' },
        },
      },
    },
  });
}

/**
 * Chart 2 — Actual vs taper plan (line chart).
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{week:number, actual:number|null, target:number}>} weeks
 * @returns {Chart}
 */
function renderActualVsPlan(canvas, weeks) {
  const labels = weeks.map((w) => `Wk ${w.week}`);
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Actual usage',
          data: weeks.map((w) => w.actual),
          borderColor: COLORS.green(),
          backgroundColor: 'transparent',
          tension: 0.25,
          spanGaps: true,
        },
        {
          label: 'Target plan',
          data: weeks.map((w) => w.target),
          borderColor: COLORS.muted(),
          borderDash: [6, 4],
          backgroundColor: 'transparent',
          tension: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: COLORS.text() } } },
      scales: {
        x: { ticks: { color: COLORS.muted() }, grid: { display: false } },
        y: {
          beginAtZero: true,
          ticks: { color: COLORS.muted() },
          grid: { color: 'rgba(128,128,128,0.15)' },
        },
      },
    },
  });
}

/**
 * Chart 3 — Cumulative money saved (line chart) with milestone annotations
 * drawn as labelled points where the cumulative line crosses each threshold.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{label:string, cumulative:number}>} points
 * @returns {Chart}
 */
function renderMoneySaved(canvas, points) {
  const labels = points.map((p) => p.label);
  const data = points.map((p) => p.cumulative);
  const milestones = [10, 25, 50, 100, 200];

  // Mark the first point that reaches each milestone with a larger dot.
  const pointRadius = points.map((p, i) => {
    const prev = i > 0 ? points[i - 1].cumulative : 0;
    const crossed = milestones.some((m) => prev < m && p.cumulative >= m);
    return crossed ? 5 : 0;
  });

  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Money saved (£)',
          data,
          borderColor: COLORS.green(),
          backgroundColor: 'rgba(34,197,94,0.12)',
          fill: true,
          tension: 0.25,
          pointRadius,
          pointBackgroundColor: COLORS.green(),
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: COLORS.text() } },
        tooltip: {
          callbacks: {
            label: (ctx) => `£${ctx.parsed.y.toFixed(2)} saved`,
          },
        },
      },
      scales: {
        x: { ticks: { color: COLORS.muted() }, grid: { display: false } },
        y: {
          beginAtZero: true,
          ticks: {
            color: COLORS.muted(),
            callback: (v) => `£${v}`,
          },
          grid: { color: 'rgba(128,128,128,0.15)' },
        },
      },
    },
  });
}

window.Charts = {
  usageColor,
  renderDailyUsage,
  renderActualVsPlan,
  renderMoneySaved,
};
