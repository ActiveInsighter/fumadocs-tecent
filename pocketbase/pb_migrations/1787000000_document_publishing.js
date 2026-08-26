/* global Collection, migrate */

// Adds the owner-scoped document publishing state used by n8n and Fumadocs.
// This migration is additive; the existing workflow history collections stay intact.

const OWNER_RULE = '@request.auth.id != "" && owner = @request.auth.id';
const OWNER_CREATE_RULE =
  '@request.auth.id != "" && @request.body.owner = @request.auth.id';

function findCollection(app, name) {
  return app.findCollectionByNameOrId(name);
}

function ownerField(clients) {
  return {
    name: 'owner',
    type: 'relation',
    required: true,
    collectionId: clients.id,
    minSelect: 1,
    maxSelect: 1,
    cascadeDelete: true,
  };
}

function auditFields() {
  return [
    { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
    { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
  ];
}

function checksumField() {
  return {
    name: 'sourceChecksum',
    type: 'text',
    required: false,
    max: 64,
    pattern: '^$|^[a-f0-9]{64}$',
  };
}

function statusField(name, values) {
  return {
    name,
    type: 'select',
    required: true,
    maxSelect: 1,
    values,
  };
}

migrate(
  (app) => {
    const clients = findCollection(app, 'aw_clients');
    const messages = findCollection(app, 'aw_messages');

    let documents;
    try {
      documents = app.findCollectionByNameOrId('aw_documents');
    } catch {
      documents = new Collection({
        id: 'awdocuments0001',
        type: 'base',
        name: 'aw_documents',
        listRule: `${OWNER_RULE} && sourceMessage.owner = @request.auth.id`,
        viewRule: `${OWNER_RULE} && sourceMessage.owner = @request.auth.id`,
        createRule: `${OWNER_CREATE_RULE} && sourceMessage.owner = @request.auth.id`,
        updateRule: `${OWNER_RULE} && @request.body.owner:changed = false && @request.body.documentId:changed = false && sourceMessage.owner = @request.auth.id`,
        deleteRule: OWNER_RULE,
        fields: [
          ownerField(clients),
          {
            name: 'sourceMessage',
            type: 'relation',
            required: true,
            collectionId: messages.id,
            minSelect: 1,
            maxSelect: 1,
            cascadeDelete: true,
          },
          { name: 'documentId', type: 'text', required: true, min: 1, max: 128 },
          { name: 'slug', type: 'text', required: true, min: 1, max: 256, presentable: true },
          { name: 'title', type: 'text', required: true, min: 1, max: 512, presentable: true },
          { name: 'summary', type: 'text', required: false, max: 2_000 },
          { name: 'tags', type: 'json', required: false, maxSize: 16_384 },
          statusField('status', ['queued', 'processing', 'published', 'failed']),
          { name: 'version', type: 'number', required: true, min: 0, onlyInt: true },
          checksumField(),
          { name: 'fumadocsPath', type: 'text', required: false, max: 1_024 },
          { name: 'lastError', type: 'text', required: false, max: 8_192 },
          { name: 'publishedAt', type: 'date', required: false },
          ...auditFields(),
        ],
        indexes: [
          'CREATE UNIQUE INDEX idx_aw_documents_owner_document_id ON aw_documents (owner, documentId)',
          'CREATE INDEX idx_aw_documents_owner_status_updated ON aw_documents (owner, status, updated DESC, id DESC)',
          'CREATE INDEX idx_aw_documents_owner_published ON aw_documents (owner, publishedAt DESC, id DESC)',
        ],
      });
    }
    app.save(documents);

    let artifacts;
    try {
      artifacts = app.findCollectionByNameOrId('aw_document_artifacts');
    } catch {
      artifacts = new Collection({
        id: 'awdocarts000001',
        type: 'base',
        name: 'aw_document_artifacts',
        listRule: `${OWNER_RULE} && document.owner = @request.auth.id`,
        viewRule: `${OWNER_RULE} && document.owner = @request.auth.id`,
        createRule: `${OWNER_CREATE_RULE} && document.owner = @request.auth.id`,
        updateRule: `${OWNER_RULE} && @request.body.owner:changed = false && @request.body.document:changed = false && @request.body.version:changed = false && @request.body.format:changed = false && document.owner = @request.auth.id`,
        deleteRule: `${OWNER_RULE} && document.owner = @request.auth.id`,
        fields: [
          ownerField(clients),
          {
            name: 'document',
            type: 'relation',
            required: true,
            collectionId: documents.id,
            minSelect: 1,
            maxSelect: 1,
            cascadeDelete: true,
          },
          { name: 'version', type: 'number', required: true, min: 1, onlyInt: true },
          {
            name: 'format',
            type: 'select',
            required: true,
            maxSelect: 1,
            values: ['md', 'pdf'],
          },
          { name: 'blobKey', type: 'text', required: true, min: 1, max: 512 },
          { name: 'contentType', type: 'text', required: true, min: 1, max: 128 },
          { name: 'byteSize', type: 'number', required: true, min: 1, onlyInt: true },
          {
            name: 'checksum',
            type: 'text',
            required: true,
            max: 64,
            pattern: '^[a-f0-9]{64}$',
          },
          statusField('status', ['uploaded', 'published', 'failed']),
          { name: 'downloadPath', type: 'text', required: true, min: 1, max: 2_048 },
          ...auditFields(),
        ],
        indexes: [
          'CREATE UNIQUE INDEX idx_aw_doc_artifacts_version_format ON aw_document_artifacts (document, version, format)',
          'CREATE INDEX idx_aw_doc_artifacts_owner_updated ON aw_document_artifacts (owner, updated DESC, id DESC)',
        ],
      });
    }
    app.save(artifacts);
  },
  (app) => {
    for (const name of ['aw_document_artifacts', 'aw_documents']) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch {
        // Down migrations are safe when an optional collection was not created.
      }
    }
  },
);
