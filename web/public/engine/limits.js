// Shared limits. Vercel Functions accept and return at most 4.5 MB per request,
// so the server converts small files and the browser converts larger ones.
export const MB = 1048576;
export const SERVER_LIMIT = 4 * MB;            // max request/response body we send through the API
export const SCHEMA_OVERHEAD = 0.35 * MB;      // 2004 schema set + pages + zip headers, per bundle
export const BROWSER_MAX = 1024 * MB;          // in-browser conversion cap (memory)
export const ZIP_LIMITS_SERVER = { maxEntries: 2000, maxTotal: 12 * MB };
export const ZIP_LIMITS_BROWSER = { maxEntries: 5000, maxTotal: 1500 * MB };

/** Rough size of the response bundle: each package holds the input once, the bundle holds every package. */
export const estimateBundle = (inputBytes, versions) => inputBytes * versions + SCHEMA_OVERHEAD;
export const fitsServer = (inputBytes, versions) => inputBytes < SERVER_LIMIT && estimateBundle(inputBytes, versions) < SERVER_LIMIT;
