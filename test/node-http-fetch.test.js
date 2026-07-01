const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const { nodeHttpFetch } = require("../src/node-http-fetch");

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("nodeHttpFetch posts JSON and exposes a fetch-compatible response", async () => {
  const fixture = await listen((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ method: request.method, body: JSON.parse(body) }));
    });
  });

  try {
    const response = await nodeHttpFetch(`${fixture.url}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "seedance" })
    });
    assert.equal(response.ok, true);
    assert.deepEqual(await response.json(), {
      method: "POST",
      body: { model: "seedance" }
    });
  } finally {
    await fixture.close();
  }
});

test("nodeHttpFetch follows redirects without Electron net.fetch", async () => {
  const fixture = await listen((request, response) => {
    if (request.url === "/start") {
      response.writeHead(302, { Location: "/result" });
      response.end();
      return;
    }
    response.end("video");
  });

  try {
    const response = await nodeHttpFetch(`${fixture.url}/start`);
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "video");
  } finally {
    await fixture.close();
  }
});
