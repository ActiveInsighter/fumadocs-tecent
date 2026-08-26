import { isSafeServiceUrl } from './contracts';

export class IntegrationConfigurationError extends Error {
  constructor(readonly missing: readonly string[]) {
    super('Document publishing integration is not configured.');
    this.name = 'IntegrationConfigurationError';
  }
}

export interface DocumentIntegrationConfig {
  readonly pocketBaseUrl?: string;
  readonly n8nWebhookUrl?: string;
  readonly n8nWebhookSecret?: string;
  readonly fumadocsBlobUploadKey?: string;
  readonly blobSignerUrl?: string;
  readonly blobSignerSecret?: string;
  readonly blobDownloadGatewayUrl?: string;
  readonly blobDownloadGatewaySecret?: string;
}

const CONFIG_KEYS = {
  pocketBaseUrl: 'POCKETBASE_URL',
  n8nWebhookUrl: 'N8N_DOCUMENT_PUBLISH_URL',
  n8nWebhookSecret: 'N8N_DOCUMENT_PUBLISH_SECRET',
  fumadocsBlobUploadKey: 'FUMADOCS_BLOB_UPLOAD_KEY',
  blobSignerUrl: 'BLOB_SIGNER_URL',
  blobSignerSecret: 'BLOB_SIGNER_SECRET',
  blobDownloadGatewayUrl: 'BLOB_DOWNLOAD_GATEWAY_URL',
  blobDownloadGatewaySecret: 'BLOB_DOWNLOAD_GATEWAY_SECRET',
} as const;

export function readDocumentIntegrationConfig(
  source: Readonly<Record<string, string | undefined>> = process.env,
): DocumentIntegrationConfig {
  const urls = ['pocketBaseUrl', 'n8nWebhookUrl', 'blobSignerUrl', 'blobDownloadGatewayUrl'] as const;
  for (const field of urls) {
    const value = source[CONFIG_KEYS[field]]?.trim();
    if (value && !isSafeServiceUrl(value)) {
      throw new IntegrationConfigurationError([CONFIG_KEYS[field]]);
    }
  }

  const secrets = [
    'n8nWebhookSecret',
    'fumadocsBlobUploadKey',
    'blobSignerSecret',
    'blobDownloadGatewaySecret',
  ] as const;
  const shortSecrets = secrets
    .filter((field) => {
      const value = source[CONFIG_KEYS[field]]?.trim();
      return value !== undefined && value.length > 0 && value.length < 16;
    })
    .map((field) => CONFIG_KEYS[field]);
  if (shortSecrets.length > 0) throw new IntegrationConfigurationError(shortSecrets);

  const read = (field: keyof typeof CONFIG_KEYS): string | undefined => {
    const value = source[CONFIG_KEYS[field]]?.trim();
    return value || undefined;
  };

  return Object.freeze({
    pocketBaseUrl: read('pocketBaseUrl'),
    n8nWebhookUrl: read('n8nWebhookUrl'),
    n8nWebhookSecret: read('n8nWebhookSecret'),
    fumadocsBlobUploadKey: read('fumadocsBlobUploadKey'),
    blobSignerUrl: read('blobSignerUrl'),
    blobSignerSecret: read('blobSignerSecret'),
    blobDownloadGatewayUrl: read('blobDownloadGatewayUrl'),
    blobDownloadGatewaySecret: read('blobDownloadGatewaySecret'),
  });
}

export function requireConfig<T extends keyof DocumentIntegrationConfig>(
  config: DocumentIntegrationConfig,
  fields: readonly T[],
): { [K in T]-?: string } {
  const missing = fields
    .filter((field) => !config[field])
    .map((field) => CONFIG_KEYS[field]);
  if (missing.length > 0) throw new IntegrationConfigurationError(missing);

  return Object.fromEntries(fields.map((field) => [field, config[field]])) as {
    [K in T]-?: string;
  };
}

export function configKey(field: keyof typeof CONFIG_KEYS): string {
  return CONFIG_KEYS[field];
}
