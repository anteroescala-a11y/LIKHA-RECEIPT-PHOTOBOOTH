# LIKHA-RECEIPT-PHOTOBOOTH — AI Bots Agency edition

A photobooth kiosk that prints photo strips on a thermal receipt printer, themed for an **AI Bots Agency**.

## AI Bots Agency receipts

| Frame | Photos | What prints |
| --- | --- | --- |
| Agent ID Badge | 1 | Official agent credentials: bot name, unit no., model, clearance level, role, "DEPLOYED" status |
| Bot Invoice | 3 | A deployment invoice: photo renders, one prompt ("SMILE"), 0 GPU hours, 0 hallucinations, total PRICELESS |
| Boot Log | 4 (grid) | A terminal boot sequence with `[ OK ]` checks and a progress bar |
| Bot Squad | 4 (strip) | The agent badge as a long four-photo strip |

Every guest gets a made-up agent persona (e.g. *NOVA, Chief Smile Officer, SMILE-7B*), fixed per order number so reprints match.
The classic receipt, boarding pass and movie ticket frames are still available.

New robot stickers: robot head, LED visor, AI chip, lightning bolt, and "BEEP!", "HI HUMAN" and "100% AI" speech bubbles.

Title, subtitle, footer and accent colour default to the agency branding and can be changed in **Kiosk settings → Design** (gear icon, default PIN `1234`).

## Booth look: AI bots canvas

By default the booth runs a dark "bot canvas" welcome screen. Each step of the booth is a bot on a dotted canvas, linked by dashed wires: Camera, Filter, Frame, Sticker, Print and Share Bot.
The bots take turns lighting up and reporting in to a live **Bot log** (countdown, frames ready, paper width, next receipt number). A **Bot Manager** status bar sits underneath.
The whole kiosk switches to a matching dark theme. To get the original light receipt-printer look back, go to **Kiosk settings → Design → Booth look**.

## Booth Bots: the business console (`bots.html`)

Bots that run the photobooth business. Click a bot on the canvas to open its panel:

| Bot | What it does |
| --- | --- |
| Inquiry Bot | Paste a customer message (English or Taglish). It finds the name, date, event, time, venue, hours, guests and phone number, checks whether the date is free, recommends a package and drafts your reply with the price and downpayment. One tap saves it as an inquiry. |
| Booking Bot | Adds and edits bookings with statuses (inquiry, confirmed, paid, done, cancelled), totals, downpayment and extra-hour and travel fees. It warns about double bookings, copies a confirmation message, downloads a calendar (.ics) file and exports CSV. |
| Scheduler Bot | A month calendar of events, inquiries and planned posts, with open weekend dates for the next 60 days. |
| Follow-up Bot | Lists the messages due today: inquiry follow-ups, downpayment reminders, event reminders (3 days before) and thank-you plus review requests after the event. |
| Marketing Bot | Writes Facebook, Instagram and TikTok captions from your real packages, open dates and past events. It queues them into your posting slots (12 PM, 6 PM and 8 PM by default), and "Plan my week" fills seven days. |
| Bot Manager | Runs the checks (double bookings, missing downpayments, waiting inquiries, no posts this week, events not closed) and shows this month's bookings and open inquiries. It also holds the settings, packages and backup. |

Data is stored on the device that opens the page. It can also sync with a Google Sheet (see below), and **Bot Manager → Export backup** saves a copy.

### Syncing bookings with a Google Sheet

Bookings sync both ways with a **Bookings** tab in the spreadsheet made by the sharing server (`server/Code.gs`):

1. Paste the new `server/Code.gs` into your Apps Script project and set your `BOOTH_KEY`.
2. Run the function **setupBookings** once and approve the permissions. It creates the tab and a trigger that notices your hand edits.
3. **Deploy → Manage deployments → Edit → Version: New version → Deploy.**
4. In Booth Bots: **Bot Manager → Google Sheet sync**. Enter the Web app URL (ends in `/exec`) and the booth key. If the booth on the same device already uses the sharing server, its address and key are used automatically.

The console syncs on open, 4 seconds after every change, and every 2 minutes. In the sheet you can edit any booking or type a new one on an empty row; it reaches the console on the next sync. Dates can be typed as `2026-12-31` or `12/31/2026`, and times as `7:00 PM`. To remove a booking from the sheet, type `yes` in the **deleted** column. If you delete the whole row, the console puts it back. When the same booking changes in both places, the most recent change wins. Phones and tablets that sync to the same sheet share one set of bookings. The bots draft messages and posts for you to copy into Messenger or Facebook; they do not send or post anything on their own.
