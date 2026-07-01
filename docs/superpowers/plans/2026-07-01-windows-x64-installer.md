# PetMo Windows x64 Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a downloadable Windows 10/11 x64 NSIS installer through GitHub Actions.

**Architecture:** Treat packaging configuration as a tested repository contract. A Node test reads `package.json` and the workflow file, while GitHub Actions performs the real Windows build and uploads the generated installer.

**Tech Stack:** Electron 43, electron-builder 26, NSIS, Node test runner, GitHub Actions

## Global Constraints

- Output filename is exactly `PetMo-Setup-0.1.0.exe`.
- Target only Windows x64.
- Do not add signing credentials or commit `release/`.
- The workflow must run tests before building.

---

### Task 1: Lock the Windows packaging contract

**Files:**
- Create: `test/windows-packaging.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `package.json`
- Produces: `scripts["app:win"]`, `build.win`, and `build.nsis`

- [ ] Write tests asserting the Windows command uses `--win nsis --x64`, the target is `nsis/x64`, the artifact name is `PetMo-Setup-${version}.exe`, and NSIS allows directory selection with desktop/start-menu shortcuts.
- [ ] Run `node --test test/windows-packaging.test.js` and confirm it fails because the Windows configuration is absent.
- [ ] Add the minimal Windows and NSIS configuration to `package.json`.
- [ ] Run the packaging test and full `npm test`; require zero failures.

### Task 2: Add the Windows GitHub Actions build

**Files:**
- Modify: `test/windows-packaging.test.js`
- Create: `.github/workflows/build-windows.yml`

**Interfaces:**
- Consumes: npm scripts from Task 1
- Produces: manually triggered Windows build and downloadable artifact

- [ ] Extend the test to require `workflow_dispatch`, `windows-latest`, `npm ci`, `npm test`, `npm run app:win`, and upload of `release/PetMo-Setup-0.1.0.exe`.
- [ ] Run the focused test and confirm it fails because the workflow is absent.
- [ ] Add the minimal workflow with read-only repository permissions and a 30-minute timeout.
- [ ] Run the focused test and full `npm test`; require zero failures.

### Task 3: Document, publish, and verify

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Windows workflow
- Produces: tester download and SmartScreen instructions

- [ ] Document where to trigger the workflow, where to download the artifact, and how to pass the unsigned SmartScreen prompt.
- [ ] Run `npm audit`, `npm test`, and `git diff --check`.
- [ ] Commit and push `main`.
- [ ] Trigger `build-windows.yml` through GitHub CLI and wait for completion.
- [ ] Download the artifact, verify it contains `PetMo-Setup-0.1.0.exe`, record its SHA-256, and report the Actions run URL.
