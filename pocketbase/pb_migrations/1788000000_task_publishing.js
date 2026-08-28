/* global Collection, TextField, SelectField, JSONField, RelationField, migrate */

// Task-level publishing schema: publish jobs, AI metadata fields with frozen
// publish keys, and aw_documents upgraded from message-only pages to
// task/event/act/message pages. This migration is additive.

const OWNER_RULE = '@request.auth.id != "" && owner = @request.auth.id';
const OWNER_CREATE_RULE =
  '@request.auth.id != "" && @request.body.owner = @request.auth.id';

const PUBLISH_KEY_PATTERN = '^$|^[a-z0-9]+(?:-[a-z0-9]+)*$';

function findCollection(app, name) {
  return app.findCollectionByNameOrId(name);
}

// `collection.fields.push()` requires core.Field instances; plain objects are
// only converted inside `new Collection({...})`.
function addField(collection, field) {
  if (collection.fields.some((existing) => existing.name === field.name)) return;
  collection.fields.push(field);
}

function textField(name, max, pattern) {
  return new TextField({ name, required: false, max, pattern: pattern || '' });
}

function autoSummaryField() {
  return textField('autoSummary', 2_000);
}

function publishKeyField() {
  return textField('publishKey', 128, PUBLISH_KEY_PATTERN);
}

function autoSlugField() {
  return textField('autoSlug', 96, PUBLISH_KEY_PATTERN);
}

function autoTitleField() {
  return textField('autoTitle', 512);
}

function jsonTagsField() {
  return new JSONField({ name: 'autoTags', required: false, maxSize: 16_384 });
}

function selectField(name, values, required) {
  return new SelectField({
    name,
    required: required !== false,
    maxSelect: 1,
    values,
  });
}

function relationField(name, collectionId, cascadeDelete) {
  return new RelationField({
    name,
    required: false,
    collectionId,
    minSelect: 0,
    maxSelect: 1,
    cascadeDelete,
  });
}

function auditFields() {
  return [
    { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
    { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
  ];
}

function backfillSelect(app, collectionName, field, value) {
  const records = app.findRecordsByFilter(collectionName, "id != ''", '-created', 0, 0);
  for (const record of records) {
    if (!record.get(field)) {
      record.set(field, value);
      app.save(record);
    }
  }
}

migrate(
  (app) => {
    const clients = findCollection(app, 'aw_clients');
    const tasks = findCollection(app, 'aw_tasks');
    const events = findCollection(app, 'aw_events');
    const acts = findCollection(app, 'aw_acts');
    const documents = findCollection(app, 'aw_documents');
    const artifacts = findCollection(app, 'aw_document_artifacts');

    let jobs;
    try {
      jobs = findCollection(app, 'aw_publish_jobs');
    } catch {
      jobs = new Collection({
        id: 'awpublishjobs01',
        type: 'base',
        name: 'aw_publish_jobs',
        listRule: OWNER_RULE,
        viewRule: OWNER_RULE,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            name: 'owner',
            type: 'relation',
            required: true,
            collectionId: clients.id,
            minSelect: 1,
            maxSelect: 1,
            cascadeDelete: true,
          },
          {
            name: 'task',
            type: 'relation',
            required: true,
            collectionId: tasks.id,
            minSelect: 1,
            maxSelect: 1,
            cascadeDelete: true,
          },
          { name: 'version', type: 'number', required: true, min: 1, onlyInt: true },
          { name: 'buildMd', type: 'bool', required: false },
          { name: 'buildPdf', type: 'bool', required: false },
          {
            name: 'sourceChecksum',
            type: 'text',
            required: false,
            max: 64,
            pattern: '^$|^[a-f0-9]{64}$',
          },
          {
            name: 'status',
            type: 'select',
            required: true,
            maxSelect: 1,
            values: [
              'queued',
              'snapshotting',
              'building',
              'uploading',
              'committing',
              'published',
              'failed',
            ],
          },
          { name: 'totalDocuments', type: 'number', required: false, min: 0, onlyInt: true },
          { name: 'completedDocuments', type: 'number', required: false, min: 0, onlyInt: true },
          { name: 'startedAt', type: 'date', required: false },
          { name: 'publishedAt', type: 'date', required: false },
          { name: 'lastError', type: 'text', required: false, max: 8_192 },
          ...auditFields(),
        ],
        indexes: [
          'CREATE UNIQUE INDEX idx_aw_publish_jobs_task_version ON aw_publish_jobs (task, version)',
          'CREATE INDEX idx_aw_publish_jobs_owner_status ON aw_publish_jobs (owner, status, updated DESC, id DESC)',
          'CREATE INDEX idx_aw_publish_jobs_task_status ON aw_publish_jobs (task, status, updated DESC, id DESC)',
        ],
      });
    }
    app.save(jobs);

    // Task metadata fields: AI values, manual overrides, frozen publish key.
    addField(tasks, selectField('metadataStatus', ['pending', 'processing', 'ready', 'failed']));
    addField(tasks, autoTitleField());
    addField(tasks, autoSlugField());
    addField(tasks, autoSummaryField());
    addField(tasks, jsonTagsField());
    addField(tasks, textField('manualTitle', 512));
    addField(tasks, textField('manualSummary', 2_000));
    addField(tasks, publishKeyField());
    addField(tasks, textField('metadataError', 8_192));
    app.save(tasks);

    for (const collection of [events, acts]) {
      addField(collection, autoTitleField());
      addField(collection, autoSlugField());
      addField(collection, autoSummaryField());
      addField(collection, publishKeyField());
      app.save(collection);
    }

    const messages = findCollection(app, 'aw_messages');
    addField(messages, autoTitleField());
    addField(messages, autoSlugField());
    addField(messages, autoSummaryField());
    addField(messages, jsonTagsField());
    addField(messages, publishKeyField());
    app.save(messages);

    // aw_documents: from message-only pages to task/event/act/message pages.
    const sourceMessage = documents.fields.find((field) => field.name === 'sourceMessage');
    if (sourceMessage) sourceMessage.required = false;
    documents.listRule = `${OWNER_RULE} && (sourceMessage = "" || sourceMessage.owner = @request.auth.id)`;
    documents.viewRule = documents.listRule;
    documents.createRule = `${OWNER_CREATE_RULE} && (sourceMessage = "" || sourceMessage.owner = @request.auth.id)`;
    documents.updateRule = `${OWNER_RULE} && @request.body.owner:changed = false && @request.body.documentId:changed = false && (sourceMessage = "" || sourceMessage.owner = @request.auth.id)`;
    documents.deleteRule = OWNER_RULE;
    addField(documents, selectField('kind', ['task', 'event', 'act', 'message']));
    addField(documents, relationField('publishJob', jobs.id, false));
    addField(documents, relationField('task', tasks.id, true));
    addField(documents, relationField('event', events.id, false));
    addField(documents, relationField('act', acts.id, false));
    addField(documents, publishKeyField());
    app.save(documents);

    addField(artifacts, relationField('publishJob', jobs.id, false));
    app.save(artifacts);

    backfillSelect(app, 'aw_tasks', 'metadataStatus', 'pending');
    backfillSelect(app, 'aw_documents', 'kind', 'message');
  },
  (app) => {
    const removeFields = (collectionName, fieldNames) => {
      try {
        const collection = findCollection(app, collectionName);
        const keep = [];
        for (const field of collection.fields) {
          if (!fieldNames.includes(field.name)) keep.push(field);
        }
        collection.fields = keep;
        app.save(collection);
      } catch {
        // Down migrations are safe when a collection was not present.
      }
    };

    removeFields('aw_tasks', [
      'metadataStatus',
      'autoTitle',
      'autoSlug',
      'autoSummary',
      'autoTags',
      'manualTitle',
      'manualSummary',
      'publishKey',
      'metadataError',
    ]);
    removeFields('aw_events', ['autoTitle', 'autoSlug', 'autoSummary', 'publishKey']);
    removeFields('aw_acts', ['autoTitle', 'autoSlug', 'autoSummary', 'publishKey']);
    removeFields('aw_messages', [
      'autoTitle',
      'autoSlug',
      'autoSummary',
      'autoTags',
      'publishKey',
    ]);
    removeFields('aw_documents', ['kind', 'publishJob', 'task', 'event', 'act', 'publishKey']);
    removeFields('aw_document_artifacts', ['publishJob']);

    try {
      const documents = findCollection(app, 'aw_documents');
      const sourceMessage = documents.fields.find((field) => field.name === 'sourceMessage');
      if (sourceMessage) sourceMessage.required = true;
      app.save(documents);
    } catch {
      // Ignore when aw_documents is absent.
    }

    try {
      app.delete(findCollection(app, 'aw_publish_jobs'));
    } catch {
      // Ignore when aw_publish_jobs is absent.
    }
  },
);
