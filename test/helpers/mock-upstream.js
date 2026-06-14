const http = require("http");

async function createMockUpstream(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = bodyText; }
      const record = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(record);
      await handler(record, res);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { createMockUpstream };
