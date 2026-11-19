"use strict";

(function (root) {
  function getAttachmentIds(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    const values = value[0] === "L" ? value.slice(1) : value;
    return values.filter(
      (id) => Number.isSafeInteger(id) && id > 0
    );
  }

  function previewKind(contentType) {
    const normalized = String(contentType || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (normalized.startsWith("image/")) {
      return "image";
    }
    if (normalized === "application/pdf") {
      return "pdf";
    }
    return "download";
  }

  function getAttachmentFileName(metadata) {
    const fileName =
      metadata && typeof metadata.fileName === "string"
        ? metadata.fileName.trim()
        : "";
    return fileName || null;
  }

  function formatDossierNumber(value) {
    if (typeof value !== "string" && typeof value !== "number") {
      return "Non renseigné";
    }
    const dossierNumber = String(value).trim();
    return dossierNumber || "Non renseigné";
  }

  function getRecordId(record) {
    const id = record && record.id;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  function addAttachmentCard(document, index, fileName, objectUrl, contentType) {
    const card = document.createElement("article");
    card.className = "attachment";
    const heading = document.createElement("h2");
    heading.textContent = fileName || `Pièce jointe ${index + 1}`;
    const preview = document.createElement("div");
    preview.className = "preview";
    const kind = previewKind(contentType);
    let nameNotice = null;
    if (!fileName) {
      nameNotice = document.createElement("p");
      nameNotice.className = "filename-unavailable";
      nameNotice.textContent = "Nom de fichier indisponible.";
    }

    if (kind === "image") {
      const image = document.createElement("img");
      image.src = objectUrl;
      image.alt = fileName
        ? `Aperçu de ${fileName}`
        : `Aperçu de la pièce jointe ${index + 1}`;
      preview.append(image);
    } else if (kind === "pdf") {
      const frame = document.createElement("iframe");
      frame.src = objectUrl;
      frame.title = fileName
        ? `Aperçu PDF de ${fileName}`
        : `Aperçu PDF de la pièce jointe ${index + 1}`;
      frame.loading = "lazy";
      preview.append(frame);
    } else {
      const message = document.createElement("p");
      message.textContent =
        "L’aperçu intégré n’est pas disponible pour ce format.";
      preview.append(message);
    }

    const label = fileName || `la pièce jointe ${index + 1}`;
    const actions = document.createElement("div");
    actions.className = "attachment-actions";

    const openLink = document.createElement("a");
    openLink.href = objectUrl;
    openLink.target = "_blank";
    openLink.rel = "noopener noreferrer";
    openLink.textContent = "Ouvrir dans un nouvel onglet";
    openLink.setAttribute(
      "aria-label",
      `Ouvrir ${label} dans un nouvel onglet`
    );

    const downloadLink = document.createElement("a");
    downloadLink.href = objectUrl;
    downloadLink.setAttribute("download", fileName || `piece-jointe-${index + 1}`);
    downloadLink.textContent = "Télécharger";
    downloadLink.setAttribute(
      "aria-label",
      `Télécharger ${label}`
    );

    actions.append(openLink, downloadLink);
    card.append(heading);
    if (nameNotice) {
      card.append(nameNotice);
    }
    card.append(preview, actions);
    return card;
  }

  function initialize(document, grist, fetchImpl, urlApi, eventTarget = root) {
    const status = document.getElementById("status");
    const attachments = document.getElementById("attachments");
    const recordInfo = document.getElementById("record-info");
    const dossierNumberElement = document.getElementById("dossier-number");
    let generation = 0;
    let objectUrls = [];
    let selectedRecordId = null;
    let currentRecordIds = null;

    function clearPreviews() {
      for (const objectUrl of objectUrls) {
        urlApi.revokeObjectURL(objectUrl);
      }
      objectUrls = [];
      attachments.replaceChildren();
    }

    function setStatus(message, state) {
      status.textContent = message;
      status.dataset.state = state || "ready";
    }

    function addErrorCard(index, fileName, reason) {
      const card = document.createElement("article");
      card.className = "attachment";
      const heading = document.createElement("h2");
      heading.textContent = fileName || `Pièce jointe ${index + 1}`;
      const message = document.createElement("p");
      message.textContent = reason;
      if (!fileName) {
        const nameNotice = document.createElement("p");
        nameNotice.className = "filename-unavailable";
        nameNotice.textContent = "Nom de fichier indisponible.";
        card.append(heading, nameNotice, message);
        return card;
      }
      card.append(heading, message);
      return card;
    }

    async function loadAttachment(baseUrl, token, id, index, currentGeneration) {
      const metadataUrl = new URL(
        `attachments/${encodeURIComponent(id)}`,
        `${baseUrl.replace(/\/+$/, "")}/`
      );
      metadataUrl.searchParams.set("auth", token);
      const downloadUrl = new URL(
        `attachments/${encodeURIComponent(id)}/download`,
        `${baseUrl.replace(/\/+$/, "")}/`
      );
      downloadUrl.searchParams.set("auth", token);

      let fileName = null;
      try {
        const metadataResponse = await fetchImpl(metadataUrl.toString());
        if (metadataResponse.ok) {
          fileName = getAttachmentFileName(await metadataResponse.json());
        }
      } catch {
        fileName = null;
      }
      if (currentGeneration !== generation) {
        return null;
      }

      try {
        const response = await fetchImpl(downloadUrl.toString());
        if (!response.ok) {
          const reason = `Échec HTTP ${response.status}. Vérifiez les droits de lecture du widget.`;
          return currentGeneration === generation
            ? {
                loaded: false,
                reason: `HTTP ${response.status}`,
                card: addErrorCard(index, fileName, reason),
              }
            : null;
        }

        const blob = await response.blob();
        const objectUrl = urlApi.createObjectURL(blob);
        if (currentGeneration !== generation) {
          urlApi.revokeObjectURL(objectUrl);
          return null;
        }

        objectUrls.push(objectUrl);
        return {
          loaded: true,
          card: addAttachmentCard(
            document,
            index,
            fileName,
            objectUrl,
            response.headers.get("content-type") || blob.type
          ),
        };
      } catch {
        const reason =
          "Échec réseau/CORS pendant le chargement. Vérifiez l’accès à l’API Grist.";
        return currentGeneration === generation
          ? {
              loaded: false,
              reason: "réseau/CORS",
              card: addErrorCard(index, fileName, reason),
            }
          : null;
      }
    }

    async function showRecord(record) {
      const currentGeneration = ++generation;
      clearPreviews();

      if (!record) {
        recordInfo.hidden = true;
        dossierNumberElement.textContent = "";
        setStatus("Sélectionnez une ligne pour afficher ses pièces jointes.");
        return;
      }

      recordInfo.hidden = false;
      dossierNumberElement.textContent = formatDossierNumber(
        record.numero_dossier
      );
      const ids = getAttachmentIds(record.PJ);
      if (ids.length === 0) {
        setStatus("Aucune pièce jointe dans la colonne PJ de cette ligne.");
        return;
      }

      setStatus("Chargement des pièces jointes…");
      try {
        const access = await grist.docApi.getAccessToken({ readOnly: true });
        if (currentGeneration !== generation) {
          return;
        }
        const results = await Promise.all(
          ids.map((id, index) =>
            loadAttachment(
              access.baseUrl,
              access.token,
              id,
              index,
              currentGeneration
            )
          )
        );
        if (currentGeneration === generation) {
          results.forEach((result) => {
            if (result) {
              attachments.append(result.card);
            }
          });
          const loadedCount = results.filter(
            (result) => result && result.loaded
          ).length;
          const failures = results.filter(
            (result) => result && !result.loaded
          );
          const failureDetails = [
            ...new Set(failures.map((result) => result.reason)),
          ].join(", ");
          if (loadedCount === ids.length) {
            const plural = loadedCount > 1;
            setStatus(
              `${loadedCount} pièce${plural ? "s" : ""} jointe${
                plural ? "s" : ""
              } affichée${plural ? "s" : ""}.`
            );
          } else if (loadedCount === 0) {
            setStatus(
              `Aucune des ${ids.length} pièces jointes n’a pu être chargée (${failureDetails}).`,
              "error"
            );
          } else {
            const plural = loadedCount > 1;
            setStatus(
              `${loadedCount} pièce${plural ? "s" : ""} jointe${
                plural ? "s" : ""
              } chargée${plural ? "s" : ""} sur ${ids.length} ; échec : ${failureDetails}.`,
              "error"
            );
          }
        }
      } catch {
        if (currentGeneration === generation) {
          setStatus(
            "Impossible de préparer l’aperçu. Vérifiez les autorisations du widget.",
            "error"
          );
        }
      }
    }

    function handleRecord(record) {
      const recordId = getRecordId(record);
      if (
        recordId !== null &&
        currentRecordIds !== null &&
        !currentRecordIds.has(recordId)
      ) {
        selectedRecordId = null;
        return showRecord(null);
      }

      selectedRecordId = recordId;
      return showRecord(record);
    }

    grist.ready({ requiredAccess: "read table" });
    grist.onRecord(handleRecord);
    grist.onRecords((records) => {
      currentRecordIds = new Set(
        records.map(getRecordId).filter((id) => id !== null)
      );
      if (
        selectedRecordId !== null &&
        !currentRecordIds.has(selectedRecordId)
      ) {
        selectedRecordId = null;
        showRecord(null);
      }
    });
    eventTarget.addEventListener("pagehide", () => {
      generation += 1;
      clearPreviews();
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      formatDossierNumber,
      getRecordId,
      getAttachmentIds,
      getAttachmentFileName,
      previewKind,
      addAttachmentCard,
      initialize,
    };
  } else if (root.document && root.grist) {
    initialize(root.document, root.grist, root.fetch.bind(root), root.URL);
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
