# snip8 ⏱️

> Snip your timesheet screenshot, hit exactly 8 hours, and stop on time.

**snip8** is an offline-first, client-side web utility that scans timesheet screenshots (Springboard, Clockify, Hubstaff), parses logged daily hours with in-browser OCR, and sets a live countdown timer with Web Audio alerts to help avoid policy violations.

## Key Features
- **In-Browser OCR:** Powered by Tesseract.js. No screenshots or data leave your device.
- **Smart Preprocessing:** Automatically binarizes and zooms faint gray header text on light backgrounds for 100% OCR accuracy.
- **Strict 8-Hour Daily Compliance:** Designed around strict daily 8h caps and 5-minute grace period boundaries (Sec. 4.a).
- **Weekly Breakdown Table:** Tracks Monday through Friday, displaying daily deltas, cumulative totals, and completion status.
- **Web Audio Melodic Chimes:** Emits repeating audio chimes when your shift hits 8:00:00, with an instant dismissal latch.

## Quick Start
1. Take a screenshot of your timesheet (`Win + Shift + S`).
2. Focus **snip8** and press `Ctrl + V`.
3. Follow the live countdown to stop your timer right on target.

## License
MIT