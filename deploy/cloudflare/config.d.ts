// The deployment's agentforeach.json, which wrangler.jsonc (or a generated config) aliases.
declare module "@agentforeach/config" {
  const config: Record<string, unknown>;
  export default config;
}
