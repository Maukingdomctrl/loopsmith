You are redesigning the UI of my drawing/animation app, Loop Emoji Studio (Next.js, running on localhost:3000). I have a finished visual mockup; this prompt is the full spec of it. Reproduce the mockup's layout, hierarchy and look in the real app while keeping every existing feature working. The folder docs/redesign/ holds the mockup screenshot (mockup.png) and its source markup (mockup-reference.html): read them first.

DESIGN DIRECTION
Do not make the app flashier. Make it calmer. It must feel like a professional creative instrument used for 2 to 6 hours without eye fatigue. Purple means interaction and selection only, never decoration. The canvas is the visual center. Use spacing instead of borders. No glow except on the primary action.

WORKING RULES
- First, read the codebase (layout, toolbar, panels, timeline, styles, state) and reply with a SHORT PLAN: which files you will change per phase, and anything in this spec that conflicts with how the app works. Wait for my "go".
- Then build in the 5 phases below. Stop after each phase, tell me what changed in 3 lines or fewer, and wait.
- Reuse existing components and state. Do not rewrite drawing logic, export, or storage. Change structure and styling only, except where a phase says to add a control.
- Centralize design values as CSS variables or theme tokens. No hard-coded hex values scattered in components.
- Keep keyboard shortcuts, tooltips and aria-labels working. Every icon-only button needs an aria-label. Keep a visible focus ring (2px #A18AFF, offset 2px).
- Where the app has a feature the mockup shows but the app lacks (shapes, mask, blend), build the UI as disabled or hidden and list it for me. Do not invent drawing logic unless I ask.

DESIGN TOKENS
Surfaces (3 levels, never add new ones):
- Workspace (level 0): #0D0D17
- Panels (level 1): #121221
- Controls (level 2): #19192B (hover/raised: #1F1F33)
- Selected (level 3): rgba(139,108,255,0.10) background plus 1px border rgba(139,108,255,0.55)
- Borders and dividers: #27273A (panels), #323248 (menus, tool-rail dividers)
Text:
- Primary #E0E0EA (never pure white), secondary #8E8EA6, section titles #7C7C94, disabled #666680
- Icons: #B8B8CC idle, #C4B8FF selected, #A18AFF accent icons
Accent:
- Selection/primary button #6F52E8, accent #8B6CFF, hover #A18AFF
- Success dot (Saved) #4FA683, destructive text #D98A92, destructive button border #5B2A31 on rgba(255,90,100,0.10) with text #FF9AA2
Fonts (load from Google Fonts):
- Sora 500/600/700: app name and section titles
- Plus Jakarta Sans 400 to 800: all body and controls
- DM Mono 400/500: every numeric value (fps, percent, frame numbers, zoom)
Type scale: app name 14px/600; section title 11px/600, 0.3px letter-spacing, sentence case (not all caps); main control 14px/500; secondary info 12 to 13px/400; metadata 11px.
Radius: controls 8px, tool buttons 9px, panels 14px, cards 10px, canvas card 20px.
Shadows (soft, no color glow): panels 0 6px 20px rgba(0,0,0,0.18); floating tool rail 0 8px 24px rgba(0,0,0,0.35); flyouts 0 10px 28px rgba(0,0,0,0.4); canvas card 0 20px 50px rgba(0,0,0,0.45) plus a 1px ring rgba(255,255,255,0.06). Primary Export button only: 0 2px 8px rgba(111,82,232,0.22).
Hover: add an overlay of rgba(255,255,255,0.07). Active: scale(0.95). Transitions 120 to 250ms ease.

PHASE 1: TOKENS AND CALM (biggest visual win)
- Introduce the tokens above and the three fonts.
- Replace purple borders, outlines, sliders-with-glow and switches-with-glow everywhere with the neutral surfaces. Selected state = tint plus thin border, no box-shadow glow.
- Soften all text from white to #E0E0EA, secondary to #8E8EA6.
- Workspace behind the canvas: dotted background only, dots #15152A, 1px, spacing 44px.
- Increase spacing: 16 to 20px panel padding, 12 to 16px between rows. Remove borders around individual rows and controls; use spacing.

PHASE 2: LAYOUT
Root layout is a column: top bar (60px), body row, timeline (168px).
Body row, left to right: Projects (248px) | Canvas (flexible) | Layers (280px, collapses to 48px) | Properties (300px, collapses to 48px).
Top bar (#121221, 1px bottom border #27273A): left = logo mark (28px rounded square, tint rgba(139,108,255,0.14), loop icon) + "Loop Emoji Studio" + quiet "Saved" (8px green dot, 12px secondary text) + divider + Undo, Redo (40px ghost icon buttons) + Import (ghost, secondary text). Center = Play (40px round, #19192B) + Auto stabilize (#19192B, accent sparkle icon). Right = Export, the only filled purple (#6F52E8, 700 weight). Visual priority: Export > Auto stabilize > Import. Saved is almost invisible.
Projects panel: header "Projects" + count, a "New animation" button (#19192B, 1px #27273A), then project cards: 48px thumbnail + name 14px/600 + "22 frames · 6 fps" 12px secondary. Normal cards are flat with no border. ONLY the selected card gets a 2px purple left edge (#8B6CFF), background rgba(139,108,255,0.10), name at 700.
Layers panel: its own full-height panel. Header (52px): "Layers" + "8 of 64", New layer, New group, divider, collapse chevrons. Body: nested tree with chevron expand/collapse, folder icon (#A18AFF) for groups, 40px rows, indent 11px with a 1px #26263A guide line per level, per-row eye and lock buttons (28px; hidden layers dimmed with a struck-eye icon; locked shows a closed lock). Group badges show child count. The BASE LAYER is pinned below the scroll area with its own "Base layer" label, selected tint, and an opacity badge (e.g. 11%, amber #F5C16C on #3A2F18). Below it, a "Base settings" block: Opacity slider with a Reset link and DM Mono value, Blend dropdown, Lock pixels and Add mask buttons, and a row of Move up, Move down, Duplicate, Delete (destructive style).
Properties panel: header + collapse. Contains ONLY: Playback section (Speed slider with DM Mono value and ticks 6/12/18/24; Frame hold slider with ticks 1/8/16/24), then collapsed accordion rows "Eraser and transparency", "Transform", "Squash and stretch" (38px rows, right chevron, no borders). Sliders: 3px track #26263A, filled part #8B6CFF, 14px thumb #E0E0EA. The value matters more than the slider: show it large, right-aligned, in DM Mono.
Collapse behavior for both right panels: collapse to a 48px rail showing an expand button, the panel icon, a vertical label, and a count badge. When one or both are collapsed, the canvas card grows (520px both open, 580px one open, 640px both collapsed). Toggle with display, not by unmounting, so state survives. Persist open/closed state in localStorage.
Timeline (168px): header "Timeline", "4 frames", Loop toggle (selected style). Frames are 80px squares, radius 10, number beneath in 11px #7C7C94. The selected frame gets a 1px rgba(139,108,255,0.8) border and its number in #A18AFF at 600, with no glow. "Add frame" is a 56x80 #19192B button with a plus.

PHASE 3: THE TOOL RAIL (floating panel on the canvas)
Position: absolute, left 20px, top 52px, 48px wide, padding 6px, radius 14, #121221 with 1px #27273A. Buttons are 36x36, radius 9, gap 2px; groups separated by a 16px-wide 1px #323248 divider with 3px vertical margin. Selected tool = tint plus 1px border rgba(139,108,255,0.55), icon #C4B8FF, no glow. A small corner triangle on a button means it opens a flyout.
Groups, top to bottom:
1. Draw: Pencil, Brush, Eraser, Shapes (flyout)
2. Color: Fill, Eyedropper, Current color (26px circle), Background color (24px swatch of the current background, flyout)
3. Guides: Onion skin (toggle, accent icon of two overlapping circles when on), Emoji guides (toggle plus flyout: Face, Full body, divider, Hide emoji guides)
4. Frame actions, used constantly: Duplicate frame, Clear frame, Delete frame (icon in #D98A92)
5. View: Zoom in, zoom readout ("100%" in DM Mono 13px), Zoom out, Fit to screen
The zoom controls, background swatches, onion skin and emoji guides MOVE here from where they live today (zoom from below the canvas, background and guides from the Properties panel). Wire them to the existing state; do not duplicate state. Remove them from their old places.
Flyouts open to the right of the rail (left 76px) aligned to their button, one open at a time, 48px wide, #19192B, 1px #323248, radius 14, items stacked in one VERTICAL line. Click outside or press Escape to close. Shapes flyout: Line, Rectangle, Ellipse, Triangle, Arrow, Star, divider, Fill-shape toggle. Background flyout: 32px swatches in one vertical line: Transparent (checker), White, Pink #F4D6E4, Blue #C5DAF5, Mint #CDEBDD, Butter #F8EBB5, Navy #202436, Black #0A0A0C, and a dashed Custom (+). The selected swatch gets a 2px #8B6CFF border. Tooltips: light chip (#E0E0EA background, #121221 text) showing the tool name and shortcut.
The rail is about 680px tall. If the viewport is shorter, make the rail scroll internally rather than overflowing.

PHASE 4: CANVAS AND GUIDES
- The canvas card is white, radius 20, centered in the space to the right of the rail.
- Emoji guide overlay: thin 1px dashed lines (dasharray 3 9) at low opacity: large circle, face circle, horizontal and vertical lines in muted lavender #8E86B8 and sage #7FA597. Put them in one group whose opacity is state-driven: idle 0.28, pointer over canvas 0.7, pointer down (drawing/dragging) 1, with a 0.25s opacity transition. Quiet when idle, visible when needed.
- The center crosshair stays outside that group at stroke-opacity 0.65, color #6F52E8.
- Frame info pill above the canvas: "Frame 4 of 4 · 0.33 s · 12 fps" (#19192B, 1px #27273A, 13px, current frame in primary text).

PHASE 5: POLISH
- Check contrast: text on surfaces at least 4.5:1 for body text.
- Check every panel at 1280px and 1600px widths. Below 1280px, auto-collapse the right panels.
- Add subtle transitions only on hover, selection and panel collapse. Respect prefers-reduced-motion.
- Do NOT build Focus Mode yet, but structure the layout so hiding Projects, Layers and Properties (keeping the timeline) would be a one-flag change later.

DEFINITION OF DONE
- All existing features still work (draw, erase, fill, layers, frames, playback, onion skin, export, import).
- The UI matches this spec; purple appears only on selection, interaction and the Export button.
- No hard-coded colors outside the token file. No console errors. Lint and typecheck pass.
- Final message: list what you changed per file, what you left disabled because the app lacks the feature, and anything in the spec you deviated from and why.
