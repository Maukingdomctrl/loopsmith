# Loop Emoji Studio UI redesign: reference pack for Claude Code

Files in this folder (read all of them before planning):

- `mockup.png`: screenshot of the approved mockup (1600x1000), shapes flyout open. This is the visual target.
- `mockup-reference.html`: the mockup's source markup. Use it ONLY to read exact sizes, colors, spacing, icon paths and structure. It is a static design file: do not import it, copy its script, or ship it. The `{{...}}` values and the `<script type="text/x-dc">` block belong to the design tool; re-implement the behavior in the app's own framework.
- `PROMPT.md`: the full spec and phased plan (same text as the prompt pasted in the chat).

Rules of thumb
- The screenshot shows the default state: both right panels open, Brush selected, Shapes flyout open, Frame 4 selected, background white.
- Where the screenshot and the spec disagree, the spec wins; tell the user about the difference.
- Features shown in the mockup but missing from the app (shapes, Add mask, Blend) are built as disabled UI and listed, not invented.
- Delete nothing in this folder; it is documentation for the human too.
