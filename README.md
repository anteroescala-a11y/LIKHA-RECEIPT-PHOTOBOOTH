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
