/**
 * Object store port: the contract, its errors, and the providers that need
 * nothing but the web platform (`memory`, `s3`). The conformance suite is a
 * separate entry point, `@agentforeach/platform/objects/conformance`.
 */

export type { ObjectInfo, ObjectStore, GetObjectOptions, PutObjectOptions, SignedUrlOptions } from "./types.js";
export { MAX_SIGNED_URL_SECONDS } from "./types.js";
export {
  ObjectStoreError,
  isObjectNotFound,
  isObjectTooLarge,
  codeForStatus,
  assertValidKey,
  readCapped,
  signedUrlSeconds,
  type ObjectStoreErrorCode,
} from "./errors.js";
export { MemoryObjectStore, type MemoryObjectStoreOptions } from "./memory.js";
export { S3ObjectStore, type S3ObjectStoreOptions } from "./s3.js";
export { signRequest, presignUrl, type AwsCredentials, type SigningScope } from "./sigv4.js";
