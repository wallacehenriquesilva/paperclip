import { describe, expect, it, vi } from "vitest";
import {
  discoverMcpOAuthEndpoints,
  discoverProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  registerDynamicClient,
} from "../services/mcp-oauth-discovery.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("mcp-oauth-discovery", () => {
  describe("discoverProtectedResourceMetadata", () => {
    it("fetches and parses .well-known/oauth-protected-resource at the origin", async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        jsonResponse({
          resource: "https://mcp.example.com/mcp",
          authorization_servers: ["https://auth.example.com"],
          scopes_supported: ["read", "write"],
        }),
      );

      const result = await discoverProtectedResourceMetadata("https://mcp.example.com/mcp", {
        fetchImpl: fetchImpl as any,
      });

      expect(result.authorization_servers).toEqual(["https://auth.example.com"]);
      expect(result.scopes_supported).toEqual(["read", "write"]);
      expect(result.metadata_url).toBe(
        "https://mcp.example.com/.well-known/oauth-protected-resource",
      );
    });

    it("falls back to /<path>/.well-known when origin-level doesn't respond", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response("not found", { status: 404 }))
        .mockResolvedValueOnce(
          jsonResponse({
            resource: "https://mcp.example.com/mcp",
            authorization_servers: ["https://auth.example.com"],
          }),
        );

      const result = await discoverProtectedResourceMetadata("https://mcp.example.com/mcp", {
        fetchImpl: fetchImpl as any,
      });

      expect(result.authorization_servers).toEqual(["https://auth.example.com"]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[1]![0]).toBe(
        "https://mcp.example.com/mcp/.well-known/oauth-protected-resource",
      );
    });

    it("throws when no candidate returns a valid metadata document", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));

      await expect(
        discoverProtectedResourceMetadata("https://mcp.example.com/mcp", {
          fetchImpl: fetchImpl as any,
        }),
      ).rejects.toThrow(/Could not discover oauth-protected-resource/);
    });
  });

  describe("discoverAuthorizationServerMetadata", () => {
    it("fetches RFC 8414 auth server metadata and exposes endpoints", async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        jsonResponse({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/oauth/authorize",
          token_endpoint: "https://auth.example.com/oauth/token",
          registration_endpoint: "https://auth.example.com/oauth/register",
          revocation_endpoint: "https://auth.example.com/oauth/revoke",
          scopes_supported: ["read", "write"],
          code_challenge_methods_supported: ["S256"],
        }),
      );

      const result = await discoverAuthorizationServerMetadata("https://auth.example.com", {
        fetchImpl: fetchImpl as any,
      });

      expect(result.authorization_endpoint).toBe("https://auth.example.com/oauth/authorize");
      expect(result.token_endpoint).toBe("https://auth.example.com/oauth/token");
      expect(result.registration_endpoint).toBe("https://auth.example.com/oauth/register");
      expect(result.revocation_endpoint).toBe("https://auth.example.com/oauth/revoke");
    });

    it("falls back to openid-configuration when oauth-authorization-server is missing", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 404 }))
        .mockResolvedValueOnce(
          jsonResponse({
            authorization_endpoint: "https://auth.example.com/oauth/authorize",
            token_endpoint: "https://auth.example.com/oauth/token",
          }),
        );

      const result = await discoverAuthorizationServerMetadata("https://auth.example.com", {
        fetchImpl: fetchImpl as any,
      });

      expect(result.authorization_endpoint).toBe("https://auth.example.com/oauth/authorize");
      expect(fetchImpl.mock.calls[1]![0]).toBe(
        "https://auth.example.com/.well-known/openid-configuration",
      );
    });

    it("throws when metadata is missing required endpoints", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ issuer: "x" }));

      await expect(
        discoverAuthorizationServerMetadata("https://auth.example.com", {
          fetchImpl: fetchImpl as any,
        }),
      ).rejects.toThrow(/Could not discover oauth-authorization-server/);
    });
  });

  describe("discoverMcpOAuthEndpoints (end-to-end)", () => {
    it("chains protected-resource + auth-server discovery", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            resource: "https://mcp.example.com/mcp",
            authorization_servers: ["https://auth.example.com"],
            scopes_supported: ["read"],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            authorization_endpoint: "https://auth.example.com/oauth/authorize",
            token_endpoint: "https://auth.example.com/oauth/token",
            registration_endpoint: "https://auth.example.com/oauth/register",
          }),
        );

      const result = await discoverMcpOAuthEndpoints("https://mcp.example.com/mcp", {
        fetchImpl: fetchImpl as any,
      });

      expect(result.authorizationEndpoint).toBe("https://auth.example.com/oauth/authorize");
      expect(result.tokenEndpoint).toBe("https://auth.example.com/oauth/token");
      expect(result.registrationEndpoint).toBe("https://auth.example.com/oauth/register");
      expect(result.scopesSupported).toEqual(["read"]);
    });

    it("throws when protected-resource has no authorization_servers", async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        jsonResponse({ resource: "https://mcp.example.com/mcp" }),
      );

      await expect(
        discoverMcpOAuthEndpoints("https://mcp.example.com/mcp", { fetchImpl: fetchImpl as any }),
      ).rejects.toThrow(/Could not discover/);
    });
  });

  describe("registerDynamicClient", () => {
    it("POSTs an RFC 7591 client registration body and parses the response", async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        jsonResponse({
          client_id: "registered-abc",
          client_secret: "shh",
          client_secret_expires_at: 0,
          scope: "read write",
          token_endpoint_auth_method: "client_secret_basic",
        }, 201),
      );

      const result = await registerDynamicClient(
        "https://auth.example.com/oauth/register",
        {
          redirectUris: ["https://paperclip.example/callback"],
          clientName: "Paperclip (notion)",
          scopes: ["read", "write"],
          tokenEndpointAuthMethod: "client_secret_basic",
        },
        { fetchImpl: fetchImpl as any },
      );

      expect(result.clientId).toBe("registered-abc");
      expect(result.clientSecret).toBe("shh");

      const [, init] = fetchImpl.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body).toMatchObject({
        redirect_uris: ["https://paperclip.example/callback"],
        client_name: "Paperclip (notion)",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_basic",
        scope: "read write",
      });
    });

    it("throws when the registration endpoint returns a non-2xx response", async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        new Response("client registration not allowed", { status: 403 }),
      );

      await expect(
        registerDynamicClient(
          "https://auth.example.com/oauth/register",
          {
            redirectUris: ["https://paperclip.example/callback"],
            clientName: "Paperclip",
          },
          { fetchImpl: fetchImpl as any },
        ),
      ).rejects.toThrow(/Dynamic client registration failed \(403\)/);
    });

    it("throws when the registration response is missing client_id", async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ scope: "read" }));

      await expect(
        registerDynamicClient(
          "https://auth.example.com/oauth/register",
          { redirectUris: ["https://paperclip.example/callback"], clientName: "Paperclip" },
          { fetchImpl: fetchImpl as any },
        ),
      ).rejects.toThrow(/missing required client_id/);
    });
  });
});
