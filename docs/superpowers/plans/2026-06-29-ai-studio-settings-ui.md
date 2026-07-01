# AI Studio Settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the existing settings window as a polished purple-gradient AI Studio while preserving all current behavior.

**Architecture:** Keep the renderer logic and DOM IDs stable. Improve semantic grouping in HTML, then replace visual tokens and component styling in CSS with responsive, accessible states.

**Tech Stack:** Electron, HTML, CSS, vanilla JavaScript, Node test runner.

## Global Constraints

- Preserve every existing DOM ID and functional control.
- Do not change API, generation, animation, or IPC behavior.
- Support the existing 680px minimum window width.
- Respect `prefers-reduced-motion`.

---

### Task 1: Page Hierarchy and Hero

**Files:**
- Modify: `src/settings/index.html`
- Modify: `src/settings/styles.css`
- Test: `test/sora-settings.test.js`

- [ ] Add non-breaking decorative and descriptive elements to the topbar.
- [ ] Restyle the page background, topbar, workspace, and cards.
- [ ] Run `node --test test/sora-settings.test.js test/settings-guide.test.js`.

### Task 2: Upload and Configuration Components

**Files:**
- Modify: `src/settings/styles.css`

- [ ] Restyle photo upload states with clear hover, drag, and filled treatments.
- [ ] Restyle provider selector, read-only models, API field, remember control, guide, and notices.
- [ ] Restyle primary and secondary generation actions.
- [ ] Verify keyboard focus visibility and disabled states.

### Task 3: Progress and Action Manager

**Files:**
- Modify: `src/settings/styles.css`

- [ ] Restyle progress panel, rows, tracks, success/failure states, and action manager.
- [ ] Add subtle motion and reduced-motion fallback.
- [ ] Verify narrow-window single-column behavior.

### Task 4: Verification

- [ ] Run `git diff --check`.
- [ ] Run JavaScript syntax checks and `npm test`.
- [ ] Launch the settings window and capture a visual screenshot.
- [ ] Fix any visible clipping, overlap, contrast, or spacing defects and repeat verification.
