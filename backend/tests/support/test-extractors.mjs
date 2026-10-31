// The suites written before phase 7f build their mappings on synthetic source
// fields ("<suite>.test.<id>") that the extractor registry does not read (J12,
// docs/ai/phase7f-extractor-registry-contract.md). allowSyntheticTestFields()
// lets those keys - and only those, the registry's own pattern - pass the
// registry check at version create and A1 with any parameters, so those
// suites keep testing what they test. The 7f suites never call it (the route
// suite sets the seam itself only to build two versions as made before 7f).
import { setExtractorFallbackForTests } from "../../src/sourceMetricExtractors.js";

const SYNTHETIC = Object.freeze({
  key: "synthetic test field", valueShape: null, parameterKind: null, zone: null, direction: null,
  checkParameters: () => null,
  extract: () => { throw new Error("A synthetic test field is never extracted."); },
});

export function allowSyntheticTestFields() {
  setExtractorFallbackForTests(() => SYNTHETIC);
}
