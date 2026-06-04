/**
 * notifications.js — Notification scheduling
 *
 * Uses the Web Notifications API (via the Service Worker registration where
 * available, falling back to the Notification constructor). Because a static
 * PWA has no server to push from, "scheduling" here means: while the app/tab
 * is alive, we set timers that fire local notifications at the configured
 * times. On iOS this only works once installed to the Home Screen.
 *
 * The app is expected to call NotificationsManager.refresh(settings, context)
 * whenever settings change or the app loads, where `context` supplies the
 * live values the messages need (allowance, week, reasons, today's totals).
 */

// Keep track of pending timers so we can clear them on refresh.
let _timers = [];

/** Clear all scheduled timers. */
function clearTimers() {
  _timers.forEach((t) => clearTimeout(t));
  _timers = [];
}

/** Request permission from the user. Returns the resulting permission string. */
async function requestPermission() {
  if (!('Notification' in window)) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch (_e) {
    // Some older browsers use the callback form.
    return new Promise((resolve) => Notification.requestPermission(resolve));
  }
}

/** Whether we currently have permission to show notifications. */
function hasPermission() {
  return 'Notification' in window && Notification.permission === 'granted';
}

/**
 * Show a notification immediately. Prefers the service worker so that
 * notificationclick can route back into the app.
 */
async function showNotification(title, body) {
  if (!hasPermission()) return;
  const options = {
    body,
    icon: 'icons/icon-192.svg',
    badge: 'icons/icon-192.svg',
  };
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, options);
      return;
    } catch (_e) {
      /* fall through to the constructor */
    }
  }
  try {
    new Notification(title, options);
  } catch (_e) {
    /* ignore — e.g. constructor blocked on some platforms */
  }
}

/**
 * Compute the delay in ms from now until the next occurrence of HH:MM today
 * (or tomorrow if that time has already passed).
 * @param {string} hhmm - "08:00"
 * @returns {number} milliseconds
 */
function msUntil(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}

/** Pick a random reason, or a gentle fallback if none are set. */
function randomReason(reasons) {
  if (reasons && reasons.length) {
    return reasons[Math.floor(Math.random() * reasons.length)];
  }
  return 'Remember why you started.';
}

/**
 * Analyse log history to find the 2-hour window (by hour-of-day) containing
 * the most entries. Returns the START hour of that window, or null if there
 * isn't enough data (need 3+ distinct days).
 * @param {Array<{timestamp:string}>} logs
 * @returns {number|null} start hour 0–23 of the busiest 2-hour window
 */
function findPeakWindowStartHour(logs) {
  if (!logs || logs.length === 0) return null;

  // Require at least 3 distinct days of data.
  const days = new Set(logs.map((l) => l.timestamp.slice(0, 10)));
  if (days.size < 3) return null;

  // Count entries per hour of day.
  const perHour = new Array(24).fill(0);
  logs.forEach((l) => {
    const hour = new Date(l.timestamp).getHours();
    perHour[hour] += 1;
  });

  // Slide a 2-hour window and find the max sum (wrapping around midnight).
  let bestStart = 0;
  let bestSum = -1;
  for (let h = 0; h < 24; h++) {
    const sum = perHour[h] + perHour[(h + 1) % 24];
    if (sum > bestSum) {
      bestSum = sum;
      bestStart = h;
    }
  }
  return bestStart;
}

/**
 * Schedule all enabled notifications. Clears any existing timers first.
 *
 * @param {object} settings - the stored settings object.
 * @param {object} context - live values:
 *   {
 *     allowanceToday: number,
 *     programmeWeek: number,
 *     reasons: string[],
 *     getTodayCount: () => number,   // called at fire time for the summary
 *     logs: Array,                   // for craving-window analysis
 *   }
 */
function refresh(settings, context) {
  clearTimers();
  if (!settings || !settings.notifications || !hasPermission()) return;

  const n = settings.notifications;

  // --- Morning check-in ---
  if (n.morningEnabled && n.morningTime) {
    const delay = msUntil(n.morningTime);
    _timers.push(
      setTimeout(() => {
        showNotification(
          `Good morning — today's allowance is ${context.allowanceToday} pouches`,
          `You're on week ${context.programmeWeek} of your plan. You've got this.`
        );
        // Re-arm for the following day.
        refresh(settings, context);
      }, delay)
    );
  }

  // --- Evening summary ---
  if (n.eveningEnabled && n.eveningTime) {
    const delay = msUntil(n.eveningTime);
    _timers.push(
      setTimeout(() => {
        const count =
          typeof context.getTodayCount === 'function'
            ? context.getTodayCount()
            : 0;
        const limit = context.allowanceToday;
        if (count <= limit) {
          showNotification(
            'Evening summary',
            `Great day — you had ${count} of your ${limit} allowed pouches. ${randomReason(
              context.reasons
            )}`
          );
        } else {
          showNotification(
            'Evening summary',
            `You had ${count} pouches today (limit was ${limit}). Tomorrow is a fresh start.`
          );
        }
        refresh(settings, context);
      }, delay)
    );
  }

  // --- Craving alerts ---
  if (n.cravingEnabled) {
    const peakStart = findPeakWindowStartHour(context.logs);
    if (peakStart !== null) {
      // Fire 15 minutes before the window starts.
      let fireMinutes = peakStart * 60 - 15;
      if (fireMinutes < 0) fireMinutes += 24 * 60; // wrap
      const hh = String(Math.floor(fireMinutes / 60)).padStart(2, '0');
      const mm = String(fireMinutes % 60).padStart(2, '0');
      const delay = msUntil(`${hh}:${mm}`);
      _timers.push(
        setTimeout(() => {
          showNotification(
            'Heads up — this is often when cravings hit',
            `Remember: ${randomReason(context.reasons)}`
          );
          refresh(settings, context);
        }, delay)
      );
    }
  }
}

window.NotificationsManager = {
  requestPermission,
  hasPermission,
  showNotification,
  findPeakWindowStartHour,
  refresh,
  clearTimers,
};
