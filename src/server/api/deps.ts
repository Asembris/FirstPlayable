/**
 * What a route handler is allowed to reach.
 *
 * Both members are factories rather than values, so configuration is read and
 * the Supabase client is constructed *inside* the handler's try block. A
 * missing or malformed environment therefore becomes the redacted
 * `PERSISTENCE_UNAVAILABLE` envelope the studio knows how to show, rather than
 * a build failure or an unhandled exception — and `next build`, the landing
 * page, and `/example` never need a database at all.
 *
 * This indirection is also why the route handlers are testable: a test passes
 * an in-memory gateway and exercises the same origin checks, body caps, Zod
 * contracts, and ownership predicates the deployed runtime executes.
 */

import {
  budgetConfig,
  type BudgetConfig,
  qlooConfig,
  type QlooConfig,
  qlooEnv,
  type QlooEnv,
} from "../config";
import type { DataGateway } from "../db/gateway";
import { supabaseGateway } from "../db/supabase-gateway";
import type { ResponsesClient } from "../model/openai";
import type { QlooLaunchGuard } from "../qloo/client";

export type RouteDeps = {
  gateway: () => DataGateway;
  budget: () => BudgetConfig;
  /** Overridable only so a test can pin time. Production always uses the clock. */
  now?: () => Date;
};

/**
 * What a phase 3 route handler may reach.
 *
 * `qlooEnv` and `qloo` are factories for the same reason `gateway` is: a
 * missing or malformed environment must become the redacted
 * `PERSISTENCE_UNAVAILABLE` envelope the studio knows how to show, inside the
 * handler's try block, rather than a build failure.
 *
 * `fetchImpl` and `launchGuard` exist so a test can drive the real handlers,
 * the real Zod contracts, the real ownership predicates, and the real cache
 * over a deterministic transport. Production supplies neither, so it always
 * uses the global `fetch` and the database-backed limiter.
 */
export type Phase3Deps = RouteDeps & {
  qlooEnv: () => QlooEnv;
  qloo: () => QlooConfig;
  fetchImpl?: typeof fetch;
  launchGuard?: (gateway: DataGateway, config: QlooConfig) => QlooLaunchGuard;
  /**
   * Overridable only so a test can supply refusal, truncation, invalid-output,
   * and repair branches without a paid call. Production omits it, so the one
   * pinned client in `src/server/model/openai.ts` is always used.
   */
  modelClient?: ResponsesClient;
  /** Observes the judging-reserve signal, for the evidence record. */
  onReserveReached?: () => void;
};

export function liveDeps(): RouteDeps {
  return { gateway: supabaseGateway, budget: budgetConfig };
}

export function livePhase3Deps(): Phase3Deps {
  return {
    gateway: supabaseGateway,
    budget: budgetConfig,
    qlooEnv,
    qloo: qlooConfig,
  };
}
