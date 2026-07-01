# Articulated Border Collie Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 2.5D image plane with a procedural articulated low-poly border collie that automatically sits and stands.

**Architecture:** Split pure animation timing and pose interpolation from Three.js model construction. `three-pet.js` remains the scene owner, creates the dog through a focused factory, and applies named-joint poses returned by the motion module.

**Tech Stack:** Electron 31, Three.js 0.184, JavaScript ES modules, Node.js built-in test runner.

## Global Constraints

- Build the dog procedurally with Three.js geometry; do not depend on Blender, a GLB asset, or another API.
- Keep the generated 2D image available when 3D mode is disabled.
- Only idle standing and automatic sit-down/hold/stand-up are active in this milestone.
- Sitting must articulate pelvis and rear-leg joints instead of rotating or translating the whole dog.
- Render correctly at 260x250 and 180x180.

---

### Task 1: Automatic Sit State Machine

**Files:**
- Create: `src/renderer/dog-motion.mjs`
- Create: `test/dog-motion.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `getSitCyclePhase(elapsedSeconds, idleDuration)` returning `{ phase, progress }`.
- Produces: `createDogPose(phase, progress, time)` returning named root, torso, pelvis, head, leg, and tail transforms.
- Produces: `smoothStep(progress)` clamped to the range 0 through 1.

- [ ] **Step 1: Write failing phase and pose tests**

```js
test("sit cycle advances through idle, sitting, seated, and standing", async () => {
  const { getSitCyclePhase } = await import("../src/renderer/dog-motion.mjs");
  assert.deepEqual(getSitCyclePhase(0, 5), { phase: "idle", progress: 0 });
  assert.equal(getSitCyclePhase(5.6, 5).phase, "sitting");
  assert.equal(getSitCyclePhase(7, 5).phase, "seated");
  assert.equal(getSitCyclePhase(9.6, 5).phase, "standing");
});

test("seated pose lowers pelvis and folds both rear legs", async () => {
  const { createDogPose } = await import("../src/renderer/dog-motion.mjs");
  const standing = createDogPose("idle", 0, 0);
  const seated = createDogPose("seated", 1, 0);
  assert.ok(seated.pelvis.positionY < standing.pelvis.positionY);
  assert.ok(Math.abs(seated.rearLeft.upperRotationX) > 0.5);
  assert.ok(Math.abs(seated.rearRight.lowerRotationX) > 0.7);
});
```

- [ ] **Step 2: Run the tests and verify missing-module failure**

Run: `npm test -- test/dog-motion.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `dog-motion.mjs`.

- [ ] **Step 3: Implement deterministic phases and pose interpolation**

```js
const SIT_DURATION = 1.2;
const HOLD_DURATION = 3;
const STAND_DURATION = 1.2;

export function smoothStep(value) {
  const t = Math.min(Math.max(value, 0), 1);
  return t * t * (3 - 2 * t);
}

export function getSitCyclePhase(elapsedSeconds, idleDuration) {
  if (elapsedSeconds < idleDuration) return { phase: "idle", progress: 0 };
  const actionTime = elapsedSeconds - idleDuration;
  if (actionTime < SIT_DURATION) return { phase: "sitting", progress: actionTime / SIT_DURATION };
  if (actionTime < SIT_DURATION + HOLD_DURATION) return { phase: "seated", progress: 1 };
  if (actionTime < SIT_DURATION + HOLD_DURATION + STAND_DURATION) {
    return { phase: "standing", progress: (actionTime - SIT_DURATION - HOLD_DURATION) / STAND_DURATION };
  }
  return { phase: "complete", progress: 1 };
}
```

Define complete standing and seated transform objects in the same module, then interpolate every scalar with `smoothStep`. During `standing`, reverse the blend with `1 - progress`. Add breathing, head movement, and tail wag only after the base pose is calculated.

- [ ] **Step 4: Run the focused and complete test suites**

Run: `npm test -- test/dog-motion.test.js && npm test`

Expected: all tests PASS.

- [ ] **Step 5: Commit the motion module**

```bash
git add package.json test/dog-motion.test.js src/renderer/dog-motion.mjs
git commit -m "feat: add automatic dog sitting motion"
```

### Task 2: Procedural Border Collie Model

**Files:**
- Create: `src/renderer/border-collie-model.js`
- Create: `test/border-collie-model.test.js`

**Interfaces:**
- Consumes: Three.js namespace passed as `THREE` to avoid renderer creation in tests.
- Produces: `createBorderCollieModel(THREE)` returning `{ root, joints, materials, dispose }`.
- `joints` contains `torso`, `pelvis`, `head`, `frontLeft`, `frontRight`, `rearLeft`, `rearRight`, and `tail`.
- Each leg contains `upper`, `lower`, and `paw` groups.

- [ ] **Step 1: Write failing model hierarchy tests**

```js
test("border collie exposes independently articulated leg chains", async () => {
  const THREE = await import("three");
  const { createBorderCollieModel } = await import("../src/renderer/border-collie-model.js");
  const dog = createBorderCollieModel(THREE);
  for (const name of ["frontLeft", "frontRight", "rearLeft", "rearRight"]) {
    assert.ok(dog.joints[name].upper);
    assert.ok(dog.joints[name].lower);
    assert.ok(dog.joints[name].paw);
  }
  assert.notEqual(dog.joints.rearLeft.upper, dog.joints.rearRight.upper);
  dog.dispose();
});

test("model contains separate black and white coat materials", async () => {
  const THREE = await import("three");
  const { createBorderCollieModel } = await import("../src/renderer/border-collie-model.js");
  const dog = createBorderCollieModel(THREE);
  assert.equal(dog.materials.black.color.getHexString(), "17191b");
  assert.equal(dog.materials.white.color.getHexString(), "e8e4da");
  dog.dispose();
});
```

- [ ] **Step 2: Run tests and verify missing-module failure**

Run: `npm test -- test/border-collie-model.test.js`

Expected: FAIL because `border-collie-model.js` does not exist.

- [ ] **Step 3: Build the named joint hierarchy**

Create focused helpers `meshPart`, `createLeg`, `createEar`, and `trackResource`. Use low-segment sphere/capsule/cone geometry and `MeshStandardMaterial` with roughness between `0.72` and `0.92`. Place the body horizontally, head forward, rear legs at the pelvis, and pivots at shoulder, elbow, hip, knee, and ankle positions.

- [ ] **Step 4: Add border collie markings as geometry**

Add white meshes for the muzzle, narrow forehead blaze, neck ruff/chest, four socks, belly patch, and tail tip. Keep the base torso, skull, ears, and upper legs black. Use a dark brown eye material and near-black nose material.

- [ ] **Step 5: Run model tests and inspect resource disposal**

Run: `npm test -- test/border-collie-model.test.js && npm test`

Expected: all tests PASS and `dispose()` completes without throwing.

- [ ] **Step 6: Commit the model**

```bash
git add test/border-collie-model.test.js src/renderer/border-collie-model.js
git commit -m "feat: build articulated border collie model"
```

### Task 3: Scene Integration and Pose Application

**Files:**
- Modify: `src/renderer/three-pet.js`
- Modify: `src/renderer/renderer.js`
- Modify: `src/settings/index.html`
- Modify: `README.md`
- Create: `test/three-pet-integration.test.js`

**Interfaces:**
- Consumes: `createBorderCollieModel(THREE)`, `getSitCyclePhase`, and `createDogPose`.
- Produces: Three.js canvas whose dog model updates named joints every frame.

- [ ] **Step 1: Write failing source-level integration assertions**

```js
test("3D scene uses articulated model and no texture plane", () => {
  const source = fs.readFileSync("src/renderer/three-pet.js", "utf8");
  assert.match(source, /createBorderCollieModel/);
  assert.match(source, /createDogPose/);
  assert.doesNotMatch(source, /PlaneGeometry/);
  assert.doesNotMatch(source, /setPetImage/);
});
```

- [ ] **Step 2: Run the test and verify it fails on the old plane implementation**

Run: `npm test -- test/three-pet-integration.test.js`

Expected: FAIL because `PlaneGeometry` and `setPetImage` remain.

- [ ] **Step 3: Replace the old model and texture plane**

Remove `imagePetRoot`, `imageGeometry`, `imageMaterial`, `TextureLoader`, `setPetImage`, and the generic cat geometry. Instantiate `createBorderCollieModel(THREE)`, retain the existing transparent renderer, lights, ground, and resize handling.

- [ ] **Step 4: Apply articulated poses every frame**

Create `applyPose(joints, pose)` that sets pelvis position/rotation and each leg chain's upper, lower, and paw rotations individually. Maintain a cycle start time and choose the next idle duration in the range 4 to 8 seconds after each completed stand-up.

- [ ] **Step 5: Remove obsolete action routing**

Stop sending generated images into the 3D renderer. In 3D mode, ignore `stage.dataset.action`; in 2D mode retain the current generated image. Change settings copy to `关节 3D 模式` and `程序化边境牧羊犬模型，自动随机坐下`.

- [ ] **Step 6: Run integration and complete tests**

Run: `npm test -- test/three-pet-integration.test.js && npm test`

Expected: all tests PASS.

- [ ] **Step 7: Commit integration**

```bash
git add src/renderer/three-pet.js src/renderer/renderer.js src/settings/index.html README.md test/three-pet-integration.test.js
git commit -m "feat: render articulated dog in 3D mode"
```

### Task 4: Electron Visual Verification

**Files:**
- Modify: `test/electron-visual-harness.js`
- Create: `test/electron-sit-visual.test.js`

**Interfaces:**
- Consumes: phase and joint diagnostics exposed on `renderer.domElement.dataset` by the production animation loop.
- Produces: screenshots and pixel statistics for standing, transition, seated, and compact views.

- [ ] **Step 1: Add failing screenshot-state checks**

```js
assert.equal(results.canvasCount, 1);
assert.ok(results.frames.standing.visiblePixels > 5000);
assert.notEqual(results.frames.standing.hash, results.frames.seated.hash);
assert.ok(results.joints.seated.pelvisY < results.joints.standing.pelvisY);
assert.ok(results.compact.visiblePixels > 3000);
```

- [ ] **Step 2: Run the harness and verify missing pose diagnostics**

Run: `./node_modules/.bin/electron test/electron-visual-harness.js`

Expected: FAIL because joint diagnostics and named sit frames are not exposed.

- [ ] **Step 3: Add test-only visual diagnostics without production controls**

Expose current phase and selected joint world positions through `renderer.domElement.dataset` values. The harness waits for `idle`, `sitting`, and `seated`, captures each state, and verifies pelvis movement and front-paw ground stability.

- [ ] **Step 4: Verify desktop and compact renderings**

Run: `./node_modules/.bin/electron test/electron-visual-harness.js`

Expected: one nonblank canvas; different standing/seated hashes; pelvis lower when seated; both front paw Y values differ by less than `0.12`; 260x250 and 180x180 captures remain framed.

- [ ] **Step 5: Inspect screenshots and run final checks**

Run: `npm test && git diff --check`

Expected: all tests PASS and no whitespace errors. Inspect all generated PNG files for border collie proportions, black-white markings, correct rear-leg folding, and clipping.

- [ ] **Step 6: Commit visual verification**

```bash
git add test/electron-visual-harness.js test/electron-sit-visual.test.js
git commit -m "test: verify articulated sitting animation"
```
