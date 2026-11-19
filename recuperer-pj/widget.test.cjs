const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const {
  createWorkflowController,
  countsFromJobName,
  formatCounts,
  formatDuration,
  statusFor,
  workflowRunTitle,
  SETTINGS,
} = require("./widget.js");

const settings = {
  owner: "example-owner",
  repository: "example-repository",
  workflow: "import.yml",
  ref: "main",
};

test("dispatches the configured workflow with the token only in Authorization", async () => {
  let request;
  const controller = createWorkflowController(async (...args) => {
    request = args;
    return { status: 204 };
  });

  assert.equal(
    await controller.dispatch(settings, "temporary-token", "request-123"),
    true
  );
  assert.equal(
    request[0],
    "https://api.github.com/repos/example-owner/example-repository/actions/workflows/import.yml/dispatches"
  );
  assert.equal(request[1].headers.Authorization, "Bearer temporary-token");
  assert.equal(
    request[1].body,
    JSON.stringify({
      ref: "main",
      inputs: { request_id: "request-123" },
    })
  );
  assert.equal(request[1].method, "POST");
});

test("uses this repository workflow and indicates when the widget is unconfigured", () => {
  assert.deepEqual(SETTINGS, {
    owner: "qiongnan-aucarre",
    repository: "recuperation-PJ-ND",
    workflow: "import.yml",
    ref: "main",
  });
  assert.equal(statusFor("unconfigured").state, "error");
  assert.match(statusFor("unconfigured").text, /options du widget/i);
});

test("keeps all text inputs out of the main widget view", () => {
  const html = fs.readFileSync(`${__dirname}/index.html`, "utf8");
  const mainPanel = html.match(
    /<section id="main-panel">([\s\S]*?)<\/section>/
  );

  assert.ok(mainPanel);
  assert.doesNotMatch(mainPanel[1], /<input\b/i);
  assert.doesNotMatch(mainPanel[1], /GitHub Actions/i);
  assert.match(mainPanel[1], /Importer les PJ/);
});

test("prevents a second dispatch while the first request is pending", async () => {
  let releaseRequest;
  let requestCount = 0;
  const controller = createWorkflowController(
    () =>
      new Promise((resolve) => {
        requestCount += 1;
        releaseRequest = () => resolve({ status: 204 });
      })
  );

  const first = controller.dispatch(settings, "temporary-token");
  assert.equal(controller.pending, true);
  assert.equal(
    await controller.dispatch(settings, "temporary-token"),
    false
  );
  assert.equal(requestCount, 1);

  releaseRequest();
  assert.equal(await first, true);
  assert.equal(controller.pending, false);
});

test("treats HTTP 204 as triggered, not as completed import", () => {
  const state = statusFor("success");
  assert.equal(state.state, "success");
  assert.match(state.text, /déclenché/i);
  assert.match(state.text, /pas encore terminé/i);
});

test("provides distinct ready and pending button messages", () => {
  assert.equal(statusFor("ready").state, "ready");
  assert.match(statusFor("ready").text, /Prêt/i);
  assert.equal(statusFor("pending").state, "pending");
  assert.match(statusFor("pending").text, /en cours/i);
});

test("formats durations and displays the completed import time", () => {
  assert.equal(formatDuration(0), "0 s");
  assert.equal(formatDuration(65), "1 min 5 s");
  assert.equal(formatDuration(3661), "1 h 1 min 1 s");
  assert.equal(
    statusFor("run-success", undefined, 65).text,
    "Import terminé en 1 min 5 s."
  );
  assert.equal(workflowRunTitle("request-123"), "Import PJ request-123");
});

test("formats and validates import counts for the result message", () => {
  const counts = {
    added: 2,
    ignored: 3,
    duplicateSource: 1,
    updated: 1,
  };
  assert.deepEqual(
    countsFromJobName(
      "PJ_COUNT added=2 ignored=3 duplicate_source=1 updated=1"
    ),
    counts
  );
  assert.equal(
    formatCounts(counts),
    "PJ ajoutées : 2 ; ignorées : 3 dont 1 doublon(s) de contenu source ; mises à jour : 1."
  );
  assert.equal(
    countsFromJobName(
      "PJ_COUNT added=x ignored=3 duplicate_source=1 updated=1"
    ),
    null
  );
  assert.equal(
    statusFor("run-success", undefined, 65, counts).text,
    "Import terminé en 1 min 5 s. PJ ajoutées : 2 ; ignorées : 3 dont 1 doublon(s) de contenu source ; mises à jour : 1."
  );
});

test("tracks the matching workflow, counts, and import step duration", async () => {
  const requests = [];
  const controller = createWorkflowController(async (...args) => {
    requests.push(args);
    if (requests.length === 1) {
      return {
        status: 200,
        json: async () => ({
          workflow_runs: [
            {
              id: 42,
              display_title: "Import PJ request-123",
              status: "completed",
              conclusion: "success",
            },
          ],
        }),
      };
    }
    return {
      status: 200,
      json: async () => ({
        jobs: [
          {
            name: "Importer les PJ dans Grist",
            steps: [
              {
                name: "Lancer l’import",
                started_at: "2026-11-18T10:00:00Z",
                completed_at: "2026-11-18T10:01:05Z",
              },
            ],
          },
          {
            name: "PJ_COUNT added=2 ignored=3 duplicate_source=1 updated=1",
          },
        ],
      }),
    };
  });

  const result = await controller.waitForCompletion(
    settings,
    "temporary-token",
    "request-123"
  );

  assert.equal(result.conclusion, "success");
  assert.equal(result.durationSeconds, 65);
  assert.deepEqual(result.counts, {
    added: 2,
    ignored: 3,
    duplicateSource: 1,
    updated: 1,
  });
  assert.equal(
    result.runUrl,
    "https://github.com/example-owner/example-repository/actions/runs/42"
  );
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0][1].headers.Authorization,
    "Bearer temporary-token"
  );
});

test("stops polling when the tracking timeout is reached", async () => {
  let currentTime = 0;
  let requestCount = 0;
  const controller = createWorkflowController(
    async () => {
      requestCount += 1;
      return { status: 200, json: async () => ({ workflow_runs: [] }) };
    },
    {
      now: () => currentTime,
      sleep: async (milliseconds) => {
        currentTime += milliseconds;
      },
      pollIntervalMs: 10000,
      timeoutMs: 15000,
    }
  );

  await assert.rejects(
    controller.waitForCompletion(settings, "temporary-token", "request-123"),
    { kind: "tracking-timeout" }
  );
  assert.equal(requestCount, 2);
});

test("returns a sanitized HTTP error without reading a response body", async () => {
  let responseBodyRead = false;
  const controller = createWorkflowController(async () => ({
    status: 403,
    text() {
      responseBodyRead = true;
      return Promise.resolve("sensitive response content");
    },
  }));

  await assert.rejects(controller.dispatch(settings, "temporary-token"), {
    kind: "http",
    status: 403,
  });
  assert.equal(responseBodyRead, false);
  assert.match(statusFor("http-error", 403).text, /permissions/i);
});

test("handles network errors without exposing exception details", async () => {
  const controller = createWorkflowController(async () => {
    throw new Error("sensitive network detail");
  });

  await assert.rejects(controller.dispatch(settings, "temporary-token"), {
    kind: "network",
  });
  assert.equal(statusFor("network-error").state, "error");
});
