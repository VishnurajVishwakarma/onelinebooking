import assert from "node:assert/strict";
import { OneLineBookingClient, verifyWebhookSignature } from "@onelinebooking/sdk/server";
import { OneLineBookingPublicClient } from "@onelinebooking/sdk/browser";

assert.equal(typeof OneLineBookingClient, "function");
assert.equal(typeof OneLineBookingPublicClient, "function");
assert.equal(typeof verifyWebhookSignature, "function");
console.log("ESM SDK import verified cleanly.");

