---
name: Haggle
description: A night bazaar trading floor under one clock, for a whole room playing one simulated market.
colors:
  night: "#0d0b19"
  night-2: "#131026"
  night-3: "#1b1733"
  night-4: "#241f3d"
  rule: "#2e2846"
  ink: "#f1eadb"
  ink-2: "#bdb6a6"
  ink-3: "#8f897b"
  saffron: "#ffb020"
  saffron-deep: "#3d2a07"
  up: "#3ddc84"
  up-deep: "#0f3a26"
  down: "#ff5c62"
  down-deep: "#44161b"
  technology: "#7c83ff"
  semiconductors: "#b27cf2"
  healthcare: "#36c2b4"
  finance: "#c2dc4c"
  energy: "#f07f4f"
  automotive: "#f0679a"
  consumer: "#5ec3f0"
  industrials: "#d9b98a"
  ecommerce: "#e48cf0"
  telecom: "#4f9df0"
  aerospace: "#9fb3c8"
  materials: "#a3a35c"
  food: "#f2a6a0"
  media: "#6fe0e8"
  logistics: "#c79a6e"
typography:
  display:
    fontFamily: "Big Shoulders Display Variable, Archivo Variable, sans-serif"
    fontSize: "clamp(3.5rem, 12vw, 9rem)"
    fontWeight: 900
    lineHeight: 0.85
    letterSpacing: "0.01em"
  headline:
    fontFamily: "Big Shoulders Display Variable, Archivo Variable, sans-serif"
    fontSize: "26px"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "0.01em"
  ticker:
    fontFamily: "Big Shoulders Display Variable, Archivo Variable, sans-serif"
    fontSize: "44px"
    fontWeight: 900
    lineHeight: 0.9
  price-tag:
    fontFamily: "Big Shoulders Display Variable, Archivo Variable, sans-serif"
    fontSize: "34px"
    fontWeight: 800
    lineHeight: 1
  title:
    fontFamily: "Big Shoulders Display Variable, Archivo Variable, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    letterSpacing: "0.06em"
  body:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.375
    fontFeature: "'tnum' 1, 'lnum' 1"
  body-small:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.375
    fontFeature: "'tnum' 1, 'lnum' 1"
  caption:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    fontFeature: "'tnum' 1, 'lnum' 1"
  label:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.08em"
    fontFeature: "'tnum' 1, 'lnum' 1"
rounded:
  swatch: "2px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  full: "9999px"
spacing:
  hair: "4px"
  row: "8px"
  stack: "12px"
  gutter: "16px"
  section: "32px"
components:
  button-primary:
    backgroundColor: "{colors.saffron}"
    textColor: "{colors.night}"
    rounded: "{rounded.md}"
    height: "48px"
    typography: "{typography.body}"
  button-sell:
    backgroundColor: "{colors.down}"
    textColor: "{colors.night}"
    rounded: "{rounded.md}"
    height: "48px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.md}"
    height: "28px"
  input:
    backgroundColor: "{colors.night}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 12px 0 36px"
  chip-effect-up:
    backgroundColor: "{colors.up-deep}"
    textColor: "{colors.up}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
  chip-effect-down:
    backgroundColor: "{colors.down-deep}"
    textColor: "{colors.down}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
  chip-simulated:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
  price-tag:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.night}"
    typography: "{typography.price-tag}"
    padding: "4px 12px 4px 14px"
  stall-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    padding: "8px 16px"
  stall-row-selected:
    backgroundColor: "{colors.night-4}"
  roster-row-you:
    backgroundColor: "{colors.saffron-deep}"
    rounded: "{rounded.md}"
  tab-active:
    textColor: "{colors.saffron}"
    typography: "{typography.label}"
    height: "56px"
  tab:
    textColor: "{colors.ink-3}"
    height: "56px"
---

# Design System: Haggle

## Overview

**Creative North Star: "The Night Bazaar"**

The market is a bazaar after dark under one shared clock. The ground is an indigo-black night that leans violet, the type is lamp-warm ink, and colour arrives in two kinds only: the green and red of prices moving, and the striped awnings that tell you which row of stalls you are standing in. Saffron is the lamp: the one colour that means "act here" or "the whole market is being called".

The interface is dense and flat, a trading terminal rather than a dashboard. Panels butt against each other separated by 1px hairlines, with no gaps and no cards on cards; chrome is mostly deleted so that type does the work. Every number is set in Archivo with tabular, lining figures so columns hold still while prices tick. A tall condensed face, Big Shoulders Display, shouts the things a crier would shout: tickers, the price tag, the clock, ranks, headlines, and the ceremony screens.

Two cut shapes carry the world: the awning (diagonal stripes in a sector colour over the night) and the price tag (a label with a punched, pointed left end). Motion is quick and expo-eased in the terminal, and theatrical only on ceremony and the crier. Everything moving respects reduced motion.

**Key Characteristics:**
- Violet-leaning night ground stepped in four tones, warm ink in three.
- Saffron as the single action and market-wide colour; fifteen awning colours reserved for sectors.
- Direction always carried by sign and arrow as well as green or red.
- Archivo with tabular figures for every number; Big Shoulders Display for what is called out.
- Hairline-ruled, gapless panels; shadows only on things that float over the floor.
- The news strip: one reserved line under the top bar where the crier calls breaking news. It is part of the layout, never laid over it.

## Colors

A dark, warm-on-violet palette: three inks on four nights, one lamp colour, two market colours, and fifteen awnings.

### Primary
- **Lamp Saffron** (saffron): the Buy button, the primary call to action on every screen, focus rings, text selection, the caret, the countdown progress bar, the rank 1 numeral, award chips, the wordmark's second word, and any crier call that covers the whole market. Its rarity on the trading floor is what makes it read as "press here".
- **Lamp Ember** (saffron-deep): the low-light ground behind saffron text: the player's own roster row, the "you hold N" badge in a stall row, the spectating banner, the reconnecting pill.

### Secondary
- **Rising Green** (up) and **Rising Green Ground** (up-deep): price up, profit, positive effect chips, the chart's upper fill. The deep tone is only ever a chip or band ground under green text.
- **Falling Red** (down) and **Falling Red Ground** (down-deep): price down, loss, negative effect chips, the last-calls band, the closing countdown, severity 3, and the Sell button fill.

### Tertiary: the awnings
Fifteen sector colours, one per row of stalls: **Indigo** (technology), **Violet** (semiconductors), **Teal** (healthcare), **Lime** (finance), **Copper** (energy), **Rose** (automotive), **Sky** (consumer), **Sand** (industrials), **Orchid** (e-commerce), **Cobalt** (telecom), **Steel** (aerospace and defence), **Olive** (materials), **Blush** (food and beverage), **Aqua** (media), **Umber** (logistics). Fifteen hues on one night ground cannot all be far apart, so an awning never appears without its sector's name or a ticker beside it; the colour is a second cue, not the only one. They appear as awning stripe bands on sector headers, as the sector name colour, as small swatches beside tickers, and as the stripe of a crier banner for a sector or company event. They are mapped in one place (`SECTOR_COLOR` in `lib/format.ts`) and passed down as the `--stripe` custom property.

### Neutral
- **Night** (night): the page ground, inputs, the ticker tape, insets inside a panel.
- **Night Stall** (night-2): side columns, the top bar, the tab bar, result cards.
- **Night Lamp** (night-3): row hover, the crier banner, toasts.
- **Night Selected** (night-4): the selected stall row, empty severity pips, progress track, scrollbar thumb.
- **Hairline** (rule): every 1px divider and input or outline-button stroke, at 60% opacity between table and feed rows.
- **Warm Ink** (ink): primary text and the price tag ground.
- **Ink Dim** (ink-2): secondary text, descriptions, panel titles.
- **Ink Faint** (ink-3): labels, company names next to tickers, metadata, placeholders.

### Named Rules
**The Awnings Mark Sectors Rule.** The fifteen awning colours identify a sector and nothing else. They never fill a button, signal direction, or decorate an unrelated surface.

**The One Lamp Rule.** Saffron means "act here" or "the whole market is called". On the trading floor it appears on the primary action, the player's own position, and focus, and nowhere decorative.

**The Sign And Arrow Rule.** Green and red never travel alone: every change carries a real sign (+ or the minus sign U+2212) and, where space allows, an up-right or down-right arrow.

## Typography

**Display Font:** Big Shoulders Display Variable (with Archivo Variable, sans-serif)
**Body Font:** Archivo Variable (with ui-sans-serif, system-ui, sans-serif)

**Character:** A tall, condensed market-sign face for what is shouted, over a sturdy grotesque that keeps every figure on a fixed grid. The contrast between them is the hierarchy; size steps are secondary.

### Hierarchy
- **Display** (900, clamp(3.5rem, 12vw, 9rem), 0.85, uppercase): ceremony only. "The market is open", "The market is closed", the lobby clock (up to clamp(6rem, 22vw, 13rem) in saffron), the join wordmark (clamp(4rem, 16vw, 8.5rem)).
- **Headline** (800, 26px, 34px at severity 3, 0.95, uppercase): the crier banner headline. Phones set it at 20px, 24px at severity 3.
- **Ticker** (900, 44px, 0.9): the selected company's ticker. Rank numerals use the same face at 20 to 24px, 800.
- **Price tag** (800, 34px, 1, night on ink): the live price inside the tag shape.
- **Title** (700, 15px, uppercase, 0.06em, ink-2): panel headings (Holdings, Roster, The crier) and, in the sector colour, sector headers. The countdown clock is the same face at 24px.
- **Body** (400 to 600, 14px rows and headlines, 13px small, snug): rows, descriptions, feed items, the order summary line. Ticker symbols in rows are 14px bold Archivo, not the display face.
- **Label** (500 to 600, 12px, 11px on chips and tabs, uppercase, 0.08em): stat labels in the top bar, the Shares field label, table headers, the Simulated chip, tab bar labels.

### Named Rules
**The Tabular Ground Rule.** The body sets `font-feature-settings: 'tnum' 1, 'lnum' 1` globally. Every number on screen sits on a fixed-width grid; never switch it off for a column of figures.

**The Crier's Voice Rule.** Big Shoulders Display is for what is called out (tickers, the tag, the clock, ranks, headings, headlines, ceremony). Running text and table figures stay in Archivo.

## Layout

A full-height terminal (`100dvh`, no page scroll) stacked as top bar (56px), news strip (36px, always reserved), an optional status band (32px last-calls, or the spectating line), then the floor. Panels scroll internally. Nothing sticky or floating may sit over the order ticket, a chart's labels, news or holdings: the strip and the order dock are rows of the layout, and toasts are desktop-only and pointer-transparent.

- **Desktop, 1280px and up:** three columns: browse 320px (Stocks or Sectors), centre flexible, roster and news 340px. The centre puts company research (header, then Chart, Financials and News tabs) beside a 300px order ticket from 1024px, with the portfolio underneath. A sector opens in the centre with a way back to the company.
- **Tablet, 768 to 1279px:** two columns, browse 300px and centre; roster and news render once beneath the portfolio in a two-column split.
- **Phone, below 768px:** one column with a five-tab bar pinned at the bottom (Market, Stock, Purse, News, Roster, 56px tall, safe-area padded; News carries an unread count). The top bar keeps the Simulated chip, countdown, value and rank. Stock is research that scrolls above an order dock that is part of the column, not laid over it; on screens shorter than 720px the dock starts as one row (price, position, Trade) and opens to the full ticket. The viewport resizes with the software keyboard (`interactive-widget=resizes-content`), so the dock rises with it instead of hiding under it. Rows are at least 44px tall; inputs are 16px on phones so browsers do not zoom.

Rhythm is tight and consistent: 16px panel gutters, 8px vertical row padding, 12px stacks inside forms, 4px hairs between related controls. Ceremony screens loosen to 32 to 40px stacks and a max width of 36rem (join) or 64rem (results).

### Named Rules
**The Hairline Floor Rule.** Panels meet edge to edge, divided by one 1px `rule` line. No gutters between panels, no cards inside panels.

## Elevation & Depth

The floor is flat. Depth comes from tonal steps of the night (night, then night-2 for columns, night-3 for hover, night-4 for selection) and from hairlines. Shadows exist only on layers that float above the floor and are soft and black.

### Shadow Vocabulary
- **Crier lift** (`box-shadow: 0 18px 40px rgba(0,0,0,0.55)`): the crier banner sweeping over the floor.
- **Toast lift** (`box-shadow: 0 10px 30px rgba(0,0,0,0.5)`): trade confirmation toasts.
- **Pill lift** (`box-shadow: 0 8px 24px rgba(0,0,0,0.5)`): the reconnecting pill.

### Named Rules
**The Flat Floor Rule.** Nothing docked in the terminal grid casts a shadow. Only overlays (crier, toasts, connection pill, the bell) lift.

## Shapes

Small, quiet radii on controls (4px chips, 6px buttons and inputs, 8px result cards, 2px awning swatches and severity pips) set against two hard-cut signature forms.

- **The awning:** a repeating -45deg stripe, 10px of the sector colour then 10px of that colour mixed 30% into night (in oklab). Used as 6px bands on sector headers, 8 to 12px bands atop the crier, 12 by 20px swatches next to a sector name or feed item, and on ceremony screens as a flag of all eight awnings side by side.
- **The price tag:** a five-vertex clip-path with a 9px pointed left end and a 4px night-coloured punch hole, ink ground, night text.

### Named Rules
**The Two Cuts Rule.** Diagonal stripes belong to awnings and the pointed clip belongs to the price tag. No other surface borrows either.

## Components

### Buttons
Solid, bold, and few.
- **Shape:** gently rounded (6px).
- **Primary:** saffron fill, night text, bold 15px at 48px tall on the order ticket, 56px tall on join. Hover brightens to 110%; disabled drops to 35 to 40% opacity.
- **Sell:** the same button filled with the down red. The Buy/Sell segmented toggle above it slides a saffron or red pill (spring 500/38) inside a night track with a 4px inset.
- **Outline:** transparent with a hairline stroke and ink-2 text (Share my result); hover lifts the stroke to ink-3 or saffron at 60%.
- **Focus:** global 2px saffron outline, 2px offset, 4px radius.

### Chips
- **Effect chips:** up-deep ground with green text, or down-deep with red, 4px radius, 12px semibold, "TICKER +1.23%". Clickable; hover brightens to 125%.
- **Simulated chip:** hairline outline, ink-2 uppercase label. Present in every top bar, lobby and join screen.
- **Holding badge:** saffron on saffron-deep, 11px, beside a ticker the player owns.

### Inputs / Fields
- **Style:** night ground, hairline stroke, 6px radius; search at 36px with a 15px leading icon, quantity at 40px centred 18px semibold, nickname at 56px 20px semibold.
- **Focus:** stroke turns saffron at 60 to 70%, no glow; caret is saffron.
- **Error:** helper text below turns red with `role="alert"`.

### Order ticket
The Buy/Sell toggle; price, available cash and how many shares that buys (or how many are held); a Shares label with +10, +100 and a saffron Max (whole shares the cash covers) over a 44px stepper; one line with the estimated cost (or proceeds) and cash after; the Buy or Sell button, which reads Sending order and stays disabled until the server answers. Beneath it one status line: the confirmed fill with its execution price, the server's refusal (the quantity is kept so the player can adjust), the problem that stops the order, or the position and its P/L. The phone dock is the same ticket with the price folded into the toggle row.

### Navigation
- **Top bar:** night-2, wordmark (Big Shoulders 900, "Haggle" with the doubled "gg" in saffron), Simulated chip, centred countdown with a 3px progress bar, right-aligned stats (label over 15px semibold value).
- **Top bar stats:** the market index (equal-weighted change since the bell, with the volatility regime: calm, nervous or stressed), value, cash and rank. Under the Simulated chip, the time of the last price, or Prices delayed in saffron when ticks stop arriving.
- **Phone tab bar:** five equal 56px cells, icon over uppercase 11px label, saffron when current, ink-3 otherwise.

### Stall list (signature)
Search, a show filter (All, Favourites, My holdings, Recent), a sector select and a sort (sector, change, price, P/E, earnings growth, price against fair value, either direction). Sorted by sector, sections open with a sticky awning band and a sector-coloured display title with its average change; any other sort is one flat list with a sector swatch on each row. Rows: a favourite star, then ticker (with the holding badge) over the faint name, price over its simulated-price P/E, and a fixed-width change since the bell. Hover night-3, selected night-4. A price change flashes the figure green or red for 0.9s. The Sectors view lists every sector with its average change, median P/E and story count; a sector page shows what the sector is exposed to in plain words, its companies' relative performance as a centred bar, and its news.

### Price tag (signature)
The selected company's price in the tag shape, nudging 5px up or down on change with the expo ease.

### News strip (signature)
The crier's place in the layout, replacing both the floating banner (which sat over the order ticket) and the ticker tape. A 36px night row under the top bar, its left edge an awning in the story's colour (sector or company awning, saffron for the economy). Breaking news wipes in left to right over 0.55s (clip-path, expo ease), labelled Breaking in saffron with the headline in display caps, a dismiss button and a 2px stripe timer running down over 9s; it then settles to Latest with the headline in body type. Long headlines truncate on one line and the strip opens the news view, where the whole story is. Reduced motion drops the wipe.

Stories never carry a price impact: the strip and feed report what happened (category, source, time, severity, headline, briefing, figures, companies named) and leave the trade to the player. A source that is not confirmed (rumour, analysts, preliminary) carries a dashed outline, and a rumour takes the strip in ink rather than saffron. A market-wide call widens the strip's awning and reads Market call. An earnings story shows the earnings tally: a bar springing to what was earned against a fixed mark for what was expected, with the guidance beneath. Feed items expand in place for the briefing and figures; the feed filters by Economy, Sectors, Companies and My holdings.

### Research
The company header is ticker, name, sector awning, industry, exchange and risk over the price tag, with the player's position in the description line. Under it, three tabs: Chart (ranges the stored history can fill, pan and pinch, crosshair tooltip with time, price, change in range and any story at that moment, saffron dots for stories, ink-3 squares for opening bells, breaks across closed-market gaps, a Back to live pill when the player has panned into the past), Financials (valuation figures, the model fair value with its reasoning spelled out and a not-advice line, quarterly and annual tables with right-aligned tabular figures) and News. Every model-derived number says it is simulated.

### Roster
Ranked rows with a display numeral (saffron for first, ink for second and third, ink-3 after), nickname, biggest holding, value and change. The player's row sits on saffron-deep; if they are outside the top list, a pinned saffron-deep row with a 30% saffron outline follows.

### Host console
A two-panel screen for the organiser's laptop or the room's big screen, behind a host-code gate. Left on night: the phase label and a saffron display clock at up to 12rem (red in last calls), the room count, one primary action at 64px (saffron to open the bell or start the next round, red to close the market, with a confirm), then roster and latest headlines; on results, the awards in saffron display caps and the final roster. Right on night-2: "Scan to join" in display caps, a QR code in night on an ink tile (8px radius, crier lift), the join address in display type and one line of rules. Stacks to one column on phones.

### Ceremony
Join, lobby, bell and results open with the all-awnings flag (bands grow in from the top, staggered 50ms). The results podium reuses the awning stripe in saffron, ink-2 and ink-3 for first, second and third; the result card is night-2 with an 8px radius and a 12px flag across its top.

## Do's and Don'ts

### Do:
- **Do** separate panels with one 1px `rule` hairline and step depth through night, night-2, night-3, night-4.
- **Do** pass a sector's awning colour as `--stripe` from `SECTOR_COLOR` and let the awning, swatch and title read it.
- **Do** pair every green or red figure with a sign, and an arrow where it fits.
- **Do** keep every number in Archivo with tabular figures, and right-align figure columns.
- **Do** label simulated data on every screen with the Simulated chip or an explicit line.
- **Do** ease terminal motion with `cubic-bezier(0.16, 1, 0.3, 1)` and turn flashes, pulses and the tape off under reduced motion.

### Don't:
- **Don't** fill a button, badge or status with an awning colour; awnings mark sectors only.
- **Don't** use saffron as decoration on the trading floor; it marks the action, the player, focus, or a market-wide call.
- **Don't** wrap panels in cards or nest cards inside panels; the floor is hairline-ruled and gapless.
- **Don't** cast a shadow from anything docked in the grid; only overlays lift.
- **Don't** use stripes or the pointed tag clip on surfaces other than awnings and the price tag.
- **Don't** set running text or table figures in Big Shoulders Display.
