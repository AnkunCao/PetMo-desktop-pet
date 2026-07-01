# PetMo macOS Local App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Produce a Finder-launchable Apple Silicon `PetMo.app` for local testing.

**Architecture:** Add electron-builder as a development dependency, keep configuration in `package.json`, use a generated 1024px PNG icon, and build the unsigned `dir` target.

**Tech Stack:** Electron, electron-builder, macOS arm64.

### Task 1: Build assets and configuration

- Add `build/icon.png`.
- Add `electron-builder`, `app:mac`, and `app:mac:clean`.
- Configure product name, app ID, arm64 dir target, files, icon, output, and `identity: null`.

### Task 2: Build and verify

- Run complete tests.
- Build `release/mac-arm64/PetMo.app`.
- Inspect Info.plist, executable architecture, app icon, and bundle contents.
- Launch with `open`, confirm the process remains active, then close the test instance.

### Task 3: Documentation

- Document local build, installation into `/Applications`, first launch, and the future signed distribution path.
