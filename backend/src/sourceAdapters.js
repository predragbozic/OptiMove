// Read-only source adapters, selected by (source_system, apiFamily).
//
// A host key selects its profile (backend/src/sourceHosts.js); the profile's
// API family selects the adapter. An adapter is written for ONE family and
// is never reused for another by rewriting its paths: a family without an
// adapter answers adapter_not_available.
//
//   gpexe / rest_v1   backend/src/gpexeRestV1Adapter.js (server3)
//   gpexe / api       no adapter here. The e03 importer keeps its own client
//                     (backend/src/gpexeClient.js), unchanged.
import { resolveApprovedSourceHost } from "./sourceHosts.js";
import { createGpexeRestV1Adapter, SourceAdapterError } from "./gpexeRestV1Adapter.js";

const own = (object, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(object, key);

export const SOURCE_ADAPTERS = Object.freeze({
  gpexe: Object.freeze({
    rest_v1: createGpexeRestV1Adapter,
  }),
});

export function adapterFamilies(sourceSystem) {
  return own(SOURCE_ADAPTERS, sourceSystem) ? Object.keys(SOURCE_ADAPTERS[sourceSystem]) : [];
}

// One adapter for one connection: its host key with the key's own approved
// catalog row, the credential the caller already holds, and the source team
// the connection's binding names. Nothing here reads a request, a database
// or the environment.
export function createSourceAdapter({ sourceSystem, hostKey, catalogRow, credential, boundSourceTeamId, ...options } = {}) {
  const host = resolveApprovedSourceHost(sourceSystem, hostKey, catalogRow);
  const families = own(SOURCE_ADAPTERS, sourceSystem) ? SOURCE_ADAPTERS[sourceSystem] : null;
  const create = families && own(families, host.apiFamily) ? families[host.apiFamily] : null;
  if (!create) {
    throw new SourceAdapterError("adapter_not_available", "There is no read adapter for the API family this host speaks.", { apiFamily: host.apiFamily });
  }
  return create({ hostKey, catalogRow, credential, boundSourceTeamId, ...options });
}

export { SourceAdapterError };
