# snip8 ⏱️

> Snip your timesheet screenshot, hit exactly 8 hours, and stop on time.

**snip8** is an offline-first, client-side web utility that scans
timesheet screenshots (Springboard, Clockify, Hubstaff), parses logged
daily hours with in-browser OCR and Gemini AI Vision, and sets a live
countdown timer with Web Audio alerts to help avoid policy violations.

------------------------------------------------------------------------

## 🚀 Key Features

### 📸 Intelligent Hybrid Vision Pipeline

-   **In-Browser OCR (Tesseract.js):** Local, client-side OCR for
    instant, private text extraction.
-   **Smart Contrast Binarization:** Automatically preprocesses and
    sharpens faint gray header text on light backgrounds for maximum OCR
    accuracy.
-   **Gemini AI Vision Fallback:** Automatically falls back to Google
    Gemini Vision (`@google/genai`) for complex crops, low-contrast
    screenshots, mobile uploads, or OCR on timeouts.
-   **Header Priority Parsing:** Detects cumulative daily header totals
    (e.g. `08 hr 00 min 05 sec` → `28,805s`) with regex priority,
    avoiding fragmented day splits.

### 📊 Unified Progress & Status Bar

-   **Multi-Stage Visual Feedback:** Smooth animated gradient progress
    bar guiding the user through:
    -   `15%`: Extracting timesheet text (OCR)...
    -   `50%`: Validating timesheet with Gemini Vision...
    -   `85%`: Applying timesheet values & syncing...
    -   `100%`: Timesheet successfully synced! (Emerald success state
        with auto-fadeout)

### ☁️ Single-Screenshot Cloudinary Storage & Preview

-   **Strict 1-Image Storage:** Overwrites a single fixed asset per user
    PIN (`snip8/snip8_user_{pin}_latest`) in Cloudinary to eliminate
    file accumulation.
-   **Dynamic Folder Placement:** Routes uploads directly into
    Cloudinary's `snip8` asset folder.
-   **Collapsible Preview Card:** Displays the latest scanned timesheet
    directly beneath the drop zone, complete with expandable toggle,
    timestamp badge, "Open Full ↗" link, and CDN cache-busting queries.

### 💾 Offline-First PWA Storage & Neon DB Sync

-   **Instant Hydration (Stale-While-Revalidate):** Renders immediately
    from local storage on app boot, enabling offline access to cached
    state.
-   **Monotonic State Reconciliation:** Compares local device
    progression against remote Neon PostgreSQL DB state, preventing
    accidental time regression or stale overwrites.
-   **Offline Mutation Queue:** Queues updates when offline and
    automatically syncs them to Neon DB when network connectivity
    resumes.
-   **PIN-Scoped Sessions:** Sessions are scoped by user PIN and work
    date (`CURRENT_DATE`).

### ⏰ Strict 8-Hour Daily Compliance & Timer Controls

-   **Live Countdown:** Real-time countdown clock tracking seconds
    remaining until 8 hours.
-   **Grace Period Cutoff:** Highlights the configured 5-minute policy
    cutoff boundary.
-   **Live Increment:** Optional ticking mode that increments logged
    seconds in real time while on shift.
-   **Micro-Adjustments:** Quick `-5m`, `-1m`, `+1m`, `+5m` offset
    buttons and an instant reset latch.
-   **Web Audio Melodic Chimes:** Emits repeating audio alarms upon
    reaching 8:00:00 with browser notification support.

### 🛑 Remote Springboard Stop Bridge

-   **Remote Stop Requests:** Send a stop request from snip8 on a mobile
    device or another browser tab.
-   **Bookmarklet-Based Desktop Bridge:** A JavaScript bookmarklet runs
    in the existing Springboard desktop tab without requiring a
    third-party browser extension.
-   **Neon Signal Coordination:** The serverless `/api/timer-signal`
    endpoint stores a pending stop signal in the `snip8_signals`
    PostgreSQL table.
-   **Eight-Second Polling:** The desktop bridge checks for pending
    requests every 8 seconds and attempts to click Springboard's **Stop
    timer** button.
-   **Automatic Stop Request:** snip8 can send a stop signal when the
    configured 8-hour limit is reached.
-   **Bridge Status Badge:** Displays a small `snip8 Bridge Active`
    indicator in the Springboard tab after the bookmarklet initializes.

**Important limitations:** The desktop Springboard tab must remain open,
online, and running the bridge. After refreshing the Springboard page,
launch the bookmarklet again. Remote stopping is best-effort automation,
not a guarantee; always verify that Springboard's timer actually
stopped. Use this only in accordance with your organization's policies.

### 🎨 Adaptive Light & Dark Theme System

-   Complete theme controller supporting automatic OS preference
    detection (`prefers-color-scheme`) and manual toggle.
-   High-contrast, accessible styling for all cards, tables, inputs, and
    action buttons in both light and dark modes.

------------------------------------------------------------------------

## 🏗️ Architecture

### Core snip8 Data Flow

``` text
                          [ User Screenshot ]
                                   |
                 +-----------------+-----------------+
                 |                                   |
                 v                                   v
       [ Local Tesseract OCR ]            [ Cloudinary Upload ]
                 |                         (snip8/snip8_user_PIN_latest)
        (Fallback / Low Conf)                         |
                 v                                   v
       [ Gemini AI Vision API ]             [ Secure CDN URL ]
                 |                                   |
                 +-----------------+-----------------+
                                   |
                                   v
                            [ Master State ]
                             (Logged / Rem)
                                   |
                 +-----------------+-----------------+
                 |                                   |
                 v                                   v
          [ Local Storage ]                 [ Neon PostgreSQL ]
       (snip8_cache_PIN_date)                (snip8_sessions table)
```

### Remote Springboard Stop Signal Flow

``` text
[ snip8 UI / Mobile Device ]
             |
             | POST action=set
             v
[ Serverless API: /api/timer-signal ]
             |
             | Set stop_requested = TRUE
             v
[ Neon PostgreSQL: snip8_signals ]
             ^
             | GET poll every 8 seconds
             |
[ Springboard Desktop Tab + Bookmarklet ]
             |
             | Detect pending stop request
             v
[ Click Springboard "Stop timer" ]
             |
             | POST action=clear
             v
[ Signal reset: stop_requested = FALSE ]
```

The signal flow depends on the desktop bookmarklet polling the API and
successfully finding the expected Springboard button. The signal being
cleared does not, by itself, prove that the timer stopped.

------------------------------------------------------------------------

## 🛠️ Tech Stack

-   **Frontend:** Vanilla HTML5, CSS3, JavaScript (ES Modules), Tailwind
    CSS (CDN)
-   **Local OCR:** Tesseract.js v5
-   **AI Vision:** Google Gemini API (`@google/genai`)
-   **Image CDN:** Cloudinary SDK v2
-   **Database:** Neon PostgreSQL Serverless
    (`@neondatabase/serverless`)
-   **Runtime:** Node.js (v18+) with native HTTP serverless-compatible
    API routes
-   **Remote Stop Bridge:** JavaScript bookmarklet, Fetch API, DOM
    interaction, and timed polling

------------------------------------------------------------------------

## ⚙️ Environment Configuration

Create a `.env` file in the root directory:

``` env
# Neon PostgreSQL Database
DATABASE_URL=postgresql://user:password@ep-xyz.us-east-2.aws.neon.tech/neondb?sslmode=require

# Google Gemini AI Vision
GEMINI_API_KEY=your_gemini_api_key_here

# Cloudinary Storage
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_cloudinary_api_key
CLOUDINARY_API_SECRET=your_cloudinary_api_secret

# Server Port (optional, defaults to 3000)
PORT=3000
```

Keep `.env` and all credentials out of version control. Never commit
real database URLs, API keys, or Cloudinary secrets.

------------------------------------------------------------------------

## 🚦 Getting Started

### Prerequisites

-   Node.js (v18 or higher)
-   npm or yarn

### Installation

``` bash
git clone https://github.com/jamesphillipdeguzman/snip8.git
cd snip8
npm install
```

### Development Server

``` bash
npm run dev
```

Open `http://localhost:3000` in your browser.

------------------------------------------------------------------------

## 📖 How to Use

1.  **Enter Your PIN:** Click the lock icon or prompt to set your 4--8
    digit personal PIN.
2.  **Snip Timesheet:** Capture your timesheet using `Win + Shift + S`
    (Windows) or `Cmd + Shift + 4` (Mac).
3.  **Paste:** Focus snip8 and press `Ctrl + V` (or drag and drop the
    image into the drop zone).
4.  **Track & Stop:** The unified progress bar extracts hours, stores
    the screenshot preview, and sets your countdown.
5.  **Enable Remote Stop (optional):** Open Springboard on your desktop
    and launch the Sync Bridge bookmarklet once. Keep the tab open while
    using remote-stop functionality. After a page refresh, launch the
    bookmarklet again.
6.  **Verify the Timer:** Whenever a stop is requested, confirm directly
    in Springboard that the timer has stopped.

------------------------------------------------------------------------

## 🛑 Remote Springboard Stop: Quick Reference

  Item                        Details
  --------------------------- ------------------------------------------
  Daily target                8 hours / 28,800 seconds
  Grace boundary              Configured 5-minute policy grace period
  Polling interval            8 seconds
  API endpoint                `/api/timer-signal`
  Signal table                `snip8_signals`
  Request action              `action=set`
  Acknowledgment action       `action=clear`
  Springboard button          `Stop timer`
  After Springboard refresh   Relaunch the Sync Bridge bookmark
  Required verification       Confirm the timer stopped in Springboard

### Troubleshooting

-   **Bridge badge missing:** Open the correct Springboard tab and
    launch the bookmarklet.
-   **Remote stop does not work:** Confirm the tab is open, the bridge
    is active, the PIN matches, and the API is reachable. Check for
    changes to the button text.
-   **Bridge stops after refresh:** Reloading clears the in-memory
    script. Launch the bookmarklet again.
-   **Timer still running:** Stop it manually in Springboard and
    investigate the bridge/API before relying on remote stopping again.

------------------------------------------------------------------------

## 📚 Documentation

- **[System Architecture & Remote Stop Guide](docs/snip8-system-documentation.md):** Detailed technical breakdown of the out-of-band polling bridge, Neon DB signal persistence, CORS configuration, DOM click automation, and full bookmarklet scripts.
------------------------------------------------------------------------

## 📄 License

MIT
