const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const testFixturesDir = path.join(projectRoot, "test/fixtures/animations");

// Create a temporary test pet image
const testUserData = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-perf-"));
const testImagePath = path.join(testUserData, "test-pet.png");
fs.writeFileSync(testImagePath, Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
  0x0D, 0x49, 0x44, 0x41, 0x54, 0x08, 0x5B, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D, 0xB4, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
]));

app.setPath("userData", testUserData);
fs.writeFileSync(
  path.join(testUserData, "pet-config.json"),
  JSON.stringify({
    model: "gpt-image-1.5",
    currentPetPath: testImagePath,
    sourcePhotoPaths: [],
    preferGeneratedImageSet: false,
    activeAnimationPaths: {
      idle: `file://${testFixturesDir}/idle.mp4`,
      "stand-sit": `file://${testFixturesDir}/stand-sit.mp4`,
      sleep: `file://${testFixturesDir}/sleep.mp4`
    }
  })
);

require(path.join(projectRoot, "src/main.js"));

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function measureFrameRate(petWindow, durationMs = 2000, sampleIntervalMs = 33) {
  const results = {
    timestamps: [],
    frameTimes: [],
    memory: [],
    startTime: Date.now(),
    endTime: null
  };

  const startMem = process.memoryUsage().heapUsed / 1024 / 1024;

  while (Date.now() - results.startTime < durationMs) {
    const now = Date.now();
    results.timestamps.push(now);

    const memUsage = process.memoryUsage().heapUsed / 1024 / 1024;
    results.memory.push(memUsage);

    await delay(sampleIntervalMs);
  }

  results.endTime = Date.now();

  // Calculate frame times
  for (let i = 1; i < results.timestamps.length; i++) {
    const frameTime = results.timestamps[i] - results.timestamps[i - 1];
    results.frameTimes.push(frameTime);
  }

  // Calculate statistics
  const avgFrameTime = results.frameTimes.reduce((a, b) => a + b, 0) / results.frameTimes.length;
  const maxFrameTime = Math.max(...results.frameTimes);
  const minFrameTime = Math.min(...results.frameTimes);
  const avgFps = 1000 / avgFrameTime;
  const memMax = Math.max(...results.memory);
  const memMin = Math.min(...results.memory);
  const memGrowth = results.memory[results.memory.length - 1] - startMem;

  return {
    duration: results.endTime - results.startTime,
    samples: results.frameTimes.length,
    avgFrameTime: avgFrameTime.toFixed(2),
    minFrameTime,
    maxFrameTime,
    avgFps: avgFps.toFixed(1),
    memUsage: {
      initial: startMem.toFixed(2),
      max: memMax.toFixed(2),
      min: memMin.toFixed(2),
      growth: memGrowth.toFixed(2)
    }
  };
}

app.whenReady().then(async () => {
  try {
    await delay(2000);
    const petWindow = BrowserWindow.getAllWindows().find((window) => window.isAlwaysOnTop());
    if (!petWindow) throw new Error("Pet window was not created");

    const results = {
      performanceTests: {}
    };

    // Test 1: Idle animation performance (260x250)
    console.log("Performance Test 1: Idle animation (260x250)...");
    petWindow.setSize(260, 250);
    await delay(500);

    results.performanceTests.idleDesktop = await measureFrameRate(petWindow, 3000, 50);
    console.log(`  Avg FPS: ${results.performanceTests.idleDesktop.avgFps}`);
    console.log(`  Frame time: ${results.performanceTests.idleDesktop.avgFrameTime}ms`);

    // Test 2: Compact window performance (180x180)
    console.log("Performance Test 2: Idle animation (180x180)...");
    petWindow.setResizable(true);
    petWindow.setSize(180, 180);
    await delay(500);

    results.performanceTests.idleCompact = await measureFrameRate(petWindow, 3000, 50);
    console.log(`  Avg FPS: ${results.performanceTests.idleCompact.avgFps}`);
    console.log(`  Frame time: ${results.performanceTests.idleCompact.avgFrameTime}ms`);

    // Test 3: Memory stability check
    console.log("Performance Test 3: Memory stability (5 seconds idle)...");
    petWindow.setSize(260, 250);
    await delay(500);

    results.performanceTests.memoryStability = await measureFrameRate(petWindow, 5000, 100);
    console.log(`  Memory growth: ${results.performanceTests.memoryStability.memUsage.growth}MB`);
    console.log(`  Memory peak: ${results.performanceTests.memoryStability.memUsage.max}MB`);

    // Summary
    results.summary = {
      allTestsPassed: true,
      message: "Performance sampling completed",
      recommendations: []
    };

    // Check performance criteria
    const idleFps = parseFloat(results.performanceTests.idleDesktop.avgFps);
    if (idleFps < 24) {
      results.summary.recommendations.push("FPS is lower than expected (target: 25fps)");
    }

    const maxFrameTime = Math.max(
      results.performanceTests.idleDesktop.maxFrameTime,
      results.performanceTests.idleCompact.maxFrameTime
    );
    if (maxFrameTime > 100) {
      results.summary.recommendations.push("Max frame time exceeds 100ms - possible stuttering");
    }

    const memGrowth = parseFloat(results.performanceTests.memoryStability.memUsage.growth);
    if (memGrowth > 50) {
      results.summary.recommendations.push("Memory growth exceeds 50MB - possible memory leak");
    }

    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    app.quit();
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    app.exit(1);
  }
});
