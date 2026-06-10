// Web Worker: Route Planning Heuristic Engine
// Handles heavy computation off the main thread

self.onmessage = function(e) {
  const { type, payload, requestId } = e.data;

  if (type === 'COMPUTE_ROUTES') {
    const result = computeRoutes(payload);
    self.postMessage({ type: 'ROUTES_RESULT', payload: result, requestId: requestId });
  } else if (type === 'RECALCULATE_ROUTE') {
    const result = recalculateSingleRoute(payload);
    self.postMessage({ type: 'RECALC_RESULT', payload: result, requestId: requestId });
  }
};

// ========================
// Core Route Computation
// ========================

function computeRoutes({ orders, warehouses, deliveryPoints, drivers, vehicles, vehicleCount, strategy }) {
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

  // Group orders by warehouse
  const ordersByWarehouse = {};
  for (const order of validOrders) {
    if (!ordersByWarehouse[order.warehouseId]) {
      ordersByWarehouse[order.warehouseId] = [];
    }
    ordersByWarehouse[order.warehouseId].push(order);
  }

  // Select vehicles
  const selectedVehicles = vehicles.slice(0, Math.min(vehicleCount, vehicles.length));
  const availableDrivers = drivers.slice(0, selectedVehicles.length);

  // Sort orders by strategy
  const sortedOrders = sortOrdersByStrategy(validOrders, strategy, dpMap, whMap);

  // Build routes using heuristic
  const routes = buildRoutes(sortedOrders, selectedVehicles, availableDrivers, dpMap, whMap, strategy);

  // Check for remaining unassigned
  const assignedOrderIds = new Set();
  for (const route of routes) {
    for (const order of route.orders) {
      assignedOrderIds.add(order.id);
    }
  }

  for (const order of validOrders) {
    if (!assignedOrderIds.has(order.id)) {
      unassigned.push({
        order,
        reasons: ['无法在现有车辆容量、时间窗或驾驶时长约束内分配']
      });
    }
  }

  // Calculate statistics
  const stats = calculateStats(routes, unassigned, orders.length);

  return { routes, unassigned, stats };
}

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

function sortOrdersByStrategy(orders, strategy, dpMap, whMap) {
  const sorted = [...orders];

  switch (strategy) {
    case 'priority_first':
      sorted.sort((a, b) => a.priority - b.priority || a.timeWindowEnd - b.timeWindowEnd);
      break;
    case 'time_window':
      sorted.sort((a, b) => a.timeWindowEnd - b.timeWindowEnd || a.priority - b.priority);
      break;
    case 'nearest_first':
      // Will be sorted during route building based on distance
      sorted.sort((a, b) => a.priority - b.priority);
      break;
    case 'balanced':
    default:
      sorted.sort((a, b) => {
        const urgencyA = (a.timeWindowEnd - a.timeWindowStart) / a.priority;
        const urgencyB = (b.timeWindowEnd - b.timeWindowStart) / b.priority;
        return urgencyA - urgencyB;
      });
      break;
  }

  return sorted;
}

function buildRoutes(orders, vehicles, drivers, dpMap, whMap, strategy) {
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
    assignWarehouseOrders(whOrders, warehouse, routes, dpMap, strategy);
  }

  // Finalize route calculations
  for (const route of routes) {
    finalizeRoute(route, dpMap, whMap);
  }

  return routes;
}

function assignWarehouseOrders(orders, warehouse, routes, dpMap, strategy) {
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
        const score = calculateAssignmentScore(order, dp, warehouse, route, dpMap, strategy);

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

function calculateAssignmentScore(order, dp, warehouse, route, dpMap, strategy) {
  let score = 0;

  // Distance from last point in route (or warehouse)
  const lastPoint = route.orders.length > 0
    ? dpMap[route.orders[route.orders.length - 1].deliveryPointId]
    : warehouse;

  const dist = distance(lastPoint, dp);
  score += dist * 10;

  // Time window compatibility
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

  // Strategy-specific adjustments
  switch (strategy) {
    case 'priority_first':
      score += order.priority * 100;
      break;
    case 'time_window':
      score += order.timeWindowEnd * 50;
      break;
    case 'nearest_first':
      // Distance is already the primary factor
      break;
    case 'balanced':
    default:
      score += order.weight * 0.5; // Prefer filling with heavier items first
      break;
  }

  // Penalty for overloading risk (prefer balanced distribution)
  const loadRate = (route.totalWeight + order.weight) / route.vehicle.capacity;
  if (loadRate > 0.9) {
    score += 200;
  }

  return score;
}

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

  return reasons.length > 0 ? reasons.join('; ') : null;
}

function finalizeRoute(route, dpMap, whMap) {
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

  // Time window violations
  route.timeWindowViolations = [];
  let currentTime = 8; // Start at 8:00
  currentPoint = warehouse;

  for (const order of route.orders) {
    const dp = dpMap[order.deliveryPointId];
    if (dp) {
      const travelTime = distance(currentPoint, dp) / route.vehicle.speed;
      currentTime += travelTime;

      if (currentTime < order.timeWindowStart) {
        currentTime = order.timeWindowStart; // Wait
      }

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

function recalculateSingleRoute({ route, dpMap, whMap }) {
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

  finalizeRoute(recalculated, dpMap, whMap);
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
