"use strict";

(function (root) {
  const SETTINGS = Object.freeze({
    owner: "qiongnan-aucarre",
    repository: "recuperation-PJ-ND",
    workflow: "import.yml",
    ref: "main",
  });
  const TOKEN_OPTION = "githubToken";
  const API_BASE = "https://api.github.com";
  const POLL_INTERVAL_MS = 10000;
  const TRACKING_TIMEOUT_MS = 15 * 60 * 1000;
  const RUN_NOT_FOUND_TIMEOUT_MS = 2 * 60 * 1000;
  const ESTIMATE_SAMPLE_SIZE = 5;

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return null;
    }

    const totalSeconds = Math.round(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainder = totalSeconds % 60;
    const parts = [];
    if (hours) {
      parts.push(`${hours} h`);
    }
    if (minutes) {
      parts.push(`${minutes} min`);
    }
    if (remainder || parts.length === 0) {
      parts.push(`${remainder} s`);
    }
    return parts.join(" ");
  }

  function workflowRunTitle(requestId) {
    return `Import PJ ${requestId}`;
  }

  function countsFromJobName(name) {
    if (typeof name !== "string") {
      return null;
    }
    const match = name.match(
      /^PJ_COUNT added=(\d+) ignored=(\d+) duplicate_source=(\d+) updated=(\d+)$/
    );
    if (!match) {
      return null;
    }
    const counts = {
      added: Number(match[1]),
      ignored: Number(match[2]),
      duplicateSource: Number(match[3]),
      updated: Number(match[4]),
    };
    return Object.values(counts).every(Number.isSafeInteger) ? counts : null;
  }

  function estimateDurationSeconds(runs, currentTitle) {
    if (!Array.isArray(runs)) {
      return null;
    }
    const durations = runs
      .filter(
        (run) =>
          run &&
          run.status === "completed" &&
          run.conclusion === "success" &&
          run.display_title !== currentTitle
      )
      .map(
        (run) =>
          (Date.parse(run.updated_at) - Date.parse(run.run_started_at)) / 1000
      )
      .filter((seconds) => Number.isFinite(seconds) && seconds > 0)
      .slice(0, ESTIMATE_SAMPLE_SIZE)
      .sort((a, b) => a - b);
    if (!durations.length) {
      return null;
    }
    const middle = Math.floor(durations.length / 2);
    const median =
      durations.length % 2
        ? durations[middle]
        : (durations[middle - 1] + durations[middle]) / 2;
    return Math.round(median);
  }

  function formatCounts(counts) {
    if (!counts) {
      return "";
    }
    const duplicateDetails = counts.duplicateSource
      ? ` dont ${counts.duplicateSource} doublon(s) de contenu source`
      : "";
    return `PJ ajoutées : ${counts.added} ; ignorées : ${counts.ignored}${duplicateDetails} ; mises à jour : ${counts.updated}.`;
  }

  function createWorkflowController(fetchImpl, timing = {}) {
    let pending = false;
    const now = timing.now || Date.now;
    const sleep =
      timing.sleep ||
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));

    return {
      get pending() {
        return pending;
      },

      async dispatch(settings, token, requestId) {
        if (pending) {
          return false;
        }
        pending = true;

        const url = [
          API_BASE,
          "repos",
          encodeURIComponent(settings.owner),
          encodeURIComponent(settings.repository),
          "actions",
          "workflows",
          encodeURIComponent(settings.workflow),
          "dispatches",
        ].join("/");

        try {
          let response;
          try {
            const body = { ref: settings.ref };
            if (requestId) {
              body.inputs = { request_id: requestId };
            }
            response = await fetchImpl(url, {
              method: "POST",
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": "2022-11-28",
              },
              body: JSON.stringify(body),
            });
          } catch {
            throw { kind: "network" };
          }

          if (response.status !== 204) {
            throw { kind: "http", status: response.status };
          }
          return true;
        } finally {
          pending = false;
        }
      },

      async waitForCompletion(settings, token, requestId, onProgress) {
        const owner = encodeURIComponent(settings.owner);
        const repository = encodeURIComponent(settings.repository);
        const workflow = encodeURIComponent(settings.workflow);
        const runsUrl = new URL(
          `${API_BASE}/repos/${owner}/${repository}/actions/workflows/${workflow}/runs`
        );
        runsUrl.searchParams.set("event", "workflow_dispatch");
        runsUrl.searchParams.set("branch", settings.ref);
        runsUrl.searchParams.set("per_page", "100");
        const startedAt = now();
        const deadline = startedAt + (timing.timeoutMs || TRACKING_TIMEOUT_MS);
        const notFoundDeadline =
          startedAt + (timing.notFoundTimeoutMs || RUN_NOT_FOUND_TIMEOUT_MS);
        let matchingRun = null;
        let estimatedSeconds = null;

        while (now() < deadline) {
          let response;
          try {
            response = await fetchImpl(runsUrl.toString(), {
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2022-11-28",
              },
            });
          } catch {
            throw { kind: "tracking-network" };
          }
          if (response.status !== 200) {
            throw { kind: "tracking-http", status: response.status };
          }

          let payload;
          try {
            payload = await response.json();
          } catch {
            throw { kind: "tracking-response" };
          }
          if (!payload || !Array.isArray(payload.workflow_runs)) {
            throw { kind: "tracking-response" };
          }

          matchingRun = payload.workflow_runs.find(
            (run) =>
              run &&
              run.display_title === workflowRunTitle(requestId) &&
              Number.isSafeInteger(run.id) &&
              run.id > 0
          );
          if (estimatedSeconds === null) {
            estimatedSeconds = estimateDurationSeconds(
              payload.workflow_runs,
              workflowRunTitle(requestId)
            );
          }
          if (!matchingRun && now() >= notFoundDeadline) {
            throw { kind: "tracking-not-found" };
          }
          if (matchingRun && matchingRun.status === "completed") {
            let jobsResponse;
            try {
              jobsResponse = await fetchImpl(
                `${API_BASE}/repos/${owner}/${repository}/actions/runs/${matchingRun.id}/jobs?per_page=100`,
                {
                  headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${token}`,
                    "X-GitHub-Api-Version": "2022-11-28",
                  },
                }
              );
            } catch {
              throw { kind: "tracking-network" };
            }
            if (jobsResponse.status !== 200) {
              throw { kind: "tracking-http", status: jobsResponse.status };
            }

            let jobsPayload;
            try {
              jobsPayload = await jobsResponse.json();
            } catch {
              throw { kind: "tracking-response" };
            }
            const job = Array.isArray(jobsPayload && jobsPayload.jobs)
              ? jobsPayload.jobs.find(
                  (item) => item && item.name === "Importer les PJ dans Grist"
                )
              : null;
            const reportJob = Array.isArray(jobsPayload && jobsPayload.jobs)
              ? jobsPayload.jobs.find(
                  (item) =>
                    item &&
                    typeof item.name === "string" &&
                    item.name.startsWith("PJ_COUNT ")
                )
              : null;
            const counts = countsFromJobName(reportJob && reportJob.name);
            const errorJob = Array.isArray(jobsPayload && jobsPayload.jobs)
              ? jobsPayload.jobs.find(
                  (item) =>
                    item &&
                    typeof item.name === "string" &&
                    item.name.startsWith("PJ_ERROR ")
                )
              : null;
            const errorDetail = errorJob
              ? errorJob.name.slice("PJ_ERROR ".length).trim() || null
              : null;
            const importStep =
              job && Array.isArray(job.steps)
                ? job.steps.find(
                    (step) => step && step.name === "Lancer l’import"
                  )
                : null;
            const startedAt = Date.parse(importStep && importStep.started_at);
            const completedAt = Date.parse(
              importStep && importStep.completed_at
            );
            const durationSeconds =
              Number.isFinite(startedAt) &&
              Number.isFinite(completedAt) &&
              completedAt >= startedAt
                ? Math.round((completedAt - startedAt) / 1000)
                : null;

            return {
              conclusion: matchingRun.conclusion,
              durationSeconds,
              counts,
              errorDetail,
              runUrl: `https://github.com/${owner}/${repository}/actions/runs/${matchingRun.id}`,
            };
          }

          if (typeof onProgress === "function") {
            onProgress({
              elapsedSeconds: Math.round((now() - startedAt) / 1000),
              estimatedSeconds,
            });
          }

          const remaining = deadline - now();
          if (remaining > 0) {
            await sleep(
              Math.min(timing.pollIntervalMs || POLL_INTERVAL_MS, remaining)
            );
          }
        }

        throw {
          kind: "tracking-timeout",
          runId: matchingRun && matchingRun.id,
        };
      },
    };
  }

  function statusFor(
    state,
    statusCode,
    durationSeconds,
    counts,
    progress,
    errorDetail
  ) {
    if (state === "pending") {
      return {
        text: "Déclenchement du workflow en cours…",
        state: "pending",
      };
    }
    if (state === "tracking") {
      const estimate = formatDuration(progress && progress.estimatedSeconds);
      const elapsed = formatDuration(progress && progress.elapsedSeconds);
      const estimateText = estimate
        ? `Durée habituelle : environ ${estimate}.`
        : progress
          ? "Durée estimée indisponible : aucun import réussi précédemment."
          : "Calcul de la durée estimée…";
      return {
        text: [
          "Import lancé. Suivi de son exécution en cours…",
          estimateText,
          elapsed ? `Temps écoulé : ${elapsed}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
        state: "pending",
      };
    }
    if (state === "run-success") {
      const duration = formatDuration(durationSeconds);
      return {
        text: [
          duration
            ? `Import terminé en ${duration}.`
            : "Import terminé. Durée d’exécution indisponible.",
          formatCounts(counts),
        ]
          .filter(Boolean)
          .join(" "),
        state: "success",
      };
    }
    if (state === "run-failure") {
      const duration = formatDuration(durationSeconds);
      return {
        text: [
          duration
            ? `L’import a échoué après ${duration}.`
            : "L’import a échoué.",
          errorDetail ? `Motif : ${errorDetail}` : "",
          counts ? `Bilan partiel : ${formatCounts(counts)}` : "",
          errorDetail
            ? ""
            : "Consultez le journal du workflow dans GitHub Actions.",
        ]
          .filter(Boolean)
          .join(" "),
        state: "error",
      };
    }
    if (state === "tracking-timeout") {
      return {
        text: "Le workflow s’exécute peut-être encore. Le suivi dans le widget s’arrête après 15 minutes.",
        state: "error",
      };
    }
    if (state === "tracking-not-found") {
      return {
        text: "Le workflow a été lancé, mais son exécution est introuvable. Vérifiez que son run-name contient l’identifiant de la demande.",
        state: "error",
      };
    }
    if (state === "tracking-http-error") {
      return {
        text: `Le workflow a été lancé, mais son suivi a échoué (HTTP ${statusCode}). Vérifiez que le jeton a l’autorisation Actions en lecture.`,
        state: "error",
      };
    }
    if (state === "tracking-error") {
      return {
        text: "Le workflow a été lancé, mais son résultat n’a pas pu être récupéré.",
        state: "error",
      };
    }
    if (state === "success") {
      return {
        text: "Workflow déclenché. L’import n’est pas encore terminé ; son suivi est en cours dans le widget.",
        state: "success",
      };
    }
    if (state === "network-error") {
      return {
        text: "Impossible de joindre GitHub. Vérifiez la connexion réseau puis réessayez.",
        state: "error",
      };
    }
    if (state === "http-error") {
      return {
        text:
          statusCode === 401 || statusCode === 403
            ? `GitHub a refusé la demande (HTTP ${statusCode}). Vérifiez le jeton et ses permissions.`
            : `GitHub n’a pas accepté la demande (HTTP ${statusCode}). Vérifiez la configuration du workflow.`,
        state: "error",
      };
    }
    if (state === "unconfigured") {
      return {
        text: "Jeton non configuré. Ouvrez les options du widget pour le renseigner.",
        state: "error",
      };
    }
    return {
      text: "Prêt à lancer l’import.",
      state: "ready",
    };
  }

  function initialize(document, grist, fetchImpl) {
    const mainPanel = document.getElementById("main-panel");
    const settingsPanel = document.getElementById("settings-panel");
    const button = document.getElementById("submit-button");
    const status = document.getElementById("status");
    const tokenInput = document.getElementById("token");
    const settingsForm = document.getElementById("settings-form");
    const settingsStatus = document.getElementById("settings-status");
    const cancelSettings = document.getElementById("cancel-settings");
    const controller = createWorkflowController(fetchImpl);
    let token = "";
    let tracking = false;

    function render(
      state,
      statusCode,
      durationSeconds,
      counts,
      progress,
      errorDetail
    ) {
      const message = statusFor(
        state,
        statusCode,
        durationSeconds,
        counts,
        progress,
        errorDetail
      );
      status.textContent = message.text;
      status.dataset.state = message.state;
      status.setAttribute("role", message.state === "error" ? "alert" : "status");
      button.disabled =
        state === "pending" || state === "tracking" || !token;
      button.textContent =
        state === "pending"
          ? "Déclenchement en cours…"
          : state === "tracking"
            ? "Import en cours…"
            : "Importer les PJ";
    }

    function openSettings() {
      tokenInput.value = token;
      settingsStatus.textContent = "";
      mainPanel.hidden = true;
      settingsPanel.hidden = false;
      tokenInput.focus();
    }

    function closeSettings() {
      settingsPanel.hidden = true;
      mainPanel.hidden = false;
      button.focus();
    }

    cancelSettings.addEventListener("click", closeSettings);

    settingsForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const newToken = tokenInput.value.trim();
      if (!newToken) {
        settingsStatus.textContent = "Le jeton GitHub est requis.";
        return;
      }

      try {
        await grist.setOption(TOKEN_OPTION, newToken);
        token = newToken;
        render("ready");
        closeSettings();
      } catch {
        settingsStatus.textContent =
          "Impossible d’enregistrer la configuration dans Grist.";
      }
    });

    button.addEventListener("click", async () => {
      if (controller.pending || tracking || !token) {
        return;
      }

      render("pending");
      const requestId = root.crypto.randomUUID();
      let workflowAccepted = false;
      try {
        const triggered = await controller.dispatch(
          SETTINGS,
          token,
          requestId
        );
        if (triggered) {
          workflowAccepted = true;
          tracking = true;
          render("tracking");
          const result = await controller.waitForCompletion(
            SETTINGS,
            token,
            requestId,
            (progress) =>
              render("tracking", undefined, undefined, undefined, progress)
          );
          render(
            result.conclusion === "success" ? "run-success" : "run-failure",
            undefined,
            result.durationSeconds,
            result.counts,
            undefined,
            result.errorDetail
          );
        }
      } catch (error) {
        if (workflowAccepted && error && error.kind === "tracking-timeout") {
          render("tracking-timeout");
        } else if (workflowAccepted && error && error.kind === "tracking-not-found") {
          render("tracking-not-found");
        } else if (workflowAccepted && error && error.kind === "tracking-http") {
          render("tracking-http-error", error.status);
        } else if (workflowAccepted) {
          render("tracking-error");
        } else if (error && error.kind === "http") {
          render("http-error", error.status);
        } else {
          render("network-error");
        }
      } finally {
        tracking = false;
      }
    });

    grist.ready({ onEditOptions: openSettings });
    grist
      .getOption(TOKEN_OPTION)
      .then((savedToken) => {
        token = typeof savedToken === "string" ? savedToken : "";
        render(token ? "ready" : "unconfigured");
      })
      .catch(() => {
        status.textContent =
          "Impossible de lire la configuration du widget dans Grist.";
        status.dataset.state = "error";
        button.disabled = true;
      });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      createWorkflowController,
      formatDuration,
      countsFromJobName,
      estimateDurationSeconds,
      formatCounts,
      statusFor,
      workflowRunTitle,
      SETTINGS,
    };
  } else if (root.document && root.grist) {
    initialize(root.document, root.grist, root.fetch.bind(root));
  } else if (root.document) {
    const status = root.document.getElementById("status");
    if (status) {
      status.textContent =
        "API Grist indisponible. Vérifiez l’adresse du script grist-plugin-api.js.";
      status.dataset.state = "error";
      status.setAttribute("role", "alert");
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
