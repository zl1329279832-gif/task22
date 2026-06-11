// Web Worker: Route Planning Heuristic Engine
// Handles heavy computation off the main thread

self.onmessage = function(e) {
  const { type, payload } = e.data;

  if (type === 'COMPUTE_ROUTES') {
    const requestId = payload.requestId || 0;
    const result = computeRoutes(payload);
    self.postMessage({ type: 'ROUTES_RESULT', payload: { ...result, requestId } });
  } else if (type === 'RECALCULATE_ROUTE') {
    // Legacy single-route recalc (kept for backward compat)
    const result = recalculateSingleRoute(payload);
    self.postMessage({ type: 'RECALC_RESULT', payload: result });
  } else if (type === 'RECALCULATE_ROUTES') {
    // Batch recalc: recalculate multiple routes atomically
    const { routes, dpMap, whMap, routeVersion, startTime } = payload;
    const results = routes.map(route =>
      recalculateSingleRoute({ route, dpMap, whMap, startTime })
    );
    self.postMessage({
      type: 'RECALC_RESULT',
      payload: { routes: results, routeVersion, batch: true }
    });
  } else if (type === 'INCREMENTAL_COMPUTE') {
    const result = incrementalCompute(payload);
    self.postMessage({
      type: 'INCREMENTAL_RESULT',
      payload: { ...result, routeVersion: payload.routeVersion }
    });
  }
};

// ========================
// Core Route Computation
// ========================

function computeRoutes({ orders, warehouses, deliveryPoints, drivers, vehicles, vehicleCount, objective, startTime }) {
  objective = objective || 'shortest_distance';

  const dpMap = {};
  deliveryPoints.forEach(dp => { dpMap[dp.id] = dp; });
  const whMap = {};
  warehouses.forEach(wh => { whMap[wh.id] = wh; });

  // Validate orders
  const validOrders = [];
  const unassigned = [];

  for (const order of orders) {
    const issues = validateOrder(order, dpMap, whMap, vehicles);
    if (issues.length > 0) {
      unassigned.push({ order, reasons: issues });
    } else {
      validOrders.push(order);
    }
  }

  // Select vehicles
  const selectedVehicles = vehicles.slice(0, Math.min(vehicleCount, vehicles.length));
  const availableDrivers = drivers.slice(0, selectedVehicles.length);

  // Sort orders by objective
  const sortedOrders = sortOrdersByObjective(validOrders, objective, dpMap, whMap);

  // Build routes using heuristic
  const routes = buildRoutes(sortedOrders, selectedVehicles, availableDrivers, dpMap, whMap, objective, startTime);

  // Check for remaining unassigned
  const assignedOrderIds = new Set();
  for (const route of routes) {
    for (const order of route.orders) {
      assignedOrderIds.add(order.id);
    }
  }

  for (const order of validOrders) {
    if (!assignedOrderIds.has(order.id)) {
      const reasons = ['无法在现有车辆容量、时间窗或驾驶时长约束内分配'];
      if (order.coldChain) {
        reasons.push('冷链订单需优先保障，建议增加车辆或使用冷链专用车');
      }
      unassigned.push({ order, reasons });
    }
  }

  // Calculate statistics
  const stats = calculateStats(routes, unassigned, orders.length);

  return { routes, unassigned, stats };
}

// ========================
// Incremental Compute (locked routes preserved)
// ========================

function incrementalCompute(payload) {
  const {
    lockedRoutes, allOrders, warehouses, deliveryPoints,
    drivers, vehicles, vehicleCount, objective, startTime,
    dpMap, whMap
  } = payload;

  const effectiveObjective = objective || 'shortest_distance';

  // 1. Collect order IDs consumed by locked routes
  const lockedOrderIds = new Set();
  const lockedRouteIds = new Set();
  for (const lr of lockedRoutes) {
    lockedRouteIds.add(lr.id);
    for (const o of lr.orders) {
      lockedOrderIds.add(o.id);
    }
  }

  // 2. Validate orders (exclude locked ones from available pool)
  const availableOrders = [];
  const unassigned = [];

  for (const order of allOrders) {
    if (lockedOrderIds.has(order.id)) continue; // skip locked orders

    const issues = validateOrder(order, dpMap, whMap, vehicles);
    if (issues.length > 0) {
      unassigned.push({ order, reasons: issues });
    } else {
      availableOrders.push(order);
    }
  }

  // 3. Build unlocked route slots
  const selectedVehicles = vehicles.slice(0, Math.min(vehicleCount, vehicles.length));
  const availableDrivers = drivers.slice(0, selectedVehicles.length);

  const unlockedRoutes = [];
  for (let i = 0; i < selectedVehicles.length; i++) {
    const routeId = 'ROUTE_' + (i + 1);
    if (lockedRouteIds.has(routeId)) continue; // skip locked

    unlockedRoutes.push({
      id: routeId,
      vehicle: selectedVehicles[i],
      driver: availableDrivers[i] || null,
      orders: [],
      totalWeight: 0,
      totalDistance: 0,
      estimatedTime: 0,
      groupingReason: []
    });
  }

  // 4. Sort available orders and assign to unlocked routes
  const sortedOrders = sortOrdersByObjective(availableOrders, effectiveObjective, dpMap, whMap);

  // Group by warehouse
  const ordersByWarehouse = {};
  for (const order of sortedOrders) {
    if (!ordersByWarehouse[order.warehouseId]) {
      ordersByWarehouse[order.warehouseId] = [];
    }
    ordersByWarehouse[order.warehouseId].push(order);
  }

  for (const whId in ordersByWarehouse) {
    const whOrders = ordersByWarehouse[whId];
    const warehouse = whMap[whId];
    assignWarehouseOrders(whOrders, warehouse, unlockedRoutes, dpMap, effectiveObjective);
  }

  // 5. Finalize unlocked routes
  for (const route of unlockedRoutes) {
    finalizeRoute(route, dpMap, whMap, startTime);
  }

  // 6. Merge: locked routes (as-is) + new unlocked routes
  const allRoutes = [];
  for (let i = 0; i < selectedVehicles.length; i++) {
    const routeId = 'ROUTE_' + (i + 1);
    if (lockedRouteIds.has(routeId)) {
      // Find original locked route and include it
      const locked = lockedRoutes.find(r => r.id === routeId);
      if (locked) allRoutes.push(locked);
    } else {
      const unlocked = unlockedRoutes.find(r => r.id === routeId);
      if (unlocked) allRoutes.push(unlocked);
    }
  }

  // 7. Check for remaining unassigned
  const assignedOrderIds = new Set();
  for (const route of allRoutes) {
    for (const order of route.orders) {
      assignedOrderIds.add(order.id);
    }
  }

  for (const order of availableOrders) {
    if (!assignedOrderIds.has(order.id) && !lockedOrderIds.has(order.id)) {
      const reasons = ['无法在现有车辆容量、时间窗或驾驶时长约束内分配'];
      if (lockedRoutes.length > 0) {
        reasons.push('部分路线已锁定，可用运力减少');
      }
      if (order.coldChain) {
        reasons.push('冷链订单需优先保障');
      }
      unassigned.push({ order, reasons });
    }
  }

  const stats = calculateStats(allRoutes, unassigned, allOrders.length);

  return { routes: allRoutes, unassigned, stats };
}

// ========================
// Validation
// ========================

function validateOrder(order, dpMap, whMap, vehicles) {
  const reasons = [];

  if (!order.deliveryPointId) {
    reasons.push('配送点坐标缺失 (deliveryPointId 为空)');
  } else if (!dpMap[order.deliveryPointId]) {
    reasons.push('配送点不存在: ' + order.deliveryPointId);
  }

  if (!whMap[order.warehouseId]) {
    reasons.push('仓库不存在: ' + order.warehouseId);
  }

  if (dpMap[order.deliveryPointId]) {
    const dp = dpMap[order.deliveryPointId];
    if (dp.x == null || dp.y == null) {
      reasons.push('配送点坐标缺失: ' + order.deliveryPointId);
    }
  }

  const maxCapacity = Math.max(...vehicles.map(v => v.capacity));
  if (order.weight > maxCapacity) {
    reasons.push('订单重量 (' + order.weight + 'kg) 超过最大车辆容量 (' + maxCapacity + 'kg)');
  }

  if (order.timeWindowEnd <= order.timeWindowStart) {
    reasons.push('配送时间窗无效: ' + order.timeWindowStart + '-' + order.timeWindowEnd);
  }

  if (order.timeWindowEnd - order.timeWindowStart < 1) {
    reasons.push('配送时间窗过窄 (< 1小时): ' + order.timeWindowStart + '-' + order.timeWindowEnd);
  }

  return reasons;
}

// ========================
// Sorting by Objective
// ========================

function sortOrdersByObjective(orders, objective, dpMap, whMap) {
  // Split cold chain orders — they always get priority regardless of objective
  const coldChainOrders = orders.filter(o => o.coldChain);
  const normalOrders = orders.filter(o => !o.coldChain);

  // Sort each group independently by objective
  const sortFn = getObjectiveSortFn(objective);
  coldChainOrders.sort(sortFn);
  normalOrders.sort(sortFn);

  // Cold chain always first
  return coldChainOrders.concat(normalOrders);
}

// Returns the comparison function for a given objective
function getObjectiveSortFn(objective) {
  switch (objective) {
    case 'shortest_distance':
      return (a, b) => a.priority - b.priority || a.timeWindowEnd - b.timeWindowEnd;

    case 'least_overtime':
      return (a, b) => a.timeWindowEnd - b.timeWindowEnd || a.priority - b.priority;

    case 'load_balance':
      return (a, b) => b.weight - a.weight || a.priority - b.priority;

    case 'driver_fairness':
      return (a, b) => a.priority - b.priority || a.timeWindowEnd - b.timeWindowEnd;

    case 'cold_chain_priority':
      // Within cold chain or normal group, sort by deadline
      return (a, b) => a.timeWindowEnd - b.timeWindowEnd || a.priority - b.priority;

    default:
      return (a, b) => {
        const urgencyA = (a.timeWindowEnd - a.timeWindowStart) / a.priority;
        const urgencyB = (b.timeWindowEnd - b.timeWindowStart) / b.priority;
        return urgencyA - urgencyB;
      };
  }
}

// ========================
// Route Building
// ========================

function buildRoutes(orders, vehicles, drivers, dpMap, whMap, objective, startTime) {
  const routes = [];

  for (let i = 0; i < vehicles.length; i++) {
    const vehicle = vehicles[i];
    const driver = drivers[i] || null;

    routes.push({
      id: 'ROUTE_' + (i + 1),
      vehicle: vehicle,
      driver: driver,
      orders: [],
      totalWeight: 0,
      totalDistance: 0,
      estimatedTime: 0,
      groupingReason: []
    });
  }

  // Group orders by warehouse first
  const ordersByWarehouse = {};
  for (const order of orders) {
    if (!ordersByWarehouse[order.warehouseId]) {
      ordersByWarehouse[order.warehouseId] = [];
    }
    ordersByWarehouse[order.warehouseId].push(order);
  }

  // Assign orders to routes
  for (const whId in ordersByWarehouse) {
    const whOrders = ordersByWarehouse[whId];
    const warehouse = whMap[whId];
    assignWarehouseOrders(whOrders, warehouse, routes, dpMap, objective);
  }

  // Finalize route calculations
  for (const route of routes) {
    finalizeRoute(route, dpMap, whMap, startTime);
  }

  return routes;
}

function assignWarehouseOrders(orders, warehouse, routes, dpMap, objective) {
  const remainingOrders = [...orders];

  while (remainingOrders.length > 0) {
    let bestAssignment = null;
    let bestScore = Infinity;

    for (let oi = 0; oi < remainingOrders.length; oi++) {
      const order = remainingOrders[oi];
      const dp = dpMap[order.deliveryPointId];
      if (!dp) continue;

      for (const route of routes) {
        // Check capacity
        if (route.totalWeight + order.weight > route.vehicle.capacity) continue;

        // Check if single order exceeds vehicle capacity
        if (order.weight > route.vehicle.capacity) continue;

        // Calculate score
        const score = calculateAssignmentScore(order, dp, warehouse, route, dpMap, objective);

        if (score < bestScore) {
          bestScore = score;
          bestAssignment = { order, route, orderIndex: oi };
        }
      }
    }

    if (bestAssignment) {
      const { order, route, orderIndex } = bestAssignment;
      route.orders.push(order);
      route.totalWeight += order.weight;

      // Track grouping reason
      const dp = dpMap[order.deliveryPointId];
      const reason = buildGroupingReason(order, dp, warehouse, route, dpMap);
      if (reason && route.groupingReason.indexOf(reason) === -1) {
        route.groupingReason.push(reason);
      }

      remainingOrders.splice(orderIndex, 1);
    } else {
      // Cannot assign remaining orders
      break;
    }
  }
}

// ========================
// Multi-Objective Scoring
// ========================

function calculateAssignmentScore(order, dp, warehouse, route, dpMap, objective) {
  let score = 0;

  // Distance from last point in route (or warehouse)
  const lastPoint = route.orders.length > 0
    ? dpMap[route.orders[route.orders.length - 1].deliveryPointId]
    : warehouse;

  const dist = distance(lastPoint, dp);

  // Objective-specific scoring
  switch (objective) {
    case 'shortest_distance':
      // Maximize distance weight — pure proximity optimization
      score += dist * 15;
      break;

    case 'least_overtime':
      // Distance matters but violations are heavily penalized
      score += dist * 8;

      // Simulate: how much would adding this order increase time window violations?
      const travelTime = dist / route.vehicle.speed;
      const currentRouteTime = route.orders.length > 0
        ? estimateRouteEndTime(route, dpMap, warehouse)
        : 0;
      const arrivalAtNew = currentRouteTime + travelTime;
      const violationMinutes = Math.max(0, (arrivalAtNew - order.timeWindowEnd) * 60);
      score += violationMinutes * 5; // heavy penalty per minute of violation

      // Also penalize cascading delays: if this order is late, all subsequent orders may be too
      if (violationMinutes > 0) {
        score += 200;
      }

      // Prefer time window overlap to minimize idle waiting
      if (route.orders.length > 0) {
        const lastOrder = route.orders[route.orders.length - 1];
        const gap = order.timeWindowStart - lastOrder.timeWindowEnd;
        if (gap > 2) score += gap * 50; // large gap means wasted time
      }
      break;

    case 'load_balance':
      // Distance is secondary; balance load across vehicles
      score += dist * 10;

      // Quadratic penalty: the fuller the vehicle, the more we penalize adding to it
      const currentLoadRatio = route.totalWeight / route.vehicle.capacity;
      const newLoadRatio = (route.totalWeight + order.weight) / route.vehicle.capacity;
      score += (newLoadRatio * newLoadRatio - currentLoadRatio * currentLoadRatio) * 1000;

      // Prefer putting heavy orders in emptier vehicles
      if (order.weight > 500 && currentLoadRatio < 0.3) {
        score -= 100; // bonus for filling empty vehicles with heavy orders
      }
      break;

    case 'driver_fairness':
      score += dist * 10;

      // Penalize assigning to drivers who already have high estimated time
      if (route.driver && route.estimatedTime > 0) {
        const usedRatio = route.estimatedTime / route.driver.maxHours;
        score += usedRatio * 500; // more used = more penalty
      }

      // If driver is near max hours, heavy penalty
      if (route.driver) {
        const projectedTime = route.estimatedTime + (dist / route.vehicle.speed) + 0.25;
        if (projectedTime > route.driver.maxHours) {
          score += 800;
        } else if (projectedTime > route.driver.maxHours * 0.8) {
          score += 300;
        }
      }
      break;

    case 'cold_chain_priority':
      score += dist * 8;

      // Massive bonus for cold chain orders — they MUST be assigned first
      if (order.coldChain) {
        score -= 2000;

        // Also prefer tighter time window routes for cold chain
        const urgency = order.timeWindowEnd - order.timeWindowStart;
        score += urgency * 30; // tighter window = lower urgency value = better
      }

      // Non-cold-chain orders get slight penalty to push cold chain first
      if (!order.coldChain && route.orders.some(o => o.coldChain)) {
        score += 100; // slight penalty for mixing
      }
      break;

    default:
      // Fallback balanced scoring
      score += dist * 10;
      score += order.weight * 0.5;
      break;
  }

  // Common: Time window compatibility (all objectives)
  if (route.orders.length > 0) {
    const lastOrder = route.orders[route.orders.length - 1];
    const timeOverlap = Math.min(order.timeWindowEnd, lastOrder.timeWindowEnd) -
                        Math.max(order.timeWindowStart, lastOrder.timeWindowStart);
    if (timeOverlap < 0) {
      score += 500; // Penalty for non-overlapping time windows
    } else {
      score -= timeOverlap * 20; // Bonus for overlapping windows
    }
  }

  // Common: Penalty for overloading risk
  const loadRate = (route.totalWeight + order.weight) / route.vehicle.capacity;
  if (loadRate > 0.9) {
    score += 200;
  }

  return score;
}

// Helper: estimate the time when a route would finish its current orders
function estimateRouteEndTime(route, dpMap, warehouse) {
  if (route.orders.length === 0) return 0;

  let totalDist = 0;
  let currentPoint = warehouse;
  for (const order of route.orders) {
    const d = dpMap[order.deliveryPointId];
    if (d) {
      totalDist += distance(currentPoint, d);
      currentPoint = d;
    }
  }

  const drivingTime = totalDist / route.vehicle.speed;
  const serviceTime = route.orders.length * 0.25;
  return drivingTime + serviceTime;
}

// ========================
// Grouping Reasons
// ========================

function buildGroupingReason(order, dp, warehouse, route, dpMap) {
  const reasons = [];

  // Check geographic proximity
  if (route.orders.length > 0) {
    const lastDp = dpMap[route.orders[route.orders.length - 1].deliveryPointId];
    if (lastDp) {
      const dist = distance(lastDp, dp);
      if (dist < 80) {
        reasons.push('配送点' + dp.name + '与前一站' + lastDp.name + '地理相近(距离' + Math.round(dist) + ')');
      }
    }
  }

  // Check time window overlap
  if (route.orders.length > 0) {
    const lastOrder = route.orders[route.orders.length - 1];
    const overlap = Math.min(order.timeWindowEnd, lastOrder.timeWindowEnd) -
                    Math.max(order.timeWindowStart, lastOrder.timeWindowStart);
    if (overlap > 0) {
      reasons.push('与' + lastOrder.id + '时间窗重叠(' + overlap + 'h)');
    }
  }

  // Cold chain grouping
  if (order.coldChain) {
    reasons.push('冷链订单' + order.id + '需优先保障配送');
  }

  // Direction from warehouse
  if (route.orders.length === 0) {
    reasons.push('从' + warehouse.name + '出发配送至' + dp.name);
  }

  return reasons.length > 0 ? reasons.join('; ') : null;
}

// ========================
// Route Finalization (enhanced with ETA and violation reasons)
// ========================

function finalizeRoute(route, dpMap, whMap, startTime) {
  if (route.orders.length === 0) {
    route.stopETAs = [];
    return;
  }

  const warehouse = whMap[route.orders[0].warehouseId];
  if (!warehouse) {
    route.stopETAs = [];
    return;
  }

  // Calculate total distance
  let totalDist = 0;
  let currentPoint = warehouse;

  for (const order of route.orders) {
    const dp = dpMap[order.deliveryPointId];
    if (dp) {
      totalDist += distance(currentPoint, dp);
      currentPoint = dp;
    }
  }

  // Return to warehouse
  totalDist += distance(currentPoint, warehouse);

  route.totalDistance = Math.round(totalDist);

  // Estimated time (in hours)
  const drivingTime = totalDist / route.vehicle.speed;

  // Driver rest calculation
  let restTime = 0;
  if (route.driver) {
    const restStops = Math.floor(drivingTime / route.driver.restAfterHours);
    restTime = restStops * route.driver.restDuration;
  }

  // Service time at each stop (15 min each)
  const serviceTime = route.orders.length * 0.25;

  route.estimatedTime = Math.round((drivingTime + restTime + serviceTime) * 100) / 100;
  route.drivingTime = Math.round(drivingTime * 100) / 100;
  route.restTime = restTime;
  route.serviceTime = serviceTime;

  // Load rate
  route.loadRate = Math.round((route.totalWeight / route.vehicle.capacity) * 100);

  // Overtime risk
  if (route.driver) {
    route.overtimeRisk = route.estimatedTime > route.driver.maxHours
      ? 'high'
      : route.estimatedTime > route.driver.maxHours * 0.8
        ? 'medium'
        : 'low';
    route.overtimeMinutes = Math.max(0,
      Math.round((route.estimatedTime - route.driver.maxHours) * 60));
  } else {
    route.overtimeRisk = 'unknown';
    route.overtimeMinutes = 0;
  }

  // Time window violations with ETA and reasons
  route.timeWindowViolations = [];
  route.stopETAs = [];
  const routeStartTime = startTime || 8;
  let currentTime = routeStartTime;
  currentPoint = warehouse;

  for (let i = 0; i < route.orders.length; i++) {
    const order = route.orders[i];
    const dp = dpMap[order.deliveryPointId];
    if (dp) {
      const segDist = distance(currentPoint, dp);
      const travelTime = segDist / route.vehicle.speed;
      currentTime += travelTime;

      // Record ETA
      const eta = Math.round(currentTime * 100) / 100;

      if (currentTime < order.timeWindowStart) {
        const stopWaitTime = Math.round((order.timeWindowStart - currentTime) * 60);
        route.stopETAs.push({ orderId: order.id, eta, waitTime: stopWaitTime });
        currentTime = order.timeWindowStart; // Wait
      } else {
        route.stopETAs.push({ orderId: order.id, eta, waitTime: 0 });
      }

      if (currentTime > order.timeWindowEnd) {
        // Determine violation reason
        let reason = '';
        if (route.driver && route.estimatedTime > route.driver.maxHours) {
          reason = '司机工时超限导致整体延误';
        } else if (segDist > 100) {
          reason = '与前一站距离较远(' + Math.round(segDist) + ')，行驶耗时过长';
        } else if (i > 0 && route.stopETAs.length > 1) {
          const prevEta = route.stopETAs[route.stopETAs.length - 2].eta;
          const prevWait = route.stopETAs[route.stopETAs.length - 2].waitTime || 0;
          const gapTime = currentTime - travelTime - prevEta - 0.25;
          if (gapTime > 0.5 || prevWait > 30) {
            reason = '前序站点等待时间窗开启耗时' + Math.round((gapTime > 0 ? gapTime : 0) * 60) + '分钟';
          } else {
            reason = '前序站点服务耗时累积，到达时间推迟';
          }
        } else {
          reason = '前序站点服务耗时累积';
        }

        route.timeWindowViolations.push({
          orderId: order.id,
          expectedArrival: eta,
          windowEnd: order.timeWindowEnd,
          delay: Math.round((currentTime - order.timeWindowEnd) * 60),
          reason
        });
      }

      currentTime += 0.25; // Service time
      currentPoint = dp;
    }
  }
}

function recalculateSingleRoute({ route, dpMap, whMap, startTime }) {
  // Recreate a route object and recalculate
  const recalculated = {
    ...route,
    totalWeight: 0,
    totalDistance: 0,
    estimatedTime: 0,
    groupingReason: route.groupingReason || []
  };

  for (const order of route.orders) {
    recalculated.totalWeight += order.weight;
  }

  // Constraint warnings: check capacity
  const constraintWarnings = [];
  if (recalculated.totalWeight > route.vehicle.capacity) {
    constraintWarnings.push('超载: 总重 ' + recalculated.totalWeight + 'kg 超过车辆容量 ' + route.vehicle.capacity + 'kg');
  }

  finalizeRoute(recalculated, dpMap, whMap, startTime);

  // Additional constraint warnings after finalize
  if (recalculated.overtimeRisk === 'high') {
    constraintWarnings.push('超时高风险: 预计 ' + recalculated.estimatedTime + 'h 超过司机最大工时 ' + (route.driver ? route.driver.maxHours : 'N/A') + 'h');
  }
  if (recalculated.timeWindowViolations && recalculated.timeWindowViolations.length > 0) {
    constraintWarnings.push('时间窗违规: ' + recalculated.timeWindowViolations.length + ' 个订单将超时');
  }

  recalculated.constraintWarnings = constraintWarnings;
  return recalculated;
}

// ========================
// Utility Functions
// ========================

function distance(a, b) {
  const dx = (a.x || 0) - (b.x || 0);
  const dy = (a.y || 0) - (b.y || 0);
  return Math.sqrt(dx * dx + dy * dy);
}

function calculateStats(routes, unassigned, totalOrders) {
  let assignedCount = 0;
  let totalWeight = 0;
  let totalCapacity = 0;
  let totalDistance = 0;
  let totalEstimatedTime = 0;
  let highRiskCount = 0;
  let violationCount = 0;

  for (const route of routes) {
    assignedCount += route.orders.length;
    totalWeight += route.totalWeight;
    totalCapacity += route.vehicle.capacity;
    totalDistance += route.totalDistance;
    totalEstimatedTime += route.estimatedTime;
    if (route.overtimeRisk === 'high') highRiskCount++;
    violationCount += (route.timeWindowViolations || []).length;
  }

  return {
    totalOrders,
    assignedOrders: assignedCount,
    unassignedOrders: unassigned.length,
    totalWeight,
    totalCapacity,
    avgLoadRate: totalCapacity > 0 ? Math.round((totalWeight / totalCapacity) * 100) : 0,
    totalDistance: Math.round(totalDistance),
    totalEstimatedTime: Math.round(totalEstimatedTime * 100) / 100,
    highRiskRoutes: highRiskCount,
    timeWindowViolations: violationCount,
    activeRoutes: routes.filter(r => r.orders.length > 0).length
  };
}
