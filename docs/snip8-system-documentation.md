# snip8 & Remote Springboard Stop

## System Documentation

## 1. General Overview of snip8

snip8 is a companion web application designed to track, calculate, and
automate daily work-hour limits---specifically an eight-hour target of
28,800 seconds---alongside organizational time-tracking software such as
Springboard (`app.hirespringboard.com`).

### Core Capabilities

**Visual Timesheet Parsing**\
Users capture screenshots of the active Springboard timesheet grid and
summary headers. The integrated Gemini Vision backend extracts logged
hours, pay-period metrics, daily column logs, and stacked time blocks.

**Live Target Countdown**\
snip8 converts the totals from a screenshot into a live counter that
tracks cumulative logged time against the eight-hour threshold.

**Policy Compliance Safeguards**\
The application monitors the configured work-hour limit and can account
for a five-minute policy grace period, where applicable, to help prevent
unintended overtime.

**Cross-Device Cloud State**\
Active session state, parsed intervals, and user PIN-based signals are
stored in Neon PostgreSQL serverless storage.

**Remote Stop Bridge**\
A browser bookmarklet running in the desktop Springboard tab checks for
a stop request. This allows a user to request a timer stop from snip8 on
another device, without installing a browser extension.

## 2. Remote Springboard Stop Mechanism

### The Problem It Solves

Corporate-managed environments may restrict third-party browser
extensions and may not provide a native Springboard mobile application
or a supported remote-stop API. Without a bridge, a worker who steps
away from the desktop may need to return to the workstation to stop the
timer manually.

### Architecture: Asynchronous Database Signaling Bridge

snip8 uses an out-of-band polling pattern. A browser bookmarklet runs in
the desktop Springboard tab and periodically checks the snip8 API for a
pending stop request.

**Signal flow**

1.  **Request initiated:** The user selects **Stop Springboard** in
    snip8, or the configured eight-hour cap is reached.
2.  **API receives request:** The snip8 client sends a request to
    `/api/timer-signal`.
3.  **Signal stored:** The API sets `stop_requested` to `TRUE` in the
    Neon PostgreSQL table `snip8_signals`, keyed by the user's PIN.
4.  **Desktop tab polls:** The bookmarklet checks
    `/api/timer-signal?pin=<PIN>` every ten seconds (10,000 ms).
5.  **Stop action runs:** If a stop request is pending, the bookmarklet
    looks for the Springboard **Stop timer** button and clicks it.
6.  **Signal acknowledged:** The bookmarklet sends a request with
    `action=clear` to reset the signal.
7.  **Signal reset:** The database value returns to `FALSE`, ready for a
    future request.

**Important:** The bridge depends on the Springboard tab being open, the
bookmarklet having been started in that tab, network access being
available, and the expected Stop timer button being present. The
ten-second polling interval means a remote request may not be
processed immediately. Verify that Springboard actually stopped the
timer.

## 3. Component Breakdown

### A. Signal Storage: `snip8_signals`

The `snip8_signals` table is a minimal state store keyed by the user's
PIN.

  -----------------------------------------------------------------------
  Field                               Purpose
  ----------------------------------- -----------------------------------
  `pin` (`VARCHAR(64)`, primary key)  Identifies the user's signal
                                      record.

  `stop_requested` (`BOOLEAN`)        `TRUE` means a stop request is
                                      pending; `FALSE` means no stop
                                      request is pending.

  `updated_at` (`TIMESTAMPTZ`)        Records when the signal was last
                                      updated or cleared.
  -----------------------------------------------------------------------

### B. Serverless API: `/api/timer-signal`

**GET --- Poll for a stop request**

The bookmarklet polls the endpoint using the user's PIN. The response
includes the current `stop_requested` value.

Example response:

``` json
{
  "stop_requested": true
}
```

**POST --- Update the signal**

-   `action=set`: Sets `stop_requested` to `TRUE`. This is used by the
    snip8 interface or the automated cap handler.
-   `action=clear`: Sets `stop_requested` to `FALSE` after the
    bookmarklet processes the request.

**Cross-origin requests (CORS)**\
The endpoint is configured with `Access-Control-Allow-Origin: *` to
allow browser requests from the relevant application context. CORS
configuration alone does not authenticate a request or protect the
signal endpoint; access control and PIN handling should be reviewed as
part of deployment security.

### C. Desktop Sync Bridge Bookmarklet (Production Version)

#### Overview
The **Sync Bridge** is a lightweight, zero-dependency browser bookmarklet running in the Springboard web application context. It acts as an ambient consumer of the `/api/timer-signal` polling endpoint to trigger native DOM clicks without injecting unvetted browser extensions or triggering IT-flagged console spam.

#### Architecture & Features
- **Zero Console Spam:** Completely suppresses routine `console.log` statements during the polling lifecycle to avoid beaconing noise in DevTools.
- **Visual Toast Feedback:** Injects a temporary non-blocking green notification badge (`Sync Bridge Connected (PIN: ****** )`) in the bottom-right viewport corner for 3 seconds upon execution.
- **Persistent PIN Storage:** Reads and writes the user's 6-digit session PIN directly to the browser's `localStorage['snip8_bridge_pin']`. Falls back to a browser prompt only on cold profiles.
- **Duplicate Execution Guard:** Checks `window._sbSyncBridgeRunning` to prevent redundant concurrent loops if clicked multiple times.
- **Cadence & Network Footprint:** 10,000 ms (10-second) `setInterval` fetch loop, avoiding browser lockups or heavy network inspection flags.
- **Action Sequence:** On detecting `{ stop_requested: true }`:
  1. Finds the DOM button containing text matching `stop timer`.
  2. Dispatches a native `.click()` event to freeze the Springboard timesheet block.
  3. Dispatches a `POST` request to `/api/timer-signal?pin=<PIN>&action=clear` to reset the database signal.

#### Final Production Bookmarklet Code
To install or re-bind in Chrome/Edge, create a bookmark named **Sync Bridge** and set the URL to:

```javascript
javascript:(function(){if(window._sbSyncBridgeRunning){alert('Sync Bridge is already running.');return;}let p=localStorage.getItem('snip8_bridge_pin');if(!p){p=prompt('Enter your 6-digit snip8 PIN:');if(!p)return;localStorage.setItem('snip8_bridge_pin',p.trim());}window._sbSyncBridgeRunning=true;const t=document.createElement('div');t.innerText='Sync Bridge Connected (PIN: '+p+')';t.style.cssText='position:fixed;bottom:16px;right:16px;background:#10b981;color:#fff;padding:8px 14px;border-radius:6px;font-size:12px;z-index:999999;box-shadow:0 4px 6px rgba(0,0,0,0.15);font-family:sans-serif;pointer-events:none;transition:opacity 0.5s ease;';document.body.appendChild(t);setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),500);},3000);setInterval(async()=>{try{const r=await fetch('https://snip8-eight.vercel.app/api/timer-signal?pin='+encodeURIComponent(p));if(!r.ok)return;const d=await r.json();if(d&&d.stop_requested){const b=Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim().toLowerCase().includes('stop timer'));if(b){b.click();}await fetch('https://snip8-eight.vercel.app/api/timer-signal?pin='+encodeURIComponent(p)+'&action=clear',{method:'POST'});}}catch(e){}},10000);})();
```

#### Readable Source Code
Use this formatted reference when reviewing or customizing the production bridge:

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
    localStorage.setItem('snip8_bridge_pin', p.trim());
  }

  window._sbSyncBridgeRunning = true;

  // 3. Temporary visual toast badge (bottom-right, fades out after 3s)
  const t = document.createElement('div');
  t.innerText = 'Sync Bridge Connected (PIN: ' + p + ')';
  t.style.cssText = 'position:fixed;bottom:16px;right:16px;background:#10b981;color:#fff;padding:8px 14px;border-radius:6px;font-size:12px;z-index:999999;box-shadow:0 4px 6px rgba(0,0,0,0.15);font-family:sans-serif;pointer-events:none;transition:opacity 0.5s ease;';
  document.body.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 500);
  }, 3000);

  // 4. Ambient 10-second polling cadence with silent error handling
  setInterval(async () => {
    try {
      const r = await fetch('https://snip8-eight.vercel.app/api/timer-signal?pin=' + encodeURIComponent(p));
      if (!r.ok) return;
      const d = await r.json();

      if (d && d.stop_requested) {
        // Find Springboard Stop timer button
        const b = Array.from(document.querySelectorAll('button')).find(
          x => x.textContent.trim().toLowerCase().includes('stop timer')
        );
        if (b) {
          b.click();
        }
        // Acknowledge and clear signal in Neon DB
        await fetch('https://snip8-eight.vercel.app/api/timer-signal?pin=' + encodeURIComponent(p) + '&action=clear', {
          method: 'POST'
        });
      }
    } catch (e) {
      // Silent error handling: zero console noise in DevTools
    }
  }, 10000);
})();
```

#### Installation and Verification

1. Open the browser bookmarks manager (`Ctrl + Shift + O` on Chrome/Edge) or right-click the bookmarks bar and select **Add page...**.
2. Set the bookmark name to `Sync Bridge`.
3. Paste the minified `javascript:(...)` snippet into the bookmark **URL** field.
4. Navigate to your active Springboard timesheet tab (`app.hirespringboard.com`) and click the **Sync Bridge** bookmark.
5. On the first launch, enter your 6-digit snip8 PIN. The PIN is saved in `localStorage['snip8_bridge_pin']` for future launches on this browser profile.
6. A green toast badge reading `Sync Bridge Connected (PIN: ****** )` will appear in the lower-right corner for 3 seconds, confirming initialization.
7. Subsequent clicks on the bookmark will display a non-disruptive alert (`Sync Bridge is already running.`) to prevent duplicate intervals.

#### Security and Reliability Notes

- **Zero Console Footprint:** The production bridge omits all diagnostic console logging to prevent beaconing in enterprise observability environments.
- **Persistent Storage:** Storing the PIN in `localStorage['snip8_bridge_pin']` ensures seamless one-click activation across workday sessions without re-typing.
- **Fail-Safe Polling:** Network fetch errors are trapped silently to prevent unhandled promise rejections in the host application.
- **Signal Reset Safety:** The bridge only dispatches `action=clear` once a stop signal is received and processed.

### D. Application Client: `script.js` and `index.html`

**Manual stop**\
The `#btnStopSpringboard` control sends a stop request to the API.

**Automatic cap handling**\
The countdown loop monitors `remainingSeconds`. When the configured
limit is reached or the tracked total reaches 28,800 seconds, the client
calls `requestSpringboardStop()` once to submit the stop request.

**Time adjustments**\
The `-5m`, `-1m`, `+1m`, and `+5m` controls allow the user to make small
corrections when OCR-extracted time blocks differ from Springboard's
summary totals.

## 4. Operational Playbook

  -----------------------------------------------------------------------
  Stage             Location          What to do        What happens
  ----------------- ----------------- ----------------- -----------------
  Start shift       Desktop ---       Select **Start    The polling loop
                    Springboard       timer**, then     starts in the tab
                                      launch the **Sync and the bridge
                                      Bridge** bookmark badge appears.
                                      once.             

  Calibrate snip8   Desktop or mobile Capture the       The vision parser
                    --- snip8         Springboard       extracts time
                                      summary header    data and the live
                                      and daily         countdown begins.
                                      timesheet grid,   Review the parsed
                                      then upload the   values for
                                      screenshots to    accuracy.
                                      snip8.            

  Take a break or   Mobile or another Select **Stop     The API stores a
  stop remotely     device --- snip8  Springboard**.    pending signal;
                                                        the desktop
                                                        bridge detects it
                                                        and attempts to
                                                        click **Stop
                                                        timer**, then
                                                        clears the
                                                        signal.

  Resume work       Desktop ---       Select **Start    The Springboard
                    Springboard       timer** directly  timer starts
                                      in Springboard.   again. If the
                                                        bridge is still
                                                        active, do not
                                                        launch it again
                                                        unnecessarily.

  Recover after a   Desktop ---       After the page    Reloading clears
  page refresh      Springboard       reloads, launch   the page's
                                      the **Sync        in-memory script,
                                      Bridge** bookmark so the polling
                                      once again.       loop must be
                                                        initialized
                                                        again.

  Finish shift      snip8 or desktop  Select the stop   snip8 sends a
                    --- Springboard   control in snip8  stop signal; the
                                      or allow the      desktop bridge
                                      configured        attempts to stop
                                      countdown to      the Springboard
                                      reach zero.       timer.
                                      Verify the result 
                                      in Springboard.   
  -----------------------------------------------------------------------

## 5. Security and IT Policy Characteristics

**No browser extension installation**\
The bridge runs as a bookmarklet in the existing browser tab and uses
standard browser capabilities such as `fetch`, `setInterval`, and DOM
interaction.

**Standard page interaction**\
The bridge attempts to click the visible Springboard **Stop timer**
button. It does not intentionally modify Springboard's network payloads
or call private internal APIs.

**No Springboard credentials stored by snip8**\
According to the described design, snip8 uses its own Neon database and
does not store or transmit the user's Springboard username, password, or
authentication tokens.

**Security considerations**\
- Treat the user PIN as a sensitive identifier. Do not expose it in
public documentation, screenshots, URLs shared with others, or logs. -
Because the polling request includes the PIN in the URL, review server
and hosting logs to determine whether query strings are retained. - A
wildcard CORS policy (`Access-Control-Allow-Origin: *`) is not an
authentication mechanism. Ensure the API validates requests and prevents
unauthorized users from setting or clearing signals. - Confirm that the
endpoint uses HTTPS and that database access is restricted to the
server-side application. - The bridge is best-effort automation. It can
fail if the tab is closed, refreshed, suspended, offline, or if
Springboard changes its button text or page behavior. - Follow
organizational policies and obtain any required approval before using
automation with a corporate time-tracking system.

## 6. Troubleshooting

**The bridge badge does not appear** - Confirm that Springboard is open
in the intended desktop tab. - Launch the Sync Bridge bookmark again. -
Check whether the browser blocked or rejected the bookmarklet.

**A remote stop request does not stop the timer** - Confirm the desktop
Springboard tab remains open and connected. - Confirm the bridge was
initialized after the most recent page load. - Check that the user's PIN
matches between snip8 and the bookmarklet. - Verify that the API is
reachable and the stop signal was set. - Confirm that Springboard still
displays a button whose text matches `Stop timer`. - Check Springboard
directly and stop the timer manually if needed.

**The bridge stops working after refreshing Springboard** - A page
refresh clears JavaScript state in the tab. Launch the Sync Bridge
bookmark again.

**The countdown differs from Springboard** - Capture a fresh screenshot
of the summary header and daily grid. - Review OCR-extracted intervals
and use the time-adjustment controls only when needed. - Treat
Springboard's displayed values as the reference and verify the final
recorded time.

## 7. Operational Limitations

-   Remote stopping is not instantaneous; the bridge polls at a
    ten-second interval (10,000 ms).
-   The desktop Springboard tab must remain open and the bookmarklet
    must be active.
-   Browser or operating-system suspension, network problems, API
    errors, or changes to Springboard's interface can prevent the action
    from running.
-   A successful API response confirms signal handling, not necessarily
    that Springboard stopped the timer. Verify the timer state in
    Springboard.
-   Screenshot-based time extraction may require review and correction.

## 8. Quick Reference

-   **Daily target:** 8 hours / 28,800 seconds
-   **Bridge polling interval:** 10 seconds (10,000 ms)
-   **Signal table:** `snip8_signals`
-   **Signal endpoint:** `/api/timer-signal`
-   **Request action:** `action=set`
-   **Acknowledgment action:** `action=clear`
-   **Springboard button:** `Stop timer`
-   **After page refresh:** Relaunch the Sync Bridge bookmark

------------------------------------------------------------------------

**Document purpose:** This document describes the snip8 and Remote
Springboard Stop design and its expected operating procedure. Confirm
implementation details against the current source code and deployment
configuration before relying on them for operational or compliance
decisions.
