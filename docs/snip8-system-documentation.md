# snip8 & Remote Springboard Stop

## System Documentation

## 1. General Overview of snip8

snip8 is a companion web application designed to track, calculate, and automate daily work-hour limits, specifically an eight-hour target of **28,800 seconds**, alongside organizational time-tracking software such as Springboard (`app.hirespringboard.com`).

### Core Capabilities

**Visual Timesheet Parsing**

Users capture screenshots of the active Springboard timesheet grid and summary headers. The integrated Gemini Vision backend extracts logged hours, pay-period metrics, daily column logs, and stacked time blocks.

**Live Target Countdown**

snip8 converts screenshot totals into a live counter that tracks cumulative logged time against the eight-hour threshold.

**Policy Compliance Safeguards**

The application monitors the configured work-hour limit and tracks compliance across an active shift:

- **Target window:** 7 hours 55 minutes to 8 hours.
- **Grace window:** 8 hours to 8 hours 5 minutes.
- **Policy violation:** Beyond 8 hours 5 minutes.

**Cross-Device Cloud State**

Active session state, parsed intervals, and user PIN-based signals are stored in Neon PostgreSQL serverless storage.

**Remote Stop Bridge**

A browser bookmarklet running in the desktop Springboard tab checks for stop requests. This allows a user to request a timer stop from snip8 on another device without installing a browser extension.

---

## 2. Remote Springboard Stop Mechanism

### The Problem It Solves

Corporate-managed environments may restrict third-party browser extensions and may not provide a native Springboard mobile application or a supported remote-stop API. Without a bridge, a worker who steps away from the desktop may need to return to the workstation to stop the timer manually.

### Architecture: Asynchronous Database Signaling Bridge

snip8 uses an out-of-band polling pattern. A browser bookmarklet runs in the desktop Springboard tab and periodically checks the snip8 API for a pending stop request.

### Signal Flow

1. **Request initiated:** The user selects **Stop Springboard** in snip8, or the configured cap is reached.
2. **API receives request:** The snip8 client sends a request to `/api/timer-signal`.
3. **Signal stored:** The API sets `stop_requested` to `TRUE` in the Neon PostgreSQL table `snip8_signals`, keyed by the user's PIN.
4. **Desktop tab polls:** The bookmarklet checks `/api/timer-signal?pin=<PIN>` every 10 seconds.
5. **Stop action runs:** If a stop request is pending, the bookmarklet looks for the Springboard **Stop timer** button and clicks it.
6. **Signal acknowledged:** The bookmarklet sends a request with `action=clear` to reset the signal.
7. **Signal reset:** The database value returns to `FALSE`, ready for a future request.

**Important:** The bridge depends on the Springboard tab being open, the bookmarklet being active, network access being available, and the expected Stop timer button being present. The 10-second polling interval means a remote request may take up to approximately 10 seconds to be detected, excluding network or browser delays. Always verify that Springboard actually stopped the timer.

### Architecture Diagram

```text
┌──────────────────────────────────┐
│    snip8 UI / Mobile Device      │
│       Stop Springboard           │
└────────────────┬─────────────────┘
                 │
                 │ POST action=set
                 ▼
┌──────────────────────────────────┐
│    Serverless API                │
│    /api/timer-signal              │
└────────────────┬─────────────────┘
                 │
                 │ Set stop_requested = TRUE
                 ▼
┌──────────────────────────────────┐
│    Neon PostgreSQL               │
│    Table: snip8_signals           │
└────────────────┬─────────────────┘
                 ▲
                 │ GET poll every 10 seconds
                 │
┌──────────────────────────────────┐
│    Springboard Desktop Tab       │
│    Sync Bridge Bookmarklet       │
└────────────────┬─────────────────┘
                 │
                 │ Detect pending stop signal
                 ▼
┌──────────────────────────────────┐
│    Click Springboard             │
│    "Stop timer"                  │
└────────────────┬─────────────────┘
                 │
                 │ POST action=clear
                 ▼
┌──────────────────────────────────┐
│    Signal Reset                  │
│    stop_requested = FALSE        │
└──────────────────────────────────┘
```

---

## 3. Component Breakdown

### A. Signal Storage: `snip8_signals`

The `snip8_signals` table is a minimal state store keyed by the user's PIN.

| Field              | Type                       | Purpose                                                                                       |
| ------------------ | -------------------------- | --------------------------------------------------------------------------------------------- |
| `pin`              | `VARCHAR(64)`, primary key | Identifies the user's isolated signal session.                                                |
| `stop_requested`   | `BOOLEAN`                  | `TRUE` indicates a remote stop is requested; `FALSE` indicates idle.                          |
| `updated_at`       | `TIMESTAMPTZ`              | Records the UTC time when the signal was written or cleared.                                  |
| `updated_at_local` | `TIMESTAMP`, optional      | May be a generated column using `updated_at AT TIME ZONE 'Asia/Manila'` for local inspection. |

### B. Serverless API: `/api/timer-signal`

#### GET — Poll for a Stop Request

The bookmarklet polls the endpoint using the user's PIN. The response includes the current `stop_requested` value.

Example response:

```json
{
  "stop_requested": true
}
```

#### POST — Update the Signal

- `action=set`: Sets `stop_requested` to `TRUE`. Dispatched by the snip8 mobile or desktop client when the user taps **Stop Springboard** or when automatic cap handling triggers.
- `action=clear`: Sets `stop_requested` to `FALSE` after the bookmarklet processes the request.

#### Cross-Origin Requests (CORS)

The endpoint is configured with `Access-Control-Allow-Origin: *` to allow browser requests from the relevant application context.

CORS configuration alone does not authenticate a request or protect the signal endpoint. Access control, PIN handling, and request validation should be reviewed as part of deployment security.

### C. Desktop Sync Bridge Bookmarklet (Production Version)

#### Overview

The Sync Bridge is a lightweight browser bookmarklet running in the Springboard web application context. It acts as a consumer of the `/api/timer-signal` polling endpoint and attempts to trigger the native Springboard timer button without requiring a third-party browser extension.

#### Architecture and Features

- **Minimal console output:** Suppresses routine polling messages and silently handles polling errors.
- **Temporary status notification:** Displays a green notification reading `Sync Bridge Connected (PIN: ******)` in the bottom-right corner for three seconds. The implementation below displays the PIN value, so avoid sharing screenshots of the notification.
- **Persistent PIN storage:** Reads and writes the user's PIN to `localStorage['snip8_bridge_pin']`. Prompts for the PIN when it is not already saved.
- **Duplicate execution guard:** Checks `window._sbSyncBridgeRunning` to avoid starting multiple polling loops when the bookmark is clicked repeatedly.
- **Polling cadence:** Sends a polling request every 10,000 milliseconds (10 seconds).
- **Stop action:** When `stop_requested` is `TRUE`, searches for a button whose text includes `stop timer`, clicks it if found, and sends an acknowledgment request using `action=clear`.

#### Final Production Bookmarklet Code

To install or rebind the bridge in Chrome or Edge, create a bookmark named **Sync Bridge** and set its URL to the following one-line JavaScript bookmarklet.

Replace the PIN only if you are modifying a personal copy. Do not publish your real PIN in the repository.

```javascript
javascript:(function(){if(window._sbSyncBridgeRunning){alert('Sync Bridge is already running.');return;}let p=localStorage.getItem('snip8_bridge_pin');if(!p){p=prompt('Enter your 6-digit snip8 PIN:');if(!p)return;localStorage.setItem('snip8_bridge_pin',p.trim());}window._sbSyncBridgeRunning=true;const t=document.createElement('div');t.innerText='Sync Bridge Connected (PIN: '+p+')';t.style.cssText='position:fixed;bottom:16px;right:16px;background:#10b981;color:#fff;padding:8px 14px;border-radius:6px;font-size:12px;z-index:999999;box-shadow:0 4px 6px rgba(0,0,0,0.15);font-family:sans-serif;pointer-events:none;transition:opacity 0.5s ease;';document.body.appendChild(t);setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),500);},3000);setInterval(async()=>{try{const r=await fetch('https://snip8-eight.vercel.app/api/timer-signal?pin='+encodeURIComponent(p));if(!r.ok)return;const d=await r.json();if(d&&d.stop_requested){const b=Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim().toLowerCase().includes('stop timer'));if(b){b.click();}await fetch('https://snip8-eight.vercel.app/api/timer-signal?pin='+encodeURIComponent(p)+'&action=clear',{method:'POST'});}}catch(e){}},10000);})();
```

#### Readable Source Code

Use this formatted version when reviewing, maintaining, or auditing the production bridge.

```javascript
(function() {
  // 1. Guard against duplicate concurrent execution
  if (window._sbSyncBridgeRunning) {
    alert('Sync Bridge is already running.');
    return;
  }

  // 2. Read or prompt for user PIN, persisted in localStorage
  let p = localStorage.getItem('snip8_bridge_pin');

  if (!p) {
    p = prompt('Enter your 6-digit snip8 PIN:');
    if (!p) return;

    p = p.trim();
    localStorage.setItem('snip8_bridge_pin', p);
  }

  window._sbSyncBridgeRunning = true;

  // 3. Temporary visual toast badge
  const t = document.createElement('div');
  t.innerText = 'Sync Bridge Connected (PIN: ' + p + ')';
  t.style.cssText = 'position:fixed;bottom:16px;right:16px;background:#10b981;color:#fff;padding:8px 14px;border-radius:6px;font-size:12px;z-index:999999;box-shadow:0 4px 6px rgba(0,0,0,0.15);font-family:sans-serif;pointer-events:none;transition:opacity 0.5s ease;';

  document.body.appendChild(t);

  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 500);
  }, 3000);

  // 4. Ambient 10-second polling cadence
  setInterval(async () => {
    try {
      const r = await fetch(
        'https://snip8-eight.vercel.app/api/timer-signal?pin=' +
        encodeURIComponent(p)
      );

      if (!r.ok) return;

      const d = await r.json();

      if (d && d.stop_requested) {
        // Find Springboard Stop timer button
        const b = Array.from(
          document.querySelectorAll('button')
        ).find(
          x => x.textContent.trim().toLowerCase().includes('stop timer')
        );

        if (b) {
          b.click();
        }

        // Acknowledge and clear signal in Neon DB
        await fetch(
          'https://snip8-eight.vercel.app/api/timer-signal?pin=' +
          encodeURIComponent(p) +
          '&action=clear',
          { method: 'POST' }
        );
      }
    } catch (e) {
      // Silent error handling: no console output during polling
    }
  }, 10000);
})();
```

#### Installation and Verification

1. Open the browser bookmarks manager using `Ctrl + Shift + O` in Chrome or Edge, or right-click the bookmarks bar and select **Add page**.
2. Set the bookmark name to `Sync Bridge`.
3. Paste the minified `javascript:(...)` snippet into the bookmark's **URL** field.
4. Navigate to the active Springboard timesheet tab (`app.hirespringboard.com`) and click the **Sync Bridge** bookmark.
5. On the first launch, enter your six-digit snip8 PIN. The PIN is saved in `localStorage['snip8_bridge_pin']` for future launches in that browser profile.
6. Confirm that the green `Sync Bridge Connected (PIN: ******)` toast appears in the lower-right corner for three seconds.
7. Clicking the bookmark again in the same tab should display the `Sync Bridge is already running.` alert rather than starting another polling loop.

#### Security and Reliability Notes

- The PIN is stored in browser local storage and is sent to the API as a query parameter. Do not expose it in public documentation, screenshots, URLs shared with others, or logs.
- The toast in the supplied implementation includes the actual PIN. Consider changing it to display a masked value before using it in shared or managed environments.
- The duplicate-execution guard prevents a second loop from starting in the same page context. The implementation does not provide a stop or teardown control for the running interval; refreshing the page clears the in-memory loop.
- The script clears the signal even when it cannot find the Springboard **Stop timer** button. A cleared signal is therefore not proof that the timer stopped.
- The script silently handles polling errors, so a working-looking page does not guarantee that the API is reachable.
- Verify that the endpoint uses HTTPS and that the API validates requests and protects each user's signal.
- Confirm the endpoint URL and API behavior against the current deployment before relying on the bookmarklet.
- Follow organizational policies for browser automation and time-tracking systems.

### D. Application Client: `script.js` and `index.html`

#### Manual Remote Stop

The `#btnStopSpringboard` control dispatches a POST signal to `/api/timer-signal?pin=<PIN>&action=set` and pauses the local countdown interval.

#### Wall-Clock Revalidation and Auto-Resume

When tapping **Sync** or restoring an active session from Neon DB, snip8 calculates elapsed seconds since the desktop snapshot was recorded:

`Date.now() - updated_at`

If the remote session was actively running, snip8 deducts elapsed seconds from `remainingSeconds`, adds them to `loggedSeconds`, enables **Live Increment**, and resumes the countdown loop.

#### Background Wake Re-anchoring

A browser `visibilitychange` listener recalculates remaining time against a static `targetTimestamp` whenever the mobile browser wakes up. This helps prevent sleep-mode clock drift.

#### Visual Progress Bar and Policy Indicators

Directly beneath the countdown timer, an eight-hour progress bar renders dynamic color thresholds:

- **In Progress:** Emerald bar (`#10b981`).
- **7h 55m to 8h 00m — Target Met:** Glowing emerald (`#34d399`) with a checkmark indicator.
- **8h 00m to 8h 05m — Grace Window:** Amber warning bar (`#f59e0b`).
- **Beyond 8h 05m — Violation Overflow:** Pulsing red bar (`#dc2626`) indicating a policy breach.

---

## 4. Operational Playbook

| Stage                | Location                        | What to Do                                                                                                               | What Happens                                                                                                                                  |
| -------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Start shift          | Desktop — Springboard           | Click **Start timer**, then click the **Sync Bridge** bookmark once.                                                     | The bridge starts polling silently every 10 seconds. A green toast appears for three seconds.                                                 |
| Calibrate snip8      | Desktop or mobile — snip8       | Paste or upload a screenshot crop of the active Springboard column.                                                      | Gemini Vision scans the header and column logs, computes remaining time, sets the target stop clock, and saves the active session to Neon DB. |
| Track on mobile      | Mobile — snip8                  | Open snip8 and tap **Sync** once.                                                                                        | Session data loads with elapsed time deducted, and the timer automatically continues counting down.                                           |
| Stop remotely        | Mobile — snip8                  | Tap **Stop Springboard**.                                                                                                | snip8 sets `stop_requested = TRUE`; the desktop bridge detects the signal, attempts to click **Stop timer**, and clears the signal.           |
| Resume work          | Desktop — Springboard and snip8 | Click **Start timer** in Springboard. In snip8, paste a fresh screenshot or toggle **Live Increment** on as appropriate. | Time tracking resumes. Do not click the bookmarklet again unless the page was refreshed.                                                      |
| Recover after reload | Desktop — Springboard           | Click the **Sync Bridge** bookmark once after reloading Springboard.                                                     | The polling loop is initialized again in the refreshed tab.                                                                                   |

---

## 5. Security and IT Policy Characteristics

### Zero Extension Footprint

The bridge runs as a browser bookmarklet using standard browser APIs such as `fetch`, `setInterval`, and DOM interaction. It does not require a third-party browser extension or elevated administrative rights.

### Isolated Client Storage

The PIN and client-side session settings are stored in the browser profile's local storage. Other devices do not automatically share this local storage; each browser profile may need its own setup.

### No Credential Interception

snip8 does not intentionally capture, store, or transmit Springboard passwords, session tokens, or private cookies. Communication is designed for out-of-band coordination using the user's PIN in Neon DB.

### Deployment Security Checklist

- Do not commit `.env` files, database credentials, API keys, or real user PINs.
- Review whether query parameters are stored in hosting, proxy, or application logs.
- Do not treat CORS as authentication.
- Ensure the API validates the PIN and limits access to the appropriate signal record.
- Avoid showing the actual PIN in notifications or screenshots.
- Verify successful timer termination in Springboard.
- Confirm that use of the bookmarklet complies with organizational IT and timekeeping policies.

---

## 6. Troubleshooting

### The Bridge Toast Does Not Appear

- Confirm that Springboard is open in the active tab.
- Click the **Sync Bridge** bookmark.
- Check whether bookmarklet execution is restricted by the browser or organization.
- If needed, open Developer Tools with `F12` and inspect the Console.

### Remote Stop Does Not Trigger

- Confirm that the desktop Springboard tab is open and has not been suspended by browser or operating-system power policies.
- Verify that the six-digit PIN in snip8 matches the PIN saved by the bookmarklet.
- Confirm that the API endpoint is reachable.
- Verify that Springboard still has a button whose text contains `stop timer`.
- Check the timer directly and stop it manually if necessary.

### Bookmarklet Stops Working After Reload

Reloading the page clears in-memory JavaScript. Click the **Sync Bridge** bookmark once to reinitialize the polling loop.

### Timer Displays an Offset After a Long Break

Take a fresh screenshot of Springboard and paste it into snip8. Compare the parsed time against Springboard's displayed column totals and correct any OCR discrepancies.

### The Bookmarklet Says It Is Already Running

The duplicate-execution guard uses `window._sbSyncBridgeRunning`. Refresh the Springboard tab to clear the in-memory flag, then click the bookmarklet again. Refreshing also clears the existing polling loop, so reinitialize it only after the page has finished loading.

---

## 7. Quick Reference

| Item                    | Value                                          |
| ----------------------- | ---------------------------------------------- |
| Daily target            | 8 hours / 28,800 seconds                       |
| Compliant stop window   | 7h 55m to 8h 00m                               |
| Grace period cap        | 8h 05m                                         |
| Bridge polling interval | 10 seconds / 10,000 ms                         |
| Signal storage table    | `snip8_signals`                                |
| Signal endpoint         | `/api/timer-signal`                            |
| Request action          | `action=set`                                   |
| Acknowledgment action   | `action=clear`                                 |
| Springboard DOM target  | Native button whose text contains `stop timer` |
| Desktop activation      | Click **Sync Bridge** once per tab session     |
| Recovery after refresh  | Relaunch **Sync Bridge**                       |
| Required verification   | Confirm the timer stopped in Springboard       |

---

## 8. Operational Limitations

- Remote stopping is not instantaneous. The bridge checks for a signal every 10 seconds, and network or browser delays may add more time.
- The desktop Springboard tab must remain open, connected, and active enough to execute JavaScript.
- Browser suspension, network interruptions, API errors, or Springboard interface changes can prevent the action from running.
- The bookmarklet acknowledges and clears the signal even if it does not find the expected button.
- The temporary toast confirms initialization, not continuous connectivity or successful timer termination.
- Screenshot-based time extraction can require manual review.
- Always verify the actual Springboard timer state after a remote-stop request.

---

## 9. Documentation Maintenance

This document describes the intended architecture and the production bookmarklet implementation supplied for snip8. Verify all implementation details against the deployed source code, API behavior, database schema, and current organizational requirements before relying on them for operational or compliance decisions.
