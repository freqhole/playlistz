# freqhole-playlistz Development Guide

## Project Overview

freqhole-playlistz is a music playlist management tool built on top of the main freqhole project. It provides a standalone web interface for creating, editing, and sharing playlists.

## Code Style

### Lowercase Prose Preference

Write comments, documentation, and user-facing messages in lowercase conversational style.

**Keep uppercase for:**

- Acronyms: API, HTTP, JSON, SQL, CRUD, REST, CLI
- Proper nouns: Rust, TypeScript, GitHub, SQLite, PostgreSQL
- Code identifiers: function names, type names, constants
- Special markers: TODO, FIXME, NOTE, WARNING

**Use lowercase for:**

- Regular comments explaining logic
- Documentation/docstrings
- Error messages and user-facing strings
- Log messages

**Examples:**

```rust
// ✅ GOOD
// extract album metadata from file tags
let metadata = parse_tags(&file)?;

return Err(GrimoireError::NotFound("playlist not found".to_string()));

// TODO: add support for batch operations
```

```rust
// ❌ AVOID
// Extract Album Metadata From File Tags
let metadata = parse_tags(&file)?;

return Err(GrimoireError::NotFound("Playlist Not Found".to_string()));

// Todo: Add Support For Batch Operations
```

### No Emojis in Code

Avoid emojis in comments, error messages, or any code. Use them only in markdown documentation if appropriate.

## Conventions

- **Naming**: Use `snake_case` for Rust and TypeScript (tho `camelCase` is used)
- **Documentation**: AI-generated docs live in `docs/`, with `docs/INDEX.md` as the entry point

## E2E Testing Conventions

### Selectors - prefer `data-testid`

Use `data-testid` attributes as the primary selector for interactive elements and structural containers. This decouples tests from copy, tooltips, and class names.

**Add `data-testid` to:**

- Icon-only buttons with no visible text (hamburger, edit, share, close, remove)
- Panel/container roots used for scoping child locators
- App-state sentinels (e.g. the visually-hidden `<h1>` that signals the app has loaded)

**Naming scheme:**

| Type              | Pattern               | Examples                                                       |
| ----------------- | --------------------- | -------------------------------------------------------------- |
| panels / drawers  | `[name]-panel`        | `all-playlists-panel`, `share-panel`, `edit-panel`             |
| icon buttons      | `btn-[action]`        | `btn-edit-playlist`, `btn-share-playlist`, `btn-all-playlists` |
| close buttons     | `btn-close-panel`     | single stable testid; only one panel open at a time            |
| row-level buttons | `btn-[action]-song`   | `btn-edit-song`, `btn-remove-song`                             |
| content cells     | `[component]-[field]` | `song-duration`, `song-count`                                  |
| app sentinel      | `app-ready`           | signals initial load is done                                   |

**When `getByText` / `getByRole` is still fine:**

- Asserting that specific _content_ is visible: `expect(page.getByText("song-00")).toBeVisible()`

**Always use `data-testid` for:**

- Buttons (even ones with visible text labels) - copy changes; testids don't
- Form inputs - use testid, not placeholder text

**Avoid:**

- `getByTitle(...)` to click or wait on elements - `title` is a tooltip for UX, not a test hook; it can collide when shared and changes with UI state
- `.first()` on a click target - this means the selector is ambiguous; fix it with a scoped container or a testid instead
- `page.getByRole("heading", { name: "playlistz" })` as the app-ready sentinel - use `getByTestId("app-ready")`

### ARIA attributes for state

Use ARIA attributes to express interactive state on elements. This is good accessibility practice and produces stable, semantic selectors in tests - no asserting on border colors, class names, or theme tokens to detect selected/active state.

**Preferred attributes and when to use them:**

| Attribute       | Element                         | When                                                      |
| --------------- | ------------------------------- | --------------------------------------------------------- |
| `aria-pressed`  | toggle buttons                  | button is in an "on" state (e.g. mode active, panel open) |
| `aria-selected` | tab-like buttons, playlist rows | item is the current selection                             |
| `aria-current`  | nav-style items                 | the currently active page/view/step                       |
| `aria-expanded` | buttons that open panels        | panel is open                                             |
| `aria-checked`  | custom checkboxes / toggles     | item is checked                                           |
| `aria-busy`     | containers loading data         | async operation in progress                               |
| `aria-disabled` | buttons that are disabled       | disabled state (use alongside `disabled` attr)            |

**Examples in source:**

```tsx
// mode toggle button - aria-pressed reflects active state
<button
  data-testid="btn-mode-public"
  aria-pressed={settings().mode === "public"}
  onClick={() => void handleSaveSettings({ mode: "public" })}
>
  anyone (public)
</button>

// hamburger that opens a panel - aria-expanded reflects open state
<button
  data-testid="btn-all-playlists"
  aria-expanded={showAllPlaylists()}
>...</button>
```

**Examples in tests - assert state without touching styles:**

```ts
// good: semantic, stable
await expect(page.getByTestId("btn-mode-public")).toHaveAttribute(
  "aria-pressed",
  "true"
);
await expect(page.getByTestId("btn-all-playlists")).toHaveAttribute(
  "aria-expanded",
  "true"
);

// bad: couples the test to the current theme/design
await expect(page.getByTestId("btn-mode-public")).toHaveClass(
  /border-magenta-500/
);
```

**Avoid:**

- Asserting on CSS classes or inline styles to detect active/selected state
- Using `aria-label` as a test hook when a `data-testid` would be cleaner (aria-label is for screen reader copy, which can change)

### Logging for E2E debugging

Use the `log` utility (`src/utils/log.ts`) - never raw `console.log` in source files.

**Levels** (lowest to highest): `trace` < `debug` < `info` < `warn` < `error`

- `trace` - call-by-call service internals (off by default, even in dev)
- `debug` - normal dev noise (on in dev, off in prod)
- `warn` / `error` - always on

**Tags** use dotted namespaces: `"automerge.repo"`, `"playlist.sync"`, `"idb.docindex"`.

To turn on trace logging for a specific area during e2e debugging, set `localStorage` before reload:

```ts
// in browser devtools or a page.evaluate():
localStorage.setItem("logLevel", "trace");
localStorage.setItem("logFilter", "automerge.repo,playlist.doc");
```

Or via env at test time:

```
VITE_LOG_LEVEL=trace VITE_LOG_FILTER=playlist npm run test:e2e
```

Keep `console.log` / `console.warn` out of committed source - use `log.trace` for traces you want to keep around but silent by default.

### Timeouts

Lean on the global Playwright timeouts configured in `config/playwright.config.ts`:

- `timeout` - per-test timeout (default 30s; slow tests call `test.setTimeout()`)
- `actionTimeout` - single interaction (click, fill, etc.)
- `navigationTimeout` - `goto` / `waitForURL`
- `expect.timeout` - default assertion timeout for `expect(...).toBeVisible()` etc.

**Only add inline `{ timeout: N }` when:**

- The wait is genuinely longer than the global default (e.g. waiting 15s for IDB file processing to complete)
- The wait is genuinely shorter than the global default and you want a faster failure signal (e.g. `{ timeout: 1000 }` on a "must not be visible" assertion)

**Avoid:**

- Duplicating the global default: `{ timeout: 5000 }` when the global expect timeout is already 5000
- Sprinkling `waitForTimeout(300)` as a "let things settle" patch - prefer waiting for a specific element state instead
- Overly generous timeouts that mask real bugs (a test that "passes" in 28s is hiding something)
