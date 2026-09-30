// Identifier rules shared by the API and the registries.

// Blueprint and workspace names: one DNS label.
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Blueprint versions: letters, digits, dots, plus and hyphen, e.g. 1.2.0-rc.1.
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
// Capabilities: <provider>:<resource>:<verb>, where the resource may itself
// contain slashes and colons, e.g. github:repo/acme/api:read.
const CAPABILITY = /^[a-z0-9-]+:[^\s]+:[a-z]+$/;
const DIGEST = /^[0-9a-f]{64}$/;

export const isName = (s: unknown): s is string => typeof s === "string" && NAME.test(s);
export const isVersion = (s: unknown): s is string => typeof s === "string" && VERSION.test(s);
export const isCapability = (s: unknown): s is string =>
  typeof s === "string" && s.length <= 256 && CAPABILITY.test(s);
export const isDigest = (s: unknown): s is string => typeof s === "string" && DIGEST.test(s);

// A new cell id: "c" and 12 base32 characters, a valid DNS label.
export function newCellId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return "c" + [...bytes].map((b) => alphabet[b & 31]).join("");
}
