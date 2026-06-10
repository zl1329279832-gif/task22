// Web Worker: Route Planning Heuristic Engine
// Handles heavy computation off the main thread

self.onmessage = function(e) {
  const { type, payload } = e.data;

  if (type === 'COMPUTE_ROUTES') {
    const requestId = payload.requestId || 0;
    const result = computeRoutes(payload);
    self.postMessage({
      type: 'ROUTES_RESULT',
      payload: { ...result, requestId, lockedRoutes: payload.lockedRoutes || [] }
    });
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
  }
};

// ========================
// Core Route Computation
// ========================

function computeRoutes({ orders, warehouses, deliveryPoints, drivers, vehicles,
                         vehicleCount, strategy, objectives, startTime,
                         lockedRoutes, lockedOrderIds }) {
  const dpMap = {};
  deliveryPoints.forEach(dp => { dpMap[dp.id] = dp; });
  const whMap = {};
  warehouses.forEach(wh => { whMap[wh.id] = wh; });

  // Backward compatibility: convert strategy to objectives
  if (!objectives && strategy) {
    objectives = buildObjectivesFromStrategy(strategy);
  }
  if (!objectives) {
    objectives = { minDistance: { enabled: true, weight: 50 } };
  }

  var lockedOrderIdSet = new Set(lockedOrderIds || []);
  var lockedVehicleIds = new Set((lockedRoutes || []).map(function(r) { return r.vehicle.id; }));
  var lockedDriverIds = new Set((lockedRoutes || []).filter(function(r) { return r.driver; }).map(function(r) { return r.driver.id; }));

  // Validate orders (skip locked orders)
  const validOrders = [];
  const unassigned = [];

  for (const order of orders) {
    if (lockedOrderIdSet.has(order.id)) continue;

    const issues = validateOrder(order, dpMap, whMap, vehicles);
    if (issues.length > 0) {
      unassigned.push({ order, reasons: issues });
    } else {
      validOrders.push(order);
    }
  }

  // Available vehicles/drivers: exclude those used by locked routes
  var availableVehicles = vehicles.filter(function(v) { return !lockedVehicleIds.has(v.id); });
  var freeVehicleCount = Math.min(vehicleCount - (lockedRoutes || []).length, availableVehicles.length);
  var selectedVehicles = availableVehicles.slice(0, Math.max(0, freeVehicleCount));

  var availableDrivers = drivers.filter(function(d) { return !lockedDriverIds.has(d.id); });
  availableDrivers = availableDrivers.slice(0, selectedVehicles.length);

  // Sort and build routes
  const sortedOrders = sortOrdersByObjectives(validOrders, objectives);
  const routes = buildRoutes(sortedOrders, selectedVehicles, availableDrivers, dpMap, whMap, objectives, startTime);

  // Check for remaining unassigned
  const assignedOrderIds = new Set();
  for (const route of routes) {
    for (const order of route.orders) {
      assignedOrderIds.add(order.id);
    }
  }

  for (const order of validOrders) {
    if (!assignedOrderIds.has(order.id)) {
      var reasons = [];
      var capacityBlock = true;
      for (var ri = 0; ri < routes.length; ri++) {
        if (routes[ri].totalWeight + order.weight <= routes[ri].vehicle.capacity) {
          capacityBlock = false;
          break;
        }
      }
      if (capacityBlock) {
        reasons.push('所有可用车辆剩余容量不足 (订单重量: ' + order.weight + 'kg)');
      } else {
        reasons.push('时间窗、驾驶时长或综合约束无法满足');
      }
      if (order.coldChain) {
        reasons.push('冷链订单未能在时间窗内被优先安排');
      }
      unassigned.push({ order, reasons: reasons });
    }
  }

  // Statistics include locked routes
  var allRoutes = (lockedRoutes || []).concat(routes);
  const stats = calculateStats(allRoutes, unassigned, orders.length);

  return { routes, unassigned, stats };
}

// ========================
// Backward Compatibility
// ========================

function buildObjectivesFromStrategy(strategy) {
  var base = {
    minDistance:    { enabled: false, weight: 50 },
    minViolation:  { enabled: false, weight: 50 },
    loadBalance:   { enabled: false, weight: 50 },
    driverFairness:{ enabled: false, weight: 50 },
    coldChainFirst:{ enabled: false, weight: 50 }
  };
  switch (strategy) {
    case 'balanced':
      base.minDistance.enabled = true;
      base.loadBalance.enabled = true;
      break;
    case 'priority_first':
      base.coldChainFirst.enabled = true;
      base.minViolation.enabled = true;
      break;
    case 'time_window':
      base.minViolation.enabled = true;
      break;
    case 'nearest_first':
      base.minDistance.enabled = true;
      base.minDistance.weight = 100;
      break;
    default:
      base.minDistance.enabled = true;
      break;
  }
  return base;
}

// ========================
// Order Validation
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
// Multi-Objective Sorting
// ========================

function sortOrdersByObjectives(orders, objectives) {
  var sorted = orders.slice();
  var obj = objectives || {};

  sorted.sort(function(a, b) {
    // Cold chain orders first when enabled
    if (obj.coldChainFirst && obj.coldChainFirst.enabled) {
      if (a.coldChain && !b.coldChain) return -1;
      if (!a.coldChain && b.coldChain) return 1;
    }

    // Time window urgency when minViolation enabled
    if (obj.minViolation && obj.minViolation.enabled) {
      var urgencyA = (a.timeWindowEnd - a.timeWindowStart);
      var urgencyB = (b.timeWindowEnd - b.timeWindowStart);
      if (urgencyA !== urgencyB) return urgencyA - urgencyB;
    }

    // Priority as tiebreaker
    if (a.priority !== b.priority) return a.priority - b.priority;

    // Then by time window end
    return a.timeWindowEnd - b.timeWindowEnd;
  });

  return sorted;
}

// ========================
// Route Building
// ========================

function buildRoutes(orders, vehicles, drivers, dpMap, whMap, objectives, startTime) {
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
    assignWarehouseOrders(whOrders, warehouse, routes, dpMap, objectives, startTime);
  }

  // Finalize route calculations
  for (const route of routes) {
    finalizeRoute(route, dpMap, whMap, startTime);
  }

  return routes;
}

function assignWarehouseOrders(orders, warehouse, routes, dpMap, objectives, startTime) {
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
        const score = calculateAssignmentScore(order, dp, warehouse, route, dpMap, objectives, startTime);

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

function calculateAssignmentScore(order, dp, warehouse, route, dpMap, objectives, startTime) {
  var score = 0;
  var obj = objectives || {};

  // Distance from last point in route (or warehouse)
  var lastPoint = route.orders.length > 0
    ? dpMap[route.orders[route.orders.length - 1].deliveryPointId]
    : warehouse;

  var dist = distance(lastPoint, dp);

  // === Objective 1: Minimize distance ===
  if (obj.minDistance && obj.minDistance.enabled) {
    var w1 = obj.minDistance.weight / 50;
    score += dist * 10 * w1;
  } else {
    score += dist * 5; // Base distance cost
  }

  // === Time window compatibility (always applied) ===
  if (route.orders.length > 0) {
    var lastOrder = route.orders[route.orders.length - 1];
    var timeOverlap = Math.min(order.timeWindowEnd, lastOrder.timeWindowEnd) -
                      Math.max(order.timeWindowStart, lastOrder.timeWindowStart);
    if (timeOverlap < 0) {
      score += 500;
    } else {
      score -= timeOverlap * 20;
    }
  }

  // === Objective 2: Minimize time window violations ===
  if (obj.minViolation && obj.minViolation.enabled) {
    var w2 = obj.minViolation.weight / 50;
    var estimatedArrival = estimateArrivalTime(route, dp, warehouse, dpMap, startTime);
    if (estimatedArrival > order.timeWindowEnd) {
      score += (estimatedArrival - order.timeWindowEnd) * 200 * w2;
    }
    // Tighter windows should be assigned earlier
    var windowSize = order.timeWindowEnd - order.timeWindowStart;
    score += (1 / Math.max(0.5, windowSize)) * 100 * w2;
  }

  // === Objective 3: Load balance ===
  if (obj.loadBalance && obj.loadBalance.enabled) {
    var w3 = obj.loadBalance.weight / 50;
    var loadRate = (route.totalWeight + order.weight) / route.vehicle.capacity;
    score += Math.abs(loadRate - 0.5) * 300 * w3;
  }

  // === Objective 4: Driver fairness ===
  if (obj.driverFairness && obj.driverFairness.enabled) {
    var w4 = obj.driverFairness.weight / 50;
    score += route.orders.length * 50 * w4;
  }

  // === Objective 5: Cold chain priority ===
  if (obj.coldChainFirst && obj.coldChainFirst.enabled) {
    var w5 = obj.coldChainFirst.weight / 50;
    if (order.coldChain) {
      score -= 500 * w5;
      if (route.orders.length > 0) {
        score += route.orders.length * 30 * w5;
      }
    }
  }

  // Overload penalty (always applied)
  var finalLoadRate = (route.totalWeight + order.weight) / route.vehicle.capacity;
  if (finalLoadRate > 0.9) {
    score += 200;
  }

  return score;
}

function estimateArrivalTime(route, targetDp, warehouse, dpMap, startTime) {
  var totalDist = 0;
  var currentPoint = warehouse;
  for (var i = 0; i < route.orders.length; i++) {
    var dp = dpMap[route.orders[i].deliveryPointId];
    if (dp) {
      totalDist += distance(currentPoint, dp);
      currentPoint = dp;
    }
  }
  totalDist += distance(currentPoint, targetDp);
  var drivingTime = totalDist / route.vehicle.speed;
  var serviceTime = (route.orders.length + 1) * 0.25;
  return (startTime || 8) + drivingTime + serviceTime;
}

// ========================
// Grouping Reason
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

  // Direction from warehouse
  if (route.orders.length === 0) {
    reasons.push('从' + warehouse.name + '出发配送至' + dp.name);
  }

  // Cold chain note
  if (order.coldChain) {
    reasons.push('冷链订单优先分配');
  }

  return reasons.length > 0 ? reasons.join('; ') : null;
}

// ========================
// Route Finalization
// ========================

function finalizeRoute(route, dpMap, whMap, startTime) {
  if (route.orders.length === 0) return;

  const warehouse = whMap[route.orders[0].warehouseId];
  if (!warehouse) return;

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

  // Time window violations & stop ETAs
  route.timeWindowViolations = [];
  route.stopETAs = [];
  const routeStartTime = startTime || 8;
  let currentTime = routeStartTime;
  currentPoint = warehouse;

  for (const order of route.orders) {
    const dp = dpMap[order.deliveryPointId];
    if (dp) {
      const travelTime = distance(currentPoint, dp) / route.vehicle.speed;
      currentTime += travelTime;

      var waitTime = 0;
      if (currentTime < order.timeWindowStart) {
        waitTime = Math.round((order.timeWindowStart - currentTime) * 60);
        currentTime = order.timeWindowStart; // Wait
      }

      route.stopETAs.push({
        orderId: order.id,
        eta: Math.round(currentTime * 100) / 100,
        waitTime: waitTime
      });

      if (currentTime > order.timeWindowEnd) {
        route.timeWindowViolations.push({
          orderId: order.id,
          expectedArrival: Math.round(currentTime * 100) / 100,
          windowEnd: order.timeWindowEnd,
          delay: Math.round((currentTime - order.timeWindowEnd) * 60)
        });
      }

      currentTime += 0.25; // Service time
      currentPoint = dp;
    }
  }
}

// ========================
// Single Route Recalc
// ========================

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
