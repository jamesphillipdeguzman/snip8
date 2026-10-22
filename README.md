# snip8 ⏱️

> Snip your timesheet screenshot, hit exactly 8 hours, and stop on time.

**snip8** is an offline-first, client-side web utility that scans timesheet screenshots (Springboard, Clockify, Hubstaff), parses logged daily hours with in-browser OCR and Gemini AI Vision, and sets a live countdown timer with Web Audio alerts to help avoid policy violations.

---

## 🚀 Key Features

### 📸 Intelligent Hybrid Vision Pipeline
- **In-Browser OCR (Tesseract.js):** Local, client-side OCR for instant, private text extraction.
- **Smart Contrast Binarization:** Automatically preprocesses and sharpens faint gray header text on light backgrounds for maximum OCR accuracy.
- **Gemini AI Vision Fallback:** Automatically falls back to Google Gemini Vision (`@google/genai`) for complex crops, low-contrast screenshots, mobile uploads, or on OCR timeouts.
- **Header Priority Parsing:** Detects cumulative daily header totals (e.g. `08 hr 00 min 05 sec` -> `28,805s`) with regex priority, avoiding fragmented day splits.

### 📊 Unified Progress & Status Bar
- **Multi-Stage Visual Feedback:** Smooth animated gradient progress bar guiding the user through:
  - `15%`: Extracting timesheet text (OCR)...
  - `50%`: Validating timesheet with Gemini Vision...
  - `85%`: Applying timesheet values & syncing...
  - `100%`: Timesheet successfully synced! (Emerald success state with auto-fadeout)

### ☁️ Single-Screenshot Cloudinary Storage & Preview
- **Strict 1-Image Storage:** Overwrites a single fixed asset per user PIN (`snip8/snip8_user_{pin}_latest`) in Cloudinary to eliminate file accumulation.
- **Dynamic Folder Placement:** Routes uploads directly into Cloudinary's `snip8` asset folder.
- **Collapsible Preview Card:** Displays the latest scanned timesheet directly beneath the drop zone, complete with expandable toggle, timestamp badge, "Open Full ↗" link, and CDN cache-busting queries.

### 💾 Offline-First PWA Storage & Neon DB Sync
- **Instant Hydration (Stale-While-Revalidate):** Renders immediately from local storage on app boot, enabling 100% offline functionality.
- **Monotonic State Reconciliation:** Compares local device progression against remote Neon PostgreSQL DB state, preventing accidental time regression or stale overwrites.
- **Offline Mutation Queue:** Queues updates when offline and automatically syncs them to Neon DB when network connectivity resumes.
- **PIN-Scoped Sessions:** Sessions are authenticated and isolated by user PIN and work date (`CURRENT_DATE`).

### ⏰ Strict 8-Hour Daily Compliance & Timer Controls
- **Live Countdown:** Real-time countdown clock tracking seconds remaining until 8 hours.
- **Grace Period Cutoff:** Highlights 5-minute policy cutoff boundaries.
- **Live Increment:** Optional ticking mode that increments logged seconds in real time while on shift.
- **Micro-Adjustments:** Quick `-5m`, `-1m`, `+1m`, `+5m` offset buttons and an instant reset latch.
- **Web Audio Melodic Chimes:** Emits repeating audio alarms upon reaching 8:00:00 with browser notification support.

### 🎨 Adaptive Light & Dark Theme System
- Complete theme controller supporting automatic OS preference detection (`prefers-color-scheme`) and manual toggle.
- High-contrast, accessible styling for all cards, tables, inputs, and action buttons in both light and dark modes.

---

## 🏗️ Architecture

```
                                  [ User Screenshot ]
                                           │
                         ┌─────────────────┴─────────────────┐
                         ▼                                   ▼
              [ Local Tesseract OCR ]            [ Cloudinary Upload ]
                         │                       (snip8/snip8_user_PIN_latest)
               (Fallback / Low Conf)                         │
                         ▼                                   ▼
             [ Gemini AI Vision API ]              [ Secure CDN URL ]
                         │                                   │
                         └─────────────────┬─────────────────┘
                                           ▼
                                 [ Master State ]
                                  (Logged / Rem)
                                           │
                         ┌─────────────────┴─────────────────┐
                         ▼                                   ▼
                 [ Local Storage ]                  [ Neon PostgreSQL ]
              (snip8_cache_PIN_date)               (snip8_sessions table)
```

---

## 🛠️ Tech Stack

- **Frontend:** Vanilla HTML5, CSS3, JavaScript (ES Modules), Tailwind CSS (CDN)
- **Local OCR:** Tesseract.js v5
- **AI Vision:** Google Gemini API (`@google/genai`)
- **Image CDN:** Cloudinary SDK v2
- **Database:** Neon PostgreSQL Serverless (`@neondatabase/serverless`)
- **Runtime:** Node.js (v18+) with native HTTP serverless-compatible API routes

---

## ⚙️ Environment Configuration

Create a `.env` file in the root directory:

```env
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

---

## 🚦 Getting Started

### Prerequisites
- Node.js (v18 or higher)
- npm or yarn

### Installation
```bash
git clone https://github.com/jamesphillipdeguzman/snip8.git
cd snip8
npm install
```

### Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 📖 How to Use

1. **Enter Your PIN:** Click the lock icon or prompt to set your 4–8 digit personal PIN.
2. **Snip Timesheet:** Capture your timesheet using `Win + Shift + S` (Windows) or `Cmd + Shift + 4` (Mac).
3. **Paste:** Focus snip8 and press `Ctrl + V` (or drag and drop the image into the drop zone).
4. **Track & Stop:** The unified progress bar will extract hours, store the screenshot preview, and set your countdown to stop on time.

---

## 📄 License
MIT