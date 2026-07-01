const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");

test("package config builds an x64 NSIS installer with the expected install experience", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")
  );

  assert.equal(packageJson.scripts["app:win"], "electron-builder --win nsis --x64");
  assert.deepEqual(packageJson.build.win.target, [
    {
      target: "nsis",
      arch: ["x64"]
    }
  ]);
  assert.equal(packageJson.build.win.icon, "build/icon.png");
  assert.equal(packageJson.build.artifactName, "PetMo-Setup-${version}.${ext}");
  assert.deepEqual(packageJson.build.nsis, {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "PetMo"
  });
});

test("Windows workflow tests, builds, and uploads the exact installer", () => {
  const workflowPath = path.join(
    projectRoot,
    ".github",
    "workflows",
    "build-windows.yml"
  );

  assert.equal(fs.existsSync(workflowPath), true, "Windows workflow must exist");
  const workflow = fs.readFileSync(workflowPath, "utf8");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /runs-on:\s*windows-latest/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /timeout-minutes:\s*30/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /run:\s*choco install ffmpeg -y --no-progress/);
  assert.match(workflow, /run:\s*npm test/);
  assert.match(workflow, /run:\s*npm run app:win/);
  assert.match(workflow, /uses:\s*actions\/upload-artifact@v4/);
  assert.match(workflow, /path:\s*release\/PetMo-Setup-0\.1\.0\.exe/);
});
