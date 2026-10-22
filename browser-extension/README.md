# Browser extension: Outlook on the web / Teams → tray app

For accounts where you can't (or don't want to) create an Azure app registration. Outlook runs in the browser and Teams as a PWA; this Edge / Chrome extension passes their meetings to the tray app on this PC. Nothing is sent anywhere else.

## Setup (once)

1. Start the tray app. In the tray menu, open **Outlook / Teams (browser) ▸ Open extension folder (Load unpacked)** to see this folder.
2. Open `edge://extensions` (or `chrome://extensions`), turn on **Developer mode**, click **Load unpacked** and pick this folder.
3. The options page opens. In the tray menu choose **Outlook / Teams (browser) ▸ Copy pairing code**, paste it there, and click **Save and test**.
4. Reload any open Outlook / Teams tabs or PWA windows so the extension can hook into them.
5. Open the Outlook calendar once. The options page lists the meetings it captured, and the tray row shows "N meetings captured".

Use the browser profile you use for Outlook and Teams. Installed PWAs run in that profile, and the extension runs inside them.

## How it works

- `page-hook.js` runs in the page's own JavaScript world on the Outlook and Teams sites. It reads (never changes) the JSON responses those apps download, and `lib/extract.js` picks out anything shaped like a calendar item (title + start + end), skipping mails, all-day events and declined or cancelled meetings. It also notes `Notification` / `showNotification` calls (the toasts these sites raise).
- `relay.js` forwards those findings to `background.js`, which merges meetings from all tabs (`lib/meetings.js`). It sends the full list to the app on `http://127.0.0.1:<port>` whenever it changes and once a minute, with the pairing token. Toasts are forwarded straight away.
- The app treats the list as one more calendar, so the regular "in N min" warning and "starting now" alarm fire for these meetings too. A meeting toast that matches no known meeting ("… meeting started", "… in 10 min") plays a reminder on its own. Turn that off with `browserBridge.toastReminders: false` in settings.json.

## Limits

- **Outlook and Teams don't document their internal APIs.** Extraction looks for item *shapes* rather than specific URLs, so it should survive most changes. If the options page shows no captured meetings after you open the calendar, check its capture log and report what you see.
- **The browser must be running.** Meetings are only seen once a page has loaded them, so open the calendar (week view) now and then. Meetings already sent stay in the app for up to 12 hours even if the browser closes.
- **A meeting deleted in Outlook while no tab shows it** can still fire a reminder until it ends, or until 3 days pass without it being seen again. Use **Forget captured meetings** if that happens.
- **Toasts only reach the extension while a tab or PWA window for that site is open.** Push notifications that arrive with no tab open are not captured.
- **If the bridge port is unavailable** (in use, or reserved by Windows), the app picks a free one, saves it, and the tray row asks you to copy the pairing code again.
