// ============================================================
// Web Worker: 配送路线启发式规划引擎
// ============================================================

self.onmessage = function (e) {
  const { type, payload } = e.data;
  if (type === 'plan') {
    const result = planRoutes(payload);
    self.postMessage({ type: 'plan-result', payload: result });
  } else if (type === 'recalc-route') {
    const result = recalcRoute(payload);
    self.postMessage({ type: 'recalc-result', payload: result });
  }
};

// ---- 工具函数 ----

function timeToMin(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minToTime(m) {
  const h = Math.floor(m / 60);
  const mm = Math.floor(m % 60);
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

function dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// 虚拟坐标距离转公里（1单位 ≈ 0.05 km）
function distToKm(d) {
  return d * 0.05;
}

// 行驶时间（分钟）
function travelMin(from, to, speedKmH) {
  const km = distToKm(dist(from, to));
  return (km / speedKmH) * 60;
}

// ---- 订单预处理 ----

function preprocessOrders(orders, deliveryPoints, vehicles) {
  const dpMap = {};
  deliveryPoints.forEach(dp => dpMap[dp.id] = dp);

  const maxVehicleWeight = Math.max(...vehicles.map(v => v.capacityWeight));
  const maxVehicleVolume = Math.max(...vehicles.map(v => v.capacityVolume));

  const valid = [];
  const invalid = [];

  orders.forEach(order => {
    const problems = [];

    // 坐标缺失
    if (!order.deliveryPointId || !dpMap[order.deliveryPointId]) {
      problems.push('坐标/配送点缺失');
    }

    // 超过所有车辆最大载重
    if (order.weight > maxVehicleWeight) {
      problems.push(`重量 ${order.weight}kg 超过最大车载 ${maxVehicleWeight}kg`);
    }
    if (order.volume > maxVehicleVolume) {
      problems.push(`体积 ${order.volume}m³ 超过最大车载 ${maxVehicleVolume}m³`);
    }

    if (problems.length > 0) {
      invalid.push({ ...order, problems, status: 'rejected' });
    } else {
      const dp = dpMap[order.deliveryPointId];
      valid.push({
        ...order,
        x: dp.x,
        y: dp.y,
        dpName: dp.name,
        twStart: timeToMin(order.timeWindowStart),
        twEnd: timeToMin(order.timeWindowEnd),
        twDuration: timeToMin(order.timeWindowEnd) - timeToMin(order.timeWindowStart),
      });
    }
  });

  return { valid, invalid };
}

// ---- 启发式路线规划 ----

function planRoutes({ warehouse, deliveryPoints, orders, vehicles, drivers, strategy, vehicleCount }) {
  const startTime = performance.now();

  // 预处理
  const { valid, invalid } = preprocessOrders(orders, deliveryPoints, vehicles);

  // 确定使用的车辆数
  const usedCount = Math.min(vehicleCount || drivers.length, drivers.length, vehicles.length);
  const usedDrivers = drivers.slice(0, usedCount);

  // 构建车辆-司机对
  const fleets = usedDrivers.map(driver => {
    const vehicle = vehicles.find(v => v.id === driver.vehicleId) || vehicles[0];
    return { driver, vehicle };
  });

  // 排序订单（根据策略）
  let sortedOrders = [...valid];
  switch (strategy) {
    case 'urgent_first':
      sortedOrders.sort((a, b) => {
        if (a.priority === 'high' && b.priority !== 'high') return -1;
        if (a.priority !== 'high' && b.priority === 'high') return 1;
        return a.twEnd - b.twEnd; // 截止早的先配
      });
      break;
    case 'cluster':
      // 按到仓库角度分区
      sortedOrders.sort((a, b) => {
        const angleA = Math.atan2(a.y - warehouse.y, a.x - warehouse.x);
        const angleB = Math.atan2(b.y - warehouse.y, b.x - warehouse.x);
        return angleA - angleB;
      });
      break;
    case 'balanced':
      // 先按重量降序（大件优先分配）
      sortedOrders.sort((a, b) => b.weight - a.weight);
      break;
    case 'nearest_first':
    default:
      // 按到仓库的距离排序
      sortedOrders.sort((a, b) => dist(warehouse, a) - dist(warehouse, b));
      break;
  }

  // 初始化每条路线
  const routes = fleets.map((fleet, idx) => ({
    id: 'R-' + String(idx + 1).padStart(2, '0'),
    driverId: fleet.driver.id,
    driverName: fleet.driver.name,
    vehicleId: fleet.vehicle.id,
    vehicleName: fleet.vehicle.name,
    capacityWeight: fleet.vehicle.capacityWeight,
    capacityVolume: fleet.vehicle.capacityVolume,
    speedKmH: fleet.vehicle.speedKmH,
    costPerKm: fleet.vehicle.costPerKm,
    workStart: timeToMin(fleet.driver.workStartTime),
    workEnd: timeToMin(fleet.driver.workEndTime),
    breakDuration: fleet.driver.breakDurationMin,
    breakAfterHours: fleet.driver.breakAfterHours,
    stops: [],
    totalWeight: 0,
    totalVolume: 0,
    totalDistance: 0,
    totalTime: 0,
    loadRateWeight: 0,
    loadRateVolume: 0,
    warnings: [],
    reasons: [],
  }));

  const assigned = new Set();
  const unassigned = [];

  if (strategy === 'balanced') {
    // 均衡策略：轮流分配
    balancedAssign(sortedOrders, routes, warehouse, assigned);
  } else if (strategy === 'cluster') {
    // 聚类策略：按角度区间分配给不同车辆
    clusterAssign(sortedOrders, routes, warehouse, assigned);
  } else {
    // nearest_first / urgent_first: 贪心填充
    greedyAssign(sortedOrders, routes, warehouse, assigned, strategy);
  }

  // 收集未分配
  sortedOrders.forEach(order => {
    if (!assigned.has(order.id)) {
      const reasons = [];
      // 分析为什么没分配
      routes.forEach(route => {
        if (route.totalWeight + order.weight > route.capacityWeight) {
          reasons.push(`${route.vehicleName}: 剩余载重不足`);
        }
        const arriveTime = estimateArrival(route, order, warehouse);
        if (arriveTime > order.twEnd) {
          reasons.push(`${route.vehicleName}: 无法在时间窗内到达`);
        }
        if (arriveTime > route.workEnd) {
          reasons.push(`${route.driverName}: 超出工作时间`);
        }
      });
      unassigned.push({
        ...order,
        status: 'unassigned',
        problems: reasons.length > 0 ? reasons : ['所有路线均已满载或时间冲突'],
      });
    }
  });

  // 计算每条路线的详细指标
  routes.forEach(route => {
    computeRouteMetrics(route, warehouse);
  });

  const elapsed = performance.now() - startTime;

  return {
    routes,
    unassigned,
    invalid,
    stats: {
      totalOrders: orders.length,
      assignedCount: assigned.size,
      unassignedCount: sortedOrders.length - assigned.size,
      invalidCount: invalid.length,
      computeTimeMs: Math.round(elapsed),
      strategy,
    },
  };
}

// ---- 贪心分配 ----

function greedyAssign(orders, routes, warehouse, assigned, strategy) {
  for (const route of routes) {
    let currentPos = { x: warehouse.x, y: warehouse.y };
    let currentTime = route.workStart;
    let workSinceBreak = 0;
    let hadBreak = false;

    for (let pass = 0; pass < orders.length; pass++) {
      let bestOrder = null;
      let bestScore = Infinity;

      for (const order of orders) {
        if (assigned.has(order.id)) continue;

        // 容量检查
        if (route.totalWeight + order.weight > route.capacityWeight) continue;
        if (route.totalVolume + order.volume > route.capacityVolume) continue;

        // 行驶时间
        const travel = travelMin(currentPos, order, route.speedKmH);
        const arriveTime = currentTime + travel;

        // 休息时间检查
        let effectiveArrival = arriveTime;
        if (!hadBreak && workSinceBreak + travel > route.breakAfterHours * 60) {
          effectiveArrival += route.breakDuration;
        }

        // 等待到时间窗开始
        const serviceStart = Math.max(effectiveArrival, order.twStart);

        // 时间窗检查
        if (serviceStart > order.twEnd) continue;

        // 工作时间检查（需要回仓库的时间）
        const returnTravel = travelMin(order, warehouse, route.speedKmH);
        const serviceEnd = serviceStart + 10; // 假设每站卸货10分钟
        if (serviceEnd + returnTravel > route.workEnd) continue;

        // 评分
        let score;
        if (strategy === 'urgent_first') {
          score = order.twEnd - serviceStart; // 越紧迫越优先
          if (order.priority === 'high') score -= 1000;
        } else {
          score = travel; // 最近优先
        }

        if (score < bestScore) {
          bestScore = score;
          bestOrder = order;
        }
      }

      if (!bestOrder) break;

      // 分配
      const travel = travelMin(currentPos, bestOrder, route.speedKmH);
      let arriveTime = currentTime + travel;

      // 处理休息
      let breakInserted = false;
      if (!hadBreak && workSinceBreak + travel > route.breakAfterHours * 60) {
        arriveTime += route.breakDuration;
        hadBreak = true;
        breakInserted = true;
      }

      const serviceStart = Math.max(arriveTime, bestOrder.twStart);
      const serviceEnd = serviceStart + 10;

      // 生成分配原因
      const reason = buildReason(bestOrder, route, currentPos, warehouse, travel, strategy);

      route.stops.push({
        orderId: bestOrder.id,
        deliveryPointId: bestOrder.deliveryPointId,
        dpName: bestOrder.dpName,
        x: bestOrder.x,
        y: bestOrder.y,
        weight: bestOrder.weight,
        volume: bestOrder.volume,
        priority: bestOrder.priority,
        description: bestOrder.description,
        timeWindowStart: bestOrder.timeWindowStart,
        timeWindowEnd: bestOrder.timeWindowEnd,
        arriveTime: minToTime(arriveTime),
        serviceStart: minToTime(serviceStart),
        serviceEnd: minToTime(serviceEnd),
        waitMin: Math.max(0, bestOrder.twStart - arriveTime),
        breakBefore: breakInserted,
        reason,
      });

      route.totalWeight += bestOrder.weight;
      route.totalVolume += bestOrder.volume;
      assigned.add(bestOrder.id);
      currentPos = { x: bestOrder.x, y: bestOrder.y };
      currentTime = serviceEnd;
      workSinceBreak = hadBreak ? (serviceEnd - (arriveTime - route.breakDuration)) : (serviceEnd - route.workStart);
    }
  }
}

// ---- 均衡分配 ----

function balancedAssign(orders, routes, warehouse, assigned) {
  let routeIdx = 0;
  for (const order of orders) {
    if (assigned.has(order.id)) continue;

    // 找负载最低的可行路线
    let bestRoute = null;
    let bestLoad = Infinity;

    for (let i = 0; i < routes.length; i++) {
      const ri = (routeIdx + i) % routes.length;
      const route = routes[ri];
      if (route.totalWeight + order.weight > route.capacityWeight) continue;
      if (route.totalVolume + order.volume > route.capacityVolume) continue;

      const loadRate = route.totalWeight / route.capacityWeight;
      if (loadRate < bestLoad) {
        bestLoad = loadRate;
        bestRoute = route;
      }
    }

    if (!bestRoute) continue;

    const lastPos = bestRoute.stops.length > 0
      ? bestRoute.stops[bestRoute.stops.length - 1]
      : warehouse;
    const travel = travelMin(lastPos, order, bestRoute.speedKmH);

    bestRoute.stops.push({
      orderId: order.id,
      deliveryPointId: order.deliveryPointId,
      dpName: order.dpName,
      x: order.x,
      y: order.y,
      weight: order.weight,
      volume: order.volume,
      priority: order.priority,
      description: order.description,
      timeWindowStart: order.timeWindowStart,
      timeWindowEnd: order.timeWindowEnd,
      arriveTime: '--:--',
      serviceStart: '--:--',
      serviceEnd: '--:--',
      waitMin: 0,
      breakBefore: false,
      reason: `均衡分配：该车当前负载率最低 (${(bestLoad * 100).toFixed(0)}%)`,
    });

    bestRoute.totalWeight += order.weight;
    bestRoute.totalVolume += order.volume;
    assigned.add(order.id);
    routeIdx++;
  }

  // 重新计算时间
  routes.forEach(route => recalcStopTimes(route, warehouse));
}

// ---- 聚类分配 ----

function clusterAssign(orders, routes, warehouse, assigned) {
  const n = routes.length;
  if (n === 0) return;

  // 按角度均分
  const sliceAngle = (2 * Math.PI) / n;

  for (const order of orders) {
    if (assigned.has(order.id)) continue;

    const angle = Math.atan2(order.y - warehouse.y, order.x - warehouse.x);
    const normalizedAngle = angle < -Math.PI + sliceAngle / 2 ? angle + 2 * Math.PI : angle;
    let sliceIdx = Math.floor((normalizedAngle + Math.PI) / sliceAngle) % n;

    // 尝试分配到对应区域的路线
    let placed = false;
    for (let attempt = 0; attempt < n; attempt++) {
      const ri = (sliceIdx + attempt) % n;
      const route = routes[ri];
      if (route.totalWeight + order.weight > route.capacityWeight) continue;
      if (route.totalVolume + order.volume > route.capacityVolume) continue;

      const lastPos = route.stops.length > 0
        ? route.stops[route.stops.length - 1]
        : warehouse;

      route.stops.push({
        orderId: order.id,
        deliveryPointId: order.deliveryPointId,
        dpName: order.dpName,
        x: order.x,
        y: order.y,
        weight: order.weight,
        volume: order.volume,
        priority: order.priority,
        description: order.description,
        timeWindowStart: order.timeWindowStart,
        timeWindowEnd: order.timeWindowEnd,
        arriveTime: '--:--',
        serviceStart: '--:--',
        serviceEnd: '--:--',
        waitMin: 0,
        breakBefore: false,
        reason: `区域聚类：该配送点位于车辆 ${route.vehicleName} 负责的区域`,
      });

      route.totalWeight += order.weight;
      route.totalVolume += order.volume;
      assigned.add(order.id);
      placed = true;
      break;
    }
  }

  // 每条路线内按距离优化顺序
  routes.forEach(route => {
    if (route.stops.length <= 1) return;
    route.stops = nearestNeighborSort(route.stops, warehouse);
    recalcStopTimes(route, warehouse);
  });
}

// ---- 路线内最近邻排序 ----

function nearestNeighborSort(stops, warehouse) {
  const sorted = [];
  const remaining = [...stops];
  let current = { x: warehouse.x, y: warehouse.y };

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = dist(current, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    sorted.push(remaining[bestIdx]);
    current = remaining[bestIdx];
    remaining.splice(bestIdx, 1);
  }

  return sorted;
}

// ---- 重算路线站点时间 ----

function recalcStopTimes(route, warehouse) {
  let currentPos = { x: warehouse.x, y: warehouse.y };
  let currentTime = route.workStart;
  let workSinceBreak = 0;
  let hadBreak = false;

  for (const stop of route.stops) {
    const travel = travelMin(currentPos, stop, route.speedKmH);
    let arriveTime = currentTime + travel;

    // 休息
    if (!hadBreak && workSinceBreak + travel > route.breakAfterHours * 60) {
      arriveTime += route.breakDuration;
      hadBreak = true;
      stop.breakBefore = true;
    }

    const twStart = timeToMin(stop.timeWindowStart);
    const twEnd = timeToMin(stop.timeWindowEnd);
    const serviceStart = Math.max(arriveTime, twStart);
    const serviceEnd = serviceStart + 10;

    stop.arriveTime = minToTime(arriveTime);
    stop.serviceStart = minToTime(serviceStart);
    stop.serviceEnd = minToTime(serviceEnd);
    stop.waitMin = Math.max(0, twStart - arriveTime);

    currentPos = { x: stop.x, y: stop.y };
    currentTime = serviceEnd;
    workSinceBreak = hadBreak ? (serviceEnd - arriveTime) : (serviceEnd - route.workStart);
  }
}

// ---- 计算路线综合指标 ----

function computeRouteMetrics(route, warehouse) {
  if (route.stops.length === 0) {
    route.totalDistance = 0;
    route.totalTime = 0;
    route.loadRateWeight = 0;
    route.loadRateVolume = 0;
    return;
  }

  let totalDist = 0;
  let prev = warehouse;
  for (const stop of route.stops) {
    totalDist += dist(prev, stop);
    prev = stop;
  }
  totalDist += dist(prev, warehouse); // 回程

  route.totalDistance = distToKm(totalDist);

  // 总耗时
  const firstStop = route.stops[0];
  const lastStop = route.stops[route.stops.length - 1];
  const lastServiceEnd = timeToMin(lastStop.serviceEnd);
  const returnTime = travelMin(lastStop, warehouse, route.speedKmH);
  route.totalTime = lastServiceEnd + returnTime - route.workStart;
  route.returnTime = minToTime(lastServiceEnd + returnTime);

  // 装载率
  route.loadRateWeight = route.totalWeight / route.capacityWeight;
  route.loadRateVolume = route.totalVolume / route.capacityVolume;

  // 超时风险检查
  route.warnings = [];
  for (const stop of route.stops) {
    const arrive = timeToMin(stop.arriveTime);
    const twEnd = timeToMin(stop.timeWindowEnd);
    const twStart = timeToMin(stop.timeWindowStart);

    if (arrive > twEnd) {
      stop.risk = 'overdue';
      route.warnings.push(`${stop.dpName}(${stop.orderId}): 到达时间 ${stop.arriveTime} 超过截止 ${stop.timeWindowEnd}`);
    } else if (twEnd - arrive < 15) {
      stop.risk = 'tight';
      route.warnings.push(`${stop.dpName}(${stop.orderId}): 到达时间 ${stop.arriveTime} 距截止仅 ${Math.round(twEnd - arrive)} 分钟`);
    } else {
      stop.risk = 'ok';
    }
  }

  // 司机下班检查
  const endTime = lastServiceEnd + returnTime;
  if (endTime > route.workEnd) {
    route.warnings.push(`${route.driverName} 预计 ${minToTime(endTime)} 返回仓库，超出下班时间 ${minToTime(route.workEnd)}`);
  }
}

// ---- 生成分配原因 ----

function buildReason(order, route, currentPos, warehouse, travel, strategy) {
  const parts = [];

  if (strategy === 'urgent_first' && order.priority === 'high') {
    parts.push('高优先级订单，优先分配');
  }

  const distKm = distToKm(dist(currentPos, order)).toFixed(1);
  parts.push(`距上一站 ${distKm}km（当前路线最近可达点）`);

  const loadAfter = ((route.totalWeight + order.weight) / route.capacityWeight * 100).toFixed(0);
  parts.push(`分配后载重率 ${loadAfter}%`);

  if (order.twDuration <= 90) {
    parts.push(`时间窗仅 ${order.twDuration} 分钟，需优先配送`);
  }

  return parts.join('；');
}

// ---- 估算到达时间 ----

function estimateArrival(route, order, warehouse) {
  const lastPos = route.stops.length > 0
    ? route.stops[route.stops.length - 1]
    : warehouse;
  const lastTime = route.stops.length > 0
    ? timeToMin(route.stops[route.stops.length - 1].serviceEnd)
    : route.workStart;
  return lastTime + travelMin(lastPos, order, route.speedKmH);
}

// ---- 单条路线重算（拖拽后） ----

function recalcRoute({ route, warehouse }) {
  // 重算重量体积
  route.totalWeight = route.stops.reduce((s, st) => s + st.weight, 0);
  route.totalVolume = route.stops.reduce((s, st) => s + st.volume, 0);

  // 重算时间
  recalcStopTimes(route, warehouse);
  computeRouteMetrics(route, warehouse);

  return route;
}
