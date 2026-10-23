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
    `/api/timer-signal?pin=YOUR_PIN` every eight seconds.
5.  **Stop action runs:** If a stop request is pending, the bookmarklet
    looks for the Springboard **Stop timer** button and clicks it.
6.  **Signal acknowledged:** The bookmarklet sends a request with
    `action=clear` to reset the signal.
7.  **Signal reset:** The database value returns to `FALSE`, ready for a
    future request.

**Important:** The bridge depends on the Springboard tab being open, the
bookmarklet having been started in that tab, network access being
available, and the expected Stop timer button being present. The
eight-second polling interval means a remote request may not be
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

### C. Client Bridge Bookmarklet

The bookmarklet is a JavaScript snippet saved as a browser bookmark and
launched in the desktop Springboard tab.

**Visual status indicator**\
The bookmarklet adds a small fixed badge to the lower-right corner of
the page with the label **snip8 Bridge Active**.

**Polling loop**\
A repeating timer checks the API every 8,000 milliseconds (eight
seconds).

**Button detection**\
The script searches page buttons for one whose visible text includes
`Stop timer`.

**Execution and acknowledgment**\
When a pending request is detected, the script clicks the matching
button and sends an `action=clear` request to reset the signal.

The badge indicates that the bridge script has been initialized; it does
not by itself prove that the API is reachable or that a stop request
will succeed.

#### Readable Bookmarklet Source Code

Use this version when reviewing, maintaining, or customizing the bridge. Replace `YOUR_PIN` with the PIN used by your snip8 signal record before installing the bookmarklet.

```javascript
(function() {
  const PIN = 'YOUR_PIN'; // Replace with your snip8 PIN
  const ENDPOINT = 'https://snip8-eight.vercel.app/api/timer-signal';

  // 1. Console confirmation of activation
  console.log(
    '%c[snip8 Bridge] Active & Listening...',
    'background:#10b981;color:#fff;font-weight:bold;padding:4px 8px;border-radius:4px;'
  );

  // 2. Inject or reuse visual status badge in the bottom-right corner
  let badge = document.getElementById('snip8-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'snip8-badge';
    badge.innerHTML = '🟢 snip8 Bridge Active';
    badge.style.cssText = [
      'position:fixed',
      'bottom:12px',
      'right:12px',
      'background:#0f172a',
      'color:#10b981',
      'border:1px solid #10b981',
      'padding:6px 12px',
      'border-radius:20px',
      'font-size:12px',
      'font-family:sans-serif',
      'font-weight:bold',
      'z-index:999999',
      'box-shadow:0 4px 12px rgba(0,0,0,0.3)',
      'pointer-events:none'
    ].join(';');
    document.body.appendChild(badge);
  }

  // 3. Persistent 8-second polling cycle
  setInterval(async () => {
    try {
      // Check the API for a pending stop signal
      const res = await fetch(`${ENDPOINT}?pin=${encodeURIComponent(PIN)}`);
      const data = await res.json();

      if (data && data.stop_requested) {
        console.log('[snip8] Stop signal detected! Stopping Springboard...');

        // Locate the active "Stop timer" button via standard DOM text matching
        const stopBtn = Array.from(document.querySelectorAll('button')).find(
          b => b.innerText && b.innerText.includes('Stop timer')
        );

        if (stopBtn) {
          stopBtn.click();
        }

        // Acknowledge and clear the stop flag
        await fetch(`${ENDPOINT}?pin=${encodeURIComponent(PIN)}&action=clear`, {
          method: 'POST'
        });

        // Update badge visual state
        if (badge) {
          badge.innerHTML = '⏹️ Stopped via snip8';
          badge.style.color = '#f87171';
          badge.style.borderColor = '#f87171';
        }
      }
    } catch (err) {
      console.error('[snip8 error]', err);
    }
  }, 8000);
})();
```

#### Minified Bookmarklet URL

This one-line version is intended for the **URL** field of the browser bookmark. Replace `YOUR_PIN` with your own PIN before saving it.

```javascript
javascript:(function(){const P='YOUR_PIN',U='https://snip8-eight.vercel.app/api/timer-signal';console.log('%c[snip8 Bridge] Active & Listening...','background:#10b981;color:#fff;font-weight:bold;padding:4px 8px;border-radius:4px;');let b=document.getElementById('snip8-badge');if(!b){b=document.createElement('div');b.id='snip8-badge';b.innerHTML='🟢 snip8 Bridge Active';b.style.cssText='position:fixed;bottom:12px;right:12px;background:#0f172a;color:#10b981;border:1px solid #10b981;padding:6px 12px;border-radius:20px;font-size:12px;font-family:sans-serif;font-weight:bold;z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,0.3);pointer-events:none;';document.body.appendChild(b);}setInterval(async()=>{try{const r=await fetch(`${U}?pin=${encodeURIComponent(P)}`);const d=await r.json();if(d&&d.stop_requested){console.log('[snip8] Stop signal detected! Stopping Springboard...');const btn=Array.from(document.querySelectorAll('button')).find(x=>x.innerText&&x.innerText.includes('Stop timer'));if(btn){btn.click();}await fetch(`${U}?pin=${encodeURIComponent(P)}&action=clear`,{method:'POST'});if(b){b.innerHTML='⏹️ Stopped via snip8';b.style.color='#f87171';b.style.borderColor='#f87171';}}}catch(err){console.error('[snip8 error]',err);}},8000);})();
```

#### Installation and Verification

1. Open the browser bookmarks manager with `Ctrl + Shift + O`, or right-click the bookmarks bar and choose **Add page** (the exact menu wording may vary by browser).
2. Set the bookmark name to `Sync Bridge`.
3. Paste the minified snippet into the bookmark's **URL** field. Replace `YOUR_PIN` with the PIN associated with your snip8 signal record.
4. Open the intended Springboard tab and click the **Sync Bridge** bookmark.
5. Open Developer Tools with `F12` and check the Console for `[snip8 Bridge] Active & Listening...`.
6. Confirm that the `🟢 snip8 Bridge Active` badge appears in the bottom-right corner.

#### Security and Reliability Notes

- Do not publish or commit a bookmarklet containing your real PIN. Anyone who obtains the PIN may be able to interact with the signal endpoint, depending on the API's access controls.
- The PIN is sent as a query parameter in API requests. Query strings may be recorded in hosting or server logs, so review logging and access controls.
- The script clears the signal after detecting it even if it cannot find a matching **Stop timer** button. Therefore, the badge changing to **Stopped via snip8** is not proof that Springboard stopped. Always verify the timer in Springboard.
- The script does not check `res.ok` before parsing the polling response, and it does not prevent overlapping polling calls if a request takes longer than eight seconds. Treat it as best-effort automation and test it in the intended environment.
- Confirm the endpoint URL and API behavior against the current deployment before using this snippet. Follow your organization's policies for browser automation and time-tracking systems.

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

-   Remote stopping is not instantaneous; the bridge polls at an
    eight-second interval.
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
-   **Bridge polling interval:** 8 seconds
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
