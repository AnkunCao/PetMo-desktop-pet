# Articulated Border Collie Design

## Goal

Replace the current image-plane 2.5D mode with a real articulated Three.js dog model. The first version targets a semi-realistic low-poly border collie that automatically transitions between standing and sitting.

## Scope

- Build the dog procedurally with Three.js geometry; do not depend on Blender, a GLB asset, or another API.
- Match the reference dog's border collie proportions: long muzzle, folded ears, lean torso, long legs, and full tail.
- Use separate black and white material regions for the forehead blaze, muzzle, neck and chest, paws, belly accents, and tail tip.
- Support idle standing, sit-down, seated hold, and stand-up transitions.
- Disable the previous eat, drink, play, and sleep actions for this milestone.
- Remove the generated-image plane from 3D rendering. Keep the generated 2D image available when 3D mode is disabled.

## Model Architecture

The model is a hierarchy of `THREE.Group` joints and low-poly meshes:

- `dogRoot`: world placement and breathing motion.
- `torsoJoint`: rib cage, chest marking, shoulders, and neck.
- `headJoint`: skull, muzzle, forehead blaze, ears, eyes, and nose.
- `pelvisJoint`: hips and tail base.
- Four leg chains: upper leg, lower leg, and paw joints.
- `tailJoint`: two or three tapered tail segments for idle wagging.

Body parts use stretched sphere, capsule, cone, and custom tapered geometry. Joint pivots are placed at anatomical rotation points so animation changes limb pose instead of moving the entire dog as one object.

## Appearance

The generated 2D image is used as a visual reference, not as a full-body texture map. The initial dog uses independently shaped black and white meshes to represent the observed coat pattern. Materials use high roughness, subtle normal variation, and directional lighting to avoid a plastic appearance.

The model remains intentionally low-poly. It should read as the same black-and-white border collie at desktop size, but it will not attempt individual fur strands or photorealistic texture projection in this milestone.

## Sitting Animation

Animation is a deterministic pose blend driven by elapsed time:

1. Idle standing for a randomized interval.
2. Sit down over approximately 1.2 seconds.
3. Hold the seated pose for approximately 3 seconds.
4. Stand up over approximately 1.2 seconds.
5. Return to randomized idle timing.

During sitting, the pelvis moves down and slightly forward, rear thighs rotate forward, rear lower legs fold beneath the body, and rear paws settle on the ground. The torso becomes more upright while front legs remain planted and adjust slightly to preserve contact. The head counters the torso rotation and the tail lowers beside the body.

Pose interpolation uses smooth easing and explicit standing and sitting transforms. Idle breathing, small head motion, and tail wagging are additive and reduced while seated.

## Integration

- `three-pet.js` owns scene setup and delegates dog construction and posing to focused modules.
- A model module creates the hierarchy and returns named joints and disposable resources.
- A motion module calculates the random sit state and interpolated joint pose.
- The renderer continues to switch between the existing 2D image and the new 3D canvas through the current `use3d` setting.
- No OpenAI request is required to preview or animate the 3D model.

## Failure Handling

If WebGL initialization fails, the existing 2D generated image remains visible. If appearance data is missing, the model uses the default black-and-white border collie materials.

## Verification

- Unit tests cover animation phases, easing boundaries, and standing/sitting transforms.
- Structural tests verify that each required joint exists and rear legs are independently articulated.
- Electron screenshots verify that the dog is visible and fully framed at 260x250 and 180x180.
- Pixel comparisons verify that standing, transition, and seated frames differ.
- Visual inspection verifies that the pelvis and rear-leg joints move while front paws remain near the ground.

## Acceptance Criteria

- 3D mode displays a modeled dog, not an image plane.
- The dog is recognizable as a black-and-white border collie at desktop size.
- The dog automatically performs a complete stand-to-sit-to-stand cycle.
- Sitting visibly articulates the pelvis and rear legs; it is not a whole-model rotation or translation effect.
- The model remains framed and nonblank in both supported test window sizes.
