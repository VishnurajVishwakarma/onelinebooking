const assert = require("node:assert/strict");
const { OneLineBookingClient, verifyWebhookSignature } = require("@onelinebooking/sdk/server");
const { OneLineBookingPublicClient } = require("@onelinebooking/sdk/browser");

assert.equal(typeof OneLineBookingClient, "function");
assert.equal(typeof OneLineBookingPublicClient, "function");
assert.equal(typeof verifyWebhookSignature, "function");
console.log("CJS SDK require verified cleanly.");

