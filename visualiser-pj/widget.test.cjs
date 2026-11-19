"use strict";

const assert = require("node:assert/strict");
const {
  formatDossierNumber,
  getAttachmentIds,
  getAttachmentFileName,
  previewKind,
  addAttachmentCard,
  initialize,
} = require("./widget.js");

assert.deepEqual(getAttachmentIds(["L", 3, 8]), [3, 8]);
assert.deepEqual(getAttachmentIds([3, 8]), [3, 8]);
assert.deepEqual(getAttachmentIds(["L", 3, "8", -1, null]), [3]);
assert.deepEqual(getAttachmentIds(null), []);

assert.equal(previewKind("image/jpeg"), "image");
assert.equal(previewKind("application/pdf; charset=binary"), "pdf");
assert.equal(previewKind("application/zip"), "download");
assert.equal(getAttachmentFileName({ fileName: "document.pdf" }), "document.pdf");
assert.equal(getAttachmentFileName({}), null);

assert.equal(formatDossierNumber(123456), "123456");
assert.equal(formatDossierNumber(" 123456 "), "123456");
assert.equal(formatDossierNumber(null), "Non renseigné");

function createElement(tagName) {
  return {
    tagName,
    children: [],
    attributes: {},
    dataset: {},
    append(...children) {
      this.children.push(...children);
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
}

const card = addAttachmentCard(
  { createElement },
  0,
  "justificatif.pdf",
  "blob:attachment",
  "application/pdf"
);
const frame = card.children[1].children[0];
const actionLinks = card.children[2].children;
assert.equal(frame.tagName, "iframe");
assert.equal(frame.src, "blob:attachment");
assert.equal(frame.loading, "lazy");
assert.equal(actionLinks[0].textContent, "Ouvrir dans un nouvel onglet");
assert.equal(actionLinks[0].target, "_blank");
assert.equal(actionLinks[0].attributes.download, undefined);
assert.equal(actionLinks[1].textContent, "Télécharger");
assert.equal(actionLinks[1].href, "blob:attachment");
assert.equal(actionLinks[1].attributes.download, "justificatif.pdf");

function makeDocument() {
  const elements = new Map(
    ["status", "attachments", "record-info", "dossier-number"].map((id) => [
      id,
      createElement("div"),
    ])
  );
  elements.get("attachments").replaceChildren = function (...children) {
    this.children = children;
  };
  return {
    elements,
    getElementById(id) {
      return elements.get(id);
    },
    createElement,
  };
}

async function testClearsDeletedSelectedRecord() {
  const document = makeDocument();
  let onRecord;
  let revokedObjectUrl = null;
  const grist = {
    ready() {},
    onRecord(callback) {
      onRecord = callback;
    },
    docApi: {
      async getAccessToken() {
        return {
          baseUrl: "https://grist.example/api/docs/doc/",
          token: "read-token",
        };
      },
    },
  };
  const fetchImpl = async (url) => {
    if (url.includes("/attachments/42?")) {
      return {
        ok: true,
        async json() {
          return { fileName: "document.pdf" };
        },
      };
    }
    return {
      ok: true,
      headers: { get: () => "application/pdf" },
      async blob() {
        return { type: "application/pdf" };
      },
    };
  };
  const urlApi = {
    createObjectURL: () => "blob:document",
    revokeObjectURL: (url) => {
      revokedObjectUrl = url;
    },
  };
  initialize(document, grist, fetchImpl, urlApi, { addEventListener() {} });

  await onRecord({ numero_dossier: 123, PJ: ["L", 42] });
  assert.equal(document.elements.get("attachments").children.length, 1);
  assert.equal(document.elements.get("record-info").hidden, false);
  assert.match(
    document.elements.get("attachments").children[0].children[1].children[0].src,
    /^blob:/
  );

  await onRecord(null);
  assert.equal(document.elements.get("attachments").children.length, 0);
  assert.equal(document.elements.get("record-info").hidden, true);
  assert.equal(revokedObjectUrl, "blob:document");
  assert.match(document.elements.get("status").textContent, /Sélectionnez une ligne/);
}

async function testAttachmentPreviewUsesGristAuthUrl() {
  const document = makeDocument();
  let onRecord;
  const requests = [];
  const grist = {
    ready() {},
    onRecord(callback) {
      onRecord = callback;
    },
    docApi: {
      async getAccessToken() {
        return {
          baseUrl: "https://grist.example/api/docs/doc/",
          token: "read-token",
        };
      },
    },
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.includes("/attachments/42?")) {
      return {
        ok: true,
        async json() {
          return { fileName: "document.pdf" };
        },
      };
    }
    return {
      ok: true,
      headers: { get: () => "application/pdf" },
      async blob() {
        return { type: "application/pdf" };
      },
    };
  };
  const urlApi = {
    createObjectURL: () => "blob:document",
    revokeObjectURL() {},
  };
  initialize(document, grist, fetchImpl, urlApi, { addEventListener() {} });

  await onRecord({ numero_dossier: 123, PJ: ["L", 42] });

  assert.equal(requests.length, 2);
  for (const request of requests) {
    const requestUrl = new URL(request.url);
    assert.equal(requestUrl.origin, "https://grist.example");
    assert.equal(requestUrl.searchParams.get("auth"), "read-token");
    assert.equal(request.options, undefined);
  }
  assert.equal(
    document.elements.get("attachments").children[0].children[0].textContent,
    "document.pdf"
  );
  assert.match(document.elements.get("status").textContent, /1 pièce jointe affichée/);
}

async function testIgnoresAccessTokenAfterSelectionChanges() {
  const document = makeDocument();
  let onRecord;
  let resolveAccessToken;
  const grist = {
    ready() {},
    onRecord(callback) {
      onRecord = callback;
    },
    docApi: {
      getAccessToken() {
        return new Promise((resolve) => {
          resolveAccessToken = resolve;
        });
      },
    },
  };
  const fetchImpl = async () => {
    throw new Error("Should not fetch after the selection changes");
  };
  initialize(
    document,
    grist,
    fetchImpl,
    { createObjectURL() {}, revokeObjectURL() {} },
    { addEventListener() {} }
  );

  const pendingPreview = onRecord({ numero_dossier: 123, PJ: ["L", 42] });
  await onRecord(null);
  resolveAccessToken({
    baseUrl: "https://grist.example/api/docs/doc/",
    token: "read-token",
  });
  await pendingPreview;

  assert.equal(document.elements.get("attachments").children.length, 0);
  assert.match(document.elements.get("status").textContent, /Sélectionnez une ligne/);
}

Promise.all([
  testClearsDeletedSelectedRecord(),
  testAttachmentPreviewUsesGristAuthUrl(),
  testIgnoresAccessTokenAfterSelectionChanges(),
])
  .then(() => {
    console.log("Suppression de la ligne sélectionnée : aperçu effacé.");
    console.log("Les pièces jointes sont prévisualisées dans des URL Blob.");
    console.log("Tests du widget de prévisualisation réussis.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
