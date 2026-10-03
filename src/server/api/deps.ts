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

import { budgetConfig, type BudgetConfig } from "../config";
import type { DataGateway } from "../db/gateway";
import { supabaseGateway } from "../db/supabase-gateway";

export type RouteDeps = {
  gateway: () => DataGateway;
  budget: () => BudgetConfig;
  /** Overridable only so a test can pin time. Production always uses the clock. */
  now?: () => Date;
};

export function liveDeps(): RouteDeps {
  return { gateway: supabaseGateway, budget: budgetConfig };
}
