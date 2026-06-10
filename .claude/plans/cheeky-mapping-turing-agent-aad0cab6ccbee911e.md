# Multi-Objective Dynamic Scheduling with Manual Route Locking
## Implementation Plan

---

## 1. Data Model Changes

### 1.1 State Object - New Fields (app.js, line 10-42)

Add to the existing state object inside the IIFE closure:

- **objective** (string, default shortest_distance): Current optimization objective key
- **lockedRoutes** (Set of strings): Route IDs locked from recalculation
- **coldChainOrderIds** (Set of strings): Populated from data.json on load
- **animationFrame** (number or null): requestAnimationFrame ID for pulsing markers
- **pulsePhase** (number, 0-1): Animation cycle phase for pulsing

### 1.2 Route Object - New Fields

Each route object (worker.js buildRoutes, line 162-173) gains:

| Field | Type | Default | Purpose |
|---|---|---|---|
| locked | boolean | false | Locked from recalculation |
| stopETAs | Array of {orderId, eta} | [] | Arrival time at each stop |
| violationReasons | Array of {orderId, reason, delay} | [] | WHY violated |

The locked field is set by the main thread, not the worker. When receiving ROUTES_RESULT or RECALC_RESULT, the main thread applies locked:true to any route whose id is in state.lockedRoutes.

### 1.3 Order Object - New Field

| Field | Type | Default | Purpose |
|---|---|---|---|
| coldChain | boolean | false (absent=false) | Cold chain required |

### 1.4 Unassigned Item - Enhanced Shape

Current: { order, reasons: string[] }
Enhanced: { order, reasons: string[], reasonCodes: string[], suggestion: string or null }

---

## 2. data.json Changes

### 2.1 Add coldChain Flag to 5 Orders

- ORD001 (WH01, DP01, 800kg, priority 1) -> coldChain: true
- ORD008 (WH01, DP08, 1100kg, priority 1) -> coldChain: true
- ORD017 (WH02, DP17, 1500kg, priority 1) -> coldChain: true
- ORD022 (WH01, DP07, 550kg, priority 1) -> coldChain: true
- ORD019 (WH02, DP19, 600kg, priority 2) -> coldChain: true

### 2.2 No Other Changes

All warehouses, delivery points, drivers, and vehicles remain unchanged. The coldChain field is backward-compatible.

---

## 3. index.html Changes

### 3.1 Optimization Objective Selector

Insert after the strategy select (after line 51), before departure time selector. A new form-group div with label and select id=objective and 5 options: shortest_distance, least_overtime, load_balance, driver_fairness, cold_chain_priority.

### 3.2 Legend Additions

After existing legend items (after line 106), add 3 entries: cold chain (blue dot), locked route (yellow dot), violation (red dot).

---

## 4. style.css Changes

### 4.1 New CSS Custom Properties

Add to :root after line 30: --cold-chain: #38bdf8; --locked-bg: rgba(245,158,11,0.15); --locked-border: #f59e0b;

### 4.2 New CSS Classes (~120 lines)

**Lock button (.lock-btn, .lock-btn.locked)**: Toggle in route header. Default: muted. Locked: amber tint, warning border.

**Locked card (.route-card.locked)**: Amber border, amber bg tint, header amber overlay.

**Capacity bar (.capacity-bar-container, .capacity-bar-fill)**: 6px bar. Colors: .low(green,0-60%), .medium(yellow,60-85%), .high(red,85-100%), .over(red+pulse).

**Cold chain badge (.cold-chain-badge)**: Inline-flex, 10px, light blue, blue tint bg. .order-item.cold-chain adds left blue border.

**ETA (.order-eta, .order-eta.violated)**: 10px, info color. Violated: danger+bold.

**Violation reason (.violation-reason)**: 10px, muted, italic.

**Unassigned suggestion (.unassigned-suggestion)**: 11px, info color, info-tinted bg, left info border.

**Legend dots**: .cold-chain(blue), .locked-route(yellow), .violation(red).

**Route header actions (.route-header-actions)**: Flexbox, center, 6px gap.
---

## 5. worker.js Changes

### 5.1 New Message Handler: INCREMENTAL_COMPUTE

Add after RECALCULATE_ROUTES handler (line 25). Receives: lockedRoutes, allOrders, unlockedRouteSlots, warehouses, deliveryPoints, drivers, vehicles, strategy, startTime, objective, routeVersion, requestId. Calls incrementalCompute(). Posts INCREMENTAL_RESULT.

### 5.2 Thread objective Through Existing Pipeline

- **computeRoutes()** line 32: Add objective to destructured params, default shortest_distance
- **buildRoutes()** line 156: Accept objective, pass to assignWarehouseOrders()
- **assignWarehouseOrders()** line 199: Accept objective + allRoutes ref, pass to calculateAssignmentScore()
- **sortOrdersByStrategy()** line 129: Accept objective. When cold_chain_priority, pre-sort cold chain orders first

### 5.3 Rewrite calculateAssignmentScore() - Multi-Objective

The existing function (lines 248-295) uses distance, time window overlap, strategy, overload penalty. Rewrite adds objective and allRoutes parameters.

**shortest_distance**: Distance already primary. Add weight preference (order.weight * 0.3).

**least_overtime**: Call estimateRouteTimeWithOrder(). If exceeds driver.maxHours: +2000. If exceeds 80%: +800. Bonus for time budget remaining (-timeBudget * 30).

**load_balance**: Quadratic penalty (currentLoadRate^2 * 1000). Bonus (-300) if projected below fleet average.

**driver_fairness**: Compare driving time to fleet avg. Above avg: penalty (aboveAvg * 500). Below avg: bonus (belowAvg * 100).

**cold_chain_priority**: Cold chain orders: -2000 bonus. Fast vehicles (speed>=50): -500. Fewer stops preferred: +route.orders.length * 200.

Strategy-specific adjustments remain as secondary factor after objective.

### 5.4 New Helper: estimateRouteTimeWithOrder(route, newOrder, dpMap, warehouse)

Simulates appending newOrder: warehouse->stops->warehouse distance, driving+rest+service time. Returns total hours.

### 5.5 Enhance finalizeRoute() - ETA per Stop + Violation Reasons

In the time window violation loop (lines 387-415):
- Build route.stopETAs: push {orderId, eta} for each stop
- Build route.violationReasons: when violation detected, call determineViolationReason(), push {orderId, reason, delay}

### 5.6 New Helper: determineViolationReason()

Analyzes WHY violated. Checks 5 reasons:
1. Late departure (startTime > 9)
2. Cumulative delay from prior stops (orderIndex > 0)
3. Long travel (travelTime > 2h)
4. Narrow time window (windowWidth <= 2h)
5. Prior stop wait consumed budget

Returns Chinese string joining applicable reasons with semicolons.

Also add formatWorkerTime(hours) for HH:MM formatting.

### 5.7 New Function: incrementalCompute(payload)

Core algorithm:
1. Build dpMap/whMap
2. Collect lockedOrderIds Set from lockedRoutes orders
3. Re-finalize locked routes, mark locked:true
4. Filter allOrders excluding lockedOrderIds -> availableOrders
5. Validate available orders (reuse validateOrder)
6. Build empty route slots from unlockedRouteSlots (preserve vehicle/driver)
7. Sort by strategy (objective-aware), group by warehouse
8. Run assignWarehouseOrders() with objective per warehouse
9. Finalize unlocked routes
10. Collect unassigned with enhanced reasons and suggestions
11. Merge locked + unlocked routes, calculate stats
12. Return { routes, unassigned, stats }
---

## 6. app.js Changes

### 6.1 State Object (line 10-42)
Add 5 new fields: objective, lockedRoutes, coldChainOrderIds, animationFrame, pulsePhase.

### 6.2 cacheDom() (line 47-87)
Add: dom.objective = document.getElementById("objective")

### 6.3 loadData() (line 141-156)
After state.data = data, populate coldChainOrderIds Set from orders where coldChain is true.

### 6.4 bindEvents() (line 183-217)
Add objective selector change handler: update state.objective, clear locks, recompute if routes exist.
Add debounced vehicle count slider: 500ms debounce, clear locks, recompute.

### 6.5 initWorker() (line 112-126)
Add INCREMENTAL_RESULT branch in onmessage, calls handleIncrementalResult().

### 6.6 startComputation() (line 535-569)
Clear state.lockedRoutes on full recompute. Add objective: state.objective to worker payload.

### 6.7 handleRoutesResult() (line 572-598)
After setting state.routes, apply lock flags. Call startPulseAnimation() if violations.

### 6.8 New: handleIncrementalResult(payload)
Stale-result guards (requestId + routeVersion). Sets state.routes/unassigned/stats. Re-applies locks. Calls recalcGlobalStats, updateStatsBar, renderRouteList, renderUnassigned, renderCanvas. Starts pulse animation.

### 6.9 Rewrite createRouteCard() (line 659-738)
- Read lock state from state.lockedRoutes.has(route.id)
- Add locked CSS class + data-route-id attribute
- Insert lock/unlock button in header (lock emoji unicode)
- Insert capacity utilization bar (6px, color-coded low/medium/high/over)
- Build etaMap from route.stopETAs, violationReasonMap from route.violationReasons
- Show violation reasons inline under each violation
- Pass ETA + coldChain flag to createOrderItemHTML()
- Bind lock button click to toggleRouteLock()

### 6.10 Rewrite createOrderItemHTML() (line 740-752)
New signature: (order, routeIndex, eta, isColdChain)
- cold-chain class on li when isColdChain
- Snowflake + text badge for cold chain
- ETA span with order-eta class (violated class if eta > timeWindowEnd)

### 6.11 New: toggleRouteLock(routeId)
Toggle routeId in/out of state.lockedRoutes Set. Update route.locked. Re-render routeList + canvas. Toast.

### 6.12 Modify moveOrderBetweenRoutes() (line 796-881)
After local move + recalc: if lockedRoutes.size > 0 call triggerIncrementalCompute(), else send RECALCULATE_ROUTES.

### 6.13 New: triggerIncrementalCompute()
Build lockedRoutes data + unlockedRouteSlots arrays. Guard: if all locked, toast + return. Post INCREMENTAL_COMPUTE. Increment computeRequestId + routeVersion.

### 6.14 Modify drawRoutes() (line 476-532)
- Locked routes: setLineDash([]) solid, lineWidth 3.5
- Unlocked: setLineDash([6,4]) dashed (existing)
- Lock emoji at midpoint of first segment for locked routes

### 6.15 New: drawViolationMarkers(ctx)
Pulsing red circles at violation delivery points. pulsePhase modulates radius (10-16px) + alpha. Warning triangle above.

### 6.16 New: drawColdChainMarkers(ctx)
Snowflake character at delivery points with cold chain orders.

### 6.17 Modify renderCanvas() (line 368-395)
After drawRoutes: call drawViolationMarkers + drawColdChainMarkers.

### 6.18 New: Animation Loop
startPulseAnimation(): rAF loop, pulsePhase += 0.02/frame, render when violations exist.
stopPulseAnimation(): cancel rAF.
hasAnyViolations(): boolean check.

### 6.19 Modify renderUnassigned() (line 1001-1020)
Make items draggable (state.dragSourceRoute = null). Show cold chain badge. Show suggestion div.

### 6.20 Modify onOrderDrop() (line 782-794)
When dragSourceRoute === null: call assignUnassignedToRoute().

### 6.21 New: assignUnassignedToRoute(orderId, targetRouteIndex)
Find in unassigned pool. Check capacity. Remove from unassigned, add to route. Local recalc. Re-render. Trigger worker recalc (incremental if locks).

### 6.22 Modify exportPlan() (line 1096-1138)
Add: objective, lockedRouteIds, per-route routeId/locked/violationReasons/stopETAs.

### 6.23 Modify savePlan()/loadPlan() (line 1140-1206)
Save: lockedRoutes array + objective. Load: restore Set + objective + selector value + apply locks.

### 6.24 Modify applyImportedData() (line 1064-1094)
Clear lockedRoutes. Repopulate coldChainOrderIds from imported data.
---

## 7. Edge Case Handling

### 7.1 Continuous Vehicle Count Adjustment
Debounce slider with 500ms delay. Clear lockedRoutes (route IDs become invalid when vehicle count changes). Existing computeRequestId mechanism discards stale results automatically.

### 7.2 Recalc After Locking Routes
Locking does NOT trigger recalculation. It only sets a flag in state.lockedRoutes. The next user action (drag, recompute, vehicle count change) respects the lock. Avoids unnecessary computation.

### 7.3 Expired routeVersion Handling
handleIncrementalResult() uses the same stale-result guard: discard if payload.routeVersion < state.routeVersion. Also check requestId for INCREMENTAL_RESULT messages.

### 7.4 Overloaded Orders (Weight > Remaining Capacity)
Both moveOrderBetweenRoutes() and assignUnassignedToRoute() enforce: toRoute.totalWeight + order.weight > toRoute.vehicle.capacity check. Error toast shown. Applies equally to locked and unlocked target routes.

### 7.5 Time Window Conflicts After Manual Assignment
Existing warning simulation (lines 816-845) simulates the move and detects new violations. Works for locked routes too. Warnings shown as toasts but move is allowed (user intent). Worker provides authoritative recalculation.

### 7.6 Export Consistency
Export includes: lockedRouteIds, objective, per-route locked flag and routeId. state.routes is always up-to-date with local recalcs, so exported data accurately reflects current state.

### 7.7 All Routes Locked
Guard in triggerIncrementalCompute(): if unlockedRouteSlots.length === 0, show toast and skip worker call. User sees clear message.

### 7.8 Drag Between Two Locked Routes
Allow local move. Recalc both via localRecalcRoute(). Skip worker call (both locked, nothing to optimize). Re-render UI.

### 7.9 Cold Chain Orders in Unassigned Pool
Worker sets suggestion field to cold-chain-specific advice (e.g., add refrigerated vehicles or relax time windows). UI renders in highlighted suggestion box.

---

## 8. Implementation Order

### Phase 1: Data Layer (No UI Impact)
1. data.json - Add coldChain: true to 5 orders
2. app.js state - Add 5 new fields
3. app.js loadData() - Populate coldChainOrderIds

### Phase 2: Worker Multi-Objective Scoring
4. worker.js - Thread objective through computeRoutes/buildRoutes/assignWarehouseOrders
5. worker.js - Rewrite calculateAssignmentScore() with 5 objective branches
6. worker.js - Add estimateRouteTimeWithOrder() helper
7. worker.js - Modify sortOrdersByStrategy() for cold chain pre-sort
8. app.js startComputation() - Pass objective in worker message
9. app.js bindEvents() - Add objective selector handler

### Phase 3: Enhanced Worker Output
10. worker.js finalizeRoute() - Add stopETAs and violationReasons
11. worker.js - Add determineViolationReason() and formatWorkerTime()
12. worker.js - Enhance unassigned with reasonCodes and suggestion

### Phase 4: Route Locking UI + Logic
13. index.html - Add objective selector and legend items
14. style.css - Add all new CSS (~120 lines)
15. app.js cacheDom() - Add dom.objective
16. app.js createRouteCard() - Lock button, capacity bar, ETA, cold chain markers
17. app.js createOrderItemHTML() - ETA display, cold chain badge
18. app.js - Add toggleRouteLock()

### Phase 5: Canvas Visual Enhancements
19. app.js drawRoutes() - Solid vs dashed lines, lock icon
20. app.js - Add drawViolationMarkers() with pulsing animation
21. app.js - Add drawColdChainMarkers() with snowflake markers
22. app.js renderCanvas() - Call new draw functions
23. app.js - Add startPulseAnimation/stopPulseAnimation/hasAnyViolations

### Phase 6: Incremental Computation
24. worker.js - Add INCREMENTAL_COMPUTE message handler
25. worker.js - Implement incrementalCompute() function
26. app.js initWorker() - Add INCREMENTAL_RESULT handler
27. app.js - Add handleIncrementalResult()
28. app.js - Add triggerIncrementalCompute()
29. app.js moveOrderBetweenRoutes() - Route to incremental when locks exist

### Phase 7: Drag from Unassigned
30. app.js renderUnassigned() - Make items draggable, show suggestions
31. app.js onOrderDrop() - Handle null source route (unassigned pool)
32. app.js - Add assignUnassignedToRoute()

### Phase 8: Persistence and Export
33. app.js exportPlan() - Include lock state, objective, ETAs, violation reasons
34. app.js savePlan()/loadPlan() - Persist and restore lock state + objective
35. app.js applyImportedData() - Reset lock state, repopulate cold chain IDs

### Phase 9: Edge Cases and Polish
36. app.js - Debounced vehicle count recompute (500ms)
37. app.js - All-routes-locked guard in triggerIncrementalCompute()
38. app.js - Locked-to-locked drag: allow local move, skip worker
39. Testing - Verify all 9 edge cases from Section 7

---

## Summary of Changes by File

| File | Lines Changed | New Lines | Key Changes |
|---|---|---|---|
| data.json | 5 modified | 0 | Add coldChain flag to 5 orders |
| index.html | 0 modified | ~15 | Objective selector, legend additions |
| style.css | 0 modified | ~120 | Lock, capacity bar, cold chain, ETA, animations |
| worker.js | ~60 modified | ~200 | Multi-objective, incremental compute, ETA, reasons |
| app.js | ~150 modified | ~350 | Lock UI, incremental handler, canvas, animation |

**Total estimated: ~900 new/modified lines across 5 files.**