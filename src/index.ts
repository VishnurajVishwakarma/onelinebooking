export { BookingError, getErrorCategory } from "./domain/errors.js";
export type { BookingErrorCategory, BookingErrorCode, BookingErrorOptions } from "./domain/errors.js";
export {
  generateAvailabilitySlots,
  generateCandidatesForBusinessDate,
  generateSlots,
  getEffectiveWindowsForBusinessDate,
  resolveWindowsForBusinessDate,
  validateScheduleOverlaps,
  validateSlotSelection,
} from "./domain/slot-generation.js";
export {
  assertAllocationTransition,
  assertBookingTransition,
  assertHoldTransition,
  effectiveHoldState,
  isHoldExpiredAt,
  isTerminalBookingStatus,
  isTerminalHoldState,
} from "./domain/state-machines.js";
export {
  computeRequestHash,
  decodeSlotRef,
  encodeSlotRef,
  enumerateLocalInstants,
  getCurrencyExponent,
  isSupportedCurrency,
  resolveLocalDateTime,
  resolveWindowBoundary,
} from "./domain/validation.js";
export type {
  Actor,
  ActorType,
  AllocationStatus,
  AvailabilityDiagnostic,
  AvailabilityResult,
  AvailabilitySlot,
  Blackout,
  BookingHistoryEntry,
  BookingListPage,
  BookingLogger,
  BookingMetrics,
  BookingStatus,
  BookingSummary,
  CancellationPolicy,
  Capability,
  ConfigurationMutationResult,
  ConfigurationWarning,
  ExceptionWindow,
  ExpireHoldsResult,
  Facility,
  HoldResult,
  HoldState,
  ISODate,
  ISODateTime,
  ObservabilityHooks,
  OccupiedInterval,
  OutboxEvent,
  OutboxEventStatus,
  PricingRule,
  RequestOptions,
  ReservationItem,
  ScheduleBreak,
  ScheduleException,
  ScheduleWindow,
  SelectionCheckResult,
  SlotOverride,
  SlotOverrideAction,
  SlotPolicy,
  Tenant,
  TenantContext,
  TenantStatus,
  TimeInterval,
  UUID,
} from "./domain/model.js";
export {
  ALL_ADMIN_CAPABILITIES,
  DEFAULT_CUSTOMER_CAPABILITIES,
  TenantBookingClient,
  TimeSlotEngine,
} from "./application/time-slot-engine.js";
export { TimeSlotBooking } from "./application/time-slot-booking.js";
export type {
  AvailabilityQueryInput,
  BookingStore,
  CancelBookingInput,
  CheckSelectionInput,
  ConvertHoldInput,
  CreateBlackoutInput,
  CreateDirectBookingInput,
  CreateFacilityInput,
  CreateHoldInput,
  CreateTenantInput,
  ListBookingsQuery,
  SetCancellationPolicyInput,
  SetPricingInput,
  SetScheduleExceptionInput,
  SetSlotOverrideInput,
  UpdateFacilityInput,
} from "./application/ports/booking-store.js";
export {
  createBookingPool,
  localStartToInstant,
  PostgresBookingStore,
} from "./infrastructure/postgres/postgres-booking-store.js";
export type { PostgresStoreOptions, TransactionTimingMetrics } from "./infrastructure/postgres/postgres-booking-store.js";
export { runMigrations } from "./infrastructure/postgres/migrator.js";

// Phase 6 Infrastructure Platform exports
export {
  ALL_PLATFORM_SCOPES,
  READONLY_PLATFORM_SCOPES,
  mapScopesToCapabilities,
} from "./platform/model.js";
export type {
  ApiKeyStatus,
  ApiKeySummary,
  AuthenticatedPrincipal,
  CreatedWebhookEndpoint,
  Environment,
  EnvironmentType,
  IssuedApiKey,
  Location,
  Organization,
  OrganizationMember,
  OrganizationRole,
  PlatformAuditLogEntry,
  PlatformScope,
  PlatformTenant,
  Project,
  RecordUsageInput,
  UsageMetric,
  UsageSummaryRow,
  WebhookDeliveryRecord,
  WebhookDeliveryStatus,
  WebhookEndpointSummary,
} from "./platform/model.js";
export { PlatformService, redactSecrets, sha256Hex } from "./platform/control-plane.js";
export {
  buildBudgetedPoolConfig,
  computeConnectionBudget,
} from "./platform/db/connection-budget.js";
export type { ConnectionBudgetInput, ConnectionBudgetPlan } from "./platform/db/connection-budget.js";
export { RuntimeTrafficLimiter } from "./platform/runtime/concurrency-limiter.js";
export type { LimiterOptions, LimiterStats, RateLimitDecision } from "./platform/runtime/concurrency-limiter.js";
export { OPENAPI_V1_SPEC } from "./platform/api/openapi.js";
export { createPlatformHttpServer } from "./platform/api/server.js";
export type { PlatformApiServerOptions } from "./platform/api/server.js";
export { HoldExpiryWorker } from "./platform/workers/hold-expiry-worker.js";
export type { HoldExpiryWorkerOptions } from "./platform/workers/hold-expiry-worker.js";
export {
  OutboxWebhookWorker,
  parseWebhookSignatureHeader,
  signWebhookPayload,
  verifyWebhookSignature,
} from "./platform/workers/outbox-webhook-worker.js";
export type { OutboxWebhookWorkerOptions, WebhookSignatureParts } from "./platform/workers/outbox-webhook-worker.js";
export {
  OneLineBookingApiError,
  OneLineBookingClient,
} from "./sdk/client.js";
export type {
  OneLineBookingClientOptions,
  OneLineBookingErrorEnvelope,
  SdkRequestOptions,
} from "./sdk/client.js";
// Phase 7 Security, Console Auth, Distributed Limiter & Telemetry exports
export { ConsoleAuthService } from "./platform/console-auth.js";
export type { ConsoleSessionContext, ConsoleUser, ProjectRole } from "./platform/console-auth.js";
export { PostgresDistributedLimiter } from "./platform/runtime/distributed-limiter.js";
export type { DistributedLimiterOptions } from "./platform/runtime/distributed-limiter.js";
export {
  PlatformMetricsRegistry,
  checkPlatformReadiness,
  resolveTraceContext,
  runSafeRetentionCleanup,
  sanitizeTelemetryObject,
  sanitizeTelemetryText,
} from "./platform/runtime/observability.js";
export type { ReadinessReport, RetentionCleanupResult, TraceContext } from "./platform/runtime/observability.js";
export {
  AwsKmsEnvelopeProvider,
  decryptSecret,
  decryptWithKmsEnvelope,
  encryptSecret,
  encryptWithKeyring,
  encryptWithKmsEnvelope,
  hashPassword,
  maskWebhookSecret,
  resolveMasterEncryptionKey,
  resolveMasterKeyring,
  verifyPassword,
} from "./platform/security/crypto.js";
export type { AwsKmsConfig, KmsEnvelopeClient, KmsKeyring } from "./platform/security/crypto.js";
export { SmtpEmailTransport } from "./platform/security/mailer.js";
export type { EmailMessage, EmailTransport } from "./platform/security/mailer.js";
export {
  BillingService,
  ManualInvoicingProvider,
  SandboxStripePaymentProvider,
} from "./platform/billing.js";
export type {
  BillingInvoice,
  BillingPlanVersion,
  BillingSubscription,
  LedgerEntryType,
  OveragePolicy,
  PaymentProviderAdapter,
  SubscriptionStatus,
} from "./platform/billing.js";
export {
  isRestrictedIpAddress,
  sendSsrfProtectedWebhookPost,
  validateWebhookUrlAndResolve,
} from "./platform/security/ssrf.js";
export type { SsrfValidationOptions, ValidatedWebhookTarget } from "./platform/security/ssrf.js";
