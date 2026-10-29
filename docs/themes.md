# Fonts and JSON themes

Open **Settings → Appearance**. Interface, Chat, Code editor and Terminal each
have dropdowns for the installed font family, weight (Regular through Bold) and
size (10–32 px), with a preview. Font families come from the operating system;
there is no CSS to type. Existing saved fallback lists remain selectable.
Press **Save** in Settings (or **Apply appearance** in a standalone appearance view).
Existing buffers and shell processes stay open. **Restore defaults** resets
appearance.

Appearance is global across Projects and persists in this desktop profile's
local application storage, separately from the Provider settings file. Theme
Import/Export transfers JSON; font preferences are configured separately and
font files must already be installed on the destination machine.

## Create or import a theme

1. Start with [oxide-night.json](themes/oxide-night.json), or press **Edit JSON**
   under **Custom theme** in Appearance settings. **Close JSON editor** hides it
   without discarding the draft.
2. Import the file, select its variant in **Theme**, and press **Save**.
   Editing JSON alone keeps the current appearance.
3. Use **Export JSON** to share or edit the pack externally. Reimport external
   changes to apply them.

The family/variant structure follows [Zed's theme format](https://zed.dev/docs/extensions/themes).
Oxide implements the color and syntax subset below. Other Zed attributes remain
in the imported JSON but do not add unsupported Zed functionality.

```json
{
  "name": "My themes",
  "author": "Your name",
  "themes": [{
    "name": "My night theme",
    "appearance": "dark",
    "style": {
      "background": "#12151b",
      "surface.background": "#191e27",
      "text": "#e0e6f0",
      "text.muted": "#aab6c8",
      "text.accent": "#8cbdff",
      "border": "#343e50",
      "terminal.background": "#12151b",
      "editor.background": "#12151b",
      "syntax": {
        "comment": { "color": "#9daabe", "font_style": "italic" },
        "keyword": { "color": "#c7a7ff", "font_weight": 600 },
        "string": { "color": "#a9d6a0" }
      }
    }
  }]
}
```

Each variant needs a unique name, `appearance` (`dark` or `light`) and a `style`
object. Missing values inherit Oxide defaults for that appearance. Colors use
`#RGB`, `#RGBA`, `#RRGGBB` or `#RRGGBBAA`. A `null` color inherits its default.
Syntax and supported color values are validated before applying; invalid input
keeps the previous theme active. Packs must be at most 1 MiB.

## Supported style tokens

| Area | Tokens |
| --- | --- |
| Surfaces | `background`, `surface.background`, `elevated_surface.background`, `element.background` |
| Text | `text`, `text.bright`, `text.muted`, `text.disabled`, `text.accent` |
| Borders and controls | `border`, `border.focused`, `element.border`, `element.hover`, `element.active` |
| Primary actions | `accent`, `accent.hover`, `accent.foreground` |
| Status colors | `error`, `success`, `warning`, `hint` |
| Editor | `editor.background`, `editor.foreground`, `editor.gutter.background`, `editor.line_number`, `editor.active_line_number`, `editor.active_line.background`, `editor.selection.background`, `editor.cursor`, `editor.indent_guide`, `editor.widget.background`, `editor.widget.border` |
| Terminal | `terminal.background`, `terminal.foreground`, `terminal.cursor`, `terminal.selection.background` |
| Terminal ANSI | `terminal.ansi.black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, and `bright_black` … `bright_white` (all with the `terminal.ansi.` prefix) |

`syntax` is keyed by Monaco token names. Common names include `comment`,
`keyword`, `string`, `number`, `type`, `identifier` and `operator`. Rules support
`color`, `font_style` (`normal` or `italic`) and `font_weight` (100–900; 600 and
above render bold). Syntax colors are opaque. Unspecified rules inherit the
light/dark Monaco grammar palette. These rules apply to Code; Markdown snippets
retain their syntax highlighter.

Theme packs contain data only. Importing does not install fonts, extensions,
arbitrary CSS or code.
