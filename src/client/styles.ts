/**
 * Panel styles.
 *
 * Injected once as a `<style>` tag (the same approach the official plugins use)
 * because the bundle has no CSS pipeline. Colours come from the shell's design
 * tokens (`--dsw-*`) so the panel matches the surrounding chrome in every theme
 * instead of shipping its own palette.
 *
 * Visual direction: a **precision instrument panel**. A service row is a readout
 * strip — a lamp that actually glows, a nameplate-style language tag, monospaced
 * tabular numbers — and configuration is an inset form card rather than a row of
 * bare inputs. Secondary actions stay quiet (dimmed) instead of appearing only on
 * hover: "invisible until hover" is what made configuration undiscoverable.
 */
const TAG_ID = 'dsh-service-runner/styles'

const CSS = `
.dsr-root { position: relative; display: inline-flex; }
.dsr-trigger {
  min-height: 28px; display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 7px; border: 0; border-radius: 7px; cursor: pointer;
  background: none; color: var(--dsw-alias-label-tertiary);
  font-family: inherit; font-size: 12px; line-height: 18px;
  transition: color .15s ease, background .15s ease;
}
.dsr-trigger:hover, .dsr-trigger:focus-visible {
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-fill-l1, transparent);
}
.dsr-trigger[data-open="true"] { color: var(--dsw-alias-label-primary); }
.dsr-count { font-variant-numeric: tabular-nums; letter-spacing: -.2px; }

.dsr-menu {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 100;
  box-sizing: border-box; width: 540px; max-width: min(640px, 100vw - 32px);
  max-height: min(640px, 100vh - 140px); overflow: visible;
  margin: 0; padding: 8px; list-style: none;
  display: flex; flex-direction: column; gap: 3px;
  border-radius: 14px; border: 1px solid var(--dsw-alias-border-l2, #00000014);
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-base, #fff));
  box-shadow: var(--dsw-elevation-prominent, 0 10px 30px rgba(0, 0, 0, .2));
  animation: dsr-in .18s cubic-bezier(.2, .7, .3, 1) both;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
}
@keyframes dsr-in {
  from { opacity: 0; transform: translateY(-4px) scale(.995) }
  to { opacity: 1; transform: none }
}

/* Scrolling belongs to the body, not to the menu: the workspace switcher's
   popover is absolutely positioned inside the header, and an overflow: auto
   ancestor clipped it the moment the list reached past the panel's bottom edge.
   With the menu overflow: visible the popover escapes the panel and only the
   rows below the header scroll. */
.dsr-body {
  display: flex; flex-direction: column; gap: 3px;
  flex: 1 1 auto; min-height: 0; overflow: auto;
}

.dsr-head {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px 8px;
  font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary);
}
/* The workspace name is the panel's identity, so it outranks the controls beside
   it: at the inherited 11px tertiary tint it read like placeholder text. */
.dsr-ws {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--dsw-font-mono, monospace); letter-spacing: -.2px;
  font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary);
}

/* Workspace switcher: a compact pill plus its own list, so the header no longer
   shows the same full path twice and the OS-styled select stops breaking the
   panel's language. */
.dsr-pick { position: relative; flex: none; }
.dsr-pick-btn {
  display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px;
  border: 1px solid var(--dsw-alias-border-l1, transparent); border-radius: 8px;
  cursor: pointer; background: transparent; color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 11px; line-height: 18px;
  transition: background .15s ease, color .15s ease, border-color .15s ease;
}
.dsr-pick-btn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-fill-l2); }
.dsr-pick-btn[data-open="true"] {
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-fill-l2);
  border-color: var(--dsw-alias-border-l2, #0002);
}
.dsr-pick-caret { font-size: 9px; opacity: .6; }
.dsr-pick-menu {
  position: absolute; top: calc(100% + 5px); right: 0; z-index: 130;
  min-width: 300px; max-width: min(460px, 88vw);
  max-height: min(360px, 60vh); overflow: auto;
  margin: 0; padding: 5px; list-style: none; border-radius: 11px;
  border: 1px solid var(--dsw-alias-border-l2, #00000014);
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-base, #fff));
  box-shadow: var(--dsw-elevation-prominent, 0 10px 28px rgba(0, 0, 0, .2));
  animation: dsr-in .16s cubic-bezier(.2, .7, .3, 1) both;
}
.dsr-pick-item {
  display: flex; align-items: center; gap: 7px; width: 100%; box-sizing: border-box;
  padding: 6px 8px; border: 0; border-radius: 8px; cursor: pointer; background: transparent;
  color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 12px; text-align: left;
}
.dsr-pick-item:hover { background: var(--dsw-alias-fill-l2); }
.dsr-pick-item[data-current="true"] { background: var(--dsw-alias-fill-l2); }
.dsr-pick-check { flex: none; width: 10px; font-size: 10px; color: #6366f1; }
.dsr-pick-name { flex: none; font-weight: 500; }
.dsr-pick-path {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 10px; color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-mono, monospace);
}

.dsr-row {
  position: relative; display: flex; align-items: center; gap: 9px;
  box-sizing: border-box; width: 100%; padding: 8px 9px;
  border-radius: 10px; font-size: 13px; color: var(--dsw-alias-label-primary);
  transition: background .15s ease, box-shadow .2s ease;
}
.dsr-row::before {
  content: ''; position: absolute; left: 0; top: 9px; bottom: 9px; width: 2px;
  border-radius: 2px; background: currentColor; opacity: 0; transition: opacity .2s ease;
}
.dsr-row:hover { background: var(--dsw-alias-fill-l2); }
.dsr-row:hover::before { opacity: .22; }
.dsr-row[data-editing="true"] {
  background: var(--dsw-alias-fill-l2);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2, #0002);
}
.dsr-row[data-editing="true"]::before { opacity: .5; }

.dsr-dot {
  flex: none; width: 8px; height: 8px; border-radius: 50%;
  background: var(--dsw-alias-label-tertiary);
  transition: background .25s ease, box-shadow .35s ease;
}
.dsr-dot[data-s="running"] {
  background: #34d399; box-shadow: 0 0 0 3px #34d3991f, 0 0 9px #34d39980;
}
.dsr-dot[data-s="starting"] {
  background: #fbbf24; box-shadow: 0 0 0 3px #fbbf241f; animation: dsr-breathe 1.2s ease-in-out infinite;
}
.dsr-dot[data-s="stopping"] { background: #fbbf24; box-shadow: 0 0 0 3px #fbbf241f; }
.dsr-dot[data-s="failed"] {
  background: #f87171; box-shadow: 0 0 0 3px #f8717126, 0 0 9px #f8717166;
  animation: dsr-blip .5s ease-out 1;
}
@keyframes dsr-breathe { 0%, 100% { opacity: 1 } 50% { opacity: .3 } }
@keyframes dsr-blip { from { transform: scale(1.45) } to { transform: scale(1) } }

.dsr-name {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-weight: 500; letter-spacing: -.1px;
}
.dsr-tag {
  flex: none; padding: 1px 6px; border-radius: 4px; font-size: 10px; line-height: 15px;
  text-transform: uppercase; letter-spacing: .6px; font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-fill-l3, var(--dsw-alias-fill-l2));
  border: 1px solid var(--dsw-alias-border-l1, transparent);
}
.dsr-badge {
  flex: none; padding: 0 5px; border-radius: 5px; font-size: 10px; line-height: 16px;
  background: var(--dsw-alias-fill-l2); color: var(--dsw-alias-label-secondary);
  text-transform: uppercase; letter-spacing: .3px;
}
.dsr-num {
  flex: none; font-size: 11px; line-height: 16px;
  font-family: var(--dsw-font-mono, monospace); font-variant-numeric: tabular-nums;
  letter-spacing: -.3px; color: var(--dsw-alias-label-secondary);
}
/* The port is the number people actually look for, so it reads strongest. */
.dsr-strong { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsr-meta { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dsr-dim { color: var(--dsw-alias-label-tertiary); }

.dsr-actions { flex: none; display: flex; align-items: center; gap: 2px; }
.dsr-icon {
  width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  padding: 0; border: 0; border-radius: 7px; cursor: pointer; background: transparent;
  color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 12px; line-height: 1;
  transition: background .15s ease, color .15s ease, opacity .15s ease;
}
.dsr-icon:hover:not(:disabled) {
  background: var(--dsw-alias-fill-l3, var(--dsw-alias-fill-l2));
  color: var(--dsw-alias-label-primary);
}
.dsr-icon:disabled { opacity: .26; cursor: default; background: transparent; }
.dsr-icon[data-quiet="true"] { opacity: .42; }
.dsr-row:hover .dsr-icon[data-quiet="true"] { opacity: .72; }
.dsr-icon[data-quiet="true"]:hover:not(:disabled) { opacity: 1; }
.dsr-icon[data-kind="go"]:not(:disabled) { color: #10b981; }
.dsr-icon[data-kind="stop"]:not(:disabled) { color: #ef4444; }
.dsr-icon[data-kind="edit"]:hover:not(:disabled) { background: #6366f11f; color: #6366f1; }
/* Delete is the one destructive action, so it stays the quietest of the three. */
.dsr-icon[data-kind="remove"] { opacity: .3; }
.dsr-icon[data-kind="remove"]:hover:not(:disabled) { background: #ef44441f; color: #ef4444; }

.dsr-btn {
  border: 0; cursor: pointer; border-radius: 7px; padding: 3px 8px; font-size: 11px;
  line-height: 18px; background: var(--dsw-alias-fill-l2); color: var(--dsw-alias-label-secondary);
  font-family: inherit; white-space: nowrap;
  transition: background .15s ease, color .15s ease;
}
.dsr-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-fill-l3, var(--dsw-alias-fill-l2)); }
.dsr-btn:disabled { opacity: .45; cursor: default; }
.dsr-btn[data-kind="primary"] { background: #10b9811f; color: #0f9b6c; }
.dsr-btn[data-kind="primary"]:hover:not(:disabled) { background: #10b9812e; }
.dsr-btn[data-kind="danger"] { background: #ef44441f; color: #c2410c; }

.dsr-form {
  display: flex; flex-direction: column; gap: 9px;
  margin: 2px 4px 10px; padding: 11px 11px 10px; border-radius: 12px;
  background: var(--dsw-alias-fill-l1, var(--dsw-alias-fill-l2));
  border: 1px solid var(--dsw-alias-border-l1, transparent);
}
.dsr-form-head {
  display: flex; align-items: center; gap: 8px; font-size: 9px;
  letter-spacing: .9px; text-transform: uppercase; color: var(--dsw-alias-label-tertiary);
}
.dsr-form-head b { font-weight: 600; color: var(--dsw-alias-label-secondary); letter-spacing: .3px; text-transform: none; font-size: 11px; }
.dsr-field-row { display: flex; gap: 9px; align-items: flex-end; }
.dsr-field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.dsr-field[data-w="narrow"] { flex: 0 0 76px; }
.dsr-label {
  font-size: 10px; letter-spacing: .5px; text-transform: uppercase; font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}
.dsr-input {
  box-sizing: border-box; width: 100%; min-width: 0; font-size: 12px; padding: 6px 8px;
  border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, #0002);
  background: var(--dsw-alias-bg-base, transparent); color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-mono, monospace);
  transition: border-color .15s ease, box-shadow .15s ease;
}
.dsr-input::placeholder { color: var(--dsw-alias-label-tertiary); opacity: .75; }
.dsr-input:focus {
  outline: none; border-color: #6366f180;
  box-shadow: 0 0 0 3px #6366f11f;
}
.dsr-remove {
  flex: none; width: 30px; height: 30px; border: 0; border-radius: 8px; cursor: pointer;
  background: transparent; color: var(--dsw-alias-label-tertiary); font-size: 14px; line-height: 1;
  transition: background .15s ease, color .15s ease;
}
.dsr-remove:hover { background: #ef44441f; color: #ef4444; }

.dsr-empty { padding: 16px 10px; font-size: 12px; color: var(--dsw-alias-label-tertiary); text-align: center; line-height: 1.7; }
.dsr-error { margin: 4px 8px; padding: 8px 10px; border-radius: 8px; font-size: 12px; background: #ef44441f; color: #b91c1c; }

.dsr-port {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 2px 8px 0;
  padding: 6px 9px; border-radius: 9px; font-size: 11px; line-height: 1.5;
  background: var(--dsw-alias-fill-l2); color: var(--dsw-alias-label-secondary);
}
.dsr-port-busy { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #b45309; }
.dsr-port-muted { flex: 1; color: var(--dsw-alias-label-tertiary); }

.dsr-log-bar { display: flex; align-items: center; gap: 6px; margin: 4px 8px 0; }
.dsr-log-time { color: var(--dsw-alias-label-tertiary); margin-right: 6px; user-select: none; }
.dsr-group {
  margin: 8px 8px 2px; padding: 0 0 3px; font-size: 9px; letter-spacing: 1px;
  text-transform: uppercase; color: var(--dsw-alias-label-tertiary);
  border-bottom: 1px solid var(--dsw-alias-border-l1, #0001);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsr-log {
  margin: 2px 8px 8px; padding: 9px; border-radius: 9px; max-height: 260px; overflow: auto;
  background: var(--dsw-alias-fill-l2); font-family: var(--dsw-font-mono, monospace);
  font-size: 11px; line-height: 1.55; white-space: pre-wrap; word-break: break-all;
  color: var(--dsw-alias-label-secondary);
}
.dsr-log-line[data-stream="stderr"] { color: #b91c1c; }
.dsr-log-line[data-stream="system"] { color: var(--dsw-alias-label-tertiary); }

.dsr-foot { display: flex; align-items: center; gap: 6px; padding: 4px 8px 6px; }
.dsr-hint { padding: 0 10px 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary); line-height: 1.6; }
`

/** Install the stylesheet once per document. */
export function installStyles(): void {
  if (typeof document === 'undefined') return
  const existing = document.querySelector(`style[data-plugin-css="${TAG_ID}"]`)
  const tag = existing instanceof HTMLStyleElement ? existing : document.createElement('style')
  if (existing === null) {
    tag.dataset.plugin = 'dsh-service-runner'
    tag.dataset.pluginCss = TAG_ID
    document.head.appendChild(tag)
  }
  // Re-assign every time so a hot reload replaces the sheet instead of leaving a
  // stale copy in place.
  tag.textContent = CSS
}
