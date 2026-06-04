# QuitSnus

A self-contained Progressive Web App (PWA) to help you quit nicotine pouches (snus) by tapering down gradually. Everything runs in your browser — **no backend, no accounts, no external storage**. All your data lives locally on your device in IndexedDB.

## Features

- **Guided onboarding** — set your usage, generate a tapering plan, record your reasons, choose notifications.
- **Daily tapering plan** — reduces 25% per week from your starting usage down to zero. Week 1 starts at your current usage; reductions begin in week 2.
- **One-tap logging** with an over-limit nudge that shows you your own reasons.
- **Progress charts** — daily usage, actual vs. plan, and cumulative money saved.
- **Achievements** — time, usage, and money milestones with celebratory toasts.
- **History** — list and calendar views; edit or delete any entry.
- **Health milestones** timeline based on how long you've been on the programme.
- **Reminders** — morning check-in, evening summary, and smart craving alerts.
- **Export / import** your data as JSON.
- **Works fully offline** after the first load.

---

## Running locally on Windows

The easiest way (gets you full PWA features including the service worker):

```powershell
cd snus-quit-app
npx serve .
```

Then open **http://localhost:3000** in Chrome or Edge.

> You can also just double-click `index.html` to open it directly in Chrome/Edge. The core app works, but some PWA features (service worker / offline caching / installability) require it to be served over `http://` or `https://`, not `file://`.

---

## Installing on iPhone

1. Open the app's URL in **Safari** (not Chrome — iOS install only works from Safari).
2. Tap the **Share** button (the square with an upward arrow).
3. Scroll down and tap **"Add to Home Screen"**.
4. Launch QuitSnus from your Home Screen — it now runs full-screen like a native app.

---

## Enabling notifications on iOS

On iPhone/iPad, web notifications **only work once the app is installed to the Home Screen** (see above). They will **not** work in a normal Safari browser tab.

After installing to your Home Screen:

1. Open QuitSnus from the Home Screen icon.
2. Go to **Settings → Notifications**, toggle the reminders you want, and tap **Save notifications**.
3. Accept the system permission prompt when it appears.

Because this is a static app with no server, reminders are scheduled locally while the app is open/active. Keep it installed to the Home Screen for the most reliable behaviour.

---

## Hosting on GitHub Pages (step-by-step)

1. **Create a new GitHub repository** (e.g. `snus-quit-app`).
2. **Upload all project files** — either:
   - Drag and drop the contents of the `snus-quit-app` folder into the GitHub web UI, **or**
   - Use **GitHub Desktop** to commit and push the files.
3. In your repo, go to **Settings → Pages**.
4. Under **Source**, choose **Deploy from a branch**, then select **`main`** and **`/ (root)`**, and click **Save**.
5. After a minute or two, your app will be live at:
   ```
   https://<your-username>.github.io/<repo-name>/
   ```
6. **Important:** if you host in a subdirectory (i.e. the URL has `/<repo-name>/`), update `start_url` in `manifest.json` from `"/"` to `"/<repo-name>/"` so installs and the service worker scope resolve correctly.

---

## Project structure

```
snus-quit-app/
├── index.html            # App shell; loads all CSS/JS
├── manifest.json         # PWA manifest
├── service-worker.js     # Offline caching + notification clicks
├── css/styles.css        # All styling (light/dark, mobile-first)
├── js/
│   ├── db.js             # IndexedDB data layer
│   ├── taper.js          # Tapering plan calculations
│   ├── achievements.js   # Achievement definitions + unlock logic
│   ├── notifications.js  # Notification scheduling
│   ├── charts.js         # Chart.js rendering
│   └── app.js            # Routing, onboarding, screens, stats
├── icons/icon-192.svg
├── icons/icon-512.svg
└── README.md
```

## Privacy

All data stays on your device. There is no server and nothing is uploaded. Clearing your browser's site data (or deleting the installed app) will erase your logs — use **Settings → Export data** to keep a backup.
