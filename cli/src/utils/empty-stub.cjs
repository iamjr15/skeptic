// Empty stub aliased in for `react-devtools-core` (used only by Ink's
// dev-tools path, which is gated behind `process.env.DEV === "true"` and is
// not relevant to the production bundle). Without this alias, the bundler
// preserves the import and the runtime fails with ERR_MODULE_NOT_FOUND.
module.exports = {};
module.exports.connectToDevTools = () => {};
module.exports.default = {};
