import { z } from "zod";

export const MCP_SERVER_TRANSPORTS = ["stdio", "streamable_http", "sse"] as const;

export const SECRET_REFERENCE_PATTERN = /^\$\{secret:([a-z0-9][a-z0-9_-]*)\}$/;

const slugRegex = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$|^[a-z0-9]$/;
const envKeyRegex = /^[A-Z_][A-Z0-9_]{0,127}$/;
const secretKeyRegex = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const httpsUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://") || value.startsWith("http://localhost"), {
    message: "OAuth URLs must use HTTPS (http://localhost allowed for dev)",
  });

export const mcpServerEnvValueSchema = z.union([
  z.string(),
  z.object({ kind: z.literal("literal"), value: z.string() }),
  z.object({ kind: z.literal("secret"), secretKey: z.string().regex(secretKeyRegex) }),
  z.object({ kind: z.literal("secret_inline"), value: z.string().min(1) }),
]);

const envRecordSchema = z
  .record(z.string(), mcpServerEnvValueSchema)
  .refine((value) => Object.keys(value).every((key) => envKeyRegex.test(key)), {
    message: "env keys must match ^[A-Z_][A-Z0-9_]*$",
  });

export const mcpOAuthConfigSchema = z
  .object({
    provider: z.string().min(1).max(64),
    /**
     * When true, client credentials and endpoints are discovered + registered
     * dynamically per OAuth 2.1 + RFC 7591 (Dynamic Client Registration) +
     * RFC 9728 (Protected Resource Metadata). The manual fields below are
     * optional in that mode — Paperclip resolves them from the MCP server's
     * `.well-known/oauth-protected-resource` endpoint.
     */
    dynamicRegistration: z.boolean().optional(),
    clientId: z.string().min(1).max(512).optional(),
    clientSecretRef: z
      .string()
      .regex(SECRET_REFERENCE_PATTERN, {
        message: "clientSecretRef must be a ${secret:...} reference",
      })
      .optional(),
    authorizationUrl: httpsUrlSchema.optional(),
    tokenUrl: httpsUrlSchema.optional(),
    revocationUrl: httpsUrlSchema.nullable().optional(),
    scopes: z.array(z.string().min(1).max(256)).max(64).optional(),
    audience: z.string().max(512).nullable().optional(),
    usePkce: z.boolean().optional(),
    redirectPath: z
      .string()
      .startsWith("/")
      .max(256)
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dynamicRegistration === true) {
      // DCR mode: only `provider` is strictly required; the rest is discovered.
      return;
    }
    // BYO mode: client_id, client_secret ref, and the two main endpoints are required.
    const required: Array<["clientId" | "clientSecretRef" | "authorizationUrl" | "tokenUrl", string]> = [
      ["clientId", "clientId is required unless dynamicRegistration is true"],
      ["clientSecretRef", "clientSecretRef is required unless dynamicRegistration is true"],
      ["authorizationUrl", "authorizationUrl is required unless dynamicRegistration is true"],
      ["tokenUrl", "tokenUrl is required unless dynamicRegistration is true"],
    ];
    for (const [field, message] of required) {
      if (!value[field]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
      }
    }
    if (!value.scopes || value.scopes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopes"],
        message: "at least one scope is required unless dynamicRegistration is true",
      });
    }
  });

export type McpOAuthConfig = z.infer<typeof mcpOAuthConfigSchema>;

const baseFields = {
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  command: z.string().min(0).max(255).optional(),
  args: z.array(z.string().max(1024)).max(64).optional(),
  url: z.string().url().max(2048).nullable().optional(),
  oauthConfig: mcpOAuthConfigSchema.nullable().optional(),
  env: envRecordSchema.optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
};

function validateTransportShape<
  T extends {
    transport?: string;
    command?: string;
    url?: string | null;
    oauthConfig?: McpOAuthConfig | null;
  },
>(value: T, ctx: z.RefinementCtx) {
  const transport = value.transport ?? "stdio";

  if (transport === "stdio") {
    if (!value.command || value.command.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "command is required when transport is stdio",
      });
    }
    if (value.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "url must be empty when transport is stdio",
      });
    }
    if (value.oauthConfig) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["oauthConfig"],
        message: "oauthConfig is only valid for streamable_http/sse transports",
      });
    }
  } else {
    if (!value.url || value.url.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "url is required when transport is streamable_http or sse",
      });
    }
  }
}

export const companyMcpServerCreateSchema = z
  .object({
    ...baseFields,
    key: z.string().regex(slugRegex).nullable().optional(),
    transport: z.enum(MCP_SERVER_TRANSPORTS).optional(),
  })
  .superRefine(validateTransportShape);

export const companyMcpServerUpdateSchema = z
  .object({
    name: baseFields.name.optional(),
    description: baseFields.description,
    command: baseFields.command,
    args: baseFields.args,
    url: baseFields.url,
    oauthConfig: baseFields.oauthConfig,
    env: baseFields.env,
    enabled: baseFields.enabled,
    metadata: baseFields.metadata,
    transport: z.enum(MCP_SERVER_TRANSPORTS).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.transport !== undefined) {
      validateTransportShape(value, ctx);
    }
  });

export const companyMcpServerTestSchema = z.object({
  timeoutMs: z.number().int().min(500).max(30_000).optional(),
});

export type CompanyMcpServerCreate = z.infer<typeof companyMcpServerCreateSchema>;
export type CompanyMcpServerUpdate = z.infer<typeof companyMcpServerUpdateSchema>;
export type CompanyMcpServerTest = z.infer<typeof companyMcpServerTestSchema>;

/**
 * Parses a template string of the form `${secret:my-key}`.
 * Returns the inner secret key, or null if the value is a literal.
 */
export function parseSecretReference(value: string): string | null {
  const match = value.match(SECRET_REFERENCE_PATTERN);
  return match ? match[1]! : null;
}

export function buildSecretReference(secretKey: string): string {
  if (!secretKeyRegex.test(secretKey)) {
    throw new Error(`Invalid secret key "${secretKey}"`);
  }
  return `\${secret:${secretKey}}`;
}
