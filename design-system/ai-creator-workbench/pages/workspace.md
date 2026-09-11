# Workspace Page Overrides

> **PROJECT:** AI Creator Workbench
> **Generated:** 2026-09-03 13:56:31
> **Page Type:** Desktop creative workspace

> ⚠️ **IMPORTANT:** Rules in this file **override** the Master file (`design-system/MASTER.md`).
> Only deviations from the Master are documented here. For all other rules, refer to the Master.

---

## Page-Specific Rules

### Layout Overrides

- **Max Width:** none; shell fills the available desktop window
- **Layout:** activity rail + resource explorer + flexible editor + assistant panel
- **Reading Width:** editor content stays between 680px and 860px when space allows

### Spacing Overrides

- No overrides — use Master spacing

### Typography Overrides

- Chinese interface: `Inter`, `PingFang SC`, `Microsoft YaHei`, system sans-serif
- Chinese long-form editor: `Songti SC`, `STSong`, `Noto Serif CJK SC`, serif
- Do not fetch Google Fonts at runtime; the desktop app must remain usable offline

### Color Overrides

- Workspace background: warm paper `#F7F3EC`
- Navigation ink: `#191816`
- Creative accent: amber `#D97706`; use dark text on the accent for contrast
- Pink from Master is reserved for optional brand campaigns, not core workspace controls

### Component Overrides

- Cards are flat by default; only floating dialogs and drawers use shadows
- Hover never moves layout; use color, border and background transitions only
- Icon controls have accessible names and a minimum 44×44px target
- AI output always appears in a labeled candidate container before acceptance

---

## Page-Specific Components

- Resource tree with explicit selected and expanded states
- Script editor with save status, word count and version indicator
- AI context tray, candidate result and prompt composer
- Separate provider, CLI and knowledge status indicators
- Command palette and reversible toast feedback

---

## Recommendations

- Treat this product as a writing IDE, not a chatbot shell
- Keep the editor usable when every AI connection is unavailable
- Collapse the assistant before the resource explorer as the window narrows
- Use native CSS transitions only and respect `prefers-reduced-motion`
