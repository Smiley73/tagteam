// Whether the repository uses Codex, read off a parsed configuration. The one
// home of the answer: a caller never reads `config.useCodex` for itself. Its own
// file so that a driver can take it without importing the configuration validator.
export const usesCodex = (config) => config?.useCodex === true;
