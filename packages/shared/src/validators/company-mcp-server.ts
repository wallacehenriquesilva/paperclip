import { z } from "zod";

export const MCP_SERVER_TRANSPORTS = ["stdio"] as const;

export const SECRET_REFERENCE_PATTERN = /^\$\{secret:([a-z0-9][a-z0-9_-]*)\}$/;

const slugRegex = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$|^[a-z0-9]$/;
const envKeyRegex = /^[A-Z_][A-Z0-9_]{0,127}$/;
const secretKeyRegex = /^[a-z0-9][a-z0-9_-]{0,62}$/;

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

const baseFields = {
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  command: z.string().min(1).max(255),
  args: z.array(z.string().max(1024)).max(64).optional(),
  env: envRecordSchema.optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
};

export const companyMcpServerCreateSchema = z.object({
  ...baseFields,
  key: z.string().regex(slugRegex).nullable().optional(),
  transport: z.enum(MCP_SERVER_TRANSPORTS).optional(),
});

export const companyMcpServerUpdateSchema = z.object({
  name: baseFields.name.optional(),
  description: baseFields.description,
  command: baseFields.command.optional(),
  args: baseFields.args,
  env: baseFields.env,
  enabled: baseFields.enabled,
  metadata: baseFields.metadata,
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
