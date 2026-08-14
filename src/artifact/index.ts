export {
  Action,
  Checkpoint,
  Condition,
  FallbackLocator,
  LocatorDescriptor,
  LocatorScope,
  NameMatch,
  SCREEN_CHANGING_ACTIONS,
  STATE_CHANGING_ACTIONS,
  ValueRef,
  locatorsOf,
  locatorsOfCondition,
  resolveValueRef,
  valueRefsOf,
  valueRefsOfCondition,
  valueRefsOfLocator,
} from "./locator.js";

export {
  CapabilityArtifact,
  CapabilityArtifactShape,
  InputField,
  KnownOutcome,
  OutputField,
  Provenance,
  Recovery,
  ScalarType,
  Sensitivity,
  Step,
  Target,
  allLocators,
  sensitiveInputNames,
} from "./schema.js";

export {
  artifactJsonSchema,
  capabilityContract,
  type CapabilityContract,
  type JsonSchemaObject,
  type JsonSchemaProperty,
} from "./contract.js";

export {
  ArtifactValidationError,
  formatValidationErrors,
  loadArtifact,
  saveArtifact,
  serializeArtifact,
  validateArtifact,
  type ValidationError,
  type ValidationResult,
} from "./io.js";
