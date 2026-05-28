import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const processAdapter: ServerAdapterModule = {
  type: "process",
  execute,
  testEnvironment,
  models: [],
  supportsScriptBundle: true,
  // Scripts call back into the Paperclip API to close their assigned task —
  // they need PAPERCLIP_API_KEY in env, which is only minted when this flag
  // is set.
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: `# process agent configuration

Adapter: process

Core fields:
- command (string, optional): command to execute. When omitted, the adapter
  runs the script bundle entry file (scriptEntryFile inside scriptBundleRoot).
- args (string[] | string, optional): command arguments
- cwd (string, optional): absolute working directory
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Script bundle:
- scriptBundleRoot (string, auto): absolute path to managed scripts folder
- scriptEntryFile (string, auto): relative entry script (default: run.sh)
`,
};
