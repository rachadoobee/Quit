/**
 * app.js — Main application: routing, onboarding, screens, stats, modals.
 *
 * Depends on (loaded before this file):
 *   window.DB, window.Taper, window.Achievements,
 *   window.NotificationsManager, window.Charts
 *
 * The app is a single page. We render the active tab into #app-main and keep a
 * small amount of in-memory state (the loaded settings + cached logs) that we
 * refresh from IndexedDB whenever data changes.
 */

(() => {
  'use strict';

  /* ============================================================== */
  /* State                                                          */
  /* ============================================================== */

  const state = {
    settings: null,      // loaded settings object
    logs: [],            // all logs, oldest → newest
    activeTab: 'home',   // home | progress | history | settings
    historyView: 'list', // list | calendar
    calendarMonth: null, // Date for the calendar month being viewed
    chartInstances: [],  // live Chart.js instances to destroy on re-render
    reasonCycleIndex: 0, // for "Remind me why" cycling
  };

  // Defaults requested in the brief.
  const DEFAULTS = {
    dailyBaseline: 10,
    packCost: 6.5,
    pouchesPerPack: 20,
  };

  const REASON_PLACEHOLDERS = [
    'What will you do with the money you save?',
    'How will you feel in 3 months?',
    'Who are you doing this for?',
  ];

  const HEALTH_MILESTONES = [
    { mins: 20 / 60, label: '20 min', text: 'Heart rate and blood pressure begin to drop' },
    { mins: 8, label: '8 hours', text: 'Nicotine and carbon monoxide levels reduce by half' },
    { mins: 24, label: '24 hours', text: 'Carbon monoxide cleared from body' },
    { mins: 48, label: '48 hours', text: 'Nicotine fully cleared; taste and smell improve' },
    { mins: 72, label: '72 hours', text: 'Breathing easier; energy increases' },
    { mins: 24 * 14, label: '2 weeks', text: 'Circulation improves' },
    { mins: 24 * 30, label: '1 month', text: 'Skin and gum health starts recovering' },
    { mins: 24 * 90, label: '3 months', text: 'Lung function improves significantly' },
    { mins: 24 * 180, label: '6 months', text: 'Craving-related stress substantially reduced' },
    { mins: 24 * 365, label: '1 year', text: 'Risk of mouth and throat conditions significantly reduced' },
  ];

  /* ============================================================== */
  /* Small DOM helpers                                              */
  /* ============================================================== */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Create an element with attrs and children. */
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v !== null && v !== undefined) {
        node.setAttribute(k, v);
      }
    });
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function fmtMoney(n) {
    return `£${(n || 0).toFixed(2)}`;
  }

  function fmtDate(d) {
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /* ============================================================== */
  /* Stats computation                                              */
  /* ============================================================== */

  /** Count today's logs. */
  function todayCount() {
    const key = DB.toDateKey(new Date());
    return state.logs.filter((l) => DB.toDateKey(l.timestamp) === key).length;
  }

  /** Build a map of dateKey → count from all logs. */
  function countsByDay() {
    const map = new Map();
    state.logs.forEach((l) => {
      const k = DB.toDateKey(l.timestamp);
      map.set(k, (map.get(k) || 0) + 1);
    });
    return map;
  }

  /** Iterate each programme day from start → today, yielding {date,key}. */
  function eachProgrammeDay() {
    const out = [];
    if (!state.settings) return out;
    const start = new Date(state.settings.programmeStartDate);
    const startMid = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const today = new Date();
    const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const d = new Date(startMid);
    while (d <= todayMid) {
      out.push({ date: new Date(d), key: DB.toDateKey(d) });
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  /** Money saved = sum over days of (baseline daily cost − actual spend). */
  function computeMoneySaved() {
    if (!state.settings) return 0;
    const costPerPouch = state.settings.packCost / state.settings.pouchesPerPack;
    const baselineDailyCost = state.settings.dailyBaseline * costPerPouch;
    const counts = countsByDay();
    let saved = 0;
    eachProgrammeDay().forEach(({ key }) => {
      const actual = counts.get(key) || 0;
      saved += baselineDailyCost - actual * costPerPouch;
    });
    return Math.max(0, saved);
  }

  /** Current streak of consecutive within-allowance days ending today. */
  function computeStreaks() {
    const counts = countsByDay();
    const days = eachProgrammeDay();
    let current = 0;
    let longest = 0;
    let run = 0;
    days.forEach(({ date, key }) => {
      const usage = counts.get(key) || 0;
      const allowance = Taper.allowanceOnDate(state.settings, date);
      if (usage <= allowance) {
        run += 1;
        longest = Math.max(longest, run);
      } else {
        run = 0;
      }
    });
    // Current streak = trailing run of within-allowance days.
    for (let i = days.length - 1; i >= 0; i--) {
      const { date, key } = days[i];
      const usage = counts.get(key) || 0;
      const allowance = Taper.allowanceOnDate(state.settings, date);
      if (usage <= allowance) current += 1;
      else break;
    }
    return { current, longest };
  }

  /** Detect a perfect calendar week: 7 within-allowance days in one ISO-ish week. */
  function hasPerfectCalendarWeek() {
    const counts = countsByDay();
    const days = eachProgrammeDay();
    // Group by year-week (week starts Monday).
    const groups = new Map();
    days.forEach(({ date, key }) => {
      const usage = counts.get(key) || 0;
      const allowance = Taper.allowanceOnDate(state.settings, date);
      const within = usage <= allowance;
      // Compute Monday-based week key.
      const tmp = new Date(date);
      const dow = (tmp.getDay() + 6) % 7; // 0 = Monday
      tmp.setDate(tmp.getDate() - dow);
      const wk = DB.toDateKey(tmp);
      if (!groups.has(wk)) groups.set(wk, []);
      groups.get(wk).push(within);
    });
    for (const arr of groups.values()) {
      if (arr.length === 7 && arr.every(Boolean)) return true;
    }
    return false;
  }

  /** Whether any completed programme day had zero pouches logged. */
  function hadZeroDay() {
    const counts = countsByDay();
    const days = eachProgrammeDay();
    // Exclude today (still in progress) — only count completed days.
    for (let i = 0; i < days.length - 1; i++) {
      if ((counts.get(days[i].key) || 0) === 0) return true;
    }
    return false;
  }

  /** Build the stats snapshot consumed by achievements.js. */
  function buildStats() {
    const s = state.settings;
    const daysSinceStart = Taper.getDaysSinceStart(s.programmeStartDate);
    const currentAllowance = Taper.allowanceToday(s);
    const { current, longest } = computeStreaks();

    // starting allowance + "reached quit" differ by plan type.
    let startingAllowance;
    let reachedQuit;
    if (s.planType === 'phases') {
      startingAllowance = s.phases && s.phases[0] ? s.phases[0].count : s.dailyBaseline;
      const totalDays = Taper.phasePlanLengthDays(s.phases);
      reachedQuit = daysSinceStart > totalDays && totalDays > 0;
    } else {
      startingAllowance = s.taperPlan[0] ? s.taperPlan[0].allowance : s.dailyBaseline;
      const week = Taper.getProgrammeWeek(s.programmeStartDate);
      const finalWeek = s.taperPlan[s.taperPlan.length - 1].week;
      reachedQuit =
        week >= finalWeek &&
        s.taperPlan[s.taperPlan.length - 1].allowance === 0;
    }

    return {
      daysSinceStart,
      currentStreak: current,
      longestStreak: longest,
      perfectCalendarWeek: hasPerfectCalendarWeek(),
      startingAllowance,
      currentAllowance,
      completedWeek1AtStart: daysSinceStart > 7, // finished the whole of week 1
      hadZeroDay: hadZeroDay(),
      reachedQuitWeek: reachedQuit,
      moneySaved: computeMoneySaved(),
    };
  }

  /** Check for and persist newly-unlocked achievements; toast each one. */
  async function checkAchievements() {
    const stats = buildStats();
    const unlocked = await DB.getUnlockedAchievements();
    const have = new Set(unlocked.map((u) => u.id));
    const newly = Achievements.getNewlyUnlocked(stats, have);
    for (const id of newly) {
      const ok = await DB.unlockAchievement(id);
      if (ok) {
        const a = Achievements.getAchievement(id);
        showToast(`${a.icon} ${a.name} unlocked!`);
      }
    }
  }

  /* ============================================================== */
  /* Toast + Modal                                                  */
  /* ============================================================== */

  function showToast(message) {
    const toast = el('div', { class: 'toast' }, message);
    $('#toast-root').appendChild(toast);
    // Force reflow then animate in.
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  /**
   * Open a modal. `content` is a DOM node. Returns a close() function.
   */
  function openModal(content) {
    const root = $('#modal-root');
    const overlay = el('div', { class: 'modal-overlay' });
    const box = el('div', { class: 'modal' }, [content]);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    root.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    function close() {
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 250);
    }
    return close;
  }

  function randomReason() {
    const r = state.settings.reasons;
    if (!r || !r.length) return 'Remember why you started.';
    return r[Math.floor(Math.random() * r.length)];
  }

  /* ============================================================== */
  /* Data refresh                                                   */
  /* ============================================================== */

  async function reload() {
    state.settings = await DB.getSettings();
    state.logs = await DB.getLogs();
  }

  /** Recompute notification schedule from current state. */
  function refreshNotifications() {
    if (!state.settings) return;
    NotificationsManager.refresh(state.settings, {
      allowanceToday: Taper.allowanceToday(state.settings),
      programmeWeek: Taper.getProgrammeWeek(state.settings.programmeStartDate),
      reasons: state.settings.reasons,
      getTodayCount: todayCount,
      logs: state.logs,
    });
  }

  /* ============================================================== */
  /* ONBOARDING                                                     */
  /* ============================================================== */

  function startOnboarding() {
    // Working draft built across the steps.
    const draft = {
      name: '',
      dailyBaseline: DEFAULTS.dailyBaseline,
      packCost: DEFAULTS.packCost,
      pouchesPerPack: DEFAULTS.pouchesPerPack,
      planType: 'weekly',
      taperPlan: Taper.generateTaperPlan(DEFAULTS.dailyBaseline),
      phases: [],
      reasons: [],
      notifications: {
        morningEnabled: true,
        morningTime: '08:00',
        eveningEnabled: true,
        eveningTime: '21:00',
        cravingEnabled: false,
      },
    };
    let step = 1;

    const main = $('#app-main');
    $('#bottom-nav').style.display = 'none';
    $('#app-header').style.display = 'none';

    function render() {
      main.innerHTML = '';
      main.appendChild(el('div', { class: 'onboarding' }, [
        el('div', { class: 'onboard-progress' },
          [1, 2, 3, 4].map((n) =>
            el('span', { class: 'dot' + (n === step ? ' active' : n < step ? ' done' : '') })
          )
        ),
        stepNode(),
      ]));
    }

    function stepNode() {
      if (step === 1) return stepAbout();
      if (step === 2) return stepPlan();
      if (step === 3) return stepReasons();
      return stepNotifications();
    }

    /* --- Step 1: About you --- */
    function stepAbout() {
      const wrap = el('div', { class: 'card' }, [
        el('h2', {}, 'About you'),
        field('Name (optional)', input('text', draft.name, (v) => (draft.name = v))),
        field('Daily usage', numInput(draft.dailyBaseline, (v) => (draft.dailyBaseline = v), 0)),
        field('Pack cost (£)', numInput(draft.packCost, (v) => (draft.packCost = v), 0, 0.01)),
        field('Pouches per pack', numInput(draft.pouchesPerPack, (v) => (draft.pouchesPerPack = v), 1)),
        el('button', {
          class: 'btn-primary',
          onClick: () => {
            // Recalculate plan from the (possibly changed) daily usage.
            draft.taperPlan = Taper.generateTaperPlan(draft.dailyBaseline);
            step = 2;
            render();
          },
        }, 'Next'),
      ]);
      return wrap;
    }

    /* --- Step 2: Tapering plan --- */
    function stepPlan() {
      const startISO = new Date().toISOString(); // preview dates from today

      // Holds the editable table; rebuilt when a quit date is chosen.
      const tableWrap = el('div');
      function buildTable() {
        tableWrap.innerHTML = '';
        tableWrap.appendChild(
          planTable(draft.taperPlan, startISO, (week, val) => {
            const row = draft.taperPlan.find((p) => p.week === week);
            if (row) row.allowance = val;
          })
        );
      }
      buildTable();

      // Quit-date picker: default 8 weeks out, min = next week.
      const defaultQuit = new Date();
      defaultQuit.setDate(defaultQuit.getDate() + 56);
      const minQuit = new Date();
      minQuit.setDate(minQuit.getDate() + 7);
      const quitPicker = el('input', {
        type: 'date',
        value: DB.toDateKey(defaultQuit),
        min: DB.toDateKey(minQuit),
      });

      const quitRow = el('div', { class: 'card quit-picker' }, [
        el('div', { class: 'field' }, [
          el('span', {}, 'Want to quit by a set date? Pick it and we’ll build the plan.'),
          quitPicker,
        ]),
        el('button', {
          class: 'btn-secondary',
          onClick: () => {
            draft.taperPlan = Taper.generatePlanForQuitDate(
              draft.dailyBaseline,
              startISO,
              new Date(quitPicker.value + 'T00:00:00')
            );
            buildTable();
            showToast('Plan built for your quit date.');
          },
        }, 'Build plan for this date'),
      ]);

      return el('div', { class: 'card' }, [
        el('h2', {}, 'Your tapering plan'),
        el('p', { class: 'muted' }, 'Week 1 starts at your current usage. You can override any week, or set a quit date below to auto-build the plan.'),
        tableWrap,
        quitRow,
        el('div', { class: 'row-gap' }, [
          el('button', { class: 'btn-secondary', onClick: () => { step = 1; render(); } }, 'Back'),
          el('button', { class: 'btn-primary', onClick: () => { step = 3; render(); } }, 'Confirm plan'),
        ]),
      ]);
    }

    /* --- Step 3: Reasons --- */
    function stepReasons() {
      const listWrap = el('div', { class: 'reason-list' });
      function renderList() {
        listWrap.innerHTML = '';
        draft.reasons.forEach((r, i) => {
          listWrap.appendChild(el('div', { class: 'reason-item' }, [
            el('span', {}, r),
            el('button', {
              class: 'link-danger', onClick: () => {
                draft.reasons.splice(i, 1);
                renderList();
              },
            }, '✕'),
          ]));
        });
      }
      renderList();

      const placeholder =
        REASON_PLACEHOLDERS[draft.reasons.length % REASON_PLACEHOLDERS.length];
      const inputEl = el('input', { type: 'text', placeholder, class: 'reason-input' });

      function add() {
        const v = inputEl.value.trim();
        if (!v) return;
        draft.reasons.push(v);
        inputEl.value = '';
        inputEl.placeholder =
          REASON_PLACEHOLDERS[draft.reasons.length % REASON_PLACEHOLDERS.length];
        renderList();
      }
      inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

      return el('div', { class: 'card' }, [
        el('h2', {}, 'Why are you quitting?'),
        listWrap,
        el('div', { class: 'reason-entry' }, [
          inputEl,
          el('button', { class: 'btn-secondary', onClick: add }, 'Add reason'),
        ]),
        el('div', { class: 'row-gap' }, [
          el('button', { class: 'btn-secondary', onClick: () => { step = 2; render(); } }, 'Back'),
          el('button', {
            class: 'btn-primary',
            onClick: () => {
              if (draft.reasons.length < 1) {
                showToast('Add at least one reason to continue.');
                return;
              }
              step = 4;
              render();
            },
          }, 'Next'),
        ]),
      ]);
    }

    /* --- Step 4: Notifications --- */
    function stepNotifications() {
      const n = draft.notifications;
      return el('div', { class: 'card' }, [
        el('h2', {}, 'Notifications'),
        toggleRow('Morning check-in', n.morningEnabled, (v) => (n.morningEnabled = v),
          timeInput(n.morningTime, (v) => (n.morningTime = v))),
        toggleRow('Evening summary', n.eveningEnabled, (v) => (n.eveningEnabled = v),
          timeInput(n.eveningTime, (v) => (n.eveningTime = v))),
        toggleRow('Craving alerts', n.cravingEnabled, (v) => (n.cravingEnabled = v)),
        el('p', { class: 'muted small' }, 'You can change these anytime in Settings.'),
        el('div', { class: 'row-gap' }, [
          el('button', { class: 'btn-secondary', onClick: () => { step = 3; render(); } }, 'Back'),
          el('button', {
            class: 'btn-primary',
            onClick: async () => {
              // Request permission if any notification type is on.
              if (n.morningEnabled || n.eveningEnabled || n.cravingEnabled) {
                await NotificationsManager.requestPermission();
              }
              await finishOnboarding(draft);
            },
          }, 'Finish'),
        ]),
      ]);
    }

    render();
  }

  async function finishOnboarding(draft) {
    const settings = {
      id: 1,
      name: draft.name || '',
      dailyBaseline: draft.dailyBaseline,
      packCost: draft.packCost,
      pouchesPerPack: draft.pouchesPerPack,
      programmeStartDate: new Date().toISOString(),
      planType: draft.planType || 'weekly',
      taperPlan: draft.taperPlan,
      phases: draft.phases || [],
      reasons: draft.reasons,
      notifications: draft.notifications,
      planHistory: [],
      setupComplete: true,
    };
    await DB.saveSettings(settings);
    await reload();
    $('#bottom-nav').style.display = '';
    $('#app-header').style.display = '';
    refreshNotifications();
    await checkAchievements();
    navigate('home');
  }

  /* ============================================================== */
  /* Reusable form widgets                                          */
  /* ============================================================== */

  function field(label, control) {
    return el('label', { class: 'field' }, [el('span', {}, label), control]);
  }
  function input(type, value, onInput) {
    const i = el('input', { type, value: value ?? '' });
    i.addEventListener('input', (e) => onInput(e.target.value));
    return i;
  }
  function numInput(value, onInput, min = 0, step = 1) {
    const i = el('input', { type: 'number', value, min, step });
    i.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      onInput(Number.isNaN(v) ? 0 : v);
    });
    return i;
  }
  function timeInput(value, onInput) {
    const i = el('input', { type: 'time', value });
    i.addEventListener('input', (e) => onInput(e.target.value));
    return i;
  }
  function toggleRow(label, checked, onChange, extra) {
    const cb = el('input', { type: 'checkbox', class: 'toggle' });
    cb.checked = checked;
    cb.addEventListener('change', (e) => onChange(e.target.checked));
    return el('div', { class: 'toggle-row' }, [
      el('span', {}, label),
      el('div', { class: 'toggle-right' }, [extra || null, cb]),
    ]);
  }

  /**
   * Build an editable taper plan table.
   * onEdit(week, newAllowance) fires when a cell changes.
   */
  function planTable(plan, startISO, onEdit) {
    const tbody = el('tbody');
    function rebuild() {
      tbody.innerHTML = '';
      const dated = Taper.planWithDates(plan, startISO);
      dated.forEach((p) => {
        const allowInput = el('input', {
          type: 'number', min: 0, value: p.allowance, class: 'cell-input',
        });
        allowInput.addEventListener('input', (e) => {
          const v = Math.max(0, parseInt(e.target.value, 10) || 0);
          onEdit(p.week, v);
          // Recompute the projected dates live.
          rebuild();
        });
        tbody.appendChild(el('tr', {}, [
          el('td', {}, String(p.week)),
          el('td', {}, allowInput),
          el('td', {}, p.allowance === 0 ? `Quit · ${fmtDate(p.date)}` : fmtDate(p.date)),
        ]));
      });
    }
    rebuild();
    return el('table', { class: 'plan-table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, 'Week'),
        el('th', {}, 'Allowance'),
        el('th', {}, 'Projected date'),
      ])),
      tbody,
    ]);
  }

  /* ============================================================== */
  /* SCREEN: HOME                                                   */
  /* ============================================================== */

  function renderHome() {
    const s = state.settings;
    const allowance = Taper.allowanceToday(s);
    const count = todayCount();
    const week = Taper.getProgrammeWeek(s.programmeStartDate);
    const daysSince = Taper.getDaysSinceStart(s.programmeStartDate);
    const strength = Taper.strengthToday(s);
    const { current } = computeStreaks();
    const saved = computeMoneySaved();

    // Stat colour for pouches today.
    let countClass = 'stat-green';
    const over = count - allowance;
    if (over === 1) countClass = 'stat-amber';
    else if (over >= 2) countClass = 'stat-red';

    const main = $('#app-main');
    main.innerHTML = '';

    const grid = el('div', { class: 'stats-grid' }, [
      statCard('Pouches today', `${count} / ${allowance}`, countClass),
      statCard('Current streak', `${current}`, '', 'days'),
      statCard('Days on programme', `${daysSince}`, ''),
      statCard('Money saved', fmtMoney(saved), 'stat-green'),
    ]);

    // Big circular log button.
    const logBtn = el('button', { class: 'log-button', 'aria-label': 'Log a pouch' }, [
      el('span', { class: 'log-button-label' }, 'Log a pouch'),
    ]);
    logBtn.addEventListener('click', () => onLogTap(logBtn));

    const undoLink = el('a', { class: 'undo-link', href: '#' }, 'Undo last log');
    undoLink.addEventListener('click', async (e) => {
      e.preventDefault();
      await undoLastToday();
    });
    if (count < 1) undoLink.style.display = 'none';

    const remindBtn = el('button', { class: 'btn-secondary remind-btn' }, 'Remind me why');
    remindBtn.addEventListener('click', showReasonModal);

    // Taper strip. Phase plans show the phase + strength; weekly plans show the week.
    const pct = allowance > 0 ? Math.min(100, (count / allowance) * 100) : (count > 0 ? 100 : 0);
    let stripLabel;
    if (s.planType === 'phases') {
      const phase = Taper.getPhaseForDate(s.phases, s.programmeStartDate, new Date());
      const phaseNum = phase && phase.index >= 0 ? phase.index + 1 : '–';
      const strengthBit = strength ? ` · ${strength}` : '';
      stripLabel = `Phase ${phaseNum}${strengthBit} · ${allowance} pouches allowed today`;
    } else {
      stripLabel = `Week ${week} of your plan · ${allowance} pouches allowed today`;
    }
    const strip = el('div', { class: 'card taper-strip' }, [
      el('div', { class: 'taper-strip-label' }, stripLabel),
      el('div', { class: 'progress-track' }, [
        el('div', { class: 'progress-fill', style: `width:${pct}%` }),
      ]),
    ]);

    main.appendChild(el('div', { class: 'home' }, [
      grid,
      el('div', { class: 'log-area' }, [
        logBtn,
        undoLink,
        remindBtn,
      ]),
      strip,
    ]));
  }

  function statCard(label, value, valueClass = '', unit = '') {
    return el('div', { class: 'card stat-card' }, [
      el('div', { class: 'stat-label' }, label),
      el('div', { class: `stat-value ${valueClass}` }, [
        document.createTextNode(value),
        unit ? el('span', { class: 'stat-unit' }, ` ${unit}`) : null,
      ]),
    ]);
  }

  async function onLogTap(btn) {
    const s = state.settings;
    const allowance = Taper.allowanceToday(s);
    const count = todayCount();

    if (count >= allowance) {
      // Over-limit modal.
      showOverLimitModal(btn);
      return;
    }
    await doLog(btn);
  }

  async function doLog(btn) {
    await DB.addLog();
    await reload();
    // Scale animation.
    if (btn) {
      btn.classList.remove('pulse');
      void btn.offsetWidth; // reflow to restart animation
      btn.classList.add('pulse');
    }
    await checkAchievements();
    refreshNotifications();
    renderHome();
  }

  function showOverLimitModal(btn) {
    const content = el('div', {}, [
      el('h3', {}, "You're over today's limit"),
      el('p', { class: 'muted' }, randomReason()),
      el('div', { class: 'row-gap' }, [
        el('button', {
          class: 'btn-secondary',
          onClick: () => close(),
        }, "I'll resist"),
        el('button', {
          class: 'btn-primary',
          onClick: async () => {
            close();
            await doLog(btn);
          },
        }, 'Log it anyway'),
      ]),
    ]);
    const close = openModal(content);
  }

  function showReasonModal() {
    const reasons = state.settings.reasons || [];
    const textNode = el('p', { class: 'reason-display' }, randomReason());
    const next = el('a', { class: 'link', href: '#' }, 'Next reason');
    next.addEventListener('click', (e) => {
      e.preventDefault();
      if (reasons.length <= 1) return;
      state.reasonCycleIndex = (state.reasonCycleIndex + 1) % reasons.length;
      textNode.textContent = reasons[state.reasonCycleIndex];
    });
    openModal(el('div', {}, [
      el('h3', {}, 'Remember why'),
      textNode,
      reasons.length > 1 ? next : null,
    ]));
  }

  async function undoLastToday() {
    const key = DB.toDateKey(new Date());
    const todays = state.logs
      .filter((l) => DB.toDateKey(l.timestamp) === key)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    if (!todays.length) return;
    await DB.deleteLog(todays[0].id);
    await reload();
    renderHome();
  }

  /* ============================================================== */
  /* SCREEN: PROGRESS                                               */
  /* ============================================================== */

  function destroyCharts() {
    state.chartInstances.forEach((c) => { try { c.destroy(); } catch (_e) {} });
    state.chartInstances = [];
  }

  function renderProgress() {
    destroyCharts();
    const s = state.settings;
    const main = $('#app-main');
    main.innerHTML = '';

    const saved = computeMoneySaved();

    const c1 = el('canvas');
    const c2 = el('canvas');
    const c3 = el('canvas');

    const badgeRow = el('div', { class: 'badge-row' });

    main.appendChild(el('div', { class: 'progress' }, [
      el('div', { class: 'card' }, [
        el('h3', {}, 'Daily usage (last 14 days)'),
        el('div', { class: 'chart-wrap' }, c1),
      ]),
      el('div', { class: 'card' }, [
        el('h3', {}, 'Actual vs taper plan'),
        el('div', { class: 'chart-wrap' }, c2),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'money-total' }, `${fmtMoney(saved)} saved so far`),
        el('div', { class: 'chart-wrap' }, c3),
      ]),
      el('div', { class: 'card' }, [
        el('h3', {}, 'Achievements'),
        badgeRow,
      ]),
    ]));

    // --- Chart 1 data: last 14 days ---
    const counts = countsByDay();
    const days14 = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = DB.toDateKey(d);
      const usage = counts.get(key) || 0;
      const allowance = Taper.allowanceOnDate(s, d);
      days14.push({
        label: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
        usage,
        allowance,
      });
    }
    state.chartInstances.push(Charts.renderDailyUsage(c1, days14));

    // --- Chart 2 data: actual vs plan per week ---
    const weeksData = s.taperPlan.map((p) => {
      // Average actual daily usage during that programme week.
      const start = new Date(s.programmeStartDate);
      const startMid = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      let total = 0;
      let counted = 0;
      for (let d = 0; d < 7; d++) {
        const day = new Date(startMid);
        day.setDate(startMid.getDate() + (p.week - 1) * 7 + d);
        const todayMid = new Date();
        if (day > todayMid) break; // future day → stop
        total += counts.get(DB.toDateKey(day)) || 0;
        counted += 1;
      }
      return {
        week: p.week,
        actual: counted > 0 ? +(total / counted).toFixed(2) : null,
        target: p.allowance,
      };
    });
    state.chartInstances.push(Charts.renderActualVsPlan(c2, weeksData));

    // --- Chart 3 data: cumulative savings ---
    const costPerPouch = s.packCost / s.pouchesPerPack;
    const baselineDailyCost = s.dailyBaseline * costPerPouch;
    const points = [];
    let cum = 0;
    eachProgrammeDay().forEach(({ date, key }) => {
      const actual = counts.get(key) || 0;
      cum += Math.max(0, baselineDailyCost - actual * costPerPouch);
      points.push({
        label: date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
        cumulative: +cum.toFixed(2),
      });
    });
    if (points.length === 0) points.push({ label: 'Start', cumulative: 0 });
    state.chartInstances.push(Charts.renderMoneySaved(c3, points));

    // --- Achievement showcase ---
    renderBadges(badgeRow);
  }

  async function renderBadges(container) {
    container.innerHTML = '';
    const unlocked = await DB.getUnlockedAchievements();
    const have = new Set(unlocked.map((u) => u.id));
    const unlockedMap = new Map(unlocked.map((u) => [u.id, u.unlockedAt]));

    Achievements.ALL.forEach((a) => {
      const isUnlocked = have.has(a.id);
      const badge = el('button', {
        class: 'badge' + (isUnlocked ? '' : ' locked'),
      }, [
        el('div', { class: 'badge-icon' }, isUnlocked ? a.icon : '🔒'),
        el('div', { class: 'badge-name' }, a.name),
      ]);
      badge.addEventListener('click', () => {
        openModal(el('div', {}, [
          el('div', { class: 'badge-modal-icon' }, isUnlocked ? a.icon : '🔒'),
          el('h3', {}, a.name),
          el('p', { class: 'muted' }, a.description),
          el('p', { class: 'badge-status' },
            isUnlocked
              ? `Unlocked ${new Date(unlockedMap.get(a.id)).toLocaleDateString()}`
              : 'Locked'),
        ]));
      });
      container.appendChild(badge);
    });
  }

  /* ============================================================== */
  /* SCREEN: HISTORY                                                */
  /* ============================================================== */

  function renderHistory() {
    const main = $('#app-main');
    main.innerHTML = '';

    const tabs = el('div', { class: 'toggle-tabs' }, [
      tabBtn('List', state.historyView === 'list', () => { state.historyView = 'list'; renderHistory(); }),
      tabBtn('Calendar', state.historyView === 'calendar', () => { state.historyView = 'calendar'; renderHistory(); }),
    ]);

    const body = el('div', { class: 'history-body' });
    main.appendChild(el('div', { class: 'history' }, [tabs, body]));

    if (state.historyView === 'list') renderHistoryList(body);
    else renderHistoryCalendar(body);
  }

  function tabBtn(label, active, onClick) {
    const b = el('button', { class: 'tab-btn' + (active ? ' active' : '') }, label);
    b.addEventListener('click', onClick);
    return b;
  }

  function renderHistoryList(body) {
    body.innerHTML = '';
    const s = state.settings;

    // Group logs by day.
    const byDay = new Map();
    state.logs.forEach((l) => {
      const k = DB.toDateKey(l.timestamp);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(l);
    });
    const keys = Array.from(byDay.keys()).sort((a, b) => b.localeCompare(a));

    if (keys.length === 0) {
      body.appendChild(el('p', { class: 'muted center' }, 'No logs yet.'));
      return;
    }

    keys.forEach((key) => {
      const entries = byDay.get(key).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      const date = new Date(key + 'T00:00:00');
      const allowance = Taper.allowanceOnDate(s, date);
      const within = entries.length <= allowance;

      const detail = el('div', { class: 'day-entries', style: 'display:none' });
      entries.forEach((entry) => {
        detail.appendChild(el('div', { class: 'entry-row' }, [
          el('span', {}, fmtTime(entry.timestamp)),
          el('div', { class: 'entry-actions' }, [
            iconBtn('✎', () => editEntry(entry)),
            iconBtn('🗑', () => deleteEntry(entry)),
          ]),
        ]));
      });

      const header = el('div', { class: 'day-header' }, [
        el('div', {}, [
          el('span', { class: 'day-date' }, fmtDate(date)),
          el('span', { class: 'day-total' }, ` ${entries.length} / ${allowance}`),
        ]),
        el('span', { class: within ? 'tick' : 'cross' }, within ? '✓' : '✕'),
      ]);
      header.addEventListener('click', () => {
        detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
      });

      body.appendChild(el('div', { class: 'card day-card' }, [header, detail]));
    });
  }

  function iconBtn(symbol, onClick) {
    const b = el('button', { class: 'icon-btn' }, symbol);
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function editEntry(entry) {
    const d = new Date(entry.timestamp);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const timeIn = el('input', { type: 'time', value: `${hh}:${mm}` });
    const content = el('div', {}, [
      el('h3', {}, 'Edit log time'),
      timeIn,
      el('div', { class: 'row-gap' }, [
        el('button', { class: 'btn-secondary', onClick: () => close() }, 'Cancel'),
        el('button', {
          class: 'btn-primary',
          onClick: async () => {
            const [h, m] = timeIn.value.split(':').map(Number);
            const nd = new Date(entry.timestamp);
            nd.setHours(h, m, 0, 0);
            await DB.updateLog(entry.id, nd.toISOString());
            await reload();
            close();
            renderHistory();
          },
        }, 'Save'),
      ]),
    ]);
    const close = openModal(content);
  }

  function deleteEntry(entry) {
    const content = el('div', {}, [
      el('h3', {}, 'Delete this log?'),
      el('p', { class: 'muted' }, fmtTime(entry.timestamp)),
      el('div', { class: 'row-gap' }, [
        el('button', { class: 'btn-secondary', onClick: () => close() }, 'Cancel'),
        el('button', {
          class: 'btn-danger',
          onClick: async () => {
            await DB.deleteLog(entry.id);
            await reload();
            close();
            renderHistory();
          },
        }, 'Delete'),
      ]),
    ]);
    const close = openModal(content);
  }

  function renderHistoryCalendar(body) {
    body.innerHTML = '';
    const s = state.settings;
    if (!state.calendarMonth) {
      const now = new Date();
      state.calendarMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    const month = state.calendarMonth;
    const counts = countsByDay();
    const startProg = new Date(s.programmeStartDate);
    const startProgMid = new Date(startProg.getFullYear(), startProg.getMonth(), startProg.getDate());

    const nav = el('div', { class: 'cal-nav' }, [
      iconBtn('‹', () => { state.calendarMonth = new Date(month.getFullYear(), month.getMonth() - 1, 1); renderHistory(); }),
      el('span', { class: 'cal-title' },
        month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })),
      iconBtn('›', () => { state.calendarMonth = new Date(month.getFullYear(), month.getMonth() + 1, 1); renderHistory(); }),
    ]);

    const grid = el('div', { class: 'cal-grid' });
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((d) =>
      grid.appendChild(el('div', { class: 'cal-dow' }, d)));

    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const startOffset = (first.getDay() + 6) % 7; // Monday-based
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();

    for (let i = 0; i < startOffset; i++) grid.appendChild(el('div', { class: 'cal-cell empty' }));

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(month.getFullYear(), month.getMonth(), day);
      const key = DB.toDateKey(date);
      let cls = 'cal-cell';
      const todayMid = new Date();
      const tMid = new Date(todayMid.getFullYear(), todayMid.getMonth(), todayMid.getDate());

      if (date < startProgMid || date > tMid) {
        cls += ' grey';
      } else {
        const usage = counts.get(key) || 0;
        const allowance = Taper.allowanceOnDate(s, date);
        const over = usage - allowance;
        if (over <= 0) cls += ' green';
        else if (over === 1) cls += ' amber';
        else cls += ' red';
      }

      const cell = el('div', { class: cls }, String(day));
      cell.addEventListener('click', () => {
        const usage = counts.get(key) || 0;
        const allowance = Taper.allowanceOnDate(s, date);
        const inProgramme = date >= startProgMid && date <= tMid;
        openModal(el('div', {}, [
          el('h3', {}, fmtDate(date)),
          el('p', { class: 'muted' },
            inProgramme ? `${usage} pouches · allowance ${allowance}` : 'Outside the programme'),
        ]));
      });
      grid.appendChild(cell);
    }

    body.appendChild(el('div', { class: 'card' }, [nav, grid]));
  }

  /* ============================================================== */
  /* SCREEN: SETTINGS                                               */
  /* ============================================================== */

  /** A small pill button for the plan-type switcher. */
  function planTypeBtn(label, active, onClick) {
    const b = el('button', { class: 'tab-btn' + (active ? ' active' : '') }, label);
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * Build a starting set of phases from an existing weekly plan: one phase per
   * week (7 days each), carrying allowance as the count. Strength left blank
   * for the user to fill in.
   */
  function seedPhasesFromWeekly(taperPlan) {
    if (!Array.isArray(taperPlan) || taperPlan.length === 0) {
      return [{ count: 5, strength: '', days: 7 }, { count: 0, strength: '', days: 1 }];
    }
    return taperPlan.map((p) => ({ count: p.allowance, strength: '', days: 7 }));
  }

  /** Weekly plan editor (table + quit-date auto-build), rendered into `body`. */
  function buildWeeklyEditor(body, s, updateQuitLabel) {
    body.innerHTML = '';

    const planTableWrap = el('div');
    function buildPlanTable() {
      planTableWrap.innerHTML = '';
      planTableWrap.appendChild(
        planTable(s.taperPlan, s.programmeStartDate, (week, val) => {
          const row = s.taperPlan.find((p) => p.week === week);
          if (row) row.allowance = val;
          updateQuitLabel();
        })
      );
    }
    buildPlanTable();

    const existingQuit = Taper.getProjectedQuitDate(s.taperPlan, s.programmeStartDate);
    const settingsQuitPicker = el('input', {
      type: 'date',
      value: existingQuit ? DB.toDateKey(existingQuit) : '',
      min: DB.toDateKey(new Date(Date.now() + 7 * 86400000)),
    });
    const quitPickerCard = el('div', { class: 'card quit-picker' }, [
      el('div', { class: 'field' }, [
        el('span', {}, 'Set a quit date and auto-build the plan'),
        settingsQuitPicker,
      ]),
      el('button', {
        class: 'btn-secondary',
        onClick: () => {
          if (!settingsQuitPicker.value) { showToast('Pick a date first.'); return; }
          s.taperPlan = Taper.generatePlanForQuitDate(
            s.dailyBaseline,
            s.programmeStartDate,
            new Date(settingsQuitPicker.value + 'T00:00:00')
          );
          buildPlanTable();
          updateQuitLabel();
          showToast('Plan rebuilt — tap Save plan to keep it.');
        },
      }, 'Build plan for this date'),
    ]);

    body.appendChild(planTableWrap);
    body.appendChild(quitPickerCard);
  }

  /**
   * Custom phase editor: a list of rows, each {count, strength, days}, with
   * add/delete and live recompute of dates + quit date. Rendered into `body`.
   */
  function buildPhaseEditor(body, s, updateQuitLabel) {
    body.innerHTML = '';
    if (!Array.isArray(s.phases)) s.phases = [];

    body.appendChild(el('p', { class: 'muted small' },
      'Each phase runs for a set number of days at a pouch count and strength. ' +
      'Phases run back-to-back from your start date. Add a final phase of 0 to mark quitting.'));

    const rowsWrap = el('div', { class: 'phase-list' });

    // Date labels per row, so we can refresh dates without rebuilding the
    // whole list (which would steal focus from the input being typed in).
    let dateLabels = [];
    function refreshPhaseDates() {
      const dated = Taper.phasesWithDates(s.phases, s.programmeStartDate);
      dateLabels.forEach((label, i) => {
        if (dated[i]) {
          label.textContent = `${fmtDate(dated[i].startDate)} → ${fmtDate(dated[i].endDate)}`;
        }
      });
    }

    function rebuild() {
      rowsWrap.innerHTML = '';
      dateLabels = [];
      const dated = Taper.phasesWithDates(s.phases, s.programmeStartDate);
      s.phases.forEach((phase, i) => {
        const d = dated[i];

        // Count — plain text box with numeric keypad (no spinner arrows).
        const countIn = el('input', {
          type: 'text', inputmode: 'numeric', value: phase.count, class: 'cell-input',
        });
        countIn.addEventListener('input', (e) => {
          const v = parseInt(e.target.value, 10);
          phase.count = Number.isNaN(v) ? 0 : Math.max(0, v);
        });

        // Strength — type the nicotine content per pouch, e.g. "10.9mg".
        const strengthIn = el('input', {
          type: 'text', value: phase.strength || '', placeholder: 'e.g. 10.9mg', class: 'phase-strength',
        });
        strengthIn.addEventListener('input', (e) => { phase.strength = e.target.value; });

        // Days — plain text box with numeric keypad. Validate as a number and
        // show an inline error if it isn't one (instead of silently coercing).
        const daysIn = el('input', {
          type: 'text', inputmode: 'numeric', value: phase.days, class: 'cell-input',
        });
        const daysError = el('div', { class: 'phase-error', style: 'display:none' },
          'Enter a whole number of days');
        const dateLabel = el('div', { class: 'muted small phase-dates' },
          `${fmtDate(d.startDate)} → ${fmtDate(d.endDate)}`);

        daysIn.addEventListener('input', (e) => {
          const raw = e.target.value.trim();
          const v = parseInt(raw, 10);
          // Invalid: empty, not a number, or contains non-digits.
          if (raw === '' || Number.isNaN(v) || !/^\d+$/.test(raw) || v < 1) {
            daysError.style.display = '';
            daysIn.classList.add('invalid');
            return; // leave phase.days unchanged so dates stay sensible
          }
          daysError.style.display = 'none';
          daysIn.classList.remove('invalid');
          phase.days = v;
          // Recompute only the dependent date labels in place, so typing in
          // this field doesn't lose focus (a full rebuild would).
          refreshPhaseDates();
          updateQuitLabel();
        });

        rowsWrap.appendChild(el('div', { class: 'phase-row' }, [
          el('div', { class: 'phase-grid' }, [
            el('label', { class: 'phase-field' }, [el('span', {}, 'Count'), countIn]),
            el('label', { class: 'phase-field' }, [el('span', {}, 'Nicotine'), strengthIn]),
            el('label', { class: 'phase-field' }, [el('span', {}, 'Days'), daysIn]),
            iconBtn('🗑', () => { s.phases.splice(i, 1); rebuild(); updateQuitLabel(); }),
          ]),
          daysError,
          dateLabel,
        ]));
        // Track this row's date label so refreshPhaseDates can update it.
        dateLabels.push(dateLabel);
      });
    }
    rebuild();

    const addBtn = el('button', { class: 'btn-secondary' }, '+ Add phase');
    addBtn.addEventListener('click', () => {
      // Sensible default: copy the last phase's count, 7 days.
      const last = s.phases[s.phases.length - 1];
      s.phases.push({
        count: last ? Math.max(0, last.count - 1) : (s.dailyBaseline || 5),
        strength: last ? last.strength : '',
        days: 7,
      });
      rebuild();
      updateQuitLabel();
    });

    body.appendChild(rowsWrap);
    body.appendChild(addBtn);
  }

  function renderSettings() {
    const s = state.settings;
    const main = $('#app-main');
    main.innerHTML = '';

    /* --- Profile --- */
    const profileCard = el('div', { class: 'card' }, [
      el('h3', {}, 'Profile'),
      field('Name', input('text', s.name, (v) => (s.name = v))),
      field('Daily baseline', numInput(s.dailyBaseline, (v) => (s.dailyBaseline = v), 0)),
      field('Pack cost (£)', numInput(s.packCost, (v) => (s.packCost = v), 0, 0.01)),
      field('Pouches per pack', numInput(s.pouchesPerPack, (v) => (s.pouchesPerPack = v), 1)),
      el('button', {
        class: 'btn-primary',
        onClick: async () => { await DB.saveSettings(s); showToast('Profile saved.'); },
      }, 'Save profile'),
    ]);

    /* --- Taper plan (weekly OR custom phases) --- */
    const planCard = el('div', { class: 'card' }, [el('h3', {}, 'Taper plan')]);
    const quitLabel = el('p', { class: 'muted' });
    function updateQuitLabel() {
      const q = Taper.quitDateFor(s);
      quitLabel.textContent = q ? `Projected quit date: ${fmtDate(q)}` : 'No quit date set.';
    }

    // Plan-type switcher.
    const typeRow = el('div', { class: 'plan-type-row' }, [
      planTypeBtn('Weekly', s.planType !== 'phases', () => switchType('weekly')),
      planTypeBtn('Custom phases', s.planType === 'phases', () => switchType('phases')),
    ]);

    // Body holds whichever editor is active.
    const planBody = el('div');

    function switchType(type) {
      if (type === 'phases' && s.planType !== 'phases') {
        // Seed phases from the existing weekly plan (or a sensible default).
        if (!Array.isArray(s.phases) || s.phases.length === 0) {
          s.phases = seedPhasesFromWeekly(s.taperPlan);
        }
        s.planType = 'phases';
      } else if (type === 'weekly') {
        s.planType = 'weekly';
      }
      renderSettings(); // simplest: re-render so the switcher + body update
    }

    if (s.planType === 'phases') {
      buildPhaseEditor(planBody, s, updateQuitLabel);
    } else {
      buildWeeklyEditor(planBody, s, updateQuitLabel);
    }
    updateQuitLabel();

    planCard.appendChild(typeRow);
    planCard.appendChild(planBody);
    planCard.appendChild(quitLabel);
    planCard.appendChild(el('button', {
      class: 'btn-primary',
      onClick: async () => { await DB.saveSettings(s); refreshNotifications(); showToast('Plan saved.'); },
    }, 'Save plan'));

    /* --- Reasons --- */
    const reasonsCard = el('div', { class: 'card' }, [el('h3', {}, 'My reasons')]);
    const reasonsList = el('div', { class: 'reason-list' });
    function renderReasons() {
      reasonsList.innerHTML = '';
      s.reasons.forEach((r, i) => {
        const inp = el('input', { type: 'text', value: r, class: 'reason-edit' });
        inp.addEventListener('input', (e) => { s.reasons[i] = e.target.value; });
        reasonsList.appendChild(el('div', { class: 'reason-item' }, [
          inp,
          iconBtn('🗑', async () => {
            s.reasons.splice(i, 1);
            await DB.saveSettings(s);
            renderReasons();
          }),
        ]));
      });
    }
    renderReasons();
    const addReasonInput = el('input', { type: 'text', placeholder: 'Add a reason', class: 'reason-input' });
    reasonsCard.appendChild(reasonsList);
    reasonsCard.appendChild(el('div', { class: 'reason-entry' }, [
      addReasonInput,
      el('button', {
        class: 'btn-secondary',
        onClick: async () => {
          const v = addReasonInput.value.trim();
          if (!v) return;
          s.reasons.push(v);
          addReasonInput.value = '';
          await DB.saveSettings(s);
          renderReasons();
        },
      }, 'Add reason'),
    ]));
    reasonsCard.appendChild(el('button', {
      class: 'btn-primary',
      onClick: async () => { await DB.saveSettings(s); showToast('Reasons saved.'); },
    }, 'Save reasons'));

    /* --- Notifications --- */
    const n = s.notifications;
    const notifCard = el('div', { class: 'card' }, [
      el('h3', {}, 'Notifications'),
      toggleRow('Morning check-in', n.morningEnabled, (v) => (n.morningEnabled = v),
        timeInput(n.morningTime, (v) => (n.morningTime = v))),
      toggleRow('Evening summary', n.eveningEnabled, (v) => (n.eveningEnabled = v),
        timeInput(n.eveningTime, (v) => (n.eveningTime = v))),
      toggleRow('Craving alerts', n.cravingEnabled, (v) => (n.cravingEnabled = v)),
      el('button', {
        class: 'btn-primary',
        onClick: async () => {
          if (n.morningEnabled || n.eveningEnabled || n.cravingEnabled) {
            await NotificationsManager.requestPermission();
          }
          await DB.saveSettings(s);
          refreshNotifications();
          showToast('Notifications saved.');
        },
      }, 'Save notifications'),
    ]);

    /* --- Health milestones --- */
    const healthCard = el('div', { class: 'card' }, [el('h3', {}, 'Health milestones')]);
    const hoursSince =
      (Date.now() - new Date(s.programmeStartDate).getTime()) / (1000 * 60 * 60);
    HEALTH_MILESTONES.forEach((m) => {
      const unlocked = hoursSince >= m.mins;
      healthCard.appendChild(el('div', {
        class: 'milestone' + (unlocked ? '' : ' locked'),
      }, [
        el('span', { class: 'milestone-icon' }, unlocked ? '✓' : '🔒'),
        el('div', {}, [
          el('div', { class: 'milestone-label' }, m.label),
          el('div', { class: 'milestone-text muted' }, m.text),
        ]),
      ]));
    });

    /* --- Restart plan --- */
    const restartCard = el('div', { class: 'card' }, [el('h3', {}, 'Restart plan')]);
    restartCard.appendChild(el('p', { class: 'muted small' },
      'Begin a fresh attempt from today. Your current run — including its logs — is moved to "Past attempts" below so your new History starts clean. Achievements reset so you can earn them again.'));
    restartCard.appendChild(el('button', {
      class: 'btn-danger',
      onClick: () => confirmRestart(),
    }, 'Restart from today'));

    // Past attempts (archived runs). Each is tappable to view its logs.
    const history = Array.isArray(s.planHistory) ? s.planHistory : [];
    if (history.length) {
      restartCard.appendChild(el('h4', { class: 'subhead' }, 'Past attempts'));
      history.slice().reverse().forEach((run) => {
        const startD = new Date(run.startDate);
        const endD = new Date(run.endDate);
        const row = el('div', { class: 'attempt-row tappable' }, [
          el('div', {}, [
            el('div', { class: 'attempt-dates' }, `${fmtDate(startD)} → ${fmtDate(endD)}`),
            el('div', { class: 'muted small' },
              `${run.daysOnProgramme} days · ${run.totalLogged} pouches logged · started at ${run.startingAllowance}/day`),
          ]),
          el('span', { class: 'muted' }, '›'),
        ]);
        row.addEventListener('click', () => showArchivedRun(run));
        restartCard.appendChild(row);
      });
    }

    /* --- Data --- */
    const dataCard = el('div', { class: 'card' }, [
      el('h3', {}, 'Data'),
      el('div', { class: 'row-gap' }, [
        el('button', { class: 'btn-secondary', onClick: exportData }, 'Export data'),
        el('button', { class: 'btn-secondary', onClick: () => importInput.click() }, 'Import data'),
      ]),
    ]);
    const importInput = el('input', { type: 'file', accept: 'application/json', style: 'display:none' });
    importInput.addEventListener('change', importData);
    dataCard.appendChild(importInput);

    main.appendChild(el('div', { class: 'settings' }, [
      profileCard, planCard, reasonsCard, notifCard, healthCard, restartCard, dataCard,
    ]));
  }

  /**
   * Confirm and perform a programme restart. Archives the current run into
   * settings.planHistory, resets the start date to today, regenerates the plan
   * from the current baseline, and clears achievements. Logs are retained.
   */
  function confirmRestart() {
    const content = el('div', {}, [
      el('h3', {}, 'Restart from today?'),
      el('p', { class: 'muted' },
        'Your current run will be archived to Past attempts. The plan restarts at your current baseline from today and achievements reset. Logs are kept.'),
      el('div', { class: 'row-gap' }, [
        el('button', { class: 'btn-secondary', onClick: () => close() }, 'Cancel'),
        el('button', {
          class: 'btn-danger',
          onClick: async () => { close(); await doRestart(); },
        }, 'Restart'),
      ]),
    ]);
    const close = openModal(content);
  }

  async function doRestart() {
    const s = state.settings;
    const now = new Date();

    // Logs belonging to this run = those on/after the programme start. We move
    // them into the archive and remove them from the live logs store so they
    // no longer appear in History.
    const startMs = new Date(s.programmeStartDate).getTime();
    const runLogs = state.logs.filter(
      (l) => new Date(l.timestamp).getTime() >= startMs
    );

    const daysOnProgramme = Taper.getDaysSinceStart(s.programmeStartDate, now);
    const startingAllowance =
      s.planType === 'phases'
        ? (s.phases && s.phases[0] ? s.phases[0].count : s.dailyBaseline)
        : (s.taperPlan[0] ? s.taperPlan[0].allowance : s.dailyBaseline);

    const archived = {
      startDate: s.programmeStartDate,
      endDate: now.toISOString(),
      daysOnProgramme,
      totalLogged: runLogs.length,
      startingAllowance,
      planType: s.planType || 'weekly',
      taperPlan: s.taperPlan,
      phases: s.phases || [],
      // The actual logs from this run, kept for the record.
      logs: runLogs.map((l) => ({ timestamp: l.timestamp, note: l.note || null })),
    };
    s.planHistory = Array.isArray(s.planHistory) ? s.planHistory : [];
    s.planHistory.push(archived);

    // Reset the run: new start date; regenerate plan from baseline. Keep the
    // current plan type so a phase user stays on phases (cleared to re-edit).
    s.programmeStartDate = now.toISOString();
    s.taperPlan = Taper.generateTaperPlan(s.dailyBaseline);
    if (s.planType === 'phases') {
      // Start phases fresh from the weekly default so the user can re-customise.
      s.phases = seedPhasesFromWeekly(s.taperPlan);
    }

    // Persist settings (with archive) first, then delete the moved logs.
    await DB.saveSettings(s);
    for (const l of runLogs) {
      await DB.deleteLog(l.id);
    }
    await DB.clearAchievements();
    await reload();
    refreshNotifications();
    showToast('Plan restarted. Past run archived.');
    navigate('settings');
  }

  /** Show an archived run's summary and its logs grouped by day. */
  function showArchivedRun(run) {
    const startD = new Date(run.startDate);
    const endD = new Date(run.endDate);
    const logs = Array.isArray(run.logs) ? run.logs : [];

    // Group archived logs by day.
    const byDay = new Map();
    logs.forEach((l) => {
      const k = DB.toDateKey(l.timestamp);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(l);
    });
    const keys = Array.from(byDay.keys()).sort((a, b) => b.localeCompare(a));

    const list = el('div', { class: 'archived-logs' });
    if (keys.length === 0) {
      list.appendChild(el('p', { class: 'muted' }, 'No logs were recorded in this run.'));
    } else {
      keys.forEach((key) => {
        const entries = byDay.get(key);
        list.appendChild(el('div', { class: 'archived-day' }, [
          el('span', { class: 'day-date' }, fmtDate(new Date(key + 'T00:00:00'))),
          el('span', { class: 'day-total' }, ` ${entries.length} pouches`),
        ]));
      });
    }

    openModal(el('div', {}, [
      el('h3', {}, 'Past attempt'),
      el('p', { class: 'muted' }, `${fmtDate(startD)} → ${fmtDate(endD)}`),
      el('p', { class: 'muted small' },
        `${run.daysOnProgramme} days · ${run.totalLogged} pouches · started at ${run.startingAllowance}/day`),
      list,
    ]));
  }

  async function exportData() {
    const data = await DB.exportAllData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `quitsnus-backup-${DB.toDateKey(new Date())}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      await DB.importAllData(text);
      await reload();
      showToast('Data imported.');
      navigate('settings');
    } catch (err) {
      showToast('Import failed — invalid file.');
    }
  }

  /* ============================================================== */
  /* Routing                                                        */
  /* ============================================================== */

  function navigate(tab) {
    state.activeTab = tab;
    // Update nav active states.
    $$('.nav-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.tab === tab);
    });
    const main = $('#app-main');
    main.classList.remove('fade-in');
    void main.offsetWidth;
    main.classList.add('fade-in');

    if (tab === 'home') renderHome();
    else if (tab === 'progress') renderProgress();
    else if (tab === 'history') renderHistory();
    else if (tab === 'settings') renderSettings();
  }

  /* ============================================================== */
  /* Boot                                                           */
  /* ============================================================== */

  function wireNav() {
    $$('.nav-item').forEach((item) => {
      item.addEventListener('click', () => navigate(item.dataset.tab));
    });
    $('#settings-cog').addEventListener('click', () => navigate('settings'));
  }

  function maybeShowIosBanner() {
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = window.navigator.standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;
    if (isIos && !standalone && !localStorage.getItem('iosBannerDismissed')) {
      const banner = el('div', { class: 'ios-banner' }, [
        el('span', {}, 'Add this app to your Home Screen to enable notifications.'),
        el('button', {
          class: 'banner-close',
          onClick: () => {
            banner.remove();
            localStorage.setItem('iosBannerDismissed', '1');
          },
        }, '✕'),
      ]);
      document.body.appendChild(banner);
    }
  }

  async function boot() {
    // Register service worker for offline support.
    if ('serviceWorker' in navigator) {
      try { await navigator.serviceWorker.register('service-worker.js'); }
      catch (_e) { /* offline support unavailable; app still works */ }
    }

    await reload();
    wireNav();
    maybeShowIosBanner();

    if (!state.settings || !state.settings.setupComplete) {
      startOnboarding();
    } else {
      refreshNotifications();
      await checkAchievements();
      navigate('home');
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
