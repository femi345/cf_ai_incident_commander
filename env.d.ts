/* eslint-disable */
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/server");
    durableNamespaces: "IncidentAgent";
  }
  interface Env {
    AI: Ai;
    IncidentAgent: DurableObjectNamespace<
      import("./src/server").IncidentAgent
    >;
  }
}
interface Env extends Cloudflare.Env {}
